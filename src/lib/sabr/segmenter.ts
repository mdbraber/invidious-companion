/**
 * Cuts a fragmented-MP4 byte stream into DASH-servable pieces, progressively.
 *
 * SABR delivers fMP4: a header (`ftyp` + `moov`, which carries `mvex` and so is
 * an init segment by construction) followed by repeating `moof` + `mdat` pairs.
 * That maps directly onto DASH `SegmentTemplate`: the header becomes
 * `initialization`, each `moof`+`mdat` pair becomes one numbered media segment.
 * No re-muxing, no transcode — box walking only.
 *
 * `TrackBuffer` exposes segments *as they arrive* rather than after the pull
 * finishes, so a player can start on segment 1 while the rest is still being
 * fetched. Waiters are resolved per segment number.
 */
import { Buffer } from "node:buffer";

export interface SegmentInfo {
    number: number;
    bytes: number;
    baseMediaDecodeTime?: number;
}

/** Segment durations for a whole track, read from the init segment's `sidx`. */
export interface SegmentIndex {
    timescale: number;
    /** One duration per segment, in `timescale` units. */
    durations: number[];
}

/**
 * Parse the `sidx` (segment index) box carried in the init segment.
 *
 * This is what makes the manifest cheap: `sidx` lists every segment's duration
 * up front, so the timeline can be built from the first few kilobytes of a
 * track instead of from `tfdt` values observed across a completed pull.
 * Verified against observed boundaries — 288 references, durations identical
 * to the pulled fragments, totalling the video's exact duration.
 */
export function parseSidx(init: Uint8Array): SegmentIndex | undefined {
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
    // earliest_presentation_time + first_offset
    p += version === 0 ? 8 : 16;
    p += 2; // reserved
    const count = buf.readUInt16BE(p);
    p += 2;

    const durations: number[] = [];
    for (let i = 0; i < count; i++) {
        if (p + 12 > buf.length) break;
        durations.push(buf.readUInt32BE(p + 4));
        p += 12;
    }
    if (!durations.length || !timescale) return undefined;
    return { timescale, durations };
}

function readBox(
    buf: Buffer,
    off: number,
): { size: number; type: string } | null {
    if (off + 8 > buf.length) return null;
    const size = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("latin1");
    if (!/^[a-zA-Z0-9]{4}$/.test(type) || size < 8) return null;
    if (off + size > buf.length) return null;
    return { size, type };
}

/** `mvhd` timescale, needed for the manifest's segment durations. */
function findTimescale(init: Buffer): number | undefined {
    const idx = init.indexOf("mvhd", 0, "latin1");
    if (idx < 0) return undefined;
    const version = init.readUInt8(idx + 4);
    const off = idx + 4 + 4 + (version === 1 ? 16 : 8);
    return off + 4 <= init.length ? init.readUInt32BE(off) : undefined;
}

/** `tfdt` decode time — segment start positions for the SegmentTimeline. */
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
 * One track's segments, filled in the background and readable while filling.
 */
export class TrackBuffer {
    readonly files = new Map<string, Uint8Array>();
    readonly segments: SegmentInfo[] = [];
    timescale?: number;
    /** Set once the init segment has been parsed; drives the manifest. */
    index?: SegmentIndex;
    /**
     * Resolves once the init segment (and so the segment index) is available —
     * a few kilobytes in, rather than at the end of the pull.
     */
    readonly ready: Promise<void>;
    /** Resolves when the whole track has been pulled; rejects if the pull did. */
    readonly done: Promise<void>;
    complete = false;
    error?: Error;
    bytes = 0;

    private waiters = new Map<string, Array<() => void>>();
    private resolveDone!: () => void;
    private rejectDone!: (e: Error) => void;
    private resolveReady!: () => void;
    private rejectReady!: (e: Error) => void;

    constructor() {
        this.ready = new Promise<void>((res, rej) => {
            this.resolveReady = res;
            this.rejectReady = rej;
        });
        this.done = new Promise<void>((res, rej) => {
            this.resolveDone = res;
            this.rejectDone = rej;
        });
        this.ready.catch(() => {});
        // The pull is consumed by fill(); nothing else awaits `done` unless it
        // wants completion, so make sure a failure is never an unhandled
        // rejection.
        this.done.catch(() => {});
    }

