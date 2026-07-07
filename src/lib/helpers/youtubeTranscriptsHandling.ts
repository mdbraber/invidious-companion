import { Innertube } from "youtubei.js";
import type { CaptionTrackData } from "youtubei.js/PlayerCaptionsTracklist";
import { HTTPException } from "hono/http-exception";

export async function handleTranscripts(
    _innertubeClient: Innertube,
    _videoId: string,
    selectedCaption: CaptionTrackData,
) {
    // Fetch the caption track's timedtext `base_url` directly (the same source
    // yt-dlp uses), forcing WebVTT output. This replaces youtubei.js
    // `getTranscript()` (the `get_transcript` RPC), which currently returns
    // FAILED_PRECONDITION from YouTube for many videos. The base_url comes from
    // the po-token'd player response, so it is not IP-blocked like Invidious's
    // bare timedtext fetch.
    const url = new URL(selectedCaption.base_url);
    url.searchParams.set("fmt", "vtt");

    const response = await fetch(url.toString());

    if (!response.ok) {
        throw new HTTPException(502, {
            res: new Response(
                `Failed to fetch captions (upstream ${response.status}).`,
            ),
        });
    }

    const body = await response.text();

    // Guard against an empty/blocked response masquerading as success.
    if (!body.trimStart().toUpperCase().startsWith("WEBVTT")) {
        throw new HTTPException(404, {
            res: new Response("No captions available."),
        });
    }

    return body;
}
