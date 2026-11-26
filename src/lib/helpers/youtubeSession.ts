/**
 * One egress address per YouTube session.
 *
 * Per-request IPv6 rotation (a new random address of NETWORKING_IPV6_BLOCK for
 * every request) spread one YouTube session across hundreds of /64s: the
 * visitor data, the BotGuard challenge and the integrity token for a PO token
 * each came from a different address, and every player request made with that
 * one token and visitor data came from yet another. No real client looks like
 * that; a token shared by a bot farm does. 2026-11-26: after days of it
 * YouTube answered "Sign in to confirm you're not a bot" to WEB requests from
 * any address of the /56 (and to most ANDROID_VR ones), while the same code
 * leaving from one IPv4 address validated its PO token at once.
 *
 * So with NETWORKING_IPV6_ROTATION=session (the default) a session is tied to
 * one address:
 *  - `drawSessionAddress` picks a random address (skipping flagged /64s) when
 *    a session is made: the PO token job, the JSDOM fallback worker, or a new
 *    Innertube client without PO tokens. Everything that session sends (visitor
 *    data, attestation, validation, player and fallback-client requests,
 *    captions) uses a fetch pinned to it (`getFetchClient(config, {
 *    localAddress })`).
 *  - `commitSessionAddress` makes it the current address once the session is
 *    live (after its PO token validated), so a failed attempt never replaces a
 *    working session; every retry draws a new address.
 *  - Requests that belong to no session (`getFetchClient(config)` unpinned)
 *    leave from the current session's address instead of a random one
 *    (`egressAddress`).
 *  - The session rotates early, instead of waiting for the hourly
 *    regeneration, when its /64 is flagged or when it draws
 *    NETWORKING_IPV6_SESSION_ROTATE_STRIKES (5) "not a bot" answers in a row,
 *    WEB included (a stale token is a reason to make a new session too). At
 *    most once per NETWORKING_IPV6_SESSION_ROTATE_MIN_INTERVAL_MS (5 min).
 *
 * SABR sessions (`lib/sabr/egress.ts`) already use one address each, with
 * their own visitor data, so they stay on their own addresses.
 *
 * NETWORKING_IPV6_ROTATION=request restores the old per-request rotation.
 * State is per isolate; the JSDOM worker is handed its session's address.
 */
import {
    generateRandomIPv6,
    onIPv6Flagged,
    onIPv6Verdict,
    prefix64,
} from "./ipv6Rotation.ts";

export type Ipv6RotationMode = "session" | "request";

/** NETWORKING_IPV6_ROTATION: `session` (default) or `request`. */
export function ipv6RotationMode(): Ipv6RotationMode {
    const raw = (Deno.env.get("NETWORKING_IPV6_ROTATION") ?? "").trim()
        .toLowerCase();
    return raw === "request" ? "request" : "session";
}

function envNumber(name: string, fallback: number, min: number): number {
    const value = Math.floor(Number(Deno.env.get(name) || fallback));
    return Number.isFinite(value) && value >= min ? value : fallback;
}

let current: string | undefined;
let rotate: ((why: string) => void) | undefined;
let botsInARow = 0;
let lastRotationAt = 0;

/**
 * A fresh address for a new session, or undefined when there is no block or
 * rotation is per request (callers then pass no `localAddress`).
 */
export function drawSessionAddress(
    ipv6Block: string | null | undefined,
): string | undefined {
    if (!ipv6Block || ipv6RotationMode() !== "session") return undefined;
    return generateRandomIPv6(ipv6Block);
}

/** Make `address` the live session's address (undefined clears it). */
export function commitSessionAddress(address: string | undefined): void {
    if (address === current) return;
    current = address;
    botsInARow = 0;
    if (address) {
        console.log(
            `[INFO] IPv6 YouTube session now leaves from ${address} (${
                prefix64(address)
            })`,
        );
    }
}

/** The live session's address, if any. */
export function currentSessionAddress(): string | undefined {
    return current;
}

/**
 * The address a request leaves from: the pinned one, else (session mode) the
 * live session's, else a random one per request. Undefined without a block.
 */
export function egressAddress(
    ipv6Block: string | null | undefined,
    pinned: string | undefined,
): string | undefined {
    if (!ipv6Block) return undefined;
    if (pinned) return pinned;
    if (ipv6RotationMode() === "session" && current) return current;
    return generateRandomIPv6(ipv6Block);
}

/**
 * Register what makes a new session (main.ts). Called with the reason when
 * the live session should rotate early.
 */
export function onSessionRotationNeeded(
    callback: ((why: string) => void) | undefined,
): void {
    rotate = callback;
}

function requestRotation(why: string, now = Date.now()): void {
    const minInterval = envNumber(
        "NETWORKING_IPV6_SESSION_ROTATE_MIN_INTERVAL_MS",
        5 * 60_000,
        0,
    );
    if (!rotate || now - lastRotationAt < minInterval) return;
    lastRotationAt = now;
    botsInARow = 0;
    console.log(
        `[INFO] IPv6 YouTube session on ${
            current ? prefix64(current) : "?"
        }: ${why}; making a new session on another address`,
    );
    try {
        rotate(why);
    } catch (err) {
        console.log("[WARN] IPv6 session rotation failed to start", { err });
    }
}

function isCurrent(address: string): boolean {
    return Boolean(current) && prefix64(address) === prefix64(current!);
}

/** Count a player answer for the live session (exported for tests). */
export function recordSessionVerdict(
    address: string,
    verdict: "bot" | "ok",
    now = Date.now(),
): void {
    if (ipv6RotationMode() !== "session" || !isCurrent(address)) return;
    if (verdict === "ok") {
        botsInARow = 0;
        return;
    }
    botsInARow++;
    const strikes = envNumber("NETWORKING_IPV6_SESSION_ROTATE_STRIKES", 5, 1);
    if (botsInARow >= strikes) {
        requestRotation(`${botsInARow} "not a bot" answers in a row`, now);
    }
}

/** React to a newly flagged /64 (exported for tests). */
export function recordFlaggedPrefix(prefix: string, now = Date.now()): void {
    if (ipv6RotationMode() !== "session" || !current) return;
    if (prefix === prefix64(current)) {
        requestRotation("its /64 was flagged", now);
    }
}

onIPv6Verdict((address, verdict) => recordSessionVerdict(address, verdict));
onIPv6Flagged((prefix) => recordFlaggedPrefix(prefix));

/** Forget the session state (tests). */
export function resetYoutubeSession(): void {
    current = undefined;
    rotate = undefined;
    botsInARow = 0;
    lastRotationAt = 0;
}
