import { Innertube } from "youtubei.js";
import {
    youtubePlayerParsing,
    youtubeVideoInfo,
} from "../helpers/youtubePlayerHandling.ts";
import type { Config } from "../helpers/config.ts";
import { Metrics } from "../helpers/metrics.ts";
import {
    closeCamoufoxPoTokenRuntime,
    createCamoufoxPoTokenGeneration,
} from "./camoufox.ts";
import { BrowserPoTokenUnavailableError } from "../potoken/errors.ts";
import { InputMessage, OutputMessageSchema } from "./worker.ts";
import { drawSessionAddress } from "../helpers/youtubeSession.ts";
let getFetchClientLocation = "getFetchClient";
if (Deno.env.get("GET_FETCH_CLIENT_LOCATION")) {
    if (Deno.env.has("DENO_COMPILED")) {
        getFetchClientLocation = Deno.mainModule.replace("src/main.ts", "") +
            Deno.env.get("GET_FETCH_CLIENT_LOCATION");
    } else {
        getFetchClientLocation = Deno.env.get(
            "GET_FETCH_CLIENT_LOCATION",
        ) as string;
    }
}
const { getFetchClient } = await import(getFetchClientLocation);

import { PLAYER_ID } from "../../constants.ts";

export type TokenMinter = (videoId: string) => Promise<string>;
let generationInFlight: Promise<PoTokenResult> | undefined;
let activeFallbackWorker: TokenGeneratorWorker | undefined;
export type PoTokenResult = {
    innertubeClient: Innertube;
    tokenMinter: TokenMinter;
    /**
     * The address the whole session leaves from (see youtubeSession.ts);
     * undefined without an IPv6 block or with per-request rotation. The
     * caller commits it once it makes this session the live one.
     */
    localAddress?: string;
};
interface TokenGeneratorWorker extends Omit<Worker, "postMessage"> {
    postMessage(message: InputMessage): void;
}

// Adapted from https://github.com/LuanRT/BgUtils/blob/main/examples/node/index.ts
export function poTokenGenerate(
    config: Config,
    metrics: Metrics | undefined,
): Promise<PoTokenResult> {
    if (generationInFlight) return generationInFlight;
    generationInFlight = generatePoToken(config, metrics).finally(() => {
        generationInFlight = undefined;
    });
    return generationInFlight;
}

async function generatePoToken(
    config: Config,
    metrics: Metrics | undefined,
): Promise<PoTokenResult> {
    // One address for the whole session: visitor data, BotGuard challenge,
    // integrity token, validation, and later every player request made with
    // this token. A retry (the caller's) draws a new one.
    const localAddress = drawSessionAddress(config.networking.ipv6_block);
    if (localAddress) {
        console.log(`[INFO] PO token session will leave from ${localAddress}`);
    }
    const fetchImpl = getFetchClient(config, { localAddress });
    let generation;
    try {
        generation = await createCamoufoxPoTokenGeneration(
            fetchImpl,
            config.youtube_session.cookies,
        );
    } catch (error) {
        if (error instanceof BrowserPoTokenUnavailableError) {
            console.warn(
                "[WARN] Camoufox is unavailable; using the JSDOM PO token fallback",
                { error },
            );
            return await generateWithJSDOM(config, metrics, localAddress);
        }
        throw error;
    }

    try {
        const instantiatedInnertubeClient = await Innertube.create({
            enable_session_cache: false,
            po_token: generation.sessionPoToken,
            visitor_data: generation.visitorData,
            user_agent: generation.userAgent,
            fetch: fetchImpl,
            generate_session_locally: true,
            cookie: config.youtube_session.cookies || undefined,
            player_id: PLAYER_ID,
        });
        await checkToken({
            instantiatedInnertubeClient,
            config,
            integrityTokenBasedMinter: generation.mint,
            metrics,
            fetchImpl,
        });
        await generation.activate();
        if (activeFallbackWorker) {
            void shutdownWorker(activeFallbackWorker);
            activeFallbackWorker = undefined;
        }
        console.log("[INFO] Successfully generated PO token with Camoufox");
        return {
            innertubeClient: instantiatedInnertubeClient,
            tokenMinter: generation.mint,
            localAddress,
        };
    } catch (error) {
        await generation.discard();
        console.log("[WARN] Failed to get valid PO token, will retry", {
            error,
        });
        throw error;
    }
}

