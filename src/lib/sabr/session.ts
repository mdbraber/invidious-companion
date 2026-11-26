/**
 * SABR session + track pulling.
 *
 * The session's client identity decides whether the server serves random
 * access at all. Measured 2026-09-23 (owntube docs/LIVE-AND-DVR-PLAYBACK.md,
 * "VOD via SABR"): **VISIONOS** — the visionOS YouTube app's client, no PO
 * token needed, what NewPipeExtractor and LibreTube stream from — reports
 * `STREAM_PROTECTION_STATUS` 1 on the first response and starts at any
 * position in ~50 ms, on every video tried. ANDROID_VR refuses to start more
 * than ~1 min into a video (empty answers, then a reload demand), and WEB
 * with a Camoufox or headless-Chromium PO token is only verified on some
 * videos; elsewhere it is cut off after ~48 s of media with "attestation
 * required". So VOD sessions are VISIONOS, with the older paths kept as
 * fallbacks:
 *
 *  1. **WEB with a proof-of-origin token.** Gives the full format list —
 *     every video height and every dubbed audio track. Requires a po_token
 *     provider (`SABR_POT_URL`), and the token attached to the *streaming*
 *     request must be bound to the **video id**, not to visitorData. A
 *     visitorData-bound token is accepted at first and then rejected ~60s in
 *     with `streamProtectionStatus: 3` (= token seen and judged invalid), which
 *     is indistinguishable from having no token at all until you look at the
 *     status code.
 *
 *  2. **ANDROID_VR, no token.** Exempt from attestation, so it needs no
 *     provider, but its player response lists only the original audio track.
 *     Used automatically when no provider is configured or minting fails.
 *
 * In both cases the player response is fetched with **one coherent client
 * identity** — context, user-agent, and the ClientInfo echoed in every SABR
 * request all agreeing. A response fetched under a blended identity gets its
 * streaming session classified as suspect and cut off after ~60s of media.
 */
import { type SessionFetch, sessionFetch } from "./egress.ts";
import { Innertube } from "youtubei.js";
import { SabrStream } from "gv/sabr-stream.js";
import { buildSabrFormat, EnabledTrackTypes } from "gv/utils.js";
import {
    type SabrVideoRendition,
    videoFormatForHeight,
    videoLadder,
} from "./ladder.ts";

const POT_URL = Deno.env.get("SABR_POT_URL") || "";

export interface SabrAudioTrack {
    trackId: string;
    language?: string;
    isDubbed?: boolean;
    label: string;
}

export interface SabrCaptionTrack {
    languageCode: string;
    label: string;
}

export type { SabrVideoRendition } from "./ladder.ts";

export interface SabrSession {
    videoId: string;
    /** Egress for everything this session sends (see egress.ts). */
    fetch?: SessionFetch;
    title: string;
    durationSec: number;
    // deno-lint-ignore no-explicit-any
    formats: any[];
    url: string;
    ustreamer: string;
    clientInfo: Record<string, unknown>;
    userAgent?: string;
    poToken?: string;
    audioTracks: SabrAudioTrack[];
    videoRenditions: SabrVideoRendition[];
    /**
     * Advertised in the manifest, but fetched from the companion's existing
     * `/api/v1/captions` route rather than served here: Google IP-blocks the
     * `timedtext` base_url (HTTP 200, zero bytes), and that route already
     * works around it.
     */
    captions: SabrCaptionTrack[];
    /**
     * Live or post-live DVR. Neither has a stable segment index, and a live
     * SABR pull stalls out — these are delegated to the companion's existing
     * DASH manifest route, which serves YouTube's native dynamic manifest.
     */
    isLive: boolean;
    /** YouTube's own dynamic manifest, for the live path. */
    dashManifestUrl?: string;
    /** Which path produced this session, for logging and manifest hints. */
    mode: "web+pot" | "android_vr" | "visionos";
}

const VR = {
    id: 28,
    version: "1.65.10",
    userAgent:
        "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
    context: {
        clientName: "ANDROID_VR",
        clientVersion: "1.65.10",
        deviceMake: "Oculus",
        deviceModel: "Quest 3",
        androidSdkVersion: 32,
        osName: "Android",
        osVersion: "12L",
        hl: "en",
        gl: "US",
    },
    clientInfo: {
        clientName: 28,
        clientVersion: "1.65.10",
        deviceMake: "Oculus",
        deviceModel: "Quest 3",
        osName: "Android",
        osVersion: "12L",
        androidSdkVersion: 32,
    },
};

