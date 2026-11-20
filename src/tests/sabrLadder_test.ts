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
    fmt(278, 144, "vp9", 90000, "webm"),
    audio,
];

Deno.test("videoCodecFamily", () => {
    assertEquals(videoCodecFamily('video/mp4; codecs="avc1.4d400c"'), "avc1");
    assertEquals(videoCodecFamily('video/mp4; codecs="av01.0.00M.08"'), "av01");
    assertEquals(videoCodecFamily("video/mp4"), "");
});

Deno.test("ladder is H.264 only when the video has H.264", () => {
    assertEquals(ladderCodecFamily(mixed), "avc1");
    const ladder = videoLadder(mixed);
    assertEquals(ladder.map((r) => r.height), [144, 240, 360, 480, 720]);
    assertEquals(ladder.map((r) => r.itag), [160, 133, 134, 135, 136]);
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
