/**
 * On-demand segment serving.
 *
 * SABR is a sequential protocol; DASH players want numbered segments at
 * arbitrary positions. The obvious bridge is to pull a whole video and serve it
 * statically, and that is what this connector used to do — but random access
 * turns out to cost **39–88ms** (measured: seeking 50 minutes into a 52-minute
 * video and receiving the first segment). Storing ~83MB per watched video to
 * avoid an 88ms operation is not a trade worth making, and it turns the cache
 * directory into a watch history with the content attached.
 *
 * So nothing is stored. A `TrackReader` is a live SABR stream positioned at
 * some segment, retaining only a short window behind the playhead. Sequential
 * playback reads from one reader; a seek beyond its window opens another. Idle
 * readers are aborted, which also means abandoning playback stops the download
 * instead of quietly fetching the rest of the video.
 */
import { Buffer } from "node:buffer";
import {
    pullSabrTrack,
    type SabrPullSelection,
    type SabrSession,
} from "./session.ts";

/** Segments retained behind the playhead, for small player rewinds. */
const RETAIN = Number(Deno.env.get("SABR_RETAIN_SEGMENTS") || 12);
/** A reader this far behind a wanted segment is read forward rather than replaced. */
const FORWARD_WINDOW = Number(Deno.env.get("SABR_FORWARD_WINDOW") || 24);
/** Readers idle longer than this are aborted. */
const IDLE_MS = Number(Deno.env.get("SABR_READER_IDLE_MS") || 45_000);

export interface TrackIndex {
    timescale: number;
    /** Duration of each segment, in `timescale` units. */
    durations: number[];
    /** Byte size of each segment, so a byte range can map to a segment. */
    sizes: number[];
    init: Uint8Array<ArrayBuffer>;
    /** Cumulative start time of each segment, in `timescale` units. */
    starts: number[];
}

function readBox(buf: Buffer, off: number) {
    if (off + 8 > buf.length) return null;
    const size = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("latin1");
    if (!/^[a-zA-Z0-9]{4}$/.test(type) || size < 8) return null;
    if (off + size > buf.length) return null;
    return { size, type };
}

function findBaseMediaDecodeTime(moof: Buffer): number | undefined {
    const idx = moof.indexOf("tfdt", 0, "latin1");
    if (idx < 0) return undefined;
    const version = moof.readUInt8(idx + 4);
    const off = idx + 8;
    if (version === 1) {
        return off + 8 <= moof.length
            ? Number(moof.readBigUInt64BE(off))
            : undefined;
    }
    return off + 4 <= moof.length ? moof.readUInt32BE(off) : undefined;
}

/**
 * Parse the `sidx` (segment index) box carried in the init segment.
 *
 * This is what makes the manifest cheap: `sidx` lists every segment's duration
 * *and* byte size up front, so the timeline is built from the first few
 * kilobytes of a track rather than from a completed pull. Verified against
 * observed data — 288 references, durations and sizes both matching the pulled
 * fragments exactly.
 */
function parseSidx(
    init: Uint8Array,
): { timescale: number; durations: number[]; sizes: number[] } | undefined {
    const buf = Buffer.from(init);
    let off = 0;
    let found = -1;
    while (off + 8 <= buf.length) {
        const size = buf.readUInt32BE(off);
        const type = buf.subarray(off + 4, off + 8).toString("latin1");
        if (type === "sidx") {
            found = off;
            break;
        }
        if (size < 8) break;
        off += size;
    }
    if (found < 0) return undefined;

    let p = found + 8;
    const version = buf.readUInt8(p);
    p += 4; // version + flags
    p += 4; // reference_id
    const timescale = buf.readUInt32BE(p);
    p += 4;
    p += version === 0 ? 8 : 16; // earliest_presentation_time + first_offset
    p += 2; // reserved
    const count = buf.readUInt16BE(p);
    p += 2;

    const durations: number[] = [];
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
        if (p + 12 > buf.length) break;
        // Top bit of the first word is the reference type, not part of the size.
        sizes.push(buf.readUInt32BE(p) & 0x7fffffff);
        durations.push(buf.readUInt32BE(p + 4));
        p += 12;
    }
    if (!durations.length || !timescale) return undefined;
    return { timescale, durations, sizes };
}

