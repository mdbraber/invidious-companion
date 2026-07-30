/**
 * SABR→DASH connector routes.
 *
 * Serves ordinary DASH — manifest, init segment, numbered media segments — by
 * pulling YouTube's SABR protocol server-side and cutting the fMP4 stream on
 * `moof` boundaries. Segmentation only: no re-muxing, no transcode.
 *
 *   GET /sabr/:videoId/manifest.mpd[?audio=de,fr][?check=]
 *   GET /sabr/:videoId/:track/:file[?check=]
 *
 * Track names are `v<height>` and `a-<trackId>`.
 *
 * **Only one representation is pulled up front.** The manifest advertises the
 * whole quality ladder, but the timeline is shared: fragment boundaries are
 * byte-identical across heights (verified — 288 fragments, 0.0000s drift
 * between 144p and 720p), because they are cut from the same source encode. A
 * height other than the seed is pulled on first request for one of its
 * segments, and its segments are served *as they arrive* rather than after the
 * whole track finishes.
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
import { TrackBuffer } from "../lib/sabr/segmenter.ts";
import {
    diskCacheEnabled,
    loadTrack,
    prune,
    saveTrack,
} from "../lib/sabr/diskStore.ts";

/** Height pulled up front; the rest of the ladder is pulled on demand. */
const SEED_HEIGHT = Number(Deno.env.get("SABR_SEED_HEIGHT") || 360);
/** Ceiling on advertised heights, so a manifest cannot promise 4K by accident. */
const MAX_HEIGHT = Number(Deno.env.get("SABR_MAX_HEIGHT") || 1080);
/** Total bytes of prepared media held in memory before evicting. */
const CACHE_BYTES = Number(Deno.env.get("SABR_CACHE_MB") || 512) * 1024 * 1024;
/** How long a segment request waits for a still-arriving segment. */
const SEGMENT_WAIT_MS = Number(Deno.env.get("SABR_SEGMENT_WAIT_MS") || 30_000);

interface Track {
    name: string;
    buffer: TrackBuffer;
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
    /** Track name -> track. Grows as representations are pulled on demand. */
    tracks: Map<string, Track>;
    /** The seed video track, whose timeline every video rendition shares. */
    seed: Track;
    /** In-flight lazy pulls, so concurrent requests share one pull. */
    pending: Map<string, Promise<Track>>;
}

const prepared = new Map<string, Promise<Prepared>>();

const cachedBytes = async () => {
    let total = 0;
    for (const p of prepared.values()) {
        try {
            const { tracks } = await p;
            for (const t of tracks.values()) total += t.buffer.bytes;
        } catch {
            // A failed preparation holds nothing.
        }
    }
    return total;
};

