import { assertEquals } from "./deps.ts";
import {
    clearStreamUrlRefresh,
    MAX_REFRESHES_PER_VIDEO_PER_HOUR,
    pickSameFormat,
    REFRESH_MIN_INTERVAL_MS,
    refreshStreamUrl,
    rememberStreamUrls,
    replacementFor,
    videoIdForStream,
} from "../lib/helpers/streamUrlRefresh.ts";

const url = (id: string, itag: number, xtags = "") =>
    `https://r1.googlevideo.com/videoplayback?id=${id}&itag=${itag}${
        xtags ? `&xtags=${xtags}` : ""
    }&expire=9999999999`;

function player(id: string) {
    return {
        streamingData: {
            formats: [{ itag: 18, url: url(id, 18) }],
            adaptiveFormats: [
                { itag: 136, url: url(id, 136) },
                { itag: 140, url: url(id, 140, "lang=en") },
                { itag: 140, url: url(id, 140, "lang=de") },
            ],
        },
    };
}

Deno.test("rememberStreamUrls - maps a stream id to its video", () => {
    clearStreamUrlRefresh();
    rememberStreamUrls("vid12345678", player("o-OLD"));
    assertEquals(videoIdForStream("o-OLD"), "vid12345678");
    assertEquals(videoIdForStream("o-UNKNOWN"), undefined);
    assertEquals(videoIdForStream(null), undefined);
    clearStreamUrlRefresh();
});

Deno.test("pickSameFormat - same itag, same audio track when it can", () => {
    const fresh = player("o-NEW");
    assertEquals(pickSameFormat(fresh, "136", null), url("o-NEW", 136));
    assertEquals(
        pickSameFormat(fresh, "140", "lang=de"),
        url("o-NEW", 140, "lang=de"),
    );
    // no matching xtags: the same itag still beats nothing
    assertEquals(
        pickSameFormat(fresh, "140", "lang=fr"),
        url("o-NEW", 140, "lang=en"),
    );
    assertEquals(pickSameFormat(fresh, "137", null), undefined);
});

Deno.test("refreshStreamUrl - fetches once, then serves the replacement", async () => {
    clearStreamUrlRefresh();
    rememberStreamUrls("vid12345678", player("o-OLD"));
    let fetches = 0;
    const fetchPlayer = (videoId: string) => {
        fetches++;
        assertEquals(videoId, "vid12345678");
        return Promise.resolve(player("o-NEW"));
    };
    const now = Date.now();
    const [a, b] = await Promise.all([
        refreshStreamUrl(
            { streamId: "o-OLD", itag: "136", xtags: null, fetchPlayer },
            now,
        ),
        refreshStreamUrl(
            { streamId: "o-OLD", itag: "136", xtags: null, fetchPlayer },
            now,
        ),
    ]);
    assertEquals(a, url("o-NEW", 136));
    assertEquals(b, url("o-NEW", 136));
    assertEquals(fetches, 1);
    assertEquals(replacementFor("o-OLD", "136", null), url("o-NEW", 136));

    // Within the interval: the replacement, no new player request.
    const c = await refreshStreamUrl(
        { streamId: "o-OLD", itag: "136", xtags: null, fetchPlayer },
        now + 1000,
    );
    assertEquals(c, url("o-NEW", 136));
    assertEquals(fetches, 1);

    // The fresh URL is known too, so it can be refreshed when it is revoked.
    assertEquals(videoIdForStream("o-NEW"), "vid12345678");
    clearStreamUrlRefresh();
});

Deno.test("refreshStreamUrl - nothing for unknown streams or a spent budget", async () => {
    clearStreamUrlRefresh();
    const fetchPlayer = () => Promise.resolve(player("o-NEW"));
    assertEquals(
        await refreshStreamUrl({
            streamId: "o-UNKNOWN",
            itag: "136",
            xtags: null,
            fetchPlayer,
        }),
        null,
    );

    rememberStreamUrls("vid12345678", player("o-OLD"));
    const start = Date.now();
    for (let i = 0; i < MAX_REFRESHES_PER_VIDEO_PER_HOUR; i++) {
        await refreshStreamUrl(
            { streamId: "o-OLD", itag: "136", xtags: null, fetchPlayer },
            start + i * (REFRESH_MIN_INTERVAL_MS + 1),
        );
    }
    let fetched = false;
    const spent = await refreshStreamUrl(
        {
            streamId: "o-OLD",
            itag: "18",
            xtags: null,
            fetchPlayer: () => {
                fetched = true;
                return Promise.resolve(player("o-NEW"));
            },
        },
        start +
            MAX_REFRESHES_PER_VIDEO_PER_HOUR * (REFRESH_MIN_INTERVAL_MS + 1),
    );
    assertEquals(fetched, false);
    assertEquals(spent, null);
    clearStreamUrlRefresh();
});
