/**
 * The SABR VOD video ladder: which format each advertised height is.
 *
 * The manifest puts every rendition in **one** AdaptationSet on the seed's
 * timeline (see `buildMpdTemplate` in routes/sabrRoutes.ts), and the segments
 * for a height are pulled with `pullSabrTrack({ height })`. Both must mean the
 * same format, and the ladder must be a single codec:
 *
 * - Players cannot switch codecs inside an adaptive selection. Media3 splits a
 *   mixed set into one group per codec and, on a device with a hardware AV1
 *   decoder, prefers a lone AV1 rung over the whole H.264 ladder, playing it
 *   as a fixed track that never switches. An Amlogic Android TV stuck at 144p
 *   for whole videos was exactly that.
 * - The shared timeline is only verified across one encode family.
 *
 * Before this, the manifest kept the highest-bitrate MP4 format per height
 * across codecs (at 144p that is often AV1 itag 394 over H.264 itag 160) while
 * the pull took the first format of that height, usually the H.264 one: the
 * MPD said `av01.0.00M.08` for segments that were `avc1.4D400C`.
 *
 * So: H.264 when the video has any (YouTube lists it for practically every
 * VOD), else the codec family that covers the most heights; within it the
 * highest-bitrate format per height; and segments are pulled by that itag.
 */

export interface SabrVideoRendition {
    height: number;
    width?: number;
    itag: number;
    bitrate: number;
    mimeType: string;
}

// deno-lint-ignore no-explicit-any
type Format = any;

const isMp4 = (f: Format) => (f?.mimeType ?? "").includes("mp4");
const isVideo = (f: Format) => Boolean(f?.width) && isMp4(f);

/** `avc1`, `av01`, `vp09`, … from `video/mp4; codecs="avc1.4d401e"`. */
export function videoCodecFamily(mimeType?: string): string {
    return /codecs="?\s*([a-z0-9]+)/i.exec(mimeType ?? "")?.[1]
        ?.toLowerCase() ?? "";
}

/** The codec family the ladder is built from; see the module comment. */
export function ladderCodecFamily(formats: Format[]): string {
    const heights = new Map<string, Set<number>>();
    for (const f of formats.filter(isVideo)) {
        const family = videoCodecFamily(f.mimeType);
        if (!heights.has(family)) heights.set(family, new Set());
        heights.get(family)!.add(f.height);
    }
    if (heights.has("avc1")) return "avc1";
    let best = "";
    let bestCount = -1;
    for (const [family, hs] of heights) {
        if (hs.size > bestCount) {
            best = family;
            bestCount = hs.size;
        }
    }
    return best;
}

/** One rendition per height, single codec family, sorted by height. */
export function videoLadder(formats: Format[]): SabrVideoRendition[] {
    const family = ladderCodecFamily(formats);
    const byHeight = new Map<number, SabrVideoRendition>();
    for (const f of formats.filter(isVideo)) {
        if (videoCodecFamily(f.mimeType) !== family) continue;
        // Keep the highest-bitrate format per height (there can be several).
        const existing = byHeight.get(f.height);
        if (existing && existing.bitrate >= Number(f.bitrate ?? 0)) continue;
        byHeight.set(f.height, {
            height: f.height,
            width: f.width,
            itag: f.itag,
            bitrate: Number(f.bitrate ?? 0),
            mimeType: f.mimeType ?? "",
        });
    }
    return [...byHeight.values()].sort((a, b) => a.height - b.height);
}

/**
 * The format to pull for `height`: the one the manifest advertises for it.
 * Falls back to the same codec family at that height (a reloaded player
 * response may renumber nothing, but be safe), then to any format of that
 * height, then to the first video format.
 */
export function videoFormatForHeight(
    formats: Format[],
    ladder: SabrVideoRendition[],
    height: number,
): Format | undefined {
    const video = formats.filter(isVideo);
    const rendition = ladder.find((r) => r.height === height);
    if (rendition) {
        const exact = video.find((f) => f.itag === rendition.itag);
        if (exact) return exact;
        const family = videoCodecFamily(rendition.mimeType);
        const sameFamily = video.find((f) =>
            f.height === height && videoCodecFamily(f.mimeType) === family
        );
        if (sameFamily) return sameFamily;
    }
    return video.find((f) => f.height === height) ?? video[0];
}
