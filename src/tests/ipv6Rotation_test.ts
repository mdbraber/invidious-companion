import { assertEquals, assertThrows } from "./deps.ts";
import {
    clearIPv6Flags,
    generateRandomIPv6,
    isIPv6Flagged,
    isIPv6InBlock,
    markIPv6Flagged,
    prefix64,
    recordIPv6Verdict,
    watchPlayerResponse,
} from "../lib/helpers/ipv6Rotation.ts";

Deno.test("generateRandomIPv6 - generates valid IPv6 addresses", () => {
    const ipv6Block = "2001:db8::/32";

    // Generate multiple addresses to ensure randomness
    const addresses = new Set<string>();
    for (let i = 0; i < 100; i++) {
        const addr = generateRandomIPv6(ipv6Block);
        addresses.add(addr);

        // Verify the address starts with the correct prefix
        // For /32 block, the first 32 bits should match
        // 2001:db8 = first 32 bits
        const parts = addr.split(":");
        assertEquals(parts[0], "2001");
        assertEquals(parts[1], "db8");
    }

    // Ensure we got different addresses (high probability with randomization)
    // At least 50 unique addresses out of 100 should be generated
    assertEquals(addresses.size > 50, true);
});

Deno.test("generateRandomIPv6 - handles different block sizes", () => {
    // Test with /32 block
    const addr32 = generateRandomIPv6("2001:db8::/32");
    const parts32 = addr32.split(":");
    assertEquals(parts32[0], "2001");
    assertEquals(parts32[1], "db8");

    // Test with /48 block
    const addr48 = generateRandomIPv6("2001:db8:1234::/48");
    const parts48 = addr48.split(":");
    assertEquals(parts48[0], "2001");
    assertEquals(parts48[1], "db8");
    assertEquals(parts48[2], "1234");

    // Test with /64 block
    const addr64 = generateRandomIPv6("2001:db8::/64");
    const parts64 = addr64.split(":");
    assertEquals(parts64[0], "2001");
    assertEquals(parts64[1], "db8");
});

Deno.test("generateRandomIPv6 - throws error for invalid block size", () => {
    assertThrows(
        () => generateRandomIPv6("2001:db8::/129"),
        Error,
        "Invalid IPv6 block size",
    );

    assertThrows(
        () => generateRandomIPv6("2001:db8::/0"),
        Error,
        "Invalid IPv6 block size",
    );
});

Deno.test("generateRandomIPv6 - handles compressed IPv6 notation", () => {
    const ipv6Block = "2001:db8::/32";
    const addr = generateRandomIPv6(ipv6Block);

    // Address should be valid IPv6
    const parts = addr.split(":");
    assertEquals(parts.length >= 3, true); // At least some parts should be present
    assertEquals(parts[0], "2001");
    assertEquals(parts[1], "db8");
});

Deno.test("isIPv6InBlock - matches addresses inside the block only", () => {
    const block = "2a02:a45d:15fe:15:fffe::/80";
    assertEquals(
        isIPv6InBlock("2a02:a45d:15fe:15:fffe:e473:8d35:b463", block),
        true,
    );
    assertEquals(isIPv6InBlock("2a02:a45d:15fe:15:fffe::1", block), true);
    // Same /64, outside the /80.
    assertEquals(
        isIPv6InBlock("2a02:a45d:15fe:15:ffff:e473:8d35:b463", block),
        false,
    );
    assertEquals(isIPv6InBlock("2a02:a45d:15fe:15::11", block), false);
    // Every generated address is inside its block.
    for (let i = 0; i < 100; i++) {
        assertEquals(isIPv6InBlock(generateRandomIPv6(block), block), true);
    }
});

Deno.test("isIPv6InBlock - rejects what is not an IPv6 address", () => {
    const block = "2001:db8::/32";
    assertEquals(isIPv6InBlock("77.171.108.25", block), false);
    assertEquals(isIPv6InBlock("", block), false);
    assertEquals(isIPv6InBlock("2001:db8::1::2", block), false);
    assertEquals(isIPv6InBlock("2001:db8:0:0:0:0:0:0:1", block), false);
    assertEquals(isIPv6InBlock("2001:db8::12345", block), false);
    assertEquals(isIPv6InBlock("2001:db8::1%eth0", block), false);
    assertEquals(isIPv6InBlock("2001:db8::1", "2001:db8::/129"), false);
});