export async function closePoTokenRuntime(): Promise<void> {
    const fallbackWorker = activeFallbackWorker;
    activeFallbackWorker = undefined;
    await Promise.all([
        fallbackWorker ? shutdownWorker(fallbackWorker) : Promise.resolve(),
        closeCamoufoxPoTokenRuntime(),
    ]);
}

function generateWithJSDOM(
    config: Config,
    metrics: Metrics | undefined,
    localAddress?: string,
): Promise<PoTokenResult> {
    const { promise, resolve, reject } = Promise.withResolvers<PoTokenResult>();
    const worker: TokenGeneratorWorker = new Worker(
        new URL("./worker.ts", import.meta.url).href,
        { type: "module", name: "JSDOM PO Token Fallback" },
    );
    let settled = false;
    const timeout = setTimeout(
        () => fail(new Error("JSDOM PO token initialization timed out")),
        5 * 60_000,
    );
    const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        worker.terminate();
        reject(error);
    };

    worker.addEventListener("error", (event) => {
        fail(event.error ?? new Error(event.message));
    });
    worker.addEventListener("messageerror", () => {
        fail(new Error("Could not deserialize JSDOM worker message"));
    });
    worker.addEventListener("message", async (event) => {
        const result = OutputMessageSchema.safeParse(event.data);
        if (!result.success) {
            fail(new Error("Invalid JSDOM worker response"));
            return;
        }
        const message = result.data;
        if (message.type === "ready") {
            worker.postMessage({ type: "initialise", config, localAddress });
            return;
        }
        if (message.type === "error") {
            fail(new Error(message.error));
            return;
        }
        if (message.type !== "initialised") return;

        try {
            const fetchImpl = getFetchClient(config, { localAddress });
            const instantiatedInnertubeClient = await Innertube.create({
                enable_session_cache: false,
                po_token: message.sessionPoToken,
                visitor_data: message.visitorData,
                fetch: fetchImpl,
                generate_session_locally: true,
                cookie: config.youtube_session.cookies || undefined,
                player_id: PLAYER_ID,
            });
            const minter = createJSDOMMinter(worker);
            await checkToken({
                instantiatedInnertubeClient,
                config,
                integrityTokenBasedMinter: minter,
                metrics,
                fetchImpl,
            });
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            const previousWorker = activeFallbackWorker;
            activeFallbackWorker = worker;
            if (previousWorker && previousWorker !== worker) {
                void shutdownWorker(previousWorker);
            }
            console.log("[INFO] Successfully generated PO token with JSDOM");
            resolve({
                innertubeClient: instantiatedInnertubeClient,
                tokenMinter: minter,
                localAddress,
            });
        } catch (error) {
            fail(error);
        }
    });
    return promise;
}

function createJSDOMMinter(worker: TokenGeneratorWorker): TokenMinter {
    return (videoId) => {
        const { promise, resolve, reject } = Promise.withResolvers<string>();
        const requestId = crypto.randomUUID();
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`PO token mint timed out for video ${videoId}`));
        }, 30_000);
        const cleanup = () => {
            clearTimeout(timeout);
            worker.removeEventListener("message", listener);
            worker.removeEventListener("error", errorListener);
        };
        const errorListener = (event: ErrorEvent) => {
            cleanup();
            reject(event.error ?? new Error(event.message));
        };
        const listener = (event: MessageEvent) => {
            const result = OutputMessageSchema.safeParse(event.data);
            if (!result.success) return;
            const message = result.data;
            if (
                message.type === "content-token" &&
                message.requestId === requestId
            ) {
                cleanup();
                resolve(message.contentToken);
            } else if (
                message.type === "content-token-error" &&
                message.requestId === requestId
            ) {
                cleanup();
                reject(new Error(message.error));
            }
        };
        worker.addEventListener("message", listener);
        worker.addEventListener("error", errorListener);
        worker.postMessage({
            type: "content-token-request",
            videoId,
            requestId,
        });
        return promise;
    };
}

function shutdownWorker(worker: TokenGeneratorWorker): Promise<void> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            worker.removeEventListener("message", listener);
            worker.terminate();
            resolve();
        };
        const timeout = setTimeout(finish, 5_000);
        const listener = (event: MessageEvent) => {
            const result = OutputMessageSchema.safeParse(event.data);
            if (result.success && result.data.type === "shutdown") finish();
        };
        worker.addEventListener("message", listener);
        try {
            worker.postMessage({ type: "shutdown" });
        } catch {
            finish();
        }
    });
}

