import { assertEquals } from "./deps.ts";
import {
    clearIPv6Flags,
    isIPv6InBlock,
    markIPv6Flagged,
    prefix64,
    watchPlayerResponse,
} from "../lib/helpers/ipv6Rotation.ts";
import {
    commitSessionAddress,
    currentSessionAddress,
    drawSessionAddress,
    egressAddress,
    ipv6RotationMode,
    onSessionRotationNeeded,
    recordFlaggedPrefix,
    recordSessionVerdict,
    resetYoutubeSession,
} from "../lib/helpers/youtubeSession.ts";

const BLOCK = "2001:db8:0:f00::/56";
const BOT = "Sign in to confirm you’re not a bot";

function reset(): void {
    resetYoutubeSession();
    clearIPv6Flags();
    Deno.env.delete("NETWORKING_IPV6_ROTATION");
    Deno.env.delete("NETWORKING_IPV6_SESSION_ROTATE_STRIKES");
    Deno.env.delete("NETWORKING_IPV6_SESSION_ROTATE_MIN_INTERVAL_MS");
}

function rotations(): string[] {
    const why: string[] = [];
    onSessionRotationNeeded((reason) => why.push(reason));
    return why;
}

Deno.test("ipv6RotationMode - session unless told 'request'", () => {
    reset();
    assertEquals(ipv6RotationMode(), "session");
    Deno.env.set("NETWORKING_IPV6_ROTATION", "request");
    assertEquals(ipv6RotationMode(), "request");
    Deno.env.set("NETWORKING_IPV6_ROTATION", "bogus");
    assertEquals(ipv6RotationMode(), "session");
    reset();
});

Deno.test("drawSessionAddress - in the block, none without one or per request", () => {
    reset();
    const a = drawSessionAddress(BLOCK);
    assertEquals(typeof a, "string");
    assertEquals(isIPv6InBlock(a!, BLOCK), true);
    assertEquals(drawSessionAddress(null), undefined);
    Deno.env.set("NETWORKING_IPV6_ROTATION", "request");
    assertEquals(drawSessionAddress(BLOCK), undefined);
    reset();
});

Deno.test("drawSessionAddress - skips flagged /64s", () => {
    reset();
    for (let i = 0; i < 256; i++) {
        if (i === 0x42) continue;
        markIPv6Flagged(
            `2001:db8:0:f${i.toString(16).padStart(2, "0")}::1`,
            "test",
        );
    }
    let clean = 0;
    for (let i = 0; i < 100; i++) {
        if (prefix64(drawSessionAddress(BLOCK)!) === "2001:db8:0:f42::/64") {
            clean++;
        }
    }
    assertEquals(clean > 5, true);
    reset();
});

Deno.test("egressAddress - pinned, else the live session's, else random", () => {
    reset();
    assertEquals(egressAddress(null, undefined), undefined);
    assertEquals(
        egressAddress(BLOCK, "2001:db8:0:f01::1"),
        "2001:db8:0:f01::1",
    );
    const random = egressAddress(BLOCK, undefined)!;
    assertEquals(isIPv6InBlock(random, BLOCK), true);

    commitSessionAddress("2001:db8:0:f02::7");
    assertEquals(currentSessionAddress(), "2001:db8:0:f02::7");
    assertEquals(egressAddress(BLOCK, undefined), "2001:db8:0:f02::7");
    assertEquals(
        egressAddress(BLOCK, "2001:db8:0:f01::1"),
        "2001:db8:0:f01::1",
    );

    Deno.env.set("NETWORKING_IPV6_ROTATION", "request");
    const perRequest = new Set(
        Array.from({ length: 20 }, () => egressAddress(BLOCK, undefined)),
    );
    assertEquals(perRequest.size > 1, true);
    reset();
});

Deno.test("session - rotates after 5 'not a bot' in a row on its /64 only", () => {
    reset();
    const why = rotations();
    const now = Date.now();
    commitSessionAddress("2001:db8:0:f10::1");
    for (let i = 0; i < 4; i++) {
        recordSessionVerdict("2001:db8:0:f10::99", "bot", now + i);
    }
    // other /64s never count for the session
    for (let i = 0; i < 10; i++) {
        recordSessionVerdict("2001:db8:0:f11::1", "bot", now + 10 + i);
    }
    assertEquals(why.length, 0);
    recordSessionVerdict("2001:db8:0:f10::1", "bot", now + 30);
    assertEquals(why.length, 1);
    reset();
});

Deno.test("session - an OK resets the run; rotations are rate limited", () => {
    reset();
    const why = rotations();
    const now = Date.now();
    commitSessionAddress("2001:db8:0:f20::1");
    for (let i = 0; i < 4; i++) {
        recordSessionVerdict("2001:db8:0:f20::1", "bot", now + i);
    }
    recordSessionVerdict("2001:db8:0:f20::1", "ok", now + 5);
    for (let i = 0; i < 4; i++) {
        recordSessionVerdict("2001:db8:0:f20::1", "bot", now + 10 + i);
    }
    assertEquals(why.length, 0);
    recordSessionVerdict("2001:db8:0:f20::1", "bot", now + 20);
    assertEquals(why.length, 1);
    // a minute later the same session can't rotate again yet
    for (let i = 0; i < 5; i++) {
        recordSessionVerdict("2001:db8:0:f20::1", "bot", now + 60_000 + i);
    }
    assertEquals(why.length, 1);
    // after the 5 min interval it can
    for (let i = 0; i < 5; i++) {
        recordSessionVerdict("2001:db8:0:f20::1", "bot", now + 6 * 60_000 + i);
    }
    assertEquals(why.length, 2);
    reset();
});

Deno.test("session - rotates when its /64 is flagged", () => {
    reset();
    const why = rotations();
    commitSessionAddress("2001:db8:0:f30::1");
    recordFlaggedPrefix("2001:db8:0:f31::/64");
    assertEquals(why.length, 0);
    recordFlaggedPrefix("2001:db8:0:f30::/64");
    assertEquals(why.length, 1);
    reset();
});

Deno.test("session - nothing rotates per request or without a session", () => {
    reset();
    const why = rotations();
    for (let i = 0; i < 10; i++) {
        recordSessionVerdict("2001:db8:0:f40::1", "bot");
    }
    recordFlaggedPrefix("2001:db8:0:f40::/64");
    assertEquals(why.length, 0);
    Deno.env.set("NETWORKING_IPV6_ROTATION", "request");
    commitSessionAddress("2001:db8:0:f40::1");
    for (let i = 0; i < 10; i++) {
        recordSessionVerdict("2001:db8:0:f40::1", "bot");
    }
    assertEquals(why.length, 0);
    reset();
});

Deno.test("session - WEB 'not a bot' answers rotate it (but never flag)", async () => {
    reset();
    const why = rotations();
    commitSessionAddress("2001:db8:0:f50::1");
    const web = {
        method: "POST",
        body: JSON.stringify({ context: { client: { clientName: "WEB" } } }),
    };
    for (let i = 0; i < 5; i++) {
        const res = new Response(
            JSON.stringify({
                playabilityStatus: { status: "LOGIN_REQUIRED", reason: BOT },
            }),
            { status: 200 },
        );
        watchPlayerResponse(
            "https://www.youtube.com/youtubei/v1/player",
            res,
            "2001:db8:0:f50::1",
            web,
        );
        await res.text();
        await new Promise((r) => setTimeout(r, 20));
    }
    assertEquals(why.length, 1);
    reset();
});
