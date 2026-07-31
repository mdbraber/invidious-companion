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
 *   GET /sabr/:videoId/watch                         dash.js page, for a browser
 *
 * **Nothing is cached.** Manifests are built from the `sidx` index carried in
 * each track's init segment, and segments come from short-lived readers
 * positioned in a live SABR stream. Random access costs 39–88ms, so storing
 * whole videos to avoid it was never a good trade — and it turned the cache
 * directory into a watch history with the content attached. A consequence
 * worth having: abandoning playback stops the download, instead of quietly
 * fetching the rest of the video.
 *
 * **Live and post-live DVR work**, but not through SABR. A broadcast is
 * manifest-driven per-segment fetching, not an adaptive-bitrate stream — kira
 * and FreeTube both play live through `SabrStreamingAdapter`, which skips the
 * ABR request loop entirely for it. So live proxies YouTube's own dynamic
 * manifest with its BaseURLs rewritten to point back here; see lib/sabr/live.ts.
 *
 * The live path triggers on either signal: the player response says live, or
 * the track has no `sidx`. The second matters because a post-live recording
 * that *does* carry an index is served here as ordinary VOD, rather than being
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
import { getLiveManifest, liveBaseUrl } from "../lib/sabr/live.ts";

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
        log(
            "live/post-live — redirecting to /api/manifest/dash/id (note: that route returns an empty manifest for live)",
        );
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

/**
 * A minimal player page, so the connector can be opened in a browser rather
 * than only exercised by tooling. dash.js is loaded from a CDN — this is a
 * spike aid, not something to ship.
 *
 * Shows what the manifest actually offers (quality rungs, audio tracks,
 * subtitles) and lets each be switched, because those are the parts that
 * command-line checks cannot really prove.
 */
sabrRoutes.get("/:videoId/watch", (c) => {
    const videoId = guard(c);
    const { q } = checkSuffixes(c);
    const audio = c.req.query("audio");
    // Sibling of this route: /sabr/<id>/watch -> /sabr/<id>/manifest.mpd
    const manifest = `manifest.mpd${
        audio
            ? (q ? `${q}&audio=${encodeURIComponent(audio)}` : `?audio=${encodeURIComponent(audio)}`)
            : q
    }`;

    c.header("content-type", "text/html; charset=utf-8");
    return c.body(`<!doctype html>
<html><head><meta charset="utf-8"><title>SABR&rarr;DASH ${videoId}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,">
<script src="https://cdn.dashjs.org/latest/dash.all.min.js"></script>
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:1rem;background:#111;color:#eee}
  video{width:100%;max-width:1280px;background:#000;aspect-ratio:16/9}
  .row{margin:.75rem 0;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
  select,button{font:inherit;padding:.3rem .5rem;background:#222;color:#eee;border:1px solid #444;border-radius:4px}
  code{background:#222;padding:.1rem .35rem;border-radius:3px}
  #log{white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px;color:#9b9;max-height:9rem;overflow:auto}
</style></head>
<body>
<h2 style="margin:0 0 .5rem">SABR&rarr;DASH &mdash; <code>${videoId}</code></h2>
<video id="v" controls autoplay muted playsinline></video>
<div class="row">
  <label>quality <select id="q"><option value="-1">auto</option></select></label>
  <label>audio <select id="a"></select></label>
  <label>subtitles <select id="t"><option value="-1">off</option></select></label>
  <button id="live">jump to live edge</button>
</div>
<div class="row" id="stat"></div>
<div id="log"></div>
<script>
  // One element per line, rather than appending a newline escape. This script
  // is emitted through a template literal, where "\\n" is one escaping layer
  // too many and collapses into a real newline — which lands mid-string and
  // leaves the whole script unterminated.
  var log = function (m) {
    var d = document.createElement('div');
    d.textContent = m;
    document.getElementById('log').appendChild(d);
  };
  var player = dashjs.MediaPlayer().create();
  player.initialize(document.getElementById('v'), ${JSON.stringify(manifest)}, true);
  player.updateSettings({ streaming: { buffer: { fastSwitchEnabled: true } } });

  function fill(sel, items, label) {
    items.forEach(function (it, i) {
      var o = document.createElement('option'); o.value = i; o.textContent = label(it, i); sel.appendChild(o);
    });
  }
  player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, function () {
    var vq = player.getRepresentationsByType('video') || [];
    fill(document.getElementById('q'), vq, function (r) { return (r.height || '?') + 'p'; });
    var at = player.getTracksFor('audio') || [];
    fill(document.getElementById('a'), at, function (t, i) { return t.lang || ('track ' + i); });
    var tt = player.getTracksFor('text') || [];
    fill(document.getElementById('t'), tt, function (t, i) { return t.lang || ('sub ' + i); });
    var d = player.duration();
    document.getElementById('stat').textContent =
      'duration ' + (isFinite(d) ? d.toFixed(0) + 's' : 'live') +
      ' | ' + vq.length + ' quality rungs, ' + at.length + ' audio, ' + tt.length + ' subtitle';
    log('manifest loaded');
  });
  document.getElementById('q').onchange = function (e) {
    var i = Number(e.target.value);
    player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: i < 0 } } } });
    if (i >= 0) player.setRepresentationForTypeByIndex('video', i, true);
    log('quality -> ' + (i < 0 ? 'auto' : e.target.selectedOptions[0].textContent));
  };
  document.getElementById('a').onchange = function (e) {
    var t = (player.getTracksFor('audio') || [])[Number(e.target.value)];
    if (t) { player.setCurrentTrack(t); log('audio -> ' + (t.lang || '?')); }
  };
  document.getElementById('t').onchange = function (e) {
    var i = Number(e.target.value);
    player.enableText(i >= 0);
    if (i >= 0) player.setTextTrack(i);
    log('subtitles -> ' + (i < 0 ? 'off' : e.target.selectedOptions[0].textContent));
  };
  document.getElementById('live').onclick = function () {
    try { player.seek(player.duration()); } catch (err) { log('seek failed: ' + err); }
  };
  player.on(dashjs.MediaPlayer.events.ERROR, function (e) { log('ERROR ' + JSON.stringify(e.error || e)); });
  player.on(dashjs.MediaPlayer.events.PLAYBACK_ERROR, function (e) { log('PLAYBACK_ERROR ' + JSON.stringify(e)); });
</script>
</body></html>`);
});

