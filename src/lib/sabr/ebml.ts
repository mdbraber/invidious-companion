/**
 * Minimal EBML/WebM parsing for the SABR connector's VP9 (WebM) tracks.
 *
 * A SABR VP9 pull arrives as a plain WebM byte stream: EBML header, Segment
 * (Info, Tracks, Cues, then Clusters). The Cues element sits before the first
 * Cluster and lists every cluster's timecode and byte offset — the same
 * one-round-trip indexing the fMP4 init's `sidx` provides, so a WebM track
 * needs no media download to build a DASH SegmentTimeline.
 */
export interface WebmTrackIndex {
    /** Ticks per second (from Info.TimecodeScale; default scale -> 1000 = ms). */
    timescale: number;
    /** Duration of each cluster, in `timescale` units. */
    durations: number[];
    /** Cumulative start time of each cluster, in `timescale` units. */
    starts: number[];
    /** Cluster byte sizes (last one estimated — the stream has no hard end). */
    sizes: number[];
    /** The init portion: everything before the first Cluster. */
    init: Uint8Array<ArrayBuffer>;
    /** Segment duration in ticks, from Info.Duration. */
    durationTicks: number;
    /** Track number of the video track (Cues are filtered to it). */
    trackNumber: number;
    /** Always true here; lets TrackIndex treat this uniformly. */
    webm: boolean;
}

export const WEBM_VIDEO_MIME_RE = /video\/webm/i;

const IDS = {
    ebml: "1a45dfa3",
    segment: "18538067",
    info: "1549a966",
    timecodeScale: "2ad7b1",
    duration: "4489",
    tracks: "1654ae6b",
    trackEntry: "ae",
    trackNumberEl: "d7",
    cues: "1c53bb6b",
    cuePoint: "bb",
    cueTime: "b3",
    cueTrackPositions: "b7",
    cueClusterPosition: "f1",
    cueTrack: "f7",
    cluster: "1f43b675",
    timecode: "e7",
} as const;

export class EbmlCursor {
    off: number;
    constructor(readonly data: Uint8Array, start = 0) {
        this.off = start;
    }

    /** Element id length from the leading marker bits (1-4 bytes raw, up to 8). */
    private idLen(off: number): number | null {
        if (off >= this.data.length) return null;
        const b = this.data[off];
        for (let i = 1; i <= 8; i++) {
            if (b & (0x80 >> (i - 1))) return i;
        }
        return null;
    }

    /** An element id (marker bits preserved in the hex form). */
    id(off: number): { hex: string; length: number } | null {
        const len = this.idLen(off);
        if (!len) return null;
        let hex = "";
        for (let i = 0; i < len; i++) {
            hex += this.data[off + i].toString(16).padStart(2, "0");
        }
        return { hex, length: len };
    }

    /**
     * A size VINT: marker bit stripped; `unknown` when all value bits are set.
     * Plain arithmetic, not bitwise ops: sizes run to 8 bytes (56 bits), past
     * JS's 32-bit shifts (`1 << 56` is `1 << 24`).
     */
    size(
        off: number,
    ): { value: number; length: number; unknown: boolean } | null {
        const len = this.idLen(off);
        if (!len || off + len > this.data.length) return null;
        let value = this.data[off] & (0xff >> len);
        let allOnes = value === 0xff >> len;
        for (let i = 1; i < len; i++) {
            const b = this.data[off + i];
            value = value * 256 + b;
            if (b !== 0xff) allOnes = false;
        }
        return { value, length: len, unknown: allOnes };
    }

    /**
     * The element at `off`. An unknown-size element (a streamed Segment or
     * Cluster) is null unless `allowUnknown`, which reports it with
     * `unknown: true` and a size running to the end of the data.
     */
    element(
        off: number,
        allowUnknown = false,
    ): { id: string; size: number; body: number; unknown: boolean } | null {
        const id = this.id(off);
        if (!id) return null;
        const size = this.size(off + id.length);
        if (!size) return null;
        const body = off + id.length + size.length;
        if (size.unknown) {
            if (!allowUnknown) return null;
            return {
                id: id.hex,
                size: Math.max(0, this.data.length - body),
                body,
                unknown: true,
            };
        }
        return { id: id.hex, size: size.value, body, unknown: false };
    }