async function checkToken({
    instantiatedInnertubeClient,
    config,
    integrityTokenBasedMinter,
    metrics,
    fetchImpl,
}: {
    instantiatedInnertubeClient: Innertube;
    config: Config;
    integrityTokenBasedMinter: TokenMinter;
    metrics: Metrics | undefined;
    /** The session's fetch: the stream URL is checked from its address. */
    fetchImpl: ReturnType<typeof getFetchClient>;
}) {
    try {
        console.log("[INFO] Searching for videos to validate PO token");
        const searchResults = await instantiatedInnertubeClient.search("news", {
            type: "video",
            upload_date: "week",
            duration: "three_to_twenty_mins",
        });

        // Get all videos that have an id property and shuffle them randomly
        const videos = searchResults.videos
            .filter((video) =>
                video.type === "Video" && "id" in video && video.id
            )
            .map((value) => ({ value, sort: Math.random() }))
            .sort((a, b) => a.sort - b.sort)
            .map(({ value }) => value);

        if (videos.length === 0) {
            throw new Error("No videos with valid IDs found in search results");
        }

        // Try up to 3 random videos to validate the token. Each failure is
        // recorded so the final error says why, not just that it failed.
        const maxAttempts = Math.min(3, videos.length);
        const failures: string[] = [];
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const video = videos[attempt];

            try {
                // Type guard to ensure video has an id property
                if (!("id" in video) || !video.id) {
                    console.log(
                        `[WARN] Video at index ${attempt} has no valid ID, trying next video`,
                    );
                    continue;
                }

                console.log(
                    `[INFO] Validating PO token with video: ${video.id}`,
                );

                const youtubePlayerResponseJson = await youtubePlayerParsing({
                    innertubeClient: instantiatedInnertubeClient,
                    videoId: video.id,
                    config,
                    tokenMinter: integrityTokenBasedMinter,
                    metrics,
                    overrideCache: true,
                });

                const videoInfo = youtubeVideoInfo(
                    instantiatedInnertubeClient,
                    youtubePlayerResponseJson,
                );

                const validFormat = videoInfo.streaming_data
                    ?.adaptive_formats[0];
                if (!validFormat) {
                    const playability = (youtubePlayerResponseJson as {
                        playabilityStatus?: {
                            status?: string;
                            reason?: string;
                        };
                    }).playabilityStatus;
                    const why = `no formats (playability ${
                        playability?.status ?? "missing"
                    }${playability?.reason ? `: ${playability.reason}` : ""})`;
                    failures.push(`${video.id}: ${why}`);
                    console.log(
                        `[WARN] No valid format found for video ${video.id}: ${why}, trying next video`,
                    );
                    continue;
                }

                // A two-byte GET, not HEAD: googlevideo now refuses HEAD on
                // some stream URLs (seen 2026-11-03) while serving the data.
                const result = await fetchImpl(validFormat?.url, {
                    method: "GET",
                    headers: { range: "bytes=0-1" },
                });
                await result.body?.cancel();

                if (result.status !== 200 && result.status !== 206) {
                    failures.push(`${video.id}: HTTP ${result.status}`);
                    console.log(
                        `[WARN] Got status ${result.status} for video ${video.id}, trying next video`,
                    );
                    continue;
                } else {
                    console.log(
                        `[INFO] Successfully validated PO token with video: ${video.id}`,
                    );
                    return; // Success
                }
            } catch (err) {
                const videoId = ("id" in video && video.id)
                    ? video.id
                    : "unknown";
                console.log(
                    `[WARN] Failed to validate with video ${videoId}:`,
                    { err },
                );
                if (attempt === maxAttempts - 1) {
                    throw new Error(
                        "Failed to validate PO token with any available videos",
                    );
                }
                continue;
            }
        }
        // If we reach here, all attempts failed without throwing an exception
        throw new Error(
            `Failed to validate PO token: no video validated (${
                failures.join("; ")
            })`,
        );
    } catch (err) {
        console.log("Failed to validate PO token using search method", { err });
        throw err;
    }
}