/**
 * The visionOS YouTube app, as NewPipeExtractor's `ofVisionOsClient()` sends
 * it (ClientsConstants.java; bump these together with it). Talks to the
 * `youtubei.googleapis.com` host with `X-Goog-Api-Format-Version: 2`.
 */
const VISION = {
    id: 101,
    version: "1.04",
    model: "RealityDevice17,1",
    osVersion: "26.6.0.23O770",
    userAgent:
        "com.google.visionos.youtube/1.04(RealityDevice17,1; U; CPU visionOS 26_6_0 like Mac OS X; US)",
    context: {
        clientName: "VISIONOS",
        clientVersion: "1.04",
        clientScreen: "WATCH",
        deviceMake: "Apple",
        deviceModel: "RealityDevice17,1",
        osName: "visionOS",
        osVersion: "26.6.0.23O770",
        hl: "en",
        gl: "US",
        utcOffsetMinutes: 0,
    },
    clientInfo: {
        clientName: 101,
        clientVersion: "1.04",
        deviceMake: "Apple",
        deviceModel: "RealityDevice17,1",
        osName: "visionOS",
        osVersion: "26.6.0.23O770",
    },
};

async function mintPoToken(binding: string): Promise<string> {
    const res = await fetch(POT_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content_binding: binding }),
    });
    const body = await res.json() as { poToken?: string };
    if (!body.poToken) {
        throw new Error(`po_token provider returned no token for ${binding}`);
    }
    return body.poToken;
}

/**
 * One entry per language. A video commonly lists the same language twice
 * (authored and auto-generated); the manifest keys captions by language, so a
 * duplicate would produce two identical AdaptationSets.
 */
function dedupeCaptions(tracks: SabrCaptionTrack[]): SabrCaptionTrack[] {
    const seen = new Map<string, SabrCaptionTrack>();
    for (const t of tracks) {
        if (!t.languageCode || seen.has(t.languageCode)) continue;
        seen.set(t.languageCode, t);
    }
    return [...seen.values()];
}

// deno-lint-ignore no-explicit-any
const isMp4 = (f: any) => (f.mimeType ?? "").includes("mp4");

// deno-lint-ignore no-explicit-any
function describeTracks(formats: any[]) {
    const audio = new Map<string, SabrAudioTrack>();
    // deno-lint-ignore no-explicit-any
    for (const f of formats.filter((x: any) => !x.width && isMp4(x))) {
        const trackId = f.audioTrackId ?? f.language ?? "default";
        if (audio.has(trackId)) continue;
        const lang = f.language ?? String(trackId).split(".")[0];
        audio.set(trackId, {
            trackId,
            language: lang,
            isDubbed: f.isDubbed,
            label: f.isDubbed ? `${lang} (dubbed)` : lang,
        });
    }

    // The original track first: `prepare()` takes the first entry as the
    // default audio, and a native response lists dubs before the original.
    const audioTracks = [...audio.values()].sort((a, b) =>
        Number(Boolean(a.isDubbed)) - Number(Boolean(b.isDubbed))
    );
    return {
        audioTracks,
        // One codec, one format per height; see ladder.ts.
        videoRenditions: videoLadder(formats),
    };
}

/** WEB + po_token: the full ladder and every dubbed track. */
async function openWebSession(
    videoId: string,
    egress: SessionFetch = sessionFetch(),
): Promise<SabrSession> {
    // The GVS token must be bound to the video id — see the note at the top.
    const poToken = await mintPoToken(videoId);

    const bootstrap = await Innertube.create({
        retrieve_player: false,
        fetch: egress,
    });
    const visitorData = bootstrap.session.context.client.visitorData;
    if (!visitorData) throw new Error("no visitorData");

    const innertube = await Innertube.create({
        fetch: egress,
        po_token: poToken,
        visitor_data: visitorData,
    });
    // deno-lint-ignore no-explicit-any
    const info: any = await innertube.getBasicInfo(videoId, "WEB" as any);

    const url = await innertube.session.player?.decipher(
        info.streaming_data?.server_abr_streaming_url,
    );
    const ustreamer = info.player_config?.media_common_config
        ?.media_ustreamer_request_config?.video_playback_ustreamer_config;
    if (!url || !ustreamer) {
        throw new Error(`${videoId}: no SABR streaming url / ustreamer config`);
    }

    const formats = (info.streaming_data?.adaptive_formats ?? []).map(
        buildSabrFormat,
    );

    return {
        videoId,
        title: info.basic_info?.title ?? videoId,
        durationSec: info.basic_info?.duration ?? 0,
        formats,
        url,
        ustreamer,
        poToken,
        captions: dedupeCaptions(
            // deno-lint-ignore no-explicit-any
            (info.captions?.caption_tracks ?? []).map((c: any) => ({
                languageCode: c.language_code,
                label: c.name?.text ?? c.language_code,
            })),
        ),
        clientInfo: {
            clientName: 1,
            clientVersion: innertube.session.context.client.clientVersion,
        },
        isLive: Boolean(
            info.basic_info?.is_live || info.basic_info?.is_post_live_dvr,
        ),
        dashManifestUrl: info.streaming_data?.dash_manifest_url,
        mode: "web+pot",
        ...describeTracks(formats),
    };
}

