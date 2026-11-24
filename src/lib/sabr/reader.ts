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
 * some segment, retaining only a short window behind the playhead and pulling
 * only a bounded window ahead of it (`AHEAD`). Sequential playback reads from
 * one reader; a seek beyond its window opens another. Idle readers are
 * aborted, which also means abandoning playback stops the download instead of
 * quietly fetching the rest of the video.
 */
import { Buffer } from "node:buffer";
import {
    clusterTimecode,
    EbmlCursor,
    findFirstClusterOffset,
    parseWebmInit,
} from "./ebml.ts";
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
/**
 * Segments pulled beyond the newest one a client asked for before the pull
 * is stopped. The server delivers at line speed and the library has no
 * backpressure, so an unbounded reader holds the rest of the video in memory
 * within seconds (a 1080p hour is over a gigabyte). Stopped readers keep what
 * they hold; a request past it opens a new reader there, which costs ~50 ms.
 */
const AHEAD = Number(Deno.env.get("SABR_AHEAD_SEGMENTS") || 24);

export interface TrackIndex {
    timescale: number;
    /** Duration of each segment, in `timescale` units. */
    durations: number[];
    /** Byte size of each segment, so a byte range can map to a segment. */
    sizes: number[];
    init: Uint8Array<ArrayBuffer>;
    /** Cumulative start time of each segment, in `timescale` units. */
    starts: number[];
    /** True when the segments are WebM clusters rather than fMP4. */
    webm: boolean;
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
 * Read just the init portion of a track and derive its segment index. One
 * pull, one round trip; the container is detected from the bytes themselves:
 *
 * - fMP4: init = boxes before the first `moof`, which carries a `sidx`
 *   listing every segment (durations, sizes).
 * - WebM (a VP9 pull from SABR arrives as a plain WebM stream): init =
 *   elements before the first Cluster. Its Cues element lists every cluster,
 *   so the SegmentTimeline also comes from the init alone. See
 *   `parseWebmInit` (ebml.ts).
 */
export async function fetchTrackIndex(
    session: SabrSession,
    sel: SabrPullSelection,
): Promise<{ index: TrackIndex; format: unknown }> {
    const { stream, format, abort } = await pullSabrTrack(session, sel);
    const reader = stream.getReader();
    let buf = Buffer.alloc(0);
    try {
        let isWebm = false;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf = Buffer.concat([buf, Buffer.from(value)]);
            if (buf.length >= 4) {
                isWebm = buf[0] === 0x1a && buf[1] === 0x45 &&
                    buf[2] === 0xdf && buf[3] === 0xa3;
            }

            if (isWebm) {
                const first = findFirstClusterOffset(buf);
                if (first === null) continue;
                const parsed = parseWebmInit(
                    new Uint8Array(buf.subarray(0, first)),
                );
                if (!parsed) {
                    throw new Error(
                        `webm init (${first} bytes) carries no Cues index`,
                    );
                }
                return { index: parsed, format };
            }

            // fMP4: init is everything before the first `moof`.
            let off = 0;
            let boundary: number | null = null;
            for (;;) {
                const box = readBox(buf, off);
                if (!box) break;
                if (box.type === "moof") {
                    boundary = off;
                    break;
                }
                off += box.size;
            }
            if (boundary === null) continue;
            const init = new Uint8Array(buf.subarray(0, boundary));
            const parsed = parseSidx(init);
            if (!parsed) throw new Error("track carries no sidx index");
            const starts: number[] = [];
            let acc = 0;
            for (const d of parsed.durations) {
                starts.push(acc);
                acc += d;
            }
            return {
                index: {
                    timescale: parsed.timescale,
                    durations: parsed.durations,
                    sizes: parsed.sizes,
                    init,
                    starts,
                    webm: false,
                },
                format,
            };
        }
        throw new Error("track ended before its first segment");
    } finally {
        // Abandon the rest of the stream; we only wanted the index. Abort the
        // pull itself, not just the reader — see `SabrPull.abort`.
        abort();
        try {
            await reader.cancel();
        } catch { /* already gone */ }
    }
}

const EBML_SEGMENT = "18538067";
const EBML_CLUSTER = "1f43b675";

