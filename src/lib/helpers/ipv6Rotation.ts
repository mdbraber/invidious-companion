/**
 * IPv6 Rotation Utility
 *
 * This module provides IPv6 address rotation functionality to help avoid
 * "Please login" errors from YouTube by sending each request from a unique
 * IPv6 address within a configured IPv6 block.
 *
 * Setup instructions: https://gist.github.com/unixfox/2a9dbcb23d8f69c4582f7c85a849d5cc#linux-setup
 */

/**
 * Generate a random IPv6 address within the specified IPv6 block
 * @param ipv6Block - The IPv6 block in CIDR notation (e.g., "2001:db8::/32")
 * @returns A random IPv6 address within the specified IPv6 block
 */
function drawRandomIPv6(ipv6Block: string): string {
    // Parse the IPv6 block
    const [baseAddress, blockSize] = ipv6Block.split("/");
    const blockBits = parseInt(blockSize, 10);

    if (isNaN(blockBits) || blockBits < 1 || blockBits > 128) {
        throw new Error("Invalid IPv6 block size");
    }

    // Expand IPv6 address to full form
    const expandedBase = expandIPv6(baseAddress);

    // Convert to binary representation
    const baseBytes = ipv6ToBytes(expandedBase);

    // Randomize all bits after the block prefix
    for (let i = Math.floor(blockBits / 8); i < 16; i++) {
        const bitOffset = Math.max(0, blockBits - i * 8);
        if (bitOffset === 0) {
            // Fully random byte
            baseBytes[i] = Math.floor(Math.random() * 256);
        } else if (bitOffset < 8) {
            // Partially random byte
            const mask = (1 << (8 - bitOffset)) - 1;
            const randomPart = Math.floor(Math.random() * (mask + 1));
            baseBytes[i] = (baseBytes[i] & ~mask) | randomPart;
        }
        // else: keep the original byte (bitOffset >= 8)
    }

    // Convert back to IPv6 string
    return bytesToIPv6(baseBytes);
}

/**
 * Whether `address` lies inside `ipv6Block` (CIDR notation). False for anything
 * that is not a plain IPv6 address, an IPv4 address included.
 */
export function isIPv6InBlock(address: string, ipv6Block: string): boolean {
    const [baseAddress, blockSize] = ipv6Block.split("/");
    const blockBits = parseInt(blockSize, 10);
    if (isNaN(blockBits) || blockBits < 1 || blockBits > 128) return false;
    if (!/^[0-9a-fA-F:]+$/.test(address) || !address.includes(":")) {
        return false;
    }
    const groups = address.split("::");
    if (groups.length > 2) return false;
    const count = groups.reduce(
        (n, g) => n + (g ? g.split(":").length : 0),
        0,
    );
    if (groups.length === 1 ? count !== 8 : count > 7) return false;
    if (address.split(":").some((p) => p.length > 4)) return false;

    const a = ipv6ToBytes(expandIPv6(address));
    const b = ipv6ToBytes(expandIPv6(baseAddress));
    for (let bit = 0; bit < blockBits; bit++) {
        const i = bit >> 3;
        const mask = 0x80 >> (bit & 7);
        if ((a[i] & mask) !== (b[i] & mask)) return false;
    }
    return true;
}

/**
 * Expand an IPv6 address to its full form
 */
function expandIPv6(address: string): string {
    // Handle :: expansion
    if (address.includes("::")) {
        const parts = address.split("::");
        const leftParts = parts[0] ? parts[0].split(":") : [];
        const rightParts = parts[1] ? parts[1].split(":") : [];
        const missingParts = 8 - leftParts.length - rightParts.length;
        const middle = Array(missingParts).fill("0000");
        const allParts = [...leftParts, ...middle, ...rightParts];
        return allParts.map((p) => p.padStart(4, "0")).join(":");
    }

    // Pad each part to 4 characters
    return address.split(":").map((p) => p.padStart(4, "0")).join(":");
}

/**
 * Convert IPv6 address string to byte array
 */
function ipv6ToBytes(address: string): number[] {
    const parts = address.split(":");
    const bytes: number[] = [];

    for (const part of parts) {
        const value = parseInt(part, 16);
        bytes.push((value >> 8) & 0xFF);
        bytes.push(value & 0xFF);
    }

    return bytes;
}

/**
 * Convert byte array back to IPv6 address string
 */
function bytesToIPv6(bytes: number[]): string {
    const parts: string[] = [];

    for (let i = 0; i < 16; i += 2) {
        const value = (bytes[i] << 8) | bytes[i + 1];
        parts.push(value.toString(16));
    }

    // Compress consecutive zeros
    let ipv6 = parts.join(":");

    // Find the longest sequence of consecutive zeros
    const zeroSequences = ipv6.match(/(^|:)(0:)+/g);
    if (zeroSequences) {
        const longestZeroSeq = zeroSequences.reduce((a, b) =>
            a.length > b.length ? a : b
        );
        ipv6 = ipv6.replace(longestZeroSeq, longestZeroSeq[0] + ":");
    }

    return ipv6;
}