Deno.test("prefix64 - normalises to the /64", () => {
    assertEquals(prefix64("2001:db8:0:f3c::1"), "2001:db8:0:f3c::/64");
    assertEquals(
        prefix64("2001:0db8:0000:0f3c:dead:beef:0:1"),
        "2001:db8:0:f3c::/64",
    );
});

Deno.test("generateRandomIPv6 - skips flagged /64s", () => {
    clearIPv6Flags();
    const block = "2001:db8:0:f00::/56";
    // flag 255 of the 256 /64s; only 2001:db8:0:f42::/64 stays clean
    for (let i = 0; i < 256; i++) {
        if (i === 0x42) continue;
        markIPv6Flagged(
            `2001:db8:0:f${i.toString(16).padStart(2, "0")}::1`,
            "test",
        );
    }
    let clean = 0;
    for (let i = 0; i < 200; i++) {
        const addr = generateRandomIPv6(block);
        assertEquals(isIPv6InBlock(addr, block), true);
        if (prefix64(addr) === "2001:db8:0:f42::/64") clean++;
    }
    // 64 draws per call: P(miss the single clean /64) = (255/256)^64 ~ 78%,
    // so expect ~44 of 200; what matters is that it is far above 200/256
    assertEquals(clean > 15, true);
    clearIPv6Flags();
});

Deno.test("generateRandomIPv6 - falls back when the whole block is flagged", () => {
    clearIPv6Flags();
    const block = "2001:db8:0:1::/64";
    markIPv6Flagged("2001:db8:0:1::5", "test");
    const addr = generateRandomIPv6(block);
    assertEquals(isIPv6InBlock(addr, block), true);
    assertEquals(isIPv6Flagged(addr), true);
    clearIPv6Flags();
});

Deno.test("markIPv6Flagged - expires after the TTL", () => {
    clearIPv6Flags();
    const now = Date.now();
    markIPv6Flagged("2001:db8:0:2::1", "test", now);
    assertEquals(isIPv6Flagged("2001:db8:0:2::abcd", now + 1000), true);
    assertEquals(isIPv6Flagged("2001:db8:0:3::1", now + 1000), false);
    assertEquals(isIPv6Flagged("2001:db8:0:2::1", now + 25 * 3600_000), false);
    clearIPv6Flags();
});

function playerResponse(status: string, reason: string): Response {
    return new Response(
        JSON.stringify({ playabilityStatus: { status, reason } }),
        { status: 200, headers: { "content-type": "application/json" } },
    );
}

async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 20));
}

const BOT = "Sign in to confirm you’re not a bot";
const PLAYER_URL =
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";

async function watch(
    status: string,
    reason: string,
    address: string,
    init?: RequestInit,
    url = PLAYER_URL,
): Promise<void> {
    const res = playerResponse(status, reason);
    watchPlayerResponse(url, res, address, init);
    await res.text(); // the caller still gets the whole body
    await settle();
}

Deno.test("recordIPv6Verdict - lists a /64 only after 3 verdicts in a row", () => {
    clearIPv6Flags();
    const now = Date.now();
    recordIPv6Verdict("2001:db8:0:20::1", "bot", "test", now);
    recordIPv6Verdict("2001:db8:0:20::2", "bot", "test", now + 1);
    assertEquals(isIPv6Flagged("2001:db8:0:20::3", now + 2), false);
    recordIPv6Verdict("2001:db8:0:20::3", "bot", "test", now + 2);
    assertEquals(isIPv6Flagged("2001:db8:0:20::4", now + 3), true);
    clearIPv6Flags();
});

