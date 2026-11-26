import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { encodeRFC5987ValueChars } from "../lib/helpers/encodeRFC5987ValueChars.ts";
import { decryptQuery } from "../lib/helpers/encryptQuery.ts";
import { StreamingApi } from "hono/utils/stream";
import {
    refreshStreamUrl,
    replacementFor,
} from "../lib/helpers/streamUrlRefresh.ts";
import { youtubePlayerParsing } from "../lib/helpers/youtubePlayerHandling.ts";

let getFetchClientLocation = "getFetchClient";
if (Deno.env.get("GET_FETCH_CLIENT_LOCATION")) {
    if (Deno.env.has("DENO_COMPILED")) {
        getFetchClientLocation = Deno.mainModule.replace("src/main.ts", "") +
            Deno.env.get("GET_FETCH_CLIENT_LOCATION");
    } else {
        getFetchClientLocation = Deno.env.get(
            "GET_FETCH_CLIENT_LOCATION",
        ) as string;
    }
}
const { getFetchClient } = await import(getFetchClientLocation);

const videoPlaybackProxy = new Hono();

videoPlaybackProxy.options("/", () => {
    const headersForResponse: Record<string, string> = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "Content-Type, Range",
    };
    return new Response("OK", {
        status: 200,
        headers: headersForResponse,
    });
});

