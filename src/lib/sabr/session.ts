/**
 * SABR session + track pulling.
 *
 * Two ways to obtain a streaming session, in preference order:
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
import { Innertube } from "youtubei.js";
import { SabrStream } from "gv/sabr-stream.js";
import { buildSabrFormat, EnabledTrackTypes } from "gv/utils.js";

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

export interface SabrVideoRendition {
    height: number;
    width?: number;
    itag: number;
    bitrate: number;
    mimeType: string;
}

export interface SabrSession {
    videoId: string;
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
    mode: "web+pot" | "android_vr";
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

    const video = new Map<number, SabrVideoRendition>();
    // deno-lint-ignore no-explicit-any
    for (const f of formats.filter((x: any) => x.width && isMp4(x))) {
        // Keep the highest-bitrate format per height (there can be several).
        const existing = video.get(f.height);
        if (existing && existing.bitrate >= Number(f.bitrate ?? 0)) continue;
        video.set(f.height, {
            height: f.height,
            width: f.width,
            itag: f.itag,
            bitrate: Number(f.bitrate ?? 0),
            mimeType: f.mimeType ?? "",
        });
    }

    return {
        audioTracks: [...audio.values()],
        videoRenditions: [...video.values()].sort((a, b) =>
            a.height - b.height
        ),
    };
}

/** WEB + po_token: the full ladder and every dubbed track. */
async function openWebSession(videoId: string): Promise<SabrSession> {
    // The GVS token must be bound to the video id — see the note at the top.
    const poToken = await mintPoToken(videoId);

    const bootstrap = await Innertube.create({ retrieve_player: false });
    const visitorData = bootstrap.session.context.client.visitorData;
    if (!visitorData) throw new Error("no visitorData");

    const innertube = await Innertube.create({
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
async function openVrSession(videoId: string): Promise<SabrSession> {
    const bootstrap = await Innertube.create({ retrieve_player: false });
    const visitorData = bootstrap.session.context.client.visitorData;
    if (!visitorData) throw new Error("no visitorData");

    const res = await fetch(
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

    // buildSabrFormat reads the raw camelCase player JSON directly; only drc
    // and the audio-track id need aliasing to its snake_case fallbacks.
    // deno-lint-ignore no-explicit-any
    const formats = (player.streamingData.adaptiveFormats ?? []).map((f: any) =>
        buildSabrFormat({
            ...f,
            is_drc: f.isDrc,
            audio_track: f.audioTrack
                ? {
                    id: f.audioTrack.id,
                    audio_is_default: f.audioTrack.audioIsDefault,
                }
                : undefined,
            // deno-lint-ignore no-explicit-any
        } as any)
    );

    return {
        videoId,
        title: player?.videoDetails?.title ?? videoId,
        durationSec: parseInt(player?.videoDetails?.lengthSeconds ?? "0"),
        formats,
        url,
        ustreamer,
        captions: dedupeCaptions(
            (player?.captions?.playerCaptionsTracklistRenderer
                ?.captionTracks ?? [])
                // deno-lint-ignore no-explicit-any
                .map((c: any) => ({
                    languageCode: c.languageCode,
                    label: c.name?.simpleText ?? c.name?.runs?.[0]?.text ??
                        c.languageCode,
                })),
        ),
        clientInfo: VR.clientInfo,
        userAgent: VR.userAgent,
        dashManifestUrl: player?.streamingData?.dashManifestUrl,
        isLive: Boolean(
            player?.videoDetails?.isLive ||
                player?.videoDetails?.isPostLiveDvr ||
                player?.videoDetails?.isLiveContent &&
                    !parseInt(player?.videoDetails?.lengthSeconds ?? "0"),
        ),
        mode: "android_vr",
        ...describeTracks(formats),
    };
}

/**
 * ANDROID_VR is preferred, and it is not close: measured against the same
 * video, indexing a track takes **69ms** on ANDROID_VR versus **4.1s** on
 * WEB+pot, and a seek 27–115ms versus ~4s. WEB is only worth that cost when
 * the request needs something ANDROID_VR cannot express — a dubbed audio
 * track, which its player response does not list at all.
 *
 * @param needsFullFormats ask for WEB+pot because a dub was requested.
 */
export async function openSabrSession(
    videoId: string,
    needsFullFormats = false,
): Promise<SabrSession> {
    if (needsFullFormats && POT_URL) {
        try {
            return await openWebSession(videoId);
        } catch (err) {
            console.log(
                `[WARN] [sabr] [${videoId}] WEB+pot session failed (${
                    (err as Error).message
                }); falling back to ANDROID_VR, dubbed audio will be unavailable`,
            );
        }
    }
    return await openVrSession(videoId);
}

export interface SabrPullSelection {
    /** Exact video height to pull, or null for audio-only. */
    height?: number | null;
    audioTrackId?: string;
    /**
     * Start position, for resuming a partially cached track. Needs the seek
     * fix in the vendored googlevideo; SABR begins at the segment *containing*
     * this time, so the caller must expect some overlap.
     */
    startAtMs?: number;
}

/**
 * Pull one track as a stream of fMP4 bytes. The format *selectors* pin the
 * container — preference flags alone will still hand back WebM/Opus, which
 * cannot be cut into fMP4 segments.
 */
export function pullSabrTrack(
    session: SabrSession,
    sel: SabrPullSelection,
): Promise<{ stream: ReadableStream<Uint8Array>; format: unknown }> {
    const stream = new SabrStream({
        formats: session.formats,
        serverAbrStreamingUrl: session.url,
        videoPlaybackUstreamerConfig: session.ustreamer,
        ...(session.poToken ? { poToken: session.poToken } : {}),
        // deno-lint-ignore no-explicit-any
        clientInfo: session.clientInfo as any,
        ...(session.userAgent
            ? {
                // deno-lint-ignore no-explicit-any
                fetch: (input: any, init?: any) =>
                    fetch(input, {
                        ...init,
                        headers: {
                            ...(init?.headers ?? {}),
                            "user-agent": session.userAgent,
                        },
                    }),
            }
            : {}),
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
        const video = fs.filter((f) => isMp4(f) && f.width);
        if (!sel.height) return video[0];
        return video.find((f) => f.height === sel.height) ?? video[0];
    };

    const wantVideo = sel.height !== null;
    return stream.start({
        videoFormat: videoFor,
        audioFormat: audioFor,
        enabledTrackTypes: wantVideo
            ? EnabledTrackTypes.VIDEO_ONLY
            : EnabledTrackTypes.AUDIO_ONLY,
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
    }));
}