/** ANDROID_VR: no token needed, original audio track only. */
async function openVrSession(
    videoId: string,
    egress: SessionFetch = sessionFetch(),
    reloadToken?: string,
): Promise<SabrSession> {
    const bootstrap = await Innertube.create({
        retrieve_player: false,
        fetch: egress,
    });
    const visitorData = bootstrap.session.context.client.visitorData;
    if (!visitorData) throw new Error("no visitorData");

    const res = await egress(
        "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "user-agent": VR.userAgent,
                "x-youtube-client-name": String(VR.id),
                "x-youtube-client-version": VR.version,
                "x-goog-visitor-id": visitorData,
            },
            body: JSON.stringify({
                context: { client: { ...VR.context, visitorData } },
                videoId,
                contentCheckOk: true,
                racyCheckOk: true,
                ...reloadPlaybackContext(reloadToken),
            }),
        },
    );
    // deno-lint-ignore no-explicit-any
    const player: any = await res.json();

    const status = player?.playabilityStatus?.status;
    if (status !== "OK") {
        throw new Error(
            `${videoId}: playability ${status}: ${
                player?.playabilityStatus?.reason ?? ""
            }`,
        );
    }

    // ANDROID_VR streaming URLs need no deciphering (no JS player involved).
    const url = player?.streamingData?.serverAbrStreamingUrl;
    const ustreamer = player?.playerConfig?.mediaCommonConfig
        ?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig;
    if (!url || !ustreamer) {
        throw new Error(`${videoId}: no SABR streaming url / ustreamer config`);
    }

    const formats = nativeFormats(player);

    return {
        videoId,
        title: player?.videoDetails?.title ?? videoId,
        durationSec: parseInt(player?.videoDetails?.lengthSeconds ?? "0"),
        formats,
        url,
        ustreamer,
        captions: nativeCaptions(player),
        clientInfo: VR.clientInfo,
        userAgent: VR.userAgent,
        dashManifestUrl: player?.streamingData?.dashManifestUrl,
        isLive: nativeIsLive(player),
        mode: "android_vr",
        ...describeTracks(formats),
    };
}

/**
 * A raw player response from a native (non-JS) client: no deciphering, no
 * PO token. `buildSabrFormat` reads the camelCase JSON directly; only drc and
 * the audio-track id need aliasing to its snake_case fallbacks.
 */
// deno-lint-ignore no-explicit-any
function nativeFormats(player: any) {
    // deno-lint-ignore no-explicit-any
    return (player?.streamingData?.adaptiveFormats ?? []).map((f: any) => {
        // A native response describes audio tracks as
        // `audioTrack: {id: "en-US.4", displayName, audioIsDefault, isAutoDubbed}`
        // — the original carries `audioIsDefault: true`, every dub is
        // another track. Map that onto the YouTube.js-style flags
        // `buildSabrFormat` reads, so `describeTracks` and the audio
        // selector can tell the original from the dubs.
        const track = f.audioTrack;
        return buildSabrFormat({
            ...f,
            is_drc: f.isDrc,
            audio_track: track
                ? { id: track.id, audio_is_default: track.audioIsDefault }
                : undefined,
            is_original: track ? Boolean(track.audioIsDefault) : undefined,
            is_dubbed: track ? !track.audioIsDefault : undefined,
            is_auto_dubbed: track?.isAutoDubbed,
            language: track?.id?.split(".")[0],
            // deno-lint-ignore no-explicit-any
        } as any);
    });
}