/**
 * Read just the init segment — which carries the `sidx` index of the whole
 * track — then stop. This is all the manifest needs, and costs one round trip.
 */
export async function fetchTrackIndex(
    session: SabrSession,
    sel: SabrPullSelection,
): Promise<{ index: TrackIndex; format: unknown }> {
    const { stream, format } = await pullSabrTrack(session, sel);
    const reader = stream.getReader();
    let buf = Buffer.alloc(0);
    const header: Buffer[] = [];
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf = Buffer.concat([buf, Buffer.from(value)]);
            let off = 0;
            let sawMoof = false;
            for (;;) {
                const box = readBox(buf, off);
                if (!box) break;
                if (box.type === "moof") {
                    sawMoof = true;
                    break;
                }
                header.push(Buffer.from(buf.subarray(off, off + box.size)));
                off += box.size;
            }
            if (off > 0) buf = buf.subarray(off);
            if (sawMoof) break;
        }
    } finally {
        // Abandon the rest of the stream; we only wanted the index.
        try {
            await reader.cancel();
        } catch { /* already gone */ }
    }

    const init = new Uint8Array(Buffer.concat(header));
    const parsed = parseSidx(init);
    if (!parsed) throw new Error("track has no sidx index");
    const starts: number[] = [];
    let acc = 0;
    for (const d of parsed.durations) {
        starts.push(acc);
        acc += d;
    }
    return { index: { ...parsed, init, starts }, format };
}

/** A live SABR stream positioned at a segment, retaining a short window. */
class TrackReader {
    next: number;
    lastUsed = performance.now();
    private segments = new Map<number, Uint8Array<ArrayBuffer>>();
    private waiters = new Map<number, Array<() => void>>();
    private aborted = false;
    private failed?: Error;

    constructor(
        readonly key: string,
        private readonly index: TrackIndex,
        startSegment: number,
        private readonly abortFn: () => void,
    ) {
        this.next = startSegment;
    }

    static async open(
        key: string,
        session: SabrSession,
        sel: SabrPullSelection,
        index: TrackIndex,
        startSegment: number,
    ): Promise<TrackReader> {
        const startMs = Math.floor(
            (index.starts[startSegment - 1] / index.timescale) * 1000,
        );
        const { stream } = await pullSabrTrack(session, {
            ...sel,
            ...(startSegment > 1 ? { startAtMs: startMs } : {}),
        });
        const streamReader = stream.getReader();
        const reader = new TrackReader(key, index, startSegment, () => {
            void streamReader.cancel().catch(() => {});
        });
        void reader.consume(streamReader);
        return reader;
    }

    private publish(number: number, bytes: Uint8Array<ArrayBuffer>) {
        if (this.segments.has(number)) return;
        this.segments.set(number, bytes);
        if (number >= this.next) this.next = number + 1;
        // Drop what is well behind the playhead; a player only rewinds a little.
        for (const n of this.segments.keys()) {
            if (n < this.next - RETAIN) this.segments.delete(n);
        }
        const w = this.waiters.get(number);
        if (w) {
            this.waiters.delete(number);
            for (const fn of w) fn();
        }
    }

    private releaseAll() {
        for (const [, w] of this.waiters) for (const fn of w) fn();
        this.waiters.clear();
    }