/** A live SABR stream positioned at a segment, retaining a short window. */
class TrackReader {
    next: number;
    /** The newest segment a client asked this reader for. */
    private wanted: number;
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
        this.wanted = startSegment;
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
        const { stream, abort } = await pullSabrTrack(session, {
            ...sel,
            ...(startSegment > 1 ? { startAtMs: startMs } : {}),
        });
        const streamReader = stream.getReader();
        const reader = new TrackReader(key, index, startSegment, () => {
            abort();
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
        // Far enough ahead of the player: stop pulling, keep what is held.
        if (number >= this.wanted + AHEAD) this.abort();
    }

    private releaseAll() {
        for (const [, w] of this.waiters) for (const fn of w) fn();
        this.waiters.clear();
    }

    /**
     * WebM cut path. A DASH segment here is the run of Clusters from one
     * CuePoint to the next (YouTube cues every ~4-7 s, but clusters are often
     * shorter, so a segment usually spans several clusters). Each Cluster
     * carries its own Timecode; one equal to a cue time (`index.starts`)
     * opens segment n, and following clusters are appended until the
     * segment's indexed byte size is reached or the next cue's cluster
     * arrives. Clusters before the first cue boundary (a positioned pull
     * begins at the cluster *containing* the time) are dropped.
     *
     * The pull re-sends the EBML header and the Segment start (whose size
     * spans the whole file): skip the header, step into the Segment, skip
     * SeekHead/Info/Tracks/Cues.
     */
    private async consumeWebm(
        streamReader: ReadableStreamDefaultReader<Uint8Array>,
    ) {
        let buf = Buffer.alloc(0);
        /** The segment being assembled: its number and clusters so far. */
        let n = 0;
        let parts: Buffer[] = [];
        let bytes = 0;
        const flush = () => {
            if (n > 0) this.publish(n, new Uint8Array(Buffer.concat(parts)));
            n = 0;
            parts = [];
            bytes = 0;
        };
        try {
            for (;;) {
                const { done, value } = await streamReader.read();
                if (this.aborted) break;
                if (done) {
                    // A natural end completes the final segment.
                    if (n === this.index.durations.length) flush();
                    break;
                }
                buf = Buffer.concat([buf, Buffer.from(value)]);
                const cur = new EbmlCursor(buf);
                let off = 0;
                for (;;) {
                    const head = cur.id(off);
                    if (!head) break;
                    if (head.hex === EBML_SEGMENT) {
                        // Step into the Segment: its children follow its size.
                        const size = cur.size(off + head.length);
                        if (!size) break;
                        off += head.length + size.length;
                        continue;
                    }
                    const el = cur.element(off);
                    if (!el) {
                        if (cur.size(off + head.length)?.unknown) {
                            throw new Error(
                                `webm element ${head.hex} has unknown size`,
                            );
                        }
                        break; // header not fully arrived
                    }
                    const end = el.body + el.size;
                    if (end > buf.length) break; // not fully arrived
                    if (el.id === EBML_CLUSTER) {
                        const raw = buf.subarray(off, end);
                        const time = clusterTimecode(raw);
                        const at = time === undefined ? 0 : this.index.starts
                            .findIndex((s) => Math.abs(s - time) <= 2) + 1;
                        if (at > 0) {
                            flush();
                            n = at;
                        }
                        if (n > 0) {
                            parts.push(Buffer.from(raw));
                            bytes += raw.length;
                            if (bytes >= this.index.sizes[n - 1]) flush();
                        }
                    }
                    off = end;
                }
                if (off > 0) buf = buf.subarray(off);
            }
        } catch (err) {
            this.failed = err as Error;
        } finally {
            this.releaseAll();
        }
    }

    private async consume(
        streamReader: ReadableStreamDefaultReader<Uint8Array>,
    ) {
        if (this.index.webm) return this.consumeWebm(streamReader);
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
        if (n > this.wanted) this.wanted = n;
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

    /** True if this reader holds `n`, or can reach it by reading forward, cheaply. */
    canReach(n: number): boolean {
        if (this.segments.has(n)) return true;
        if (this.aborted || this.failed) return false;
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