// ---- Flagged /64s ----------------------------------------------------------
//
// YouTube's "Sign in to confirm you're not a bot" verdict sticks to a whole
// /64 (2026-11-18: every address of 2a02:a45d:15fe:15::/64 got it, while the
// neighbouring /64s did not). With a block wider than a /64, remember each /64
// that drew the verdict and leave it alone for a while, so later requests and
// SABR sessions land on clean ones. In-memory, per isolate (the PO-token worker
// keeps its own list); a restart forgets.
// NETWORKING_IPV6_FLAG_TTL_MS: how long a /64 is avoided (default 24 h).

const FLAG_TTL_MS = Number(
    Deno.env.get("NETWORKING_IPV6_FLAG_TTL_MS") || 24 * 3600_000,
);
const MAX_DRAWS = 64;
const flagged = new Map<string, number>(); // /64 prefix -> avoid until (ms)
let warnedAllFlagged = 0;

/** The /64 an address lies in, as "xxxx:xxxx:xxxx:xxxx::/64". */
export function prefix64(address: string): string {
    const groups = expandIPv6(address).split(":").slice(0, 4)
        .map((g) => g.replace(/^0+(?=.)/, ""));
    return `${groups.join(":")}::/64`;
}

function pruneFlagged(now: number): void {
    for (const [p, until] of flagged) {
        if (until <= now) flagged.delete(p);
    }
}

/** Whether the /64 of `address` is currently being avoided. */
export function isIPv6Flagged(address: string, now = Date.now()): boolean {
    const until = flagged.get(prefix64(address));
    return until !== undefined && until > now;
}

/** Avoid the /64 of `address` for NETWORKING_IPV6_FLAG_TTL_MS. */
export function markIPv6Flagged(
    address: string,
    reason: string,
    now = Date.now(),
): void {
    const p = prefix64(address);
    const known = isIPv6Flagged(address, now);
    flagged.set(p, now + FLAG_TTL_MS);
    if (!known) {
        pruneFlagged(now);
        console.log(
            `[INFO] IPv6 ${p} flagged by YouTube (${reason}); avoiding it for ` +
                `${
                    Math.round(FLAG_TTL_MS / 60_000)
                } min (${flagged.size} flagged)`,
        );
    }
}

/** Forget every flagged /64 (tests). */
export function clearIPv6Flags(): void {
    flagged.clear();
    warnedAllFlagged = 0;
}

/**
 * Generate a random IPv6 address within the specified IPv6 block, skipping
 * /64s YouTube recently flagged. Falls back to any address of the block when
 * every draw hits a flagged /64 (a block of one /64, or everything flagged).
 * @param ipv6Block - The IPv6 block in CIDR notation (e.g., "2001:db8::/32")
 */
export function generateRandomIPv6(ipv6Block: string): string {
    let address = drawRandomIPv6(ipv6Block);
    if (flagged.size === 0) return address;
    const now = Date.now();
    for (let i = 1; i < MAX_DRAWS && isIPv6Flagged(address, now); i++) {
        address = drawRandomIPv6(ipv6Block);
    }
    if (isIPv6Flagged(address, now) && now - warnedAllFlagged > 600_000) {
        warnedAllFlagged = now;
        console.log(
            `[WARN] IPv6: every /64 tried in ${ipv6Block} is flagged by ` +
                `YouTube (${flagged.size} flagged); using one anyway`,
        );
    }
    return address;
}

const PLAYER_PATH = "/youtubei/v1/player";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url;
}

/**
 * When `response` answers a player request sent from `localAddress`, read a
 * copy of it in the background and flag the address's /64 if YouTube asked
 * to "confirm you're not a bot". Other LOGIN_REQUIRED reasons (age checks,
 * private videos) do not flag. Returns nothing and never throws.
 */
export function watchPlayerResponse(
    input: Parameters<typeof fetch>[0],
    response: Response,
    localAddress: string | undefined,
): void {
    if (!localAddress || !response.ok || !response.body) return;
    if (!requestUrl(input).includes(PLAYER_PATH)) return;
    let copy: Response;
    try {
        copy = response.clone();
    } catch {
        return;
    }
    copy.json().then((data) => {
        const status = data?.playabilityStatus?.status;
        const reason = String(data?.playabilityStatus?.reason ?? "");
        if (status === "LOGIN_REQUIRED" && /\bbot\b/i.test(reason)) {
            markIPv6Flagged(localAddress, `${status}: ${reason}`);
        }
    }).catch(() => {
        // not JSON, or the body was cancelled: nothing to learn
    });
}