// deno-lint-ignore no-explicit-any
function nativeCaptions(player: any): SabrCaptionTrack[] {
    return dedupeCaptions(
        (player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ??
            [])
            // deno-lint-ignore no-explicit-any
            .map((c: any) => ({
                languageCode: c.languageCode,
                label: c.name?.simpleText ?? c.name?.runs?.[0]?.text ??
                    c.languageCode,
            })),
    );
}

// deno-lint-ignore no-explicit-any
function nativeIsLive(player: any): boolean {
    return Boolean(
        player?.videoDetails?.isLive ||
            player?.videoDetails?.isPostLiveDvr ||
            player?.videoDetails?.isLiveContent &&
                !parseInt(player?.videoDetails?.lengthSeconds ?? "0"),
    );
}

/** VISIONOS: no token needed, random access works. The VOD default. */
async function openVisionSession(
    videoId: string,
    egress: SessionFetch = sessionFetch(),
    reloadToken?: string,
): Promise<SabrSession> {
    const bootstrap = await Innertube.create({
        retrieve_player: false,
        fetch: egress,
    });
    const visitorData = bootstrap.session.context.client.visitorData;
    if (!visitorData) throw new Error("no visitorData");

    const res = await egress(
        "https://youtubei.googleapis.com/youtubei/v1/player?prettyPrint=false",
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "user-agent": VISION.userAgent,
                "x-goog-api-format-version": "2",
                "x-goog-visitor-id": visitorData,
            },
            body: JSON.stringify({
                context: {
                    client: { ...VISION.context, visitorData },
                    request: { internalExperimentFlags: [], useSsl: true },
                    user: { lockedSafetyMode: false },
                },
                videoId,
                contentCheckOk: true,
                racyCheckOk: true,
                ...reloadPlaybackContext(reloadToken),
            }),
        },
    );
    // deno-lint-ignore no-explicit-any
    const player: any = await res.json();

    const status = player?.playabilityStatus?.status;
    if (status !== "OK") {
        throw new Error(
            `${videoId}: playability ${status}: ${
                player?.playabilityStatus?.reason ?? ""
            }`,
        );
    }
    const url = player?.streamingData?.serverAbrStreamingUrl;
    const ustreamer = player?.playerConfig?.mediaCommonConfig
        ?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig;
    if (!url || !ustreamer) {
        throw new Error(`${videoId}: no SABR streaming url / ustreamer config`);
    }
    const formats = nativeFormats(player);

    return {
        videoId,
        title: player?.videoDetails?.title ?? videoId,
        durationSec: parseInt(player?.videoDetails?.lengthSeconds ?? "0"),
        formats,
        url,
        ustreamer,
        captions: nativeCaptions(player),
        clientInfo: VISION.clientInfo,
        userAgent: VISION.userAgent,
        dashManifestUrl: player?.streamingData?.dashManifestUrl,
        isLive: nativeIsLive(player),
        mode: "visionos",
        ...describeTracks(formats),
    };
}

/**
 * A reload demand carries a token the next player request must echo. Without
 * it YouTube answers the fresh session's first SABR request with another
 * demand, on some videos every time (mjsMqasGhKU, 2026-11-20: ten reloads in
 * a row, VISIONOS and ANDROID_VR alike, then the pull gave up and OwnTube fell
 * back to byte-range URLs that are revoked ~1 min in).
 */
function reloadPlaybackContext(token?: string) {
    return token
        ? {
            playbackContext: {
                reloadPlaybackContext: { reloadPlaybackParams: { token } },
            },
        }
        : {};
}

/**
 * VOD: VISIONOS (see the header). Live and post-live DVR: ANDROID_VR, whose
 * native manifest is what `lib/sabr/live.ts` proxies — that path is proven
 * and left alone, at the cost of a second player request for a live video.
 * WEB+pot is tried only when a dubbed track was asked for and VISIONOS did
 * not list it; ANDROID_VR is the last resort for everything.
 *
 * @param needsFullFormats a dubbed audio track was requested.
 */
export async function openSabrSession(
    videoId: string,
    needsFullFormats = false,
): Promise<SabrSession> {
    const egress = sessionFetch();
    const s = await openSabrSessionWith(videoId, needsFullFormats, egress);
    s.fetch = egress;
    return s;
}

/** A player error that is YouTube's "confirm you're not a bot" verdict. */
export function isBotVerdict(err: unknown): boolean {
    return /playability LOGIN_REQUIRED:.*\bbot\b/i.test(
        (err as Error)?.message ?? "",
    );
}

