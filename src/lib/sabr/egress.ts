import {
    generateRandomIPv6,
    watchPlayerResponse,
} from "../helpers/ipv6Rotation.ts";

/** The fetch a SABR session talks to YouTube with. */
export type SessionFetch = typeof fetch;

const IPV6_BLOCK = Deno.env.get("NETWORKING_IPV6_BLOCK") || "";
// A session lives up to SABR_SESSION_TTL_MS (4 h by default) before the
// route opens a fresh one; its client is closed an hour after that.
const CLIENT_LIFETIME_MS = Number(
    Deno.env.get("SABR_SESSION_TTL_MS") || 4 * 3600_000,
) + 3600_000;

/**
 * A fetch that sends everything from one random address of
 * NETWORKING_IPV6_BLOCK — one address per SABR session, not per request,
 * because the streaming URL YouTube hands out is bound to the address that
 * asked for it. Plain `fetch` when no block is configured.
 */
export function sessionFetch(): SessionFetch {
    if (!IPV6_BLOCK) return fetch;
    const localAddress = generateRandomIPv6(IPV6_BLOCK);
    const client = Deno.createHttpClient({ localAddress });
    const timer = setTimeout(() => {
        try {
            client.close();
        } catch {
            // already closed
        }
    }, CLIENT_LIFETIME_MS);
    Deno.unrefTimer(timer);
    return (async (input, init) => {
        const res = await fetch(
            input,
            { ...(init ?? {}), client } as RequestInit,
        );
        // Player answers count for the session's /64: repeated "not a bot"
        // verdicts list it, so later sessions pick another one.
        watchPlayerResponse(input, res, localAddress, init);
        return res;
    }) as SessionFetch;
}