Deno.test("recordIPv6Verdict - an OK clears strikes and the listing", () => {
    clearIPv6Flags();
    const now = Date.now();
    recordIPv6Verdict("2001:db8:0:21::1", "bot", "test", now);
    recordIPv6Verdict("2001:db8:0:21::1", "bot", "test", now + 1);
    recordIPv6Verdict("2001:db8:0:21::1", "ok", "", now + 2);
    recordIPv6Verdict("2001:db8:0:21::1", "bot", "test", now + 3);
    recordIPv6Verdict("2001:db8:0:21::1", "bot", "test", now + 4);
    assertEquals(isIPv6Flagged("2001:db8:0:21::1", now + 5), false);

    markIPv6Flagged("2001:db8:0:22::1", "test", now);
    recordIPv6Verdict("2001:db8:0:22::9", "ok", "", now + 1);
    assertEquals(isIPv6Flagged("2001:db8:0:22::1", now + 2), false);
    clearIPv6Flags();
});

Deno.test("recordIPv6Verdict - strikes older than the TTL start over", () => {
    clearIPv6Flags();
    const now = Date.now();
    recordIPv6Verdict("2001:db8:0:23::1", "bot", "test", now);
    recordIPv6Verdict("2001:db8:0:23::1", "bot", "test", now + 1);
    const later = now + 25 * 3600_000;
    recordIPv6Verdict("2001:db8:0:23::1", "bot", "test", later);
    assertEquals(isIPv6Flagged("2001:db8:0:23::1", later + 1), false);
    clearIPv6Flags();
});

Deno.test("watchPlayerResponse - counts 'not a bot' and OK only", async () => {
    clearIPv6Flags();
    for (let i = 0; i < 3; i++) {
        await watch("LOGIN_REQUIRED", BOT, `2001:db8:0:10::${i + 1}`);
    }
    assertEquals(isIPv6Flagged("2001:db8:0:10::99"), true);

    for (let i = 0; i < 3; i++) {
        await watch(
            "LOGIN_REQUIRED",
            "Sign in to confirm your age",
            "2001:db8:0:11::1",
        );
    }
    assertEquals(isIPv6Flagged("2001:db8:0:11::1"), false);

    await watch("LOGIN_REQUIRED", BOT, "2001:db8:0:12::1");
    await watch("LOGIN_REQUIRED", BOT, "2001:db8:0:12::1");
    await watch("OK", "", "2001:db8:0:12::1");
    await watch("LOGIN_REQUIRED", BOT, "2001:db8:0:12::1");
    assertEquals(isIPv6Flagged("2001:db8:0:12::1"), false);

    for (let i = 0; i < 3; i++) {
        await watch(
            "LOGIN_REQUIRED",
            "not a bot",
            "2001:db8:0:13::1",
            undefined,
            "https://www.youtube.com/youtubei/v1/next",
        );
    }
    assertEquals(isIPv6Flagged("2001:db8:0:13::1"), false);
    clearIPv6Flags();
});

Deno.test("watchPlayerResponse - ignores WEB requests", async () => {
    clearIPv6Flags();
    const web = {
        method: "POST",
        body: JSON.stringify({ context: { client: { clientName: "WEB" } } }),
    };
    const pot = {
        method: "POST",
        body: JSON.stringify({
            context: { client: { clientName: "MWEB" } },
            serviceIntegrityDimensions: { poToken: "x" },
        }),
    };
    for (let i = 0; i < 3; i++) {
        await watch("LOGIN_REQUIRED", BOT, "2001:db8:0:14::1", web);
        await watch("LOGIN_REQUIRED", BOT, "2001:db8:0:15::1", pot);
    }
    assertEquals(isIPv6Flagged("2001:db8:0:14::1"), false);
    assertEquals(isIPv6Flagged("2001:db8:0:15::1"), false);

    const vr = {
        method: "POST",
        body: JSON.stringify({
            context: { client: { clientName: "ANDROID_VR" } },
        }),
    };
    for (let i = 0; i < 3; i++) {
        await watch("LOGIN_REQUIRED", BOT, "2001:db8:0:16::1", vr);
    }
    assertEquals(isIPv6Flagged("2001:db8:0:16::1"), true);
    clearIPv6Flags();
});
