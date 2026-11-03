import { generateRandomIPv6 } from "../helpers/ipv6Rotation.ts";

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
    const client = Deno.createHttpClient({
        localAddress: generateRandomIPv6(IPV6_BLOCK),
    });
    const timer = setTimeout(() => {
        try {
            client.close();
        } catch {
            // already closed
        }
    }, CLIENT_LIFETIME_MS);
    Deno.unrefTimer(timer);
    return ((input, init) =>
        fetch(
            input,
            { ...(init ?? {}), client } as RequestInit,
        )) as SessionFetch;
}