    private async consume(
        streamReader: ReadableStreamDefaultReader<Uint8Array>,
    ) {
        let buf = Buffer.alloc(0);
        let pendingMoof: Buffer | null = null;
        try {
            for (;;) {
                const { done, value } = await streamReader.read();
                if (done || this.aborted) break;
                buf = Buffer.concat([buf, Buffer.from(value)]);
                let off = 0;
                for (;;) {
                    const box = readBox(buf, off);
                    if (!box) break;
                    const raw = buf.subarray(off, off + box.size);
                    if (box.type === "moof") {
                        pendingMoof = Buffer.from(raw);
                    } else if (box.type === "mdat" && pendingMoof) {
                        const dt = findBaseMediaDecodeTime(pendingMoof);
                        // Number by matching the index, not by counting: a
                        // positioned stream begins at the segment *containing*
                        // the requested time, which need not be the one asked
                        // for.
                        const n = dt === undefined
                            ? undefined
                            : this.index.starts.findIndex((s) =>
                                Math.abs(s - dt) <= 1
                            ) + 1;
                        if (n && n > 0) {
                            this.publish(
                                n,
                                new Uint8Array(
                                    Buffer.concat([pendingMoof, raw]),
                                ),
                            );
                        }
                        pendingMoof = null;
                    }
                    off += box.size;
                }
                if (off > 0) buf = buf.subarray(off);
            }
        } catch (err) {
            this.failed = err as Error;
        } finally {
            this.releaseAll();
        }
    }

    /** Wait for segment `n`, or give up after `timeoutMs`. */
    async segment(
        n: number,
        timeoutMs: number,
    ): Promise<Uint8Array<ArrayBuffer> | undefined> {
        this.lastUsed = performance.now();
        const have = this.segments.get(n);
        if (have) return have;
        if (this.failed || this.aborted) return undefined;

        await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(finish, timeoutMs);
            const list = this.waiters.get(n) ?? [];
            list.push(finish);
            this.waiters.set(n, list);
        });
        this.lastUsed = performance.now();
        return this.segments.get(n);
    }

    /** True if this reader can reach `n` by reading forward, cheaply. */
    canReach(n: number): boolean {
        if (this.aborted || this.failed) return false;
        if (this.segments.has(n)) return true;
        return n >= this.next && n - this.next <= FORWARD_WINDOW;
    }

    abort() {
        if (this.aborted) return;
        this.aborted = true;
        this.releaseAll();
        try {
            this.abortFn();
        } catch { /* already gone */ }
    }
}

/**
 * Keeps one reader per active (video, track) position. Nothing is retained
 * once playback stops.
 */
export class ReaderPool {
    private readers: TrackReader[] = [];
    private sweeper?: ReturnType<typeof setInterval>;

    private sweep() {
        const now = performance.now();
        this.readers = this.readers.filter((r) => {
            if (now - r.lastUsed < IDLE_MS) return true;
            r.abort();
            return false;
        });
        if (!this.readers.length && this.sweeper !== undefined) {
            clearInterval(this.sweeper);
            this.sweeper = undefined;
        }
    }

    private ensureSweeper() {
        if (this.sweeper !== undefined) return;
        this.sweeper = setInterval(() => this.sweep(), 5_000);
        // Never hold the process open for a cache sweep.
        Deno.unrefTimer(this.sweeper);
    }

    async segment(
        key: string,
        session: SabrSession,
        sel: SabrPullSelection,
        index: TrackIndex,
        n: number,
        timeoutMs: number,
    ): Promise<Uint8Array<ArrayBuffer> | undefined> {
        if (n < 1 || n > index.durations.length) return undefined;

        let reader = this.readers.find((r) => r.key === key && r.canReach(n));
        if (!reader) {
            reader = await TrackReader.open(key, session, sel, index, n);
            this.readers.push(reader);
            this.ensureSweeper();
            // One reader per position: an older reader for the same track that
            // can no longer reach anything useful is retired on the next sweep.
        }
        return await reader.segment(n, timeoutMs);
    }

    /** Abort every reader; used on shutdown and in tests. */
    clear() {
        for (const r of this.readers) r.abort();
        this.readers = [];
    }

    get size() {
        return this.readers.length;
    }
}
