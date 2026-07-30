/**
 * SABR session + track pulling, ported from owntube/spikes/sabr-dash/sabr.ts.
 *
 * The player response is fetched with a **clean per-client innertube call**, not
 * through the companion's shared youtubei.js session. This is load-bearing: a
 * player response fetched under a blended session identity gets its streaming
 * session classified as suspect by the GVS — it serves ~60 seconds of media,
 * then stops and demands attestation. One coherent client identity (context,
 * user-agent header, and the ClientInfo echoed in every SABR request all
 * agreeing) streams hour-long videos to completion. No po_token is involved;
 * ANDROID_VR is exempt.
 *
 * Only the companion session's visitorData is borrowed — without one the player
 * call answers LOGIN_REQUIRED.
 */
import { Buffer } from "node:buffer";
import { SabrStream } from "gv/sabr-stream.js";
import { buildSabrFormat, EnabledTrackTypes } from "gv/utils.js";

export interface SabrCaptionTrack {
    languageCode: string;
    name: string;
    kind?: string;
    baseUrl: string;
}

export interface SabrAudioTrack {
    trackId: string;
    language?: string;
    isDubbed?: boolean;
    label: string;
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
    userAgent: string;
    captions: SabrCaptionTrack[];
    audioTracks: SabrAudioTrack[];
}

/**
 * The one client this connector speaks as. Everything — the player call's
 * context, its user-agent header, and the ClientInfo inside every SABR
 * request — comes from this single definition.
 *
 * Known trade-off: the raw ANDROID_VR response lists only the original audio
 * track, so dubbed languages are unavailable on this path.
 */
const CLIENT = {
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

export async function openSabrSession(
    videoId: string,
    visitorData: string,
): Promise<SabrSession> {
    const res = await fetch(
        "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "user-agent": CLIENT.userAgent,
                "x-youtube-client-name": String(CLIENT.id),
                "x-youtube-client-version": CLIENT.version,
                "x-goog-visitor-id": visitorData,
            },
            body: JSON.stringify({
                context: { client: { ...CLIENT.context, visitorData } },
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

    const seen = new Map<string, SabrAudioTrack>();
    // deno-lint-ignore no-explicit-any
    for (const f of formats.filter((x: any) => !x.width)) {
        const trackId = f.audioTrackId ?? f.language ?? "default";
        if (seen.has(trackId)) continue;
        const lang = f.language ?? trackId.split(".")[0];
        seen.set(trackId, {
            trackId,
            language: lang,
            isDubbed: f.isDubbed,
            label: f.isDubbed ? `${lang} (dubbed)` : lang,
        });
    }

    return {
        videoId,
        title: player?.videoDetails?.title ?? videoId,
        durationSec: parseInt(player?.videoDetails?.lengthSeconds ?? "0"),
        formats,
        url,
        ustreamer,
        clientInfo: CLIENT.clientInfo,
        userAgent: CLIENT.userAgent,
        captions: (player?.captions?.playerCaptionsTracklistRenderer
            ?.captionTracks ?? [])
            // deno-lint-ignore no-explicit-any
            .map((c: any) => ({
                languageCode: c.languageCode,
                name: c.name?.simpleText ?? c.name?.runs?.[0]?.text ??
                    c.languageCode,
                kind: c.kind,
                baseUrl: c.baseUrl,
            })),
        audioTracks: [...seen.values()],
    };
}

export interface SabrPullSelection {
    /** Video height to pull, or null for audio-only. */
    height?: number | null;
    audioTrackId?: string;
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
        // deno-lint-ignore no-explicit-any
        clientInfo: session.clientInfo as any,
        // Present the client we claim to be on the videoplayback POSTs too.
        // deno-lint-ignore no-explicit-any
        fetch: (input: any, init?: any) =>
            fetch(input, {
                ...init,
                headers: {
                    ...(init?.headers ?? {}),
                    "user-agent": session.userAgent,
                },
            }),
    });

    // deno-lint-ignore no-explicit-any
    const isMp4 = (f: any) => (f.mimeType ?? "").includes("mp4");
    // deno-lint-ignore no-explicit-any
    const audioFor = (fs: any[]) => {
        const audio = fs.filter((f) => isMp4(f) && !f.width);
        if (!sel.audioTrackId) {
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
        // deno-lint-ignore no-explicit-any
    } as any).then((res: any) => ({
        stream: (wantVideo
            ? res.videoStream
            : res.audioStream) as ReadableStream<Uint8Array>,
        format: wantVideo
            ? res.selectedFormats.videoFormat
            : res.selectedFormats.audioFormat,
    }));
}

export { Buffer };