/**
 * Open a session, asking once more when YouTube answers "not a bot". The
 * verdict is mostly about the request, not the address: measured 2026-11-26,
 * the same ANDROID_VR request from the same address drew it and then got OK
 * (see `ipv6Rotation.ts`), so a second ask often saves the video from the
 * byte-range fallback, whose URLs are revoked ~1 min in.
 */
export async function openWithBotRetry<T>(
    videoId: string,
    client: string,
    open: () => Promise<T>,
): Promise<T> {
    try {
        return await open();
    } catch (err) {
        if (!isBotVerdict(err)) throw err;
        console.log(
            `[INFO] [sabr] [${videoId}] ${client}: "not a bot" verdict; asking once more`,
        );
        return await open();
    }
}

async function openSabrSessionWith(
    videoId: string,
    needsFullFormats: boolean,
    egress: SessionFetch,
): Promise<SabrSession> {
    let vision: SabrSession | undefined;
    try {
        vision = await openWithBotRetry(
            videoId,
            "VISIONOS",
            () => openVisionSession(videoId, egress),
        );
    } catch (err) {
        console.log(
            `[WARN] [sabr] [${videoId}] VISIONOS session failed (${
                (err as Error).message
            }); falling back`,
        );
    }
    if (vision && !vision.isLive) {
        if (!needsFullFormats || vision.audioTracks.length > 1 || !POT_URL) {
            return vision;
        }
    }
    if (needsFullFormats && POT_URL && !vision?.isLive) {
        try {
            return await openWebSession(videoId, egress);
        } catch (err) {
            console.log(
                `[WARN] [sabr] [${videoId}] WEB+pot session failed (${
                    (err as Error).message
                }); falling back to ${
                    vision ? "VISIONOS" : "ANDROID_VR"
                }, dubbed audio will be unavailable`,
            );
            if (vision) return vision;
        }
    }
    return await openWithBotRetry(
        videoId,
        "ANDROID_VR",
        () => openVrSession(videoId, egress),
    );
}

/** Re-fetch the player response for a session, keeping its client. */
async function reopenSabrSession(
    session: SabrSession,
    reloadToken?: string,
): Promise<SabrSession> {
    // Same egress address: the pull keeps streaming from it.
    const egress = session.fetch ?? sessionFetch();
    let fresh: SabrSession;
    switch (session.mode) {
        case "visionos":
            fresh = await openVisionSession(
                session.videoId,
                egress,
                reloadToken,
            );
            break;
        case "web+pot":
            fresh = await openWebSession(session.videoId, egress);
            break;
        default:
            fresh = await openVrSession(session.videoId, egress, reloadToken);
    }
    fresh.fetch = egress;
    return fresh;
}

/**
 * What a pull tells the server it can decode: SDR, no HDR. VISIONOS is taken
 * to be HDR-capable, and on an HDR upload the server then refuses every SDR
 * format with a player-response reload demand (mjsMqasGhKU, 2026-11-20:
 * H.264 and 8-bit VP9 refused, VP9.2 and 10-bit AV1 served; with these caps
 * declared, H.264 is served).
 *
 * Codec ids follow yt-dlp's VideoFormatCapability enum (sabr PR #13515),
 * which its working SABR downloader sends: H264=2, VP9=4, AV1=8 — the old
 * ids 1..3 (H263/H264/VP8) never claimed VP9 or AV1, and YouTube then
 * refused >1080p AV1 pulls with sabr.no_video_selected (aqz-KE-bpKQ,
 * 2026-11-24). Matches shape-with-hdrModeBitmask=0 SDR everywhere.
 */
const SDR_MEDIA_CAPABILITIES = {
    videoFormatCapabilities: [2, 4, 8].map((videoCodec) => ({
        videoCodec,
        efficient: true,
        is10BitSupported: true,
    })),
    audioFormatCapabilities: [],
    hdrModeBitmask: 0,
};

export interface SabrPullSelection {
    /** Exact video height to pull, or null for audio-only. */
    height?: number | null;
    /** Exact itag to pull; overrides the default ladder's itag for `height`. */
    itag?: number;
    audioTrackId?: string;
    /**
     * Start position, for resuming a partially cached track. Needs the seek
     * fix in the vendored googlevideo; SABR begins at the segment *containing*
     * this time, so the caller must expect some overlap.
     */
    startAtMs?: number;
}

