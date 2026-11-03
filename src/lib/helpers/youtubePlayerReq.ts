import { ApiResponse, Innertube } from "youtubei.js";
import NavigationEndpoint from "youtubei.js/NavigationEndpoint";
import type { TokenMinter } from "../jobs/potoken.ts";

import type { Config } from "./config.ts";

function callWatchEndpoint(
    videoId: string,
    innertubeClient: Innertube,
    innertubeClientType: string,
    contentPoToken: string,
) {
    const watch_endpoint = new NavigationEndpoint({
        watchEndpoint: {
            videoId: videoId,
            // Allow companion to gather sensitive content videos like
            // `VuSU7PcEKpU`
            racyCheckOk: true,
            contentCheckOk: true,
        },
    });

    return watch_endpoint.call(
        innertubeClient.actions,
        {
            playbackContext: {
                contentPlaybackContext: {
                    vis: 0,
                    splay: false,
                    lactMilliseconds: "-1",
                    signatureTimestamp: innertubeClient.session.player
                        ?.signature_timestamp,
                },
            },
            serviceIntegrityDimensions: {
                poToken: contentPoToken,
            },
            client: innertubeClientType,
        },
    );
}

export const youtubePlayerReq = async (
    innertubeClient: Innertube,
    videoId: string,
    config: Config,
    tokenMinter: TokenMinter,
): Promise<ApiResponse> => {
    const innertubeClientOauthEnabled = config.youtube_session.oauth_enabled;

    let innertubeClientUsed = "WEB";
    if (innertubeClientOauthEnabled) {
        innertubeClientUsed = "TV";
    }

    const contentPoToken = await tokenMinter(videoId);

    const youtubePlayerResponse = await callWatchEndpoint(
        videoId,
        innertubeClient,
        innertubeClientUsed,
        contentPoToken,
    );

    // Fall back to other YT clients when the first adaptive format has no
    // URL. A signatureCipher is fine: youtubePlayerParsing deciphers it.
    const firstAdaptive = youtubePlayerResponse.data.streamingData
        ?.adaptiveFormats?.[0];

    if (
        !innertubeClientOauthEnabled &&
        firstAdaptive &&
        firstAdaptive.url === undefined &&
        firstAdaptive.signatureCipher === undefined
    ) {
        console.log(
            "[WARNING] No URLs found for adaptive formats. Falling back to other YT clients.",
        );
        const innertubeClientsTypeFallback = [
            "TV_SIMPLY",
            "ANDROID_VR",
            "MWEB",
        ];

        for await (const innertubeClientType of innertubeClientsTypeFallback) {
            console.log(
                `[WARNING] Trying fallback YT client ${innertubeClientType}`,
            );
            // One client failing (e.g. TV_SIMPLY answering 400 "Request
            // contains an invalid argument" for signed-in sessions) must not
            // stop the others from being tried.
            let youtubePlayerResponseFallback: ApiResponse;
            try {
                youtubePlayerResponseFallback = await callWatchEndpoint(
                    videoId,
                    innertubeClient,
                    innertubeClientType,
                    contentPoToken,
                );
            } catch (err) {
                console.log(
                    `[WARNING] Fallback YT client ${innertubeClientType} failed: ${
                        (err as Error).message
                    }`,
                );
                continue;
            }
            if (
                youtubePlayerResponseFallback.data.streamingData && (
                    youtubePlayerResponseFallback.data.streamingData
                        .adaptiveFormats[0].url ||
                    youtubePlayerResponseFallback.data.streamingData
                        .adaptiveFormats[0].signatureCipher
                )
            ) {
                const fallbackFormats =
                    youtubePlayerResponseFallback.data.streamingData.formats;
                if (fallbackFormats?.length) {
                    youtubePlayerResponse.data.streamingData.formats =
                        fallbackFormats;
                }
                youtubePlayerResponse.data.streamingData.adaptiveFormats =
                    youtubePlayerResponseFallback.data.streamingData
                        .adaptiveFormats;
                console.log(
                    `[INFO] Using formats from fallback YT client ${innertubeClientType}`,
                );
                break;
            }
        }
    }

    return youtubePlayerResponse;
};