/** Evict least-recently-used videos until the cache fits its byte budget. */
async function enforceBudget(keep: string) {
    while (prepared.size > 1 && (await cachedBytes()) > CACHE_BYTES) {
        for (const key of prepared.keys()) {
            if (key === keep) continue;
            prepared.delete(key);
            break;
        }
    }
}

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
function timelineXml(buffer: TrackBuffer, durationSec: number) {
    // Prefer the `sidx` index: it lists every segment's duration in the init
    // segment, so the manifest can be built from a few kilobytes rather than
    // from `tfdt` values observed across a completed pull. The tfdt path stays
    // as a fallback for a track whose init carries no index.
    const ts = buffer.index?.timescale ?? buffer.timescale ?? 1000;
    const durations = buffer.index
        ? buffer.index.durations
        : (() => {
            const starts = buffer.segments.map((s) =>
                s.baseMediaDecodeTime ?? 0
            );
            return starts.map((v, i) =>
                i < starts.length - 1
                    ? starts[i + 1] - v
                    : Math.max(1, Math.round(durationSec * ts) - v)
            );
        })();
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

function buildMpdTemplate(p: Prepared, audioTracks: Track[]): string {
    const { session, seed } = p;
    const sets: string[] = [];

    // One video AdaptationSet holding the whole ladder. Every rendition shares
    // the seed's timeline — the fragment boundaries are identical across
    // heights, so `$RepresentationID$` in the template is enough to address
    // them and only the seed has to have been pulled.
    {
        const tl = timelineXml(seed.buffer, session.durationSec);
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
            timescale: tl.ts,
            timeline: tl.xml,
            representations: reps,
        }));
    }

    // One AdaptationSet per audio track, each with its own timeline (audio
    // fragmentation differs from video and between tracks).
    for (const t of audioTracks) {
        const tl = timelineXml(t.buffer, session.durationSec);
        const rep =
            `      <Representation id="${t.name}" codecs="${t.codecs}" audioSamplingRate="${tl.ts}" bandwidth="${t.bandwidth}"/>`;
        sets.push(adaptationSet({
            mimeType: t.mimeType,
            lang: t.lang,
            label: t.label,
            timescale: tl.ts,
            timeline: tl.xml,
            representations: rep,
        }));
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

/** Pull one track to completion in the background, returning it immediately. */
async function startTrack(
    session: SabrSession,
    name: string,
    sel: { height?: number | null; audioTrackId?: string },
    isVideo: boolean,
): Promise<Track> {
    if (diskCacheEnabled()) {
        const cached = await loadTrack(session.videoId, name);
        if (cached) {
            console.log(
                `[INFO] [sabr] [${session.videoId}] ${name} served from disk cache`,
            );
            return {
                name,
                buffer: TrackBuffer.fromFiles(cached.files),
                ...cached.meta,
            };
        }
    }

    return pullSabrTrack(session, sel).then(({ stream, format }) => {
        // deno-lint-ignore no-explicit-any
        const f = format as any;
        const c = parseCodec(f.mimeType);
        const buffer = new TrackBuffer();
        const track: Track = {
            name,
            buffer,
            mimeType: c.base,
            codecs: c.codecs,
            width: f.width,
            height: f.height,
            bandwidth: Number(f.bitrate ?? 0),
            isVideo,
            ...(isVideo ? {} : { lang: sel.audioTrackId }),
        };
        // Fill in the background; segment requests wait on individual segments.
        buffer.fill(stream).then(async () => {
            if (!diskCacheEnabled()) return;
            await saveTrack(session.videoId, name, buffer.files, {
                mimeType: track.mimeType,
                codecs: track.codecs,
                width: track.width,
                height: track.height,
                bandwidth: track.bandwidth,
                isVideo: track.isVideo,
            });
            await prune();
        }).catch((err) => {
            console.log(
                `[WARN] [sabr] [${session.videoId}] track ${name} failed: ${
                    (err as Error).message
                }`,
            );
        });
        return track;
    });
}

async function prepare(
    videoId: string,
    wantAudio: string[],
): Promise<Prepared> {
    const session = await openSabrSession(videoId);
    const log = (m: string) => console.log(`[INFO] [sabr] [${videoId}] ${m}`);
    log(
        `"${session.title}" ${session.durationSec}s — mode=${session.mode}, ${session.videoRenditions.length} rendition(s), ${session.audioTracks.length} audio track(s)`,
    );

    const tracks = new Map<string, Track>();

    // Seed video: the one rendition pulled up front, and the timeline every
    // other rendition borrows.
    const seedHeight = session.videoRenditions.some((r) =>
            r.height === SEED_HEIGHT
        )
        ? SEED_HEIGHT
        : session.videoRenditions[0]?.height;
    // Audio: the requested tracks, else the default one.
    const chosen = wantAudio.length
        ? session.audioTracks.filter((a) =>
            wantAudio.some((l) => a.trackId === l || a.language === l)
        )
        : [];
    const audioList = chosen.length ? chosen : session.audioTracks.slice(0, 1);

    // Seed video and the requested audio tracks are indexed concurrently, and
    // each only awaits its init segment — so the manifest costs about one round
    // trip regardless of how many dubs were asked for.
    const t0 = Date.now();
    const [seed, audioTracks] = await Promise.all([
        startTrack(session, videoTrackName(seedHeight), { height: seedHeight }, true)
            .then(async (t) => {
                await t.buffer.ready;
                return t;
            }),
        Promise.all(audioList.map(async (a) => {
            const track = await startTrack(
                session,
                audioTrackName(a.trackId),
                { height: null, audioTrackId: a.trackId },
                false,
            );
            track.lang = a.language;
            track.label = a.label;
            await track.buffer.ready;
            return track;
        })),
    ]);

    tracks.set(seed.name, seed);
    for (const t of audioTracks) tracks.set(t.name, t);
    log(
        `indexed ${seedHeight}p (${
            seed.buffer.index?.durations.length ?? "?"
        } segments) + audio [${audioList.map((a) => a.trackId).join(", ")}] in ${
            Date.now() - t0
        }ms`,
    );

    return { session, tracks, seed, pending: new Map() };
}

/**
 * Pull a rendition that was advertised but not prepared, once. Concurrent
 * requests for the same track share the pull.
 */
function ensureTrack(p: Prepared, name: string): Promise<Track> | undefined {
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

    console.log(
        `[INFO] [sabr] [${p.session.videoId}] pulling ${height}p on demand`,
    );
    const promise = startTrack(p.session, name, { height }, true)
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

sabrRoutes.get("/:videoId/manifest.mpd", async (c) => {
    const videoId = guard(c);
    const config = c.get("config");
    const audio = (c.req.query("audio") ?? "").split(",").map((s) => s.trim())
        .filter(Boolean);

    // Audio selection changes what the manifest contains, so it keys the cache.
    const key = `${videoId}|${audio.join(",")}`;
    let p = prepared.get(key);
    if (!p) {
        p = prepare(videoId, audio).catch((e) => {
            prepared.delete(key);
            throw e;
        });
    }
    prepared.delete(key);
    prepared.set(key, p);

    const resolved = await p;
    await enforceBudget(key);

    const audioTracks = [...resolved.tracks.values()].filter((t) => !t.isVideo);
    const checkSuffix = config.server.verify_requests
        ? `?check=${encodeURIComponent(c.req.query("check") ?? "")}`
        : "";
    c.header("content-type", "application/dash+xml");
    c.header("access-control-allow-origin", "*");
    return c.body(
        buildMpdTemplate(resolved, audioTracks).replaceAll(
            "%CHECK%",
            checkSuffix,
        ),
    );
});

sabrRoutes.get("/:videoId/:track/:file", async (c) => {
    const videoId = guard(c);
    const { track, file } = c.req.param();
    if (!/^(init\.mp4|seg-\d+\.m4s)$/.test(file)) {
        throw new HTTPException(400, {
            res: new Response("Invalid segment name."),
        });
    }

    // Segments are only served against a preparation the manifest request
    // started; a segment request never opens a new video.
    let entry: Promise<Prepared> | undefined;
    for (const [k, v] of prepared) {
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
    const bytes = await t.buffer.get(file, SEGMENT_WAIT_MS);
    if (!bytes) {
        // Distinguish "still coming" from "will never exist": a completed track
        // that lacks the file genuinely does not have it.
        if (t.buffer.complete || t.buffer.error) {
            throw new HTTPException(404, {
                res: new Response("No such segment."),
            });
        }
        throw new HTTPException(503, {
            res: new Response("Segment not ready yet; retry."),
        });
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
