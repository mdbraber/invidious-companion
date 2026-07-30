/**
 * SABR→DASH connector routes (proof of concept).
 *
 * Serves ordinary DASH — manifest, init segment, numbered media segments — by
 * pulling YouTube's SABR protocol server-side and cutting the fMP4 stream on
 * `moof` boundaries. Segmentation only: no re-muxing, no transcode.
 *
 *   GET /sabr/:videoId/manifest.mpd[?check=]        DASH manifest
 *   GET /sabr/:videoId/:track/:file[?check=]        init.mp4 / seg-N.m4s
 *
 * On first manifest request the video is pulled and cut into memory, then
 * served from there — a warm-up delay (≈16s for a 25-minute video at 360p) in
 * exchange for free seeking. The cache holds SABR_CACHE_VIDEOS videos (default
 * 2), evicted least-recently-used; a 25-minute video at 360p is ≈100 MB.
 *
 * When `server.verify_requests` is on, every route requires the same
 * AES-encrypted `check` parameter the other companion routes use, and the
 * manifest embeds it in the segment URLs it hands the player.
 */
import { type Context, Hono } from "hono";
import type { HonoVariables } from "../lib/types/HonoVariables.ts";
import { HTTPException } from "hono/http-exception";
import { verifyRequest } from "../lib/helpers/verifyRequest.ts";
import { validateVideoId } from "../lib/helpers/validateVideoId.ts";
import {
    openSabrSession,
    pullSabrTrack,
    type SabrSession,
} from "../lib/sabr/session.ts";
import {
    segmentToMemory,
    type SegmentResult,
} from "../lib/sabr/segmenter.ts";

const MAX_AUDIO_TRACKS = Number(
    Deno.env.get("SABR_MAX_AUDIO_TRACKS") || 2,
);
const CACHE_VIDEOS = Number(Deno.env.get("SABR_CACHE_VIDEOS") || 2);
const VIDEO_HEIGHT = Number(Deno.env.get("SABR_VIDEO_HEIGHT") || 360);

interface TrackBuild {
    name: string;
    result: SegmentResult;
    mimeType: string;
    codecs: string;
    width?: number;
    height?: number;
    bandwidth: number;
    lang?: string;
    label?: string;
}

interface Prepared {
    session: SabrSession;
    tracks: TrackBuild[];
    /** MPD with a %CHECK% placeholder in segment URLs. */
    mpdTemplate: string;
}

const prepared = new Map<string, Promise<Prepared>>();

const touchLru = (videoId: string, p: Promise<Prepared>) => {
    // Re-inserting moves the key to the end; Map iterates in insertion order.
    prepared.delete(videoId);
    prepared.set(videoId, p);
    while (prepared.size > CACHE_VIDEOS) {
        const oldest = prepared.keys().next().value;
        if (oldest === undefined) break;
        prepared.delete(oldest);
    }
};

const parseCodec = (mime?: string) => ({
    base: (mime ?? "").split(";")[0],
    codecs: /codecs="?([^"]+)"?/.exec(mime ?? "")?.[1] ?? "",
});

/**
 * `SegmentTimeline`, not a fixed `duration`: SABR's video fragments are not
 * uniform (measured 3.4s–7.0s), so a single duration desynchronises playback.
 */
function timelineXml(r: SegmentResult, durationSec: number) {
    const ts = r.timescale ?? 1000;
    const starts = r.segments.map((s) => s.baseMediaDecodeTime ?? 0);
    const durations = starts.map((v, i) =>
        i < starts.length - 1
            ? starts[i + 1] - v
            : Math.max(1, Math.round(durationSec * ts) - v)
    );
    const runs: { d: number; r: number }[] = [];
    for (const d of durations) {
        const last = runs[runs.length - 1];
        if (last && last.d === d) last.r++;
        else runs.push({ d, r: 0 });
    }
    return {
        ts,
        xml: runs.map((x) =>
            `          <S d="${x.d}"${x.r ? ` r="${x.r}"` : ""}/>`
        ).join("\n"),
    };
}

function buildMpdTemplate(session: SabrSession, tracks: TrackBuild[]): string {
    const sets = tracks.map((t) => {
        const tl = timelineXml(t.result, session.durationSec);
        const isVideo = Boolean(t.width);
        const rep = isVideo
            ? `id="${t.name}" codecs="${t.codecs}" width="${t.width}" height="${t.height}" bandwidth="${t.bandwidth}"`
            : `id="${t.name}" codecs="${t.codecs}" audioSamplingRate="${tl.ts}" bandwidth="${t.bandwidth}"`;
        const langAttr = t.lang ? ` lang="${t.lang}"` : "";
        const label = t.label ? `\n      <Label>${t.label}</Label>` : "";
        return `    <AdaptationSet mimeType="${t.mimeType}"${langAttr} segmentAlignment="true" startWithSAP="1">${label}
      <SegmentTemplate timescale="${tl.ts}" startNumber="1"
                       initialization="${t.name}/init.mp4%CHECK%" media="${t.name}/seg-$Number$.m4s%CHECK%">
        <SegmentTimeline>
${tl.xml}
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation ${rep}/>
    </AdaptationSet>`;
    });

    return `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011"
     type="static" mediaPresentationDuration="PT${session.durationSec}S" minBufferTime="PT4S">
  <Period>
${sets.join("\n")}
  </Period>
</MPD>
`;
}