    private publish(name: string, bytes: Uint8Array) {
        this.files.set(name, bytes);
        this.bytes += bytes.length;
        const w = this.waiters.get(name);
        if (w) {
            this.waiters.delete(name);
            for (const fn of w) fn();
        }
    }

    private releaseAll() {
        for (const [, w] of this.waiters) for (const fn of w) fn();
        this.waiters.clear();
    }

    /**
     * Resolve once `name` exists, the track finishes, or `timeoutMs` elapses.
     * Returns the bytes, or undefined if it never appeared.
     */
    async get(
        name: string,
        timeoutMs = 30_000,
    ): Promise<Uint8Array | undefined> {
        const have = this.files.get(name);
        if (have) return have;
        if (this.complete || this.error) return undefined;

        await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(finish, timeoutMs);
            const list = this.waiters.get(name) ?? [];
            list.push(finish);
            this.waiters.set(name, list);
        });
        return this.files.get(name);
    }

    /** Pre-fill from a cache; the track is complete on return. */
    static fromFiles(files: Map<string, Uint8Array>): TrackBuffer {
        const tb = new TrackBuffer();
        const init = files.get("init.mp4");
        for (const [name, bytes] of files) {
            tb.files.set(name, bytes);
            tb.bytes += bytes.length;
        }
        if (init) {
            tb.timescale = findTimescale(Buffer.from(init));
            tb.index = parseSidx(init);
        }
        // Segment numbers are implied by the index; the tfdt fallback is not
        // reconstructed because a cached track always has its sidx.
        tb.complete = true;
        tb.resolveReady();
        tb.resolveDone();
        return tb;
    }

    /** Consume a pulled fMP4 stream, publishing segments as they complete. */
    async fill(stream: ReadableStream<Uint8Array>): Promise<void> {
        let buf = Buffer.alloc(0);
        let init: Buffer | null = null;
        let pendingMoof: Buffer | null = null;
        const headerBoxes: Buffer[] = [];

        const flush = () => {
            let off = 0;
            for (;;) {
                const box = readBox(buf, off);
                if (!box) break;
                const raw = buf.subarray(off, off + box.size);

                if (!init) {
                    // Everything before the first moof is the init segment.
                    if (box.type === "moof") {
                        init = Buffer.concat(headerBoxes);
                        this.timescale = findTimescale(init);
                        const bytes = new Uint8Array(init);
                        this.index = parseSidx(bytes);
                        this.publish("init.mp4", bytes);
                        // The manifest can be built from here; the rest of the
                        // pull continues in the background.
                        this.resolveReady();
                        pendingMoof = Buffer.from(raw);
                    } else {
                        headerBoxes.push(Buffer.from(raw));
                    }
                } else if (box.type === "moof") {
                    pendingMoof = Buffer.from(raw);
                } else if (box.type === "mdat" && pendingMoof) {
                    const number = this.segments.length + 1;
                    const seg = Buffer.concat([pendingMoof, raw]);
                    this.segments.push({
                        number,
                        bytes: seg.length,
                        baseMediaDecodeTime: findBaseMediaDecodeTime(
                            pendingMoof,
                        ),
                    });
                    this.publish(`seg-${number}.m4s`, new Uint8Array(seg));
                    pendingMoof = null;
                }
                off += box.size;
            }
            if (off > 0) buf = buf.subarray(off);
        };

        try {
            const reader = stream.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf = Buffer.concat([buf, Buffer.from(value)]);
                flush();
            }
            flush();
            this.complete = true;
            this.releaseAll();
            if (!init) {
                this.rejectReady(new Error("stream produced no init segment"));
            }
            this.resolveDone();
        } catch (err) {
            this.error = err as Error;
            this.releaseAll();
            this.rejectReady(this.error);
            this.rejectDone(this.error);
            throw this.error;
        }
    }
}