export interface SabrPull {
    stream: ReadableStream<Uint8Array>;
    format: unknown;
    /**
     * Stop the pull. Cancelling the ReadableStream's reader is not enough:
     * the library keeps fetching and retries ten times against the closed
     * controller ("The stream controller cannot close or enqueue"), which is
     * both load on YouTube and noise in the log.
     */
    abort: () => void;
}

/**
 * Pull one track as a stream of fMP4 bytes. The format *selectors* pin the
 * container — preference flags alone will still hand back WebM/Opus, which
 * cannot be cut into fMP4 segments.
 *
 * When the server asks for a player-response reload (streaming URLs expire,
 * ~6 h), the session is re-opened with the same client and the pull's next
 * retry uses the fresh URL; the shared session object is updated in place so
 * later pulls start from it.
 */
export function pullSabrTrack(
    session: SabrSession,
    sel: SabrPullSelection,
): Promise<SabrPull> {
    const stream = new SabrStream({
        formats: session.formats,
        serverAbrStreamingUrl: session.url,
        videoPlaybackUstreamerConfig: session.ustreamer,
        ...(session.poToken ? { poToken: session.poToken } : {}),
        // deno-lint-ignore no-explicit-any
        clientInfo: session.clientInfo as any,
        // deno-lint-ignore no-explicit-any
        fetch: (input: any, init?: any) =>
            (session.fetch ?? fetch)(
                input,
                session.userAgent
                    ? {
                        ...init,
                        headers: {
                            ...(init?.headers ?? {}),
                            "user-agent": session.userAgent,
                        },
                    }
                    : init,
            ),
    });

    // deno-lint-ignore no-explicit-any
    const audioFor = (fs: any[]) => {
        const audio = fs.filter((f) => isMp4(f) && !f.width);
        if (!sel.audioTrackId) {
            // The default track, explicitly: taking the first entry picks
            // whichever dub the server happens to list first.
            return audio.find((f) => !f.isDubbed && !f.isDrc) ??
                audio.find((f) => !f.isDubbed) ?? audio[0];
        }
        return audio.find((f) =>
            (f.audioTrackId ?? f.language ?? "default") === sel.audioTrackId
        ) ?? audio[0];
    };
    // deno-lint-ignore no-explicit-any
    const videoFor = (fs: any[]) => {
        // An explicit itag (a non-default ladder family, e.g. the VP9/WebM
        // ladder a Safari requests) wins over the default ladder.
        if (sel.itag) return fs.find((f) => f.itag === sel.itag);
        if (!sel.height) return fs.find((f) => isMp4(f) && f.width);
        // The format the manifest advertises for this height, not merely the
        // first one listed at it (which can be another codec); see ladder.ts.
        return videoFormatForHeight(
            fs,
            session.videoRenditions,
            sel.height,
        );
    };

    // deno-lint-ignore no-explicit-any
    stream.on("reloadPlayerResponse", (ctx: any) => {
        const token: string | undefined = ctx?.reloadPlaybackParams?.token;
        void reopenSabrSession(session, token).then((fresh) => {
            session.url = fresh.url;
            session.ustreamer = fresh.ustreamer;
            session.formats = fresh.formats;
            stream.setStreamingURL(fresh.url);
            stream.setUstreamerConfig(fresh.ustreamer);
            console.log(
                `[INFO] [sabr] [${session.videoId}] player response reloaded (${fresh.mode})`,
            );
        }).catch((err) => {
            console.log(
                `[WARN] [sabr] [${session.videoId}] player response reload failed: ${
                    (err as Error).message
                }`,
            );
        });
    });

    const wantVideo = sel.height !== null;
    return stream.start({
        videoFormat: videoFor,
        audioFormat: audioFor,
        enabledTrackTypes: wantVideo
            ? EnabledTrackTypes.VIDEO_ONLY
            : EnabledTrackTypes.AUDIO_ONLY,
        ...(wantVideo ? { mediaCapabilities: SDR_MEDIA_CAPABILITIES } : {}),
        ...(sel.startAtMs ? { startAtMs: sel.startAtMs } : {}),
        // deno-lint-ignore no-explicit-any
    } as any).then((res: any) => ({
        stream:
            (wantVideo ? res.videoStream : res.audioStream) as ReadableStream<
                Uint8Array
            >,
        format: wantVideo
            ? res.selectedFormats.videoFormat
            : res.selectedFormats.audioFormat,
        abort: () => {
            try {
                stream.abort();
            } catch { /* already gone */ }
        },
    }));
}