videoPlaybackProxy.get("/", async (c) => {
    const { host, c: client, expire, title } = c.req.query();
    const urlReq = new URL(c.req.url);
    const config = c.get("config");
    const queryParams = new URLSearchParams(urlReq.search);

    if (c.req.query("enc") === "true") {
        const { data: encryptedQuery } = c.req.query();
        const decryptedQueryParams = decryptQuery(encryptedQuery, config);
        const parsedDecryptedQueryParams = new URLSearchParams(
            JSON.parse(decryptedQueryParams),
        );
        queryParams.delete("enc");
        queryParams.delete("data");
        queryParams.set("pot", parsedDecryptedQueryParams.get("pot") as string);
        queryParams.set("ip", parsedDecryptedQueryParams.get("ip") as string);
    }

    // Live and Post-Live-DVR (`source=yt_live_broadcast`) segments are served
    // from `*.c.youtube.com` hosts rather than the usual `*.googlevideo.com`;
    // accept both so those streams aren't rejected here (see iv-org/invidious#4589).
    if (
        host == undefined ||
        !/^[\w-]+\.(googlevideo\.com|c\.youtube\.com)$/.test(host)
    ) {
        throw new HTTPException(400, {
            res: new Response("Host query string do not match or undefined."),
        });
    }

    if (
        expire == undefined ||
        Number(expire) < Number(Date.now().toString().slice(0, -3))
    ) {
        throw new HTTPException(400, {
            res: new Response(
                "Expire query string undefined or videoplayback URL has expired.",
            ),
        });
    }

    if (client == undefined) {
        throw new HTTPException(400, {
            res: new Response("'c' query string undefined."),
        });
    }

    queryParams.delete("host");
    queryParams.delete("title");

    const rangeHeader = c.req.header("range");
    const requestBytes = rangeHeader ? rangeHeader.split("=")[1] : null;
    const [firstByte, lastByte] = requestBytes?.split("-") || [];
    if (requestBytes) {
        queryParams.append(
            "range",
            requestBytes,
        );
    }

    const headersToSend: HeadersInit = {
        "accept": "*/*",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "en-us,en;q=0.5",
        "origin": "https://www.youtube.com",
        "referer": "https://www.youtube.com",
    };

    if (client == "ANDROID") {
        headersToSend["user-agent"] =
            "com.google.android.youtube/1537338816 (Linux; U; Android 13; en_US; ; Build/TQ2A.230505.002; Cronet/113.0.5672.24)";
    } else if (client == "IOS") {
        headersToSend["user-agent"] =
            "com.google.ios.youtube/19.32.8 (iPhone14,5; U; CPU iOS 17_6 like Mac OS X;)";
    } else {
        headersToSend["user-agent"] =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
    }

    // The format this request is for: a revoked URL is replaced by a fresh
    // one for the same format (see lib/helpers/streamUrlRefresh.ts).
    const streamId = queryParams.get("id");
    const itag = queryParams.get("itag");
    const xtags = queryParams.get("xtags");
    let targetHost = host;
    const useUrl = (url: string) => {
        const fresh = new URL(url);
        const range = queryParams.get("range");
        for (const key of [...queryParams.keys()]) queryParams.delete(key);
        for (const [key, value] of fresh.searchParams) {
            queryParams.append(key, value);
        }
        if (range) queryParams.set("range", range);
        targetHost = fresh.host;
    };
    const known = replacementFor(streamId, itag, xtags);
    if (known) useUrl(known);
    const fetchPlayer = (videoId: string) =>
        youtubePlayerParsing({
            innertubeClient: c.get("innertubeClient"),
            videoId,
            config,
            tokenMinter: c.get("tokenMinter")!,
            metrics: c.get("metrics"),
            refreshCache: true,
        });

    // A stream URL is bound to the address that requested the player response
    // (its `ip=`). With IPv6 rotation every request would otherwise leave from
    // a different random address — even the HEAD, redirects and POST of one
    // segment. YouTube tolerates that for a while, then revokes the URL
    // mid-playback (every later segment 403s). So fetch from that very address
    // when it is one of ours; getFetchClient ignores it if it is not.
    const clientFor = () =>
        getFetchClient(config, {
            localAddress: queryParams.get("ip") ?? undefined,
        });
    let fetchClient = await clientFor();

    let headResponse: Response | undefined;
    let location =
        `https://${targetHost}/videoplayback?${queryParams.toString()}`;
    let refreshed = false;

    // https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-p2-semantics-17#section-7.3
    // A maximum of 5 redirections is defined in the note of the section 7.3
    // of this RFC, that's why `i < 5`
    for (let i = 0; i < 5; i++) {
        const googlevideoResponse: Response = await fetchClient(location, {
            method: "HEAD",
            headers: headersToSend,
            redirect: "manual",
        });
        if (googlevideoResponse.status == 403) {
            // Revoked (about a minute of media into the URL): once per
            // request, swap in a fresh URL for the same format and retry.
            if (!refreshed) {
                refreshed = true;
                await googlevideoResponse.body?.cancel();
                const fresh = await refreshStreamUrl({
                    streamId,
                    itag,
                    xtags,
                    fetchPlayer,
                });
                if (fresh) {
                    useUrl(fresh);
                    fetchClient = await clientFor();
                    location =
                        `https://${targetHost}/videoplayback?${queryParams.toString()}`;
                    i = -1; // a fresh redirect budget for the new URL
                    continue;
                }
                return new Response(null, {
                    status: googlevideoResponse.status,
                    statusText: googlevideoResponse.statusText,
                });
            }
            return new Response(googlevideoResponse.body, {
                status: googlevideoResponse.status,
                statusText: googlevideoResponse.statusText,
            });
        }
        if (googlevideoResponse.headers.has("Location")) {
            location = googlevideoResponse.headers.get("Location") as string;
            continue;
        } else {
            headResponse = googlevideoResponse;
            break;
        }
    }
    if (headResponse === undefined) {
        throw new HTTPException(502, {
            res: new Response(
                "Google headResponse redirected too many times",
            ),
        });
    }

    // =================== REQUEST CHUNKING =======================
    // if the requested response is larger than the chunkSize, break up the response
    // into chunks and stream the response back to the client to avoid rate limiting
    const { readable, writable } = new TransformStream();
    const stream = new StreamingApi(writable, readable);
    const googleVideoUrl = new URL(location);
    const getChunk = async (start: number, end: number) => {
        googleVideoUrl.searchParams.set(
            "range",
            `${start}-${end}`,
        );
        const postResponse = await fetchClient(googleVideoUrl, {
            method: "POST",
            body: new Uint8Array([0x78, 0]), // protobuf: { 15: 0 } (no idea what it means but this is what YouTube uses),
            headers: headersToSend,
        });
        if (postResponse.status !== 200) {
            // Revoked mid-response: have the replacement ready for the
            // player's retry of this range.
            if (postResponse.status === 403) {
                void refreshStreamUrl({ streamId, itag, xtags, fetchPlayer });
            }
            throw new Error("Non-200 response from google servers");
        }
        await stream.pipe(postResponse.body);
    };

    const chunkSize =
        config.networking.videoplayback.video_fetch_chunk_size_mb * 1_000_000;
    const totalBytes = Number(
        headResponse.headers.get("Content-Length") || "0",
    );

    // if no range sent, the client wants thw whole file, i.e. for downloads
    const wholeRequestStartByte = Number(firstByte || "0");
    const wholeRequestEndByte = wholeRequestStartByte + Number(totalBytes) - 1;

    let chunk = Promise.resolve();
    if (!totalBytes) {
        // Live / Post-Live-DVR segments carry `noclen=1` and no Content-Length,
        // so there is nothing to chunk by: the loop below would not run and the
        // response would be an empty 200. Fetch the segment in one POST, with
        // the range the client asked for (already in the URL), and stream it.
        chunk = (async () => {
            const postResponse = await fetchClient(googleVideoUrl, {
                method: "POST",
                body: new Uint8Array([0x78, 0]),
                headers: headersToSend,
            });
            if (postResponse.status !== 200) {
                throw new Error("Non-200 response from google servers");
            }
            await stream.pipe(postResponse.body);
        })();
    }
    for (
        let startByte = wholeRequestStartByte;
        // `<=`: a one-byte range (start == end) is still one chunk
        totalBytes && startByte <= wholeRequestEndByte;
        startByte += chunkSize
    ) {
        // i.e.
        // 0 - 4_999_999, then
        // 5_000_000 - 9_999_999, then
        // 10_000_000 - 14_999_999
        let endByte = startByte + chunkSize - 1;
        if (endByte > wholeRequestEndByte) {
            endByte = wholeRequestEndByte;
        }
        chunk = chunk.then(() => getChunk(startByte, endByte));
    }
    // End the response after the last chunk: without a Content-Length (noclen)
    // the client has no other way to know the segment is complete.
    chunk.then(() => stream.close()).catch(() => {
        stream.abort();
    });
    // =================== REQUEST CHUNKING =======================

    const headersForResponse: Record<string, string> = {
        "access-control-allow-origin": "*",
        "accept-ranges": headResponse.headers.get("accept-ranges") || "",
        "content-type": headResponse.headers.get("content-type") || "",
        "expires": headResponse.headers.get("expires") || "",
        "last-modified": headResponse.headers.get("last-modified") || "",
    };
    // Live / Post-Live-DVR segments carry `noclen=1` and have no length; an
    // empty content-length header would be invalid, so only send a real one.
    const contentLength = headResponse.headers.get("content-length");
    if (contentLength) headersForResponse["content-length"] = contentLength;

    // Live / Post-Live-DVR manifest generation reads YouTube's `X-Head-*`
    // metadata headers (X-Head-Time-Millis, X-Head-Seqnum, …) off the sq=0
    // response to compute the stream duration and segment count. Forward them
    // (and expose them to browsers) or YouTube.js throws "Failed to extract the
    // duration or segment count for this Post Live DVR video".
    const exposedHeaders: string[] = [];
    for (const [name, value] of headResponse.headers) {
        if (name.toLowerCase().startsWith("x-head-")) {
            headersForResponse[name] = value;
            exposedHeaders.push(name);
        }
    }
    if (exposedHeaders.length > 0) {
        headersForResponse["access-control-expose-headers"] = exposedHeaders
            .join(", ");
    }

    if (title) {
        headersForResponse["content-disposition"] = `attachment; filename="${
            encodeURIComponent(title)
        }"; filename*=UTF-8''${encodeRFC5987ValueChars(title)}`;
    }

    let responseStatus = headResponse.status;
    if (requestBytes && responseStatus == 200) {
        // check for range headers in the forms:
        // "bytes=0-" get full length from start
        // "bytes=500-" get full length from 500 bytes in
        // "bytes=500-1000" get 500 bytes starting from 500
        if (lastByte) {
            responseStatus = 206;
            headersForResponse["content-range"] = `bytes ${requestBytes}/${
                queryParams.get("clen") || "*"
            }`;
        } else {
            // i.e. "bytes=0-", "bytes=600-"
            // full size of content is able to be calculated, so a full Content-Range header can be constructed
            const bytesReceived = contentLength ?? "";
            // last byte should always be one less than the length
            const totalContentLength = Number(firstByte) +
                Number(bytesReceived);
            const lastByte = totalContentLength - 1;
            if (firstByte !== "0") {
                // only part of the total content returned, 206
                responseStatus = 206;
            }
            headersForResponse["content-range"] =
                `bytes ${firstByte}-${lastByte}/${totalContentLength}`;
        }
    }

    return new Response(stream.responseReadable, {
        status: responseStatus,
        statusText: headResponse.statusText,
        headers: headersForResponse,
    });
});

export default videoPlaybackProxy;
