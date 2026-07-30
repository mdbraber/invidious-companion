/**
 * SABR→DASH connector routes.
 *
 * Serves ordinary DASH by pulling YouTube's SABR protocol server-side and
 * cutting the fMP4 stream on `moof` boundaries. Segmentation only: no
 * re-muxing, no transcode.
 *
 *   GET /sabr/:videoId/manifest.mpd[?audio=de,fr][?check=]
 *   GET /sabr/:videoId/:track/:file[?check=]
 *   GET /sabr/:videoId/download[?itag=][?check=]
 *
 * **Nothing is cached.** Manifests are built from the `sidx` index carried in
 * each track's init segment, and segments come from short-lived readers
 * positioned in a live SABR stream. Random access costs 39–88ms, so storing
 * whole videos to avoid it was never a good trade — and it turned the cache
 * directory into a watch history with the content attached. A consequence
 * worth having: abandoning playback stops the download, instead of quietly
 * fetching the rest of the video.
 *
 * Live and post-live DVR are **delegated** to the companion's existing
 * `/api/manifest/dash/id` route. Note this is a pragmatic choice, not a
 * protocol limit: SABR does carry live, and yt-dlp implements it (~180
 * references to broadcast handling — head tracking, end detection, deep
 * rewind, seekable-range and target-duration logic). What we lack is that
 * subsystem in `SabrStream`, the headless downloader here, which has none of
 * it and simply stalls. Meanwhile YouTube publishes a native dynamic DASH
 * manifest for live, and the companion route already serves it including the
 * fresh-token handling post-live DVR needs — so reimplementing it would be a
 * lot of work to arrive back where we already are.
 *
 * Delegation triggers on either signal: the player response says live, or the
 * track has no `sidx`. The second matters because a post-live recording that
 * *does* carry an index is served here as ordinary VOD, rather than being
 * excluded by its label.
 *
 * When `server.verify_requests` is on, every route requires the same
 * AES-encrypted `check` parameter the other companion routes use, and the
 * manifest embeds it in the URLs it hands the player.
 */
import { type Context, Hono } from "hono";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";
import { HTTPException } from "hono/http-exception";
import { verifyRequest } from "../lib/helpers/verifyRequest.ts";
import { validateVideoId } from "../lib/helpers/validateVideoId.ts";
import {
    openSabrSession,
    type SabrPullSelection,
    type SabrSession,
} from "../lib/sabr/session.ts";
import {
    fetchTrackIndex,
    ReaderPool,
    type TrackIndex,
} from "../lib/sabr/reader.ts";

/** Height indexed up front; other renditions are indexed on first request. */
const SEED_HEIGHT = Number(Deno.env.get("SABR_SEED_HEIGHT") || 360);
const MAX_HEIGHT = Number(Deno.env.get("SABR_MAX_HEIGHT") || 1080);
const SEGMENT_WAIT_MS = Number(Deno.env.get("SABR_SEGMENT_WAIT_MS") || 30_000);
/** How long a player response is reused. The streaming URL is valid ~6h. */
const SESSION_TTL_MS = Number(
    Deno.env.get("SABR_SESSION_TTL_MS") || 4 * 3600_000,
);

interface TrackInfo {
    name: string;
    sel: SabrPullSelection;
    index: TrackIndex;
    mimeType: string;
    codecs: string;
    width?: number;
    height?: number;
    bandwidth: number;
    lang?: string;
    label?: string;
    isVideo: boolean;
}

interface Prepared {
    session: SabrSession;
    at: number;
    /** Indexed tracks. An index is kilobytes; no media is held. */
    tracks: Map<string, TrackInfo>;
    seed?: TrackInfo;
    pending: Map<string, Promise<TrackInfo>>;
    /** Serve this video from the native DASH route instead. */
    delegate?: boolean;
}

/** Player responses and track indexes only — no media. */
const sessions = new Map<string, Promise<Prepared>>();
const readers = new ReaderPool();

const parseCodec = (mime?: string) => ({
    base: (mime ?? "").split(";")[0],
    codecs: /codecs="?([^"]+)"?/.exec(mime ?? "")?.[1] ?? "",
});

const videoTrackName = (height: number) => `v${height}`;
const audioTrackName = (trackId: string) =>
    `a-${trackId.replace(/[^\w.-]/g, "_")}`;

/**
 * `SegmentTimeline`, not a fixed `duration`: SABR's fragments are not uniform
 * (measured 3.4s–7.0s), so a single duration desynchronises playback.
 */
