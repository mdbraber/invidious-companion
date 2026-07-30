/**
 * Cuts a fragmented-MP4 byte stream into DASH-servable pieces, in memory.
 *
 * SABR delivers fMP4: a header (`ftyp` + `moov`, which carries `mvex` and so is
 * an init segment by construction) followed by repeating `moof` + `mdat` pairs.
 * That maps directly onto DASH `SegmentTemplate`: the header becomes
 * `initialization`, each `moof`+`mdat` pair becomes one numbered media segment.
 * No re-muxing, no transcode — box walking only.
 *
 * Ported from owntube/spikes/sabr-dash/segmenter.ts; writes to a Map instead of
 * disk because the companion's `--allow-write` list is deliberately short.
 */
import { Buffer } from "node:buffer";

export interface SegmentInfo {
    number: number;
    bytes: number;
    baseMediaDecodeTime?: number;
}

export interface SegmentResult {
    initBytes: number;
    segments: SegmentInfo[];
    timescale?: number;
    /** "init.mp4" and "seg-N.m4s" -> bytes. */
    files: Map<string, Uint8Array>;
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

export async function segmentToMemory(
    stream: ReadableStream<Uint8Array>,
): Promise<SegmentResult> {
    let buf = Buffer.alloc(0);
    let init: Buffer | null = null;
    let pendingMoof: Buffer | null = null;
    const segments: SegmentInfo[] = [];
    const headerBoxes: Buffer[] = [];
    const files = new Map<string, Uint8Array>();

    const flushBoxes = () => {
        let off = 0;
        for (;;) {
            const box = readBox(buf, off);
            if (!box) break;
            const raw = buf.subarray(off, off + box.size);

            if (!init) {
                // Everything before the first moof is the init segment.
                if (box.type === "moof") {
                    init = Buffer.concat(headerBoxes);
                    files.set("init.mp4", new Uint8Array(init));
                    pendingMoof = Buffer.from(raw);
                } else {
                    headerBoxes.push(Buffer.from(raw));
                }
            } else if (box.type === "moof") {
                pendingMoof = Buffer.from(raw);
            } else if (box.type === "mdat" && pendingMoof) {
                const number = segments.length + 1;
                const segment = Buffer.concat([pendingMoof, raw]);
                files.set(`seg-${number}.m4s`, new Uint8Array(segment));
                segments.push({
                    number,
                    bytes: segment.length,
                    baseMediaDecodeTime: findBaseMediaDecodeTime(pendingMoof),
                });
                pendingMoof = null;
            }
            off += box.size;
        }
        if (off > 0) buf = buf.subarray(off);
    };

    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf = Buffer.concat([buf, Buffer.from(value)]);
        flushBoxes();
    }
    flushBoxes();

    return {
        initBytes: init === null ? 0 : (init as Buffer).length,
        segments,
        timescale: init ? findTimescale(init) : undefined,
        files,
    };
}