async function prepare(
    videoId: string,
    visitorData: string,
): Promise<Prepared> {
    const session = await openSabrSession(videoId, visitorData);
    const tracks: TrackBuild[] = [];
    const log = (m: string) => console.log(`[INFO] [sabr] [${videoId}] ${m}`);
    log(
        `"${session.title}" ${session.durationSec}s — ${session.audioTracks.length} audio track(s)`,
    );

    {
        const t0 = Date.now();
        const { stream, format } = await pullSabrTrack(session, {
            height: VIDEO_HEIGHT,
        });
        const result = await segmentToMemory(stream);
        // deno-lint-ignore no-explicit-any
        const f = format as any;
        const c = parseCodec(f.mimeType);
        tracks.push({
            name: "video",
            result,
            mimeType: c.base,
            codecs: c.codecs,
            width: f.width,
            height: f.height,
            bandwidth: Number(f.bitrate ?? 0),
        });
        log(
            `video ${f.height}p: ${result.segments.length} segments in ${
                Date.now() - t0
            }ms`,
        );
    }

    for (const track of session.audioTracks.slice(0, MAX_AUDIO_TRACKS)) {
        const t0 = Date.now();
        const name = `audio-${track.trackId.replace(/[^\w.-]/g, "_")}`;
        const { stream, format } = await pullSabrTrack(session, {
            height: null,
            audioTrackId: track.trackId,
        });
        const result = await segmentToMemory(stream);
        // deno-lint-ignore no-explicit-any
        const f = format as any;
        const c = parseCodec(f.mimeType);
        tracks.push({
            name,
            result,
            mimeType: c.base,
            codecs: c.codecs,
            bandwidth: Number(f.bitrate ?? 0),
            lang: track.language,
            label: track.label,
        });
        log(
            `audio ${track.trackId}: ${result.segments.length} segments in ${
                Date.now() - t0
            }ms`,
        );
    }

    return { session, tracks, mpdTemplate: buildMpdTemplate(session, tracks) };
}

function getPrepared(
    videoId: string,
    visitorData: string,
): Promise<Prepared> {
    let p = prepared.get(videoId);
    if (!p) {
        p = prepare(videoId, visitorData).catch((e) => {
            prepared.delete(videoId);
            throw e;
        });
    }
    touchLru(videoId, p);
    return p;
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

sabrRoutes.get("/:videoId/manifest.mpd", async (c) => {
    const videoId = guard(c);
    const config = c.get("config");
    const innertubeClient = c.get("innertubeClient");
    const visitorData = innertubeClient.session.context.client.visitorData;
    if (!visitorData) {
        throw new HTTPException(503, {
            res: new Response("No visitorData available yet."),
        });
    }

    const { mpdTemplate } = await getPrepared(videoId, visitorData);
    const checkSuffix = config.server.verify_requests
        ? `?check=${encodeURIComponent(c.req.query("check") ?? "")}`
        : "";
    c.header("content-type", "application/dash+xml");
    c.header("access-control-allow-origin", "*");
    return c.body(mpdTemplate.replaceAll("%CHECK%", checkSuffix));
});

sabrRoutes.get("/:videoId/:track/:file", async (c) => {
    const videoId = guard(c);
    const { track, file } = c.req.param();
    if (!/^(init\.mp4|seg-\d+\.m4s)$/.test(file)) {
        throw new HTTPException(400, {
            res: new Response("Invalid segment name."),
        });
    }

    // Segments are only ever served from a cache the manifest request built —
    // a segment request never triggers a pull.
    const p = prepared.get(videoId);
    if (!p) {
        throw new HTTPException(404, {
            res: new Response("Video not prepared. Request the manifest first."),
        });
    }
    const { tracks } = await p;
    const t = tracks.find((x) => x.name === track);
    const bytes = t?.result.files.get(file);
    if (!bytes) {
        throw new HTTPException(404, { res: new Response("No such segment.") });
    }
    c.header(
        "content-type",
        file === "init.mp4" ? "video/mp4" : "video/iso.segment",
    );
    c.header("access-control-allow-origin", "*");
    c.header("cache-control", "private, max-age=3600");
    return c.body(bytes);
});

export default sabrRoutes;