function timelineXml(index: TrackIndex) {
    const runs: { d: number; r: number }[] = [];
    for (const d of index.durations) {
        const last = runs[runs.length - 1];
        if (last && last.d === d) last.r++;
        else runs.push({ d, r: 0 });
    }
    return runs.map((x) =>
        `          <S d="${x.d}"${x.r ? ` r="${x.r}"` : ""}/>`
    ).join("\n");
}

function adaptationSet(opts: {
    mimeType: string;
    lang?: string;
    label?: string;
    timescale: number;
    timeline: string;
    representations: string;
}) {
    const langAttr = opts.lang ? ` lang="${opts.lang}"` : "";
    const labelXml = opts.label ? `\n      <Label>${opts.label}</Label>` : "";
    return `    <AdaptationSet mimeType="${opts.mimeType}"${langAttr} segmentAlignment="true" startWithSAP="1">${labelXml}
      <SegmentTemplate timescale="${opts.timescale}" startNumber="1"
                       initialization="$RepresentationID$/init.mp4%CHECK%" media="$RepresentationID$/seg-$Number$.m4s%CHECK%">
        <SegmentTimeline>
${opts.timeline}
        </SegmentTimeline>
      </SegmentTemplate>
${opts.representations}
    </AdaptationSet>`;
}

