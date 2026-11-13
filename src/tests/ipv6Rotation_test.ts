import { assertEquals, assertThrows } from "./deps.ts";
import {
    generateRandomIPv6,
    isIPv6InBlock,
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