    uint(off: number, end: number): number {
        let value = 0;
        for (let i = off; i < end; i++) value = value * 256 + this.data[i];
        return value;
    }

    float(off: number, end: number): number {
        const len = end - off;
        const view = new DataView(
            this.data.buffer,
            this.data.byteOffset + off,
            len,
        );
        return len === 4
            ? view.getFloat32(0)
            : len === 8
            ? view.getFloat64(0)
            : 0;
    }
}

/** Walk the direct children of [start, end), calling `fn` for each. */
function children(
    c: EbmlCursor,
    start: number,
    end: number,
    fn: (el: { id: string; size: number; body: number }) => void,
) {
    let p = start;
    while (p < end) {
        const el = c.element(p);
        if (!el || el.body + el.size > end) break; // truncated — stop
        fn(el);
        p = el.body + el.size;
    }
}

/**
 * Parse the init portion of a WebM stream (everything before the first
 * Cluster: EBML header, then the Segment's SeekHead, Info, Tracks, Cues) and
 * extract what a DASH manifest needs: timescale, per-cluster starts and
 * durations, per-cluster byte sizes, and the video track number.
 *
 * The Cues are a child of the Segment, not a top-level element: the walk
 * skips the EBML header (`body + size`), then walks the Segment's children.
 * The Segment's size may be unknown (streamed); its children then run to the
 * end of `init`.
 *
 * Returns null when the structure is not as expected (no Segment, no Cues).
 */
export function parseWebmInit(
    init: Uint8Array<ArrayBuffer>,
): WebmTrackIndex | null {
    const c = new EbmlCursor(init);
    const header = c.element(0);
    if (!header || header.id !== IDS.ebml) return null;
    const seg = c.element(header.body + header.size, true);
    if (!seg || seg.id !== IDS.segment) return null;

    let timescale = 1_000_000; // WebM default TimecodeScale: 1 ms ticks
    let durationTicks = 0;
    let trackNumber = 0;
    const cues: { time: number; offset: number; track: number }[] = [];
    const segEnd = Math.min(init.length, seg.body + seg.size);

    children(c, seg.body, segEnd, (el) => {
        if (el.id === IDS.info) {
            children(c, el.body, el.body + el.size, (sub) => {
                if (sub.id === IDS.timecodeScale) {
                    timescale = c.uint(sub.body, sub.body + sub.size);
                } else if (sub.id === IDS.duration) {
                    durationTicks = c.float(sub.body, sub.body + sub.size);
                }
            });
        } else if (el.id === IDS.tracks) {
            children(c, el.body, el.body + el.size, (entry) => {
                if (entry.id !== IDS.trackEntry || trackNumber) return;
                children(c, entry.body, entry.body + entry.size, (sub) => {
                    if (sub.id === IDS.trackNumberEl) {
                        trackNumber = c.uint(sub.body, sub.body + sub.size);
                    }
                });
            });
        } else if (el.id === IDS.cues) {
            children(c, el.body, el.body + el.size, (point) => {
                if (point.id !== IDS.cuePoint) return;
                let time: number | undefined;
                let offset: number | undefined;
                let track = 0;
                children(c, point.body, point.body + point.size, (sub) => {
                    if (sub.id === IDS.cueTime) {
                        time = c.uint(sub.body, sub.body + sub.size);
                    } else if (
                        sub.id === IDS.cueTrackPositions && offset === undefined
                    ) {
                        children(c, sub.body, sub.body + sub.size, (pos) => {
                            if (pos.id === IDS.cueClusterPosition) {
                                offset = c.uint(pos.body, pos.body + pos.size);
                            } else if (pos.id === IDS.cueTrack) {
                                track = c.uint(pos.body, pos.body + pos.size);
                            }
                        });
                    }
                });
                if (time !== undefined && offset !== undefined) {
                    cues.push({ time, offset, track });
                }
            });
        }
    });

    const own = cues.filter((q) =>
        !trackNumber || !q.track || q.track === trackNumber
    );
    return finalize(
        timescale,
        durationTicks,
        trackNumber,
        own,
        seg.unknown ? null : seg.size,
        init,
    );
}

