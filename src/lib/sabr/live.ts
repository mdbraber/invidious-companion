/**
 * Live and post-live DVR, served by proxying YouTube's own dynamic manifest.
 *
 * This deliberately does not use SABR. A live broadcast is manifest-driven
 * per-segment fetching, not an adaptive-bitrate stream: kira and FreeTube both
 * play live through `SabrStreamingAdapter`, which for a broadcast skips the ABR
 * request loop entirely and fetches the segment URLs the manifest gives it.
 * `SabrStream`, the headless downloader this connector uses for VOD, has no
 * equivalent path — an attempt to add one got media flowing at the protocol
 * level but never into an output stream.
 *
 * YouTube publishes exactly what a player needs: a `type="dynamic"` manifest
 * with a `SegmentList` per representation. The only problem is that its
 * `BaseURL`s are absolute googlevideo addresses, IP-locked to this server, so a
 * client cannot fetch them. Rewriting each `BaseURL` to a local path — and
 * keeping the relative `<SegmentURL media="sq/…"/>` entries untouched, since
 * they resolve against it — turns it into a manifest our clients can play.
 */
const MANIFEST_TTL_MS = Number(Deno.env.get("SABR_LIVE_MANIFEST_TTL_MS") || 20_000);

export interface LiveManifest {
    /** Manifest XML with BaseURLs rewritten to local paths. */
    xml: string;
    /** The real googlevideo BaseURL per representation index. */
    baseUrls: string[];
    at: number;
}

const cache = new Map<string, Promise<LiveManifest>>();

/**
 * Rewrite every `<BaseURL>` to `<prefix><index>/`, returning the originals.
 *
 * Each BaseURL ends in `/` and each `<SegmentURL media="sq/N/lmt/M"/>` is a
 * relative path beneath it, so a path-style replacement keeps DASH's own
 * resolution working. A query-style URL would not: relative resolution would
 * discard the query.
 */
export function rewriteBaseUrls(
    xml: string,
    prefix: string,
): { xml: string; baseUrls: string[] } {
    const baseUrls: string[] = [];
    const out = xml.replace(
        /<BaseURL>([^<]*)<\/BaseURL>/g,
        (_match, url: string) => {
            const index = baseUrls.length;
            baseUrls.push(url);
            return `<BaseURL>${prefix}${index}/</BaseURL>`;
        },
    );
    return { xml: out, baseUrls };
}

async function load(
    videoId: string,
    dashManifestUrl: string,
    prefix: string,
): Promise<LiveManifest> {
    const res = await fetch(dashManifestUrl);
    if (!res.ok) {
        throw new Error(
            `${videoId}: native DASH manifest returned HTTP ${res.status}`,
        );
    }
    const raw = await res.text();
    const { xml, baseUrls } = rewriteBaseUrls(raw, prefix);
    if (!baseUrls.length) {
        throw new Error(`${videoId}: native manifest carries no BaseURL`);
    }
    return { xml, baseUrls, at: Date.now() };
}

/**
 * The rewritten manifest, refreshed periodically.
 *
 * A live manifest moves: its segment list advances and its URLs carry an
 * expiry, so it is re-fetched rather than held.
 */
export function getLiveManifest(
    videoId: string,
    dashManifestUrl: string,
    prefix: string,
): Promise<LiveManifest> {
    const refresh = () => {
        const p = load(videoId, dashManifestUrl, prefix).catch((e) => {
            cache.delete(videoId);
            throw e;
        });
        cache.set(videoId, p);
        return p;
    };

    const existing = cache.get(videoId);
    if (!existing) return refresh();
    return existing
        .then((m) => (Date.now() - m.at < MANIFEST_TTL_MS ? m : refresh()))
        .catch(() => refresh());
}

/** The stored BaseURL for a representation, if the manifest is still held. */
export async function liveBaseUrl(
    videoId: string,
    index: number,
): Promise<string | undefined> {
    const entry = cache.get(videoId);
    if (!entry) return undefined;
    try {
        return (await entry).baseUrls[index];
    } catch {
        return undefined;
    }
}
