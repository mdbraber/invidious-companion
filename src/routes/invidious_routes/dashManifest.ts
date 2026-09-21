import { Hono } from "hono";
import { FormatUtils } from "youtubei.js";
import {
    youtubePlayerParsing,
    youtubeVideoInfo,
} from "../../lib/helpers/youtubePlayerHandling.ts";
import { verifyRequest } from "../../lib/helpers/verifyRequest.ts";
import { HTTPException } from "hono/http-exception";
import { encryptQuery } from "../../lib/helpers/encryptQuery.ts";
import { validateVideoId } from "../../lib/helpers/validateVideoId.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../../constants.ts";

const PRIVATE_PARAM_NAMES = ["pot", "ip"];

const dashManifest = new Hono();

dashManifest.get("/:videoId", async (c) => {
    const { videoId } = c.req.param();
    const { check, local } = c.req.query();
    c.header("access-control-allow-origin", "*");

    const innertubeClient = c.get("innertubeClient");
    const config = c.get("config");
    const metrics = c.get("metrics");
    const tokenMinter = c.get("tokenMinter");

    // Check if tokenMinter is ready (only needed when PO token is enabled)
    if (config.jobs.youtube_session.po_token_enabled && !tokenMinter) {
        throw new HTTPException(503, {
            res: new Response(TOKEN_MINTER_NOT_READY_MESSAGE),
        });
    }

    if (!validateVideoId(videoId)) {
        throw new HTTPException(400, {
            res: new Response("Invalid video ID format."),
        });
    }

    if (config.server.verify_requests && check == undefined) {
        throw new HTTPException(400, {
            res: new Response("No check ID."),
        });
    } else if (config.server.verify_requests && check) {
        if (verifyRequest(check, videoId, config) === false) {
            throw new HTTPException(400, {
                res: new Response("ID incorrect."),
            });
        }
    }

    const youtubePlayerResponseJson = await youtubePlayerParsing({
        innertubeClient,
        videoId,
        config,
        tokenMinter: tokenMinter!,
        metrics,
    });
    let videoInfo = youtubeVideoInfo(
        innertubeClient,
        youtubePlayerResponseJson,
    );

    // Live / Post-Live-DVR URLs carry a po_token YouTube ages out within
    // minutes, but player responses are cached for an hour — so a cached
    // response hands out already-dead segment URLs (403) even though the
    // manifest builds fine. Re-fetch uncached for these, so each request gets
    // a freshly minted token (this is what FreeTube effectively does by
    // minting a content po_token per playback).
    if (
        videoInfo.basic_info?.is_post_live_dvr || videoInfo.basic_info?.is_live
    ) {
        const fresh = await youtubePlayerParsing({
            innertubeClient,
            videoId,
            config,
            tokenMinter: tokenMinter!,
            metrics,
            overrideCache: true,
        });
        videoInfo = youtubeVideoInfo(innertubeClient, fresh);
    }

    if (videoInfo.playability_status?.status !== "OK") {
        throw ("The video can't be played: " + videoId + " due to reason: " +
            videoInfo.playability_status?.reason);
    }

    c.header("content-type", "application/dash+xml");

    if (videoInfo.streaming_data) {
        // video.js only support MP4 not WEBM
        videoInfo.streaming_data.adaptive_formats = videoInfo
            .streaming_data.adaptive_formats
            .filter((i) => i.mime_type.includes("mp4"));

        const player_response = videoInfo.page[0];
        // TODO: fix include storyboards in DASH manifest file
        //const storyboards = player_response.storyboards;
        const captions = player_response.captions?.caption_tracks;

        const isPostLiveDvr = Boolean(
            videoInfo.page[0].video_details?.is_post_live_dvr,
        );
        // Post-Live-DVR manifest generation makes YouTube.js fetch a media
        // segment (getPostLiveDvrInfo) using the URL this transformer returns.
        // For local proxying that URL is normally a bare path (`/companion/...`),
        // and Deno's fetch() rejects a relative URL — the iv-org/invidious-companion#249
        // 500. Prefix the companion's own absolute base for DVR so that internal
        // fetch resolves; the browser resolves the same absolute URL to the
        // companion proxy too. Non-DVR keeps the bare path (unchanged).
        const serverBaseUrl = (Deno.env.get("SERVER_BASE_URL") || "").replace(
            /\/+$/,
            "",
        );

        const dashFile = await FormatUtils.toDash(
            videoInfo.streaming_data,
            videoInfo.page[0].video_details?.is_post_live_dvr,
            (url: URL) => {
                let dashUrl = url;
                const queryParams = new URLSearchParams(dashUrl.search);
                // Can't create URL type without host part
                queryParams.set("host", dashUrl.host);

                if (local) {
                    if (config.networking.videoplayback.ump) {
                        queryParams.set("ump", "yes");
                    }
                    if (
                        config.server.encrypt_query_params
                    ) {
                        const privateParams = [...queryParams].filter(([key]) =>
                            PRIVATE_PARAM_NAMES.includes(key)
                        );
                        const encryptedParams = encryptQuery(
                            JSON.stringify(privateParams),
                            config,
                        );

                        for (const param of PRIVATE_PARAM_NAMES) {
                            queryParams.delete(param);
                        }

                        queryParams.set("enc", "true");
                        queryParams.set("data", encryptedParams);
                    }
                    const proxyBase = isPostLiveDvr && serverBaseUrl
                        ? serverBaseUrl
                        : "";
                    dashUrl = (proxyBase + config.server.base_path +
                        dashUrl.pathname + "?" +
                        queryParams.toString()) as unknown as URL;
                    return dashUrl;
                } else {
                    return dashUrl;
                }
            },
            undefined,
            videoInfo.cpn,
            undefined,
            innertubeClient.actions,
            undefined,
            captions,
            undefined,
        );
        return c.body(dashFile);
    }
});

export default dashManifest;
