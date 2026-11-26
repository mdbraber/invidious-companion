/**
 * Fresh stream URLs for revoked ones.
 *
 * YouTube revokes a byte-range stream URL after roughly a minute of fetched
 * media: every later range on it answers 403, hours before its `expire`. A
 * player on byte-range HLS or progressive MP4 (OwnTube's fallback when SABR
 * fails, and every Invidious player) then stops at about one minute. Here,
 * when `/videoplayback` gets that 403, it asks for a fresh player response for
 * the same video, takes the same format (itag, plus `xtags` for the audio
 * track), and retries the request on the new URL. Later requests that still
 * carry the revoked URL are sent to the replacement directly.
 *
 * A stream URL does not name its video (its `id=` is an opaque token), so every
 * player response this companion hands out is remembered here: stream `id` →
 * videoId (`rememberStreamUrls`, from `youtubePlayerParsing`).
 *
 * A refresh costs one player request, so they are bounded: one at a time per
 * format, at most one per format every REFRESH_MIN_INTERVAL_MS, and at most
 * MAX_REFRESHES_PER_VIDEO_PER_HOUR per video.
 */

const STREAM_ID_TTL_MS = 6 * 3600_000;
const MAX_STREAM_IDS = 20_000;
const REPLACEMENT_TTL_MS = 6 * 3600_000;
export const REFRESH_MIN_INTERVAL_MS = 20_000;
export const MAX_REFRESHES_PER_VIDEO_PER_HOUR = 90;

type Format = { itag?: number; url?: string };
type PlayerData = {
    streamingData?: { formats?: Format[]; adaptiveFormats?: Format[] };
};

const streamIds = new Map<string, { videoId: string; at: number }>();
const replacements = new Map<string, { url: string; at: number }>();
const inFlight = new Map<string, Promise<string | null>>();
const lastRefreshAt = new Map<string, number>();
const refreshLog = new Map<string, number[]>(); // videoId -> refresh times

function streamIdOf(url: string): string | null {
    try {
        return new URL(url).searchParams.get("id");
    } catch {
        return null;
    }
}

function prune(now: number): void {
    if (streamIds.size > MAX_STREAM_IDS) {
        for (const [id, v] of streamIds) {
            if (
                now - v.at > STREAM_ID_TTL_MS || streamIds.size > MAX_STREAM_IDS
            ) {
                streamIds.delete(id);
            }
        }
    }
    for (const [k, v] of replacements) {
        if (now - v.at > REPLACEMENT_TTL_MS) replacements.delete(k);
    }
}

/** Remember which video each stream URL in a player response belongs to. */
export function rememberStreamUrls(
    videoId: string,
    data: unknown,
    now = Date.now(),
): void {
    const sd = (data as PlayerData)?.streamingData;
    if (!sd) return;
    for (const f of [...(sd.formats ?? []), ...(sd.adaptiveFormats ?? [])]) {
        if (!f?.url) continue;
        const id = streamIdOf(f.url);
        if (id) streamIds.set(id, { videoId, at: now });
    }
    prune(now);
}

/** The video a stream URL's `id=` belongs to, if this companion served it. */
export function videoIdForStream(
    streamId: string | null,
    now = Date.now(),
): string | undefined {
    if (!streamId) return undefined;
    const hit = streamIds.get(streamId);
    if (!hit || now - hit.at > STREAM_ID_TTL_MS) return undefined;
    return hit.videoId;
}

function formatKey(streamId: string, itag: string, xtags: string): string {
    return `${streamId}|${itag}|${xtags}`;
}

/** The replacement URL for a revoked stream URL's format, if one is known. */
export function replacementFor(
    streamId: string | null,
    itag: string | null,
    xtags: string | null,
    now = Date.now(),
): string | undefined {
    if (!streamId || !itag) return undefined;
    const hit = replacements.get(formatKey(streamId, itag, xtags ?? ""));
    if (!hit || now - hit.at > REPLACEMENT_TTL_MS) return undefined;
    return hit.url;
}

/** The URL in `data` for the same format: same itag, same xtags if possible. */
export function pickSameFormat(
    data: unknown,
    itag: string,
    xtags: string | null,
): string | undefined {
    const sd = (data as PlayerData)?.streamingData;
    if (!sd) return undefined;
    const candidates = [...(sd.adaptiveFormats ?? []), ...(sd.formats ?? [])]
        .filter((f) => f?.url && String(f.itag) === itag);
    const xtagsOf = (url: string) => {
        try {
            return new URL(url).searchParams.get("xtags") ?? "";
        } catch {
            return "";
        }
    };
    return (
        candidates.find((f) => xtagsOf(f.url!) === (xtags ?? "")) ??
            candidates[0]
    )?.url;
}

/**
 * A fresh URL for a revoked stream URL's format, or null when the video is
 * unknown, the refresh budget is spent, or the fresh response lacks the
 * format. `fetchPlayer` fetches a fresh player response for the video.
 */
export function refreshStreamUrl(
    {
        streamId,
        itag,
        xtags,
        fetchPlayer,
    }: {
        streamId: string | null;
        itag: string | null;
        xtags: string | null;
        fetchPlayer: (videoId: string) => Promise<unknown>;
    },
    now = Date.now(),
): Promise<string | null> {
    const videoId = videoIdForStream(streamId, now);
    if (!videoId || !streamId || !itag) return Promise.resolve(null);
    const key = formatKey(streamId, itag, xtags ?? "");
    const running = inFlight.get(key);
    if (running) return running;

    const last = lastRefreshAt.get(key) ?? 0;
    if (now - last < REFRESH_MIN_INTERVAL_MS) {
        // Refreshed a moment ago: the replacement (if any) is the answer.
        return Promise.resolve(
            replacementFor(streamId, itag, xtags, now) ?? null,
        );
    }
    const recent = (refreshLog.get(videoId) ?? []).filter((t) =>
        now - t < 3600_000
    );
    if (recent.length >= MAX_REFRESHES_PER_VIDEO_PER_HOUR) {
        console.log(
            `[WARN] [videoplayback] ${videoId}: refresh budget spent (${recent.length}/h); passing the 403 on`,
        );
        return Promise.resolve(null);
    }
    recent.push(now);
    refreshLog.set(videoId, recent);
    lastRefreshAt.set(key, now);

    const task = (async () => {
        try {
            const data = await fetchPlayer(videoId);
            const url = pickSameFormat(data, itag, xtags);
            if (!url) {
                console.log(
                    `[WARN] [videoplayback] ${videoId}: fresh player response has no itag ${itag}`,
                );
                return null;
            }
            replacements.set(key, { url, at: Date.now() });
            // The fresh URL may be revoked in turn; map it to its video too.
            const freshId = streamIdOf(url);
            if (freshId) streamIds.set(freshId, { videoId, at: Date.now() });
            console.log(
                `[INFO] [videoplayback] ${videoId}: stream URL for itag ${itag} revoked; using a fresh one`,
            );
            return url;
        } catch (err) {
            console.log(
                `[WARN] [videoplayback] ${videoId}: refreshing the stream URL failed`,
                { err },
            );
            return null;
        } finally {
            inFlight.delete(key);
        }
    })();
    inFlight.set(key, task);
    return task;
}

/** Forget everything (tests). */
export function clearStreamUrlRefresh(): void {
    streamIds.clear();
    replacements.clear();
    inFlight.clear();
    lastRefreshAt.clear();
    refreshLog.clear();
}
