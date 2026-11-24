import { assertEquals } from "./deps.ts";
import {
    ladderCodecFamily,
    videoCodecFamily,
    videoFormatForHeight,
    videoLadder,
} from "../lib/sabr/ladder.ts";

const fmt = (
    itag: number,
    height: number,
    codecs: string,
    bitrate: number,
    container = "mp4",
) => ({
    itag,
    width: Math.round(height * 16 / 9),
    height,
    bitrate,
    mimeType: `video/${container}; codecs="${codecs}"`,
});
const audio = {
    itag: 140,
    bitrate: 130000,
    mimeType: 'audio/mp4; codecs="mp4a.40.2"',
};

// Shaped like 623yFeM1LwQ's VISIONOS response: at 144p the AV1 format has the
// higher bitrate, and the formats are listed with H.264 first.
const mixed = [
    fmt(160, 144, "avc1.4d400c", 73064),
    fmt(133, 240, "avc1.4d4015", 250897),
    fmt(134, 360, "avc1.4d401e", 526941),
    fmt(135, 480, "avc1.4d401e", 1041715),
    fmt(136, 720, "avc1.64001f", 2076613),
    fmt(394, 144, "av01.0.00M.08", 121906),
    fmt(395, 240, "av01.0.00M.08", 230000),
    fmt(242, 240, "vp9", 150000, "webm"),
    fmt(243, 360, "vp9", 300000, "webm"),
    fmt(244, 480, "vp9", 600000, "webm"),
    fmt(302, 720, "vp9", 1200000, "webm"),
    fmt(303, 1080, "vp9", 2500000, "webm"),
    fmt(308, 1440, "vp9", 5000000, "webm"),
    // >1080p60 exists only as VP9/AV1, so the VISIONOS response also lists
    // AV1 itags past 1080p60 (YouTube's real ladder does exactly this).
    fmt(399, 1080, "av01.0.09M.08", 4400000),
    fmt(400, 1440, "av01.0.12M.08", 9000000),
    fmt(401, 2160, "av01.0.13M.08", 22000000),
    audio,
];

// A lone VP9 rung must not drag the whole ladder down to 144p.
const loneVp9 = [
    fmt(160, 144, "avc1.4d400c", 73064),
    fmt(133, 240, "avc1.4d4015", 250897),
    fmt(134, 360, "avc1.4d401e", 526941),
    fmt(135, 480, "avc1.4d401e", 1041715),
    fmt(136, 720, "avc1.64001f", 2076613),
    fmt(278, 144, "vp9", 90000, "webm"),
    audio,
];

Deno.test("videoCodecFamily", () => {
    assertEquals(videoCodecFamily('video/mp4; codecs="avc1.4d400c"'), "avc1");
    assertEquals(videoCodecFamily('video/mp4; codecs="av01.0.00M.08"'), "av01");
    assertEquals(videoCodecFamily("video/mp4"), "");
});

Deno.test("default ladder stays H.264 even when AV1 reaches above 1080p", () => {
    // A browser that can't decode AV1 (it asked for no family, or "avc")
    // must never get AV1; >1080p goes through an explicit family ladder.
    assertEquals(ladderCodecFamily(mixed), "avc1");
    for (const r of videoLadder(mixed)) {
        assertEquals(videoCodecFamily(r.mimeType), "avc1");
    }
});

Deno.test("av01 short of >1080p leaves the ladder to H.264", () => {
    // AV1 below 2160p only: no way past 1080p60, keep full-coverage H.264.
    const formats = [
        fmt(394, 144, "av01.0.00M.08", 80000),
        fmt(395, 240, "av01.0.00M.08", 160000),
        fmt(160, 144, "avc1.4d400c", 73064),
        fmt(133, 240, "avc1.4d4015", 250897),
        fmt(134, 360, "avc1.4d401e", 526941),
        fmt(136, 720, "avc1.64001f", 2076613),
        audio,
    ];
    assertEquals(ladderCodecFamily(formats), "avc1");
    const ladder = videoLadder(formats);
    assertEquals(ladder.map((r) => r.height).sort((a, b) => a - b), [
        144,
        240,
        360,
        720,
    ]);
    for (const r of ladder) assertEquals(videoCodecFamily(r.mimeType), "avc1");
});

Deno.test("a lone VP9 rung does not override the H.264 ladder", () => {
    assertEquals(ladderCodecFamily(loneVp9), "avc1");
    const ladder = videoLadder(loneVp9);
    assertEquals(ladder.map((r) => r.height), [144, 240, 360, 480, 720]);
    assertEquals(ladder.map((r) => r.itag), [160, 133, 134, 135, 136]);
});

Deno.test("ladder is H.264 when only H.264 exists", () => {
    const ladder = videoLadder([
        fmt(160, 144, "avc1.4d400c", 73064),
        fmt(136, 720, "avc1.64001f", 2076613),
        audio,
    ]);
    assertEquals(ladder.map((r) => r.itag), [160, 136]);
    for (const r of ladder) assertEquals(videoCodecFamily(r.mimeType), "avc1");
});

Deno.test("ladder keeps the highest-bitrate format per height within the codec", () => {
    const ladder = videoLadder([
        fmt(136, 720, "avc1.4d401f", 1500000),
        fmt(298, 720, "avc1.4d4020", 2500000),
        fmt(398, 720, "av01.0.05M.08", 4000000),
    ]);
    assertEquals(ladder.map((r) => r.itag), [298]);
});

Deno.test("without H.264, the codec covering the most heights", () => {
    const ladder = videoLadder([
        fmt(394, 144, "av01.0.00M.08", 80000),
        fmt(395, 240, "av01.0.00M.08", 160000),
        fmt(396, 360, "av01.0.01M.08", 300000),
        fmt(600, 144, "hev1.1.6.L60.90", 120000),
        audio,
    ]);
    assertEquals(ladder.map((r) => r.itag), [394, 395, 396]);
});

Deno.test("the pull takes the advertised format, not the first at that height", () => {
    // AV1 listed first at 144p: the old `find(height)` pulled itag 394 while
    // the manifest could say something else.
    const formats = [
        fmt(394, 144, "av01.0.00M.08", 121906),
        fmt(160, 144, "avc1.4d400c", 73064),
        fmt(136, 720, "avc1.64001f", 2076613),
    ];
    const ladder = videoLadder(formats);
    assertEquals(videoFormatForHeight(formats, ladder, 144).itag, 160);
    assertEquals(videoFormatForHeight(formats, ladder, 720).itag, 136);
});

Deno.test("the pull falls back to the same codec when the itag is gone", () => {
    const ladder = videoLadder([fmt(160, 144, "avc1.4d400c", 73064)]);
    const reloaded = [
        fmt(394, 144, "av01.0.00M.08", 121906),
        fmt(9160, 144, "avc1.4d400c", 73064),
    ];
    assertEquals(videoFormatForHeight(reloaded, ladder, 144).itag, 9160);
});

Deno.test("every advertised rendition pulls a format of the advertised codec", () => {
    const ladder = videoLadder(mixed);
    for (const r of ladder) {
        const f = videoFormatForHeight(mixed, ladder, r.height);
        assertEquals(f.itag, r.itag);
        assertEquals(f.mimeType, r.mimeType);
    }
});