function finalize(
    timescale: number,
    durationTicks: number,
    trackNumber: number,
    cues: { time: number; offset: number }[],
    segmentSize: number | null,
    init: Uint8Array<ArrayBuffer>,
): WebmTrackIndex | null {
    if (cues.length === 0 || timescale <= 0) return null;
    // DASH wants ticks per second; one raw tick is `timescale` ns. For the
    // usual 1e6 (ms) this is exact, so starts/durations stay integral.
    const tps = Math.round(1e9 / timescale);
    const rawEnd = durationTicks > cues[cues.length - 1].time
        ? Math.round(durationTicks)
        : cues[cues.length - 1].time + 1;
    // Starts are the cue times themselves (they match each Cluster's
    // Timecode, which the cut path numbers clusters by).
    const starts = cues.map((q) => q.time);
    const durations = cues.map((q, i) =>
        Math.max(1, (i + 1 < cues.length ? cues[i + 1].time : rawEnd) - q.time)
    );
    // CueClusterPosition is relative to the Segment's body, so sizes are
    // consecutive differences. The last cluster runs to the Segment's end
    // when its size is known; otherwise estimate it from the previous one.
    const sizes = cues.map((q, i) => {
        if (i + 1 < cues.length) {
            return Math.max(0, cues[i + 1].offset - q.offset);
        }
        if (segmentSize !== null && segmentSize > q.offset) {
            return segmentSize - q.offset;
        }
        return i > 0 ? cues[i].offset - cues[i - 1].offset : 0;
    });
    return {
        timescale: tps,
        durations,
        sizes,
        init,
        starts,
        trackNumber,
        durationTicks,
        webm: true,
    };
}

/** The Timecode of a Cluster element appearing in a SABR VP9 stream. */
export function clusterTimecode(cluster: Uint8Array): number | undefined {
    const c = new EbmlCursor(cluster);
    const el = c.element(0);
    if (!el) return undefined;
    let p = el.body;
    const end = Math.min(cluster.length, el.body + el.size);
    while (p < end) {
        const sub = c.element(p);
        if (!sub) break;
        if (sub.id === IDS.timecode) {
            return c.uint(sub.body, sub.body + sub.size);
        }
        p = sub.body + sub.size;
    }
    return undefined;
}

/**
 * Offset of the first Cluster element among the top-level children of the
 * Segment — i.e. the length of the init portion (header + SeekHead + Info +
 * Tracks + Cues). Null while the data doesn't (yet) contain one.
 */
export function findFirstClusterOffset(data: Uint8Array): number | null {
    const c = new EbmlCursor(data);
    let off = 0;
    for (;;) {
        const el = c.element(off, true);
        if (!el) return null;
        if (el.id === IDS.ebml) {
            off = el.body + el.size;
            continue;
        }
        if (el.id === IDS.segment) {
            // Segment size may be `unknown` (all marker bits set) — then its
            // children run to the end of the data we have.
            const segEnd = el.body + el.size > data.length
                ? data.length
                : el.body + el.size;
            let p = el.body;
            while (p < segEnd) {
                // Only the id is needed to spot a Cluster (whose size may be
                // unknown, or whose body hasn't fully arrived yet).
                if (c.id(p)?.hex === IDS.cluster) return p;
                const child = c.element(p);
                if (!child) return null;
                p = child.body + child.size;
            }
            return null;
        }
        off = el.body + el.size;
    }
}