sabrRoutes.get("/:videoId/manifest.mpd", async (c) => {
    const videoId = guard(c);
    const audio = (c.req.query("audio") ?? "").split(",").map((s) => s.trim())
        .filter(Boolean);

    const resolved = await getPrepared(videoId, audio);
    const { q, amp } = checkSuffixes(c);

    // Live and post-live DVR: serve YouTube's own dynamic manifest with its
    // BaseURLs pointed back here, so the IP-locked googlevideo addresses are
    // fetched by us rather than by the client. See lib/sabr/live.ts for why
    // this is not done through SABR.
    if (resolved.delegate) {
        const dashUrl = resolved.session.dashManifestUrl;
        if (!dashUrl) {
            // Nothing to proxy — fall back to the route that at least tries.
            return c.redirect(`../../api/manifest/dash/id/${videoId}${q}`, 302);
        }
        const checkSegment = encodeURIComponent(c.req.query("check") ?? "-");
        const { xml } = await getLiveManifest(
            videoId,
            dashUrl,
            `live/${checkSegment}/`,
        );
        c.header("content-type", "application/dash+xml");
        c.header("access-control-allow-origin", "*");
        c.header("cache-control", "no-cache");
        return c.body(xml);
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
 * progressive file through the videoplayback proxy with Range support and
 * resumption.
 *
 * `itag=140` (audio only) is the podcast case and works reliably. `itag=18`
 * (muxed 360p video+audio) is **intermittent**: it returns 403 from googlevideo
 * in bursts, and does so through the untouched `/latest_version` route as well,
 * so it is a pre-existing companion behaviour rather than anything this
 * connector introduces. Resolving the format here from an uncached player
 * response was tried and made no difference, which rules out the stale-token
 * explanation that fits the DVR fix.
 *
 * Muxing the separate SABR video and audio tracks here would need a real
 * muxer, which is why this delegates rather than assembling anything.
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

/**
 * Live segment proxy. The manifest points every `BaseURL` here, and DASH
 * resolves `<SegmentURL media="sq/123/lmt/31"/>` against it — so the tail of
 * this path is the segment's own path beneath the real googlevideo BaseURL.
 *
 * The `check` sits in the path rather than the query because a relative
 * SegmentURL would discard a query string.
 */
sabrRoutes.get("/:videoId/live/:check/:rep/*", async (c) => {
    const videoId = c.req.param("videoId");
    if (!validateVideoId(videoId)) {
        throw new HTTPException(400, {
            res: new Response("Invalid video ID format."),
        });
    }
    const config = c.get("config");
    const check = decodeURIComponent(c.req.param("check"));
    if (config.server.verify_requests) {
        if (check === "-" || verifyRequest(check, videoId, config) === false) {
            throw new HTTPException(400, { res: new Response("ID incorrect.") });
        }
    }

    const rep = Number(c.req.param("rep"));
    if (!Number.isInteger(rep) || rep < 0) {
        throw new HTTPException(400, {
            res: new Response("Invalid representation."),
        });
    }

    const base = await liveBaseUrl(videoId, rep);
    if (!base) {
        throw new HTTPException(404, {
            res: new Response("Live manifest not held. Request the manifest first."),
        });
    }

    // Everything after `/<rep>/` is the segment path the manifest asked for.
    const marker = `/live/${c.req.param("check")}/${c.req.param("rep")}/`;
    const idx = c.req.path.indexOf(marker);
    const tail = idx < 0 ? "" : c.req.path.slice(idx + marker.length);
    if (!/^[\w./-]*$/.test(tail)) {
        throw new HTTPException(400, {
            res: new Response("Invalid segment path."),
        });
    }

    const upstream = await fetch(base + tail, {
        headers: {
            accept: "*/*",
            origin: "https://www.youtube.com",
            referer: "https://www.youtube.com",
        },
    });
    if (!upstream.ok || !upstream.body) {
        throw new HTTPException(502, {
            res: new Response(`Upstream segment HTTP ${upstream.status}`),
        });
    }

    c.header("access-control-allow-origin", "*");
    c.header(
        "content-type",
        upstream.headers.get("content-type") ?? "application/octet-stream",
    );
    c.header("cache-control", "no-cache");
    return c.body(upstream.body);
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
