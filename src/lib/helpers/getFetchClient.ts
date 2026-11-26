import { retry, type RetryOptions } from "@std/async";
import type { Config } from "./config.ts";
import {
    generateRandomIPv6,
    isIPv6InBlock,
    watchPlayerResponse,
} from "./ipv6Rotation.ts";

type FetchInputParameter = Parameters<typeof fetch>[0];
type FetchInitParameterWithClient =
    | RequestInit
    | RequestInit & { client: Deno.HttpClient };
type FetchReturn = ReturnType<typeof fetch>;

export type FetchClientOptions = {
    /**
     * Send every request from this address instead of a random one per
     * request. Only honoured when it lies inside the configured IPv6 block;
     * otherwise rotation behaves as usual.
     */
    localAddress?: string;
};

export const getFetchClient = (config: Config, options?: FetchClientOptions): {
    (
        input: FetchInputParameter,
        init?: FetchInitParameterWithClient,
    ): FetchReturn;
} => {
    const proxyAddress = config.networking.proxy;
    const ipv6Block = config.networking.ipv6_block;
    const pinnedAddress = ipv6Block && options?.localAddress &&
            isIPv6InBlock(options.localAddress, ipv6Block)
        ? options.localAddress
        : undefined;

    const fetchMaxAttempts = config.networking.fetch?.retry?.times;
    const fetchInitialDebounce = config.networking.fetch?.retry
        ?.initial_debounce;
    const fetchDebounceMultiplier = config.networking.fetch?.retry
        ?.debounce_multiplier;
    const retryOptions: RetryOptions = {
        maxAttempts: fetchMaxAttempts,
        minTimeout: fetchInitialDebounce,
        multiplier: fetchDebounceMultiplier,
        jitter: 0,
    };

    // If proxy or IPv6 rotation is configured, create a custom HTTP client
    // IPv6 rotation generates a unique localAddress for each request to help
    // avoid YouTube's "Please login" errors (unless the caller pinned one)
    if (proxyAddress || ipv6Block) {
        // For proxy-only (no IPv6 rotation), reuse a single client
        const reusableClient = proxyAddress && !ipv6Block
            ? Deno.createHttpClient({ proxy: { url: proxyAddress } })
            : undefined;

        return async (
            input: FetchInputParameter,
            init?: RequestInit,
        ) => {
            let client: Deno.HttpClient;
            let localAddress: string | undefined;

            if (reusableClient) {
                client = reusableClient;
            } else {
                const clientOptions: Deno.CreateHttpClientOptions = {};
                if (proxyAddress) {
                    clientOptions.proxy = { url: proxyAddress };
                }
                if (ipv6Block) {
                    localAddress = pinnedAddress ??
                        generateRandomIPv6(ipv6Block);
                    clientOptions.localAddress = localAddress;
                }
                client = Deno.createHttpClient(clientOptions);
            }

            const fetchRes = await fetchShim(config, retryOptions, input, {
                client,
                headers: init?.headers,
                method: init?.method,
                body: init?.body,
            });

            // Learn which /64s YouTube rejects as bots, so rotation skips them.
            watchPlayerResponse(input, fetchRes, localAddress, init);

            // If using a reusable client, return directly without closing
            if (reusableClient) {
                return new Response(fetchRes.body, {
                    status: fetchRes.status,
                    headers: fetchRes.headers,
                });
            }

            // For per-request clients (IPv6 rotation), close after body is consumed
            const originalBody = fetchRes.body;
            if (!originalBody) {
                client.close();
                return new Response(null, {
                    status: fetchRes.status,
                    headers: fetchRes.headers,
                });
            }

            const reader = originalBody.getReader();
            const wrappedBody = new ReadableStream({
                async pull(controller) {
                    const { done, value } = await reader.read();
                    if (done) {
                        controller.close();
                        client.close();
                        return;
                    }
                    controller.enqueue(value);
                },
                cancel() {
                    reader.cancel();
                    client.close();
                },
            });

            return new Response(wrappedBody, {
                status: fetchRes.status,
                headers: fetchRes.headers,
            });
        };
    }

    return (input: FetchInputParameter, init?: FetchInitParameterWithClient) =>
        fetchShim(config, retryOptions, input, init);
};

function fetchShim(
    config: Config,
    retryOptions: RetryOptions,
    input: FetchInputParameter,
    init?: FetchInitParameterWithClient,
): FetchReturn {
    const fetchTimeout = config.networking.fetch?.timeout_ms;
    const fetchRetry = config.networking.fetch?.retry?.enabled;

    const callFetch = () =>
        fetch(input, {
            // only set the AbortSignal if the timeout is supplied in the config
            signal: fetchTimeout
                ? AbortSignal.timeout(Number(fetchTimeout))
                : null,
            ...(init || {}),
        });
    // if retry enabled, call retry with the fetch shim, otherwise pass the fetch shim back directly
    return fetchRetry ? retry(callFetch, retryOptions) : callFetch();
}