function buildMpdTemplate(p: Prepared, audioTracks: TrackInfo[]): string {
    const { session } = p;
    const seed = p.seed!;
    const sets: string[] = [];

    // One video AdaptationSet holding the whole ladder, every rendition sharing
    // the seed's timeline: fragment boundaries are identical across heights
    // (verified — 288 fragments, 0.0000s drift between 144p and 720p) because
    // they are cut from the same source encode. So only the seed needs
    // indexing, and a mid-playback bitrate switch is just a request for a
    // different Representation — no extra pull, nothing retained.
    {
        const reps = session.videoRenditions
            .filter((r) => r.height <= MAX_HEIGHT)
            .map((r) => {
                const c = parseCodec(r.mimeType);
                return `      <Representation id="${
                    videoTrackName(r.height)
                }" codecs="${c.codecs}" width="${r.width}" height="${r.height}" bandwidth="${r.bitrate}"/>`;
            }).join("\n");
        sets.push(adaptationSet({
            mimeType: seed.mimeType,
            timescale: seed.index.timescale,
            timeline: timelineXml(seed.index),
            representations: reps,
        }));
    }

    for (const t of audioTracks) {
        sets.push(adaptationSet({
            mimeType: t.mimeType,
            lang: t.lang,
            label: t.label,
            timescale: t.index.timescale,
            timeline: timelineXml(t.index),
            representations:
                `      <Representation id="${t.name}" codecs="${t.codecs}" audioSamplingRate="${t.index.timescale}" bandwidth="${t.bandwidth}"/>`,
        }));
    }

    // Captions: advertised here, served by the companion's existing
    // /api/v1/captions route, which already works around Google's IP block on
    // the timedtext base_url.
    for (const cap of session.captions) {
        sets.push(
            `    <AdaptationSet contentType="text" mimeType="text/vtt" lang="${cap.languageCode}">
      <Label>${cap.label.replace(/[<>&]/g, "")}</Label>
      <Representation id="cap-${cap.languageCode}" bandwidth="0">
        <BaseURL>../../api/v1/captions/${session.videoId}?lang=${
                encodeURIComponent(cap.languageCode)
            }%CHECKAMP%</BaseURL>
      </Representation>
    </AdaptationSet>`,
        );
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011"
     type="static" mediaPresentationDuration="PT${session.durationSec}S" minBufferTime="PT4S">
  <Period>
${sets.join("\n")}
  </Period>
</MPD>
`;
}

async function indexTrack(
    session: SabrSession,
    name: string,
    sel: SabrPullSelection,
    isVideo: boolean,
): Promise<TrackInfo> {
    const { index, format } = await fetchTrackIndex(session, sel);
    // deno-lint-ignore no-explicit-any
    const f = format as any;
    const c = parseCodec(f.mimeType);
    return {
        name,
        sel,
        index,
        mimeType: c.base,
        codecs: c.codecs,
        width: f.width,
        height: f.height,
        bandwidth: Number(f.bitrate ?? 0),
        isVideo,
    };
}

async function prepare(
    videoId: string,
    wantAudio: string[],
): Promise<Prepared> {
    // A specific audio track was asked for, so the session must be able to
    // offer more than the original — worth the WEB+pot latency. Otherwise
    // ANDROID_VR, which is ~60x faster to index and seek.
    const session = await openSabrSession(videoId, wantAudio.length > 0);
    const log = (m: string) => console.log(`[INFO] [sabr] [${videoId}] ${m}`);

    if (session.isLive) {
        log("live/post-live — delegating to /api/manifest/dash/id");
        return {
            session,
            at: Date.now(),
            tracks: new Map(),
            pending: new Map(),
            delegate: true,
        };
    }

    log(
        `"${session.title}" ${session.durationSec}s — mode=${session.mode}, ${session.videoRenditions.length} rendition(s), ${session.audioTracks.length} audio track(s)`,
    );

    const seedHeight = session.videoRenditions.some((r) =>
            r.height === SEED_HEIGHT
        )
        ? SEED_HEIGHT
        : session.videoRenditions[0]?.height;

    const chosen = wantAudio.length
        ? session.audioTracks.filter((a) =>
            wantAudio.some((l) => a.trackId === l || a.language === l)
        )
        : [];
    const audioList = chosen.length ? chosen : session.audioTracks.slice(0, 1);

    const t0 = Date.now();
    let seed: TrackInfo;
    let audioTracks: TrackInfo[];
    try {
        [seed, audioTracks] = await Promise.all([
            indexTrack(session, videoTrackName(seedHeight), {
                height: seedHeight,
            }, true),
            Promise.all(audioList.map(async (a) => {
                const t = await indexTrack(
                    session,
                    audioTrackName(a.trackId),
                    { height: null, audioTrackId: a.trackId },
                    false,
                );
                t.lang = a.language;
                t.label = a.label;
                return t;
            })),
        ]);
    } catch (err) {
        // No index means nothing to build a static timeline from — a live
        // recording the player response did not label as such, most likely.
        log(
            `no segment index (${
                (err as Error).message
            }) — delegating to /api/manifest/dash/id`,
        );
        return {
            session,
            at: Date.now(),
            tracks: new Map(),
            pending: new Map(),
            delegate: true,
        };
    }

    const tracks = new Map<string, TrackInfo>();
    tracks.set(seed.name, seed);
    for (const t of audioTracks) tracks.set(t.name, t);
    log(
        `indexed ${seedHeight}p (${seed.index.durations.length} segments) + audio [${
            audioList.map((a) => a.trackId).join(", ")
        }] in ${Date.now() - t0}ms`,
    );

    return { session, at: Date.now(), tracks, seed, pending: new Map() };
}

function getPrepared(videoId: string, audio: string[]): Promise<Prepared> {
    const key = `${videoId}|${audio.join(",")}`;

    const refresh = (): Promise<Prepared> => {
        const p = prepare(videoId, audio).catch((e) => {
            sessions.delete(key);
            throw e;
        });
        sessions.set(key, p);
        return p;
    };

    const existing = sessions.get(key);
    if (!existing) return refresh();
    // A stale player response hands out expired streaming URLs.
    return existing
        .then((p) => (Date.now() - p.at < SESSION_TTL_MS ? p : refresh()))
        .catch(() => refresh());
}

/** Index a rendition that was advertised but not yet indexed. */
function ensureTrack(
    p: Prepared,
    name: string,
): Promise<TrackInfo> | undefined {
    const existing = p.tracks.get(name);
    if (existing) return Promise.resolve(existing);
    const inFlight = p.pending.get(name);
    if (inFlight) return inFlight;

    const videoMatch = /^v(\d+)$/.exec(name);
    if (!videoMatch) return undefined;
    const height = Number(videoMatch[1]);
    if (!p.session.videoRenditions.some((r) => r.height === height)) {
        return undefined;
    }

    const promise = indexTrack(p.session, name, { height }, true)
        .then((t) => {
            p.tracks.set(name, t);
            p.pending.delete(name);
            return t;
        })
        .catch((err) => {
            p.pending.delete(name);
            throw err;
        });
    p.pending.set(name, promise);
    return promise;
}

const sabrRoutes = new Hono<{ Variables: HonoVariables }>();
type Ctx = Context<{ Variables: HonoVariables }>;

const guard = (c: Ctx): string => {
    const videoId = c.req.param("videoId");
    if (!validateVideoId(videoId)) {
        throw new HTTPException(400, {
            res: new Response("Invalid video ID format."),
        });
    }
    const config = c.get("config");
    if (config.server.verify_requests) {
        const { check } = c.req.query();
        if (check === undefined) {
            throw new HTTPException(400, { res: new Response("No check ID.") });
        }
        if (verifyRequest(check, videoId, config) === false) {
            throw new HTTPException(400, { res: new Response("ID incorrect.") });
        }
    }
    return videoId;
};

const checkSuffixes = (c: Ctx) => {
    const config = c.get("config");
    const check = c.req.query("check") ?? "";
    return config.server.verify_requests
        ? {
            q: `?check=${encodeURIComponent(check)}`,
            amp: `&amp;check=${encodeURIComponent(check)}`,
        }
        : { q: "", amp: "" };
};

sabrRoutes.get("/:videoId/manifest.mpd", async (c) => {
    const videoId = guard(c);
    const audio = (c.req.query("audio") ?? "").split(",").map((s) => s.trim())
        .filter(Boolean);

    const resolved = await getPrepared(videoId, audio);
    const { q, amp } = checkSuffixes(c);

    // Live / post-live DVR, or anything without an index: hand off to the
    // route that already does this well.
    if (resolved.delegate) {
        return c.redirect(`../../api/manifest/dash/id/${videoId}${q}`, 302);
    }

    const audioTracks = [...resolved.tracks.values()].filter((t) => !t.isVideo);
    c.header("content-type", "application/dash+xml");
    c.header("access-control-allow-origin", "*");
    return c.body(
        buildMpdTemplate(resolved, audioTracks)
            .replaceAll("%CHECKAMP%", amp)
            .replaceAll("%CHECK%", q),
    );
});

/**
 * A whole-file download, for clients that want one file rather than a manifest
 * — a podcast app fetching an RSS enclosure, for instance.
 *
 * Delegates to the companion's existing `/latest_version`, which serves a
 * muxed progressive file through the videoplayback proxy and already supports
 * Range requests and resumption. Muxing the separate SABR video and audio
 * tracks here would need a real muxer, for no benefit while muxed itag 18
 * exists. `itag=140` gives audio only, which is what a podcast feed wants.
 */
sabrRoutes.get("/:videoId/download", (c) => {
    const videoId = guard(c);
    const config = c.get("config");
    const itag = c.req.query("itag") ?? "18";
    if (!/^\d+$/.test(itag)) {
        throw new HTTPException(400, { res: new Response("Invalid itag.") });
    }
    const params = new URLSearchParams({ id: videoId, itag, local: "true" });
    const check = c.req.query("check");
    if (config.server.verify_requests && check) params.set("check", check);
    const title = c.req.query("title");
    if (title) params.set("title", title);
    return c.redirect(`../../latest_version?${params.toString()}`, 302);
});

sabrRoutes.get("/:videoId/:track/:file", async (c) => {
    const videoId = guard(c);
    const { track, file } = c.req.param();
    const isInit = file === "init.mp4";
    const segMatch = /^seg-(\d+)\.m4s$/.exec(file);
    if (!isInit && !segMatch) {
        throw new HTTPException(400, {
            res: new Response("Invalid segment name."),
        });
    }

    // The audio selection is not in this URL, so match any preparation of this
    // video — video renditions are identical across audio selections.
    let entry: Promise<Prepared> | undefined;
    for (const [k, v] of sessions) {
        if (k === videoId || k.startsWith(`${videoId}|`)) entry = v;
    }
    if (!entry) {
        throw new HTTPException(404, {
            res: new Response("Video not prepared. Request the manifest first."),
        });
    }

    const p = await entry;
    const trackPromise = ensureTrack(p, track);
    if (!trackPromise) {
        throw new HTTPException(404, { res: new Response("No such track.") });
    }
    const t = await trackPromise;

    c.header("access-control-allow-origin", "*");
    if (isInit) {
        c.header("content-type", "video/mp4");
        c.header("cache-control", "private, max-age=3600");
        return c.body(t.index.init);
    }

    const n = Number(segMatch![1]);
    if (n < 1 || n > t.index.durations.length) {
        throw new HTTPException(404, { res: new Response("No such segment.") });
    }
    const bytes = await readers.segment(
        `${videoId}|${track}`,
        p.session,
        t.sel,
        t.index,
        n,
        SEGMENT_WAIT_MS,
    );
    if (!bytes) {
        throw new HTTPException(503, {
            res: new Response("Segment not ready; retry."),
        });
    }
    c.header("content-type", "video/iso.segment");
    c.header("cache-control", "private, max-age=3600");
    return c.body(bytes);
});

export default sabrRoutes;
