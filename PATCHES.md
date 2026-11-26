# Patched build of invidious-companion

This tree is upstream [iv-org/invidious-companion](https://github.com/iv-org/invidious-companion)
plus our commits, all on `master`. It is the source of the companion that runs
behind invidious.home.nedworks.org and serves OwnTube (see OwnTube's
`docs/LIVE-AND-DVR-PLAYBACK.md` for how OwnTube uses it).

## What we carry

`git log --oneline origin/master..master` lists them. In short:

- **Live / Post-Live-DVR fixes** (`src/routes/videoPlaybackProxy.ts`,
  `src/routes/invidious_routes/dashManifest.ts`):
  - accept `*.c.youtube.com` segment hosts; live/DVR are served from there;
  - forward and expose YouTube's `X-Head-*` headers, which YouTube.js reads
    to derive a DVR stream's duration and segment count;
  - send no `content-length` for `noclen` live segments rather than an empty
    header;
  - re-fetch the player response uncached for live/DVR, whose po_token'd
    segment URLs age out long before the 1 h cache;
  - absolute segment URLs in DVR manifests (upstream #249).
- **SABR connector** (`src/lib/sabr/`, `src/routes/sabrRoutes.ts`, vendored
  `googlevideo` under `vendor/`, mapped via `gv/` in `deno.jsonc`), mounted at
  `/sabr`. VOD sessions use the **VISIONOS** client (no PO token; the only
  identity found on 2026-09-23 that the SABR server lets start mid-video —
  ANDROID_VR refuses beyond ~1 min, WEB+Camoufox tokens fail attestation on most
  videos; NewPipeExtractor/LibreTube stream from it too). Live keeps ANDROID_VR.
  Its client constants mirror NewPipeExtractor's `ClientsConstants.java`; bump
  them together. A pull is aborted through `SabrPull.abort()` (cancelling the
  reader alone left the library retrying against a closed controller), and a
  server reload request re-fetches the player response in place:
  - `GET /sabr/:id/manifest.mpd`: DASH for SABR-only VOD; for live and
    post-live DVR it proxies YouTube's own dynamic manifest from an ANDROID_VR
    session, BaseURLs rewritten to `live/<check>/<index>/`;
  - `GET /sabr/:id/live/:check/:rep/*`: live segments. `check` travels in the
    path because relative segment URLs drop a query string;
  - `GET /sabr/:id/:track/(init.mp4|seg-N.m4s)`: VOD segments;
  - `GET /sabr/:id/download?itag=`, `GET /sabr/:id/watch` (test player page).
  - Guarded by `SERVER_VERIFY_REQUESTS` like the other routes.
  - The VOD video ladder is **one codec** (H.264 whenever the video has it),
    one format per height, and a height's segments are pulled by the itag the
    manifest advertises (`src/lib/sabr/ladder.ts`). The ladder used to take the
    highest-bitrate MP4 per height across codecs while the pull took the first
    listed: at 144p AV1 itag 394 often out-bitrates H.264 itag 160, so the MPD
    said `av01` for H.264 segments, and Media3 on a hardware-AV1 Android TV
    played that lone "AV1" rung as a fixed track, stuck at 144p.
- **`/videoplayback` keeps the stream URL's address**
  (`src/routes/videoPlaybackProxy.ts`, `getFetchClient`'s `localAddress`
  option): with `NETWORKING_IPV6_BLOCK` set, the proxy sends a segment's HEAD,
  redirects and POST from the URL's own `ip=` when that address is inside the
  block, instead of a new random one per request. Before this, YouTube served
  a URL for ~50–70 segments and then revoked it (every later segment 403, hours
  before `expire`), which stalled OwnTube's HLS playback.
- **Rotation skips /64s YouTube flags** (`src/lib/helpers/ipv6Rotation.ts`,
  hooked into `getFetchClient` and `src/lib/sabr/egress.ts`): YouTube's "Sign
  in to confirm you're not a bot" sticks to a whole /64 (2026-11-18: all of
  2a02:a45d:15fe:15::/64, while its neighbours stayed clean). Each
  `/youtubei/v1/player` answer is read from a copy in the background; a
  `LOGIN_REQUIRED` whose reason mentions a bot (not age checks) puts the
  sending address's /64 on an in-memory list, and `generateRandomIPv6` draws
  up to 64 times to miss listed /64s (if all are listed it uses one anyway and
  warns at most every 10 min). Logs `[INFO] IPv6 <prefix>::/64 flagged by
  YouTube (...)` once per /64. Only useful with a block wider than a /64; the
  list is per isolate (the PO-token worker has its own) and a restart forgets
  it. The request that drew the verdict still fails.
  Since 2026-11-26 a /64 is listed only after `NETWORKING_IPV6_FLAG_STRIKES`
  (3) verdicts in a row, and an OK player answer from it clears its strikes
  and lists it no longer. WEB requests (and any carrying a PO token) don't
  count. Measured that day: the verdict is mostly per request, not per
  address (the same /64 drew it and then OK, a listed /64 served VISIONOS
  fine), and with a stale PO token every WEB request draws it, so flagging on
  the first verdict listed 142 of the /56's 256 /64s in two hours.
- **SABR sessions ask once more after "not a bot"** (`openWithBotRetry` in
  `src/lib/sabr/session.ts`): VISIONOS and the ANDROID_VR fallback each get a
  second player request on that verdict before giving up, instead of the
  video falling to the byte-range path whose URLs are revoked ~1 min in.
- **Quieter logs** (`src/lib/helpers/logLevel.ts`): YouTube.js logs only
  errors by default (its parser warnings dump ~45 lines of class source per
  "X changed!" on every player request), and the request logger skips
  `/videoplayback` and SABR segment requests, which arrive by the hundred per
  video.
- **Build**: the Dockerfile copies `vendor/` (the SABR code imports it).
- **Upstream PR #360, carried ahead of upstream** (2026-09-23, one squashed
  commit without its `.github/workflows` changes, which our push token may not
  touch): PO tokens come from a headless Camoufox browser instead of JSDOM. On
  2026-09-23 YouTube began rejecting every JSDOM token ("Failed to validate PO
  token", and Invidious showing "This helps protect our community"); Camoufox
  tokens validate. The image downloads Camoufox into the `/var/tmp/youtubei.js`
  volume on first start, and the container needs `shm_size: 256mb`. Once
  upstream merges #360, drop our squash commit when rebasing.

Dropped when rebasing onto upstream `bb3b37f` (2026-09-21), because upstream now
covers them: our captions fix (upstream `ffa2156` fetches the caption
`base_url` as VTT itself, with the po_token) and the noclen passthrough
(upstream `cc2503e` removed the byte-range chunking that emptied live
segments).

Merged upstream `07ae73c` on 2026-11-18 (merge `dc8d803`: YouTube.js 18.3.0,
Deno 2.9.8, Hono 4.13.16, googlevideo 5.0.1, meriyah 7.4.1, @std/async 1.5.1).
Upstream reverted `cc2503e` there (`6cb055d`: chunking no longer buffers on
Deno 2.9.6+), so `/videoplayback` chunks again, which brought the empty-segment
problem back. Carried on top in the merge: a request without Content-Length
(`noclen` live/DVR segments) is fetched in one POST and streamed; a one-byte
range counts as a chunk (`<=`); and the response is closed after the last chunk
(`StreamingApi.pipe` keeps the stream open, so a length-less response never
ended). Drop these when upstream fixes the same.

## Settings

| env | default | |
|---|---|---|
| `SABR_LIVE_MANIFEST_TTL_MS` | 20000 | re-fetch interval for YouTube's live manifest. We run **5000**: players only see segments the manifest lists. |
| `SABR_POT_URL` | — | PO token provider for WEB sessions (dubbed audio); ANDROID_VR needs none |
| `NETWORKING_IPV6_FLAG_TTL_MS` | 86400000 | how long a /64 that drew "not a bot" is avoided by rotation |
| `NETWORKING_IPV6_FLAG_STRIKES` | 3 | "not a bot" verdicts in a row (no OK between) before rotation avoids a /64 |
| `YOUTUBEJS_LOG_LEVEL` | error | `none`, `error`, `warning`, `info` or `debug`: YouTube.js log levels shown |
| `SERVER_LOG_MEDIA_REQUESTS` | — | `true` logs `/videoplayback` and SABR segment requests again |
| `SABR_SEED_HEIGHT` / `SABR_MAX_HEIGHT` | 360 / 1080 | SABR VOD ladder |
| `SABR_SEGMENT_WAIT_MS`, `SABR_SESSION_TTL_MS`, `SABR_RETAIN_SEGMENTS`, `SABR_AHEAD_SEGMENTS`, `SABR_FORWARD_WINDOW`, `SABR_READER_IDLE_MS` | see source | SABR VOD reader tuning; `SABR_AHEAD_SEGMENTS` (24) bounds how far a reader pulls past the newest segment a player asked for |

## Updating to a newer upstream

```bash
git fetch origin
git checkout -b rebase-$(date +%Y%m%d) master
git rebase origin/master
```

Check each conflict against what upstream changed. Twice now upstream fixed
the same thing we patched; prefer its version and drop ours. Then build: `deno
task compile` inside the Dockerfile type-checks everything, which is where
dependency bumps show up (Hono 4.13 tightened `c.req.param()` and `c.body()`
types). Format and lint with the Deno version the Dockerfile pins:

```bash
docker run --rm -v "$PWD":/app:ro -w /app denoland/deno:<pinned> \
  sh -c 'deno fmt --check src/ && deno lint src/'
```

When it builds and passes the checks below, fast-forward `master` to it.

## Build, test, deploy

Images are tagged with the date and the commit, so every running image traces
to a commit:

```bash
TAG=nedworks/invidious-companion:$(date +%Y.%m.%d)-master-$(git rev-parse --short HEAD)
docker build -t $TAG .
```

**Test side by side before swapping**: run the new image as a throwaway
container next to the live one, same env and network, and compare. Env from
the running container:

```bash
docker inspect invidious-companion --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -E '^(SERVER_|SABR_)' > /tmp/companion.env
docker run -d --name companion-test --network invidious_internal-invidious \
  --env-file /tmp/companion.env --read-only \
  --tmpfs /var/tmp/youtubei.js:uid=10001 $TAG
```

Then, from a container on that network, against both `invidious-companion:8282`
and `companion-test:8282` (paths under `/companion`, `check=` signed with the
secret): a VOD `/api/manifest/dash/id`, `/api/v1/captions` (must be
`WEBVTT`), a `/videoplayback` byte range (206), the `/sabr` live manifest and
two live segments (each segment's `tfdt` must equal its `sq × 5 s`), and a
post-live DVR video's `/api/manifest/dash` plus segments through
`/videoplayback`. Remove the test container and the env file afterwards.

**Deploy**: back up `/var/data/config/invidious/docker-compose.yml`, point
`image:` at the new tag, `docker compose up -d invidious-companion`, wait for
healthy, and repeat the checks plus a browser check on OwnTube (live, DVR,
VOD).

**Roll back**: set `image:` to the previous tag and `up -d` again. Deployed
source that is no longer on a branch is kept as a tag:

| image | source |
|---|---|
| `2026.11.26-master-1e7e8e5` | `master` @ `1e7e8e5`: a /64 is flagged only after 3 "not a bot" verdicts in a row (`NETWORKING_IPV6_FLAG_STRIKES`), OK clears, WEB/PO-token requests don't count; SABR asks VISIONOS/ANDROID_VR once more after the verdict. Deployed 2026-11-26 (compose backup `docker-compose.yml.bak-pre-1e7e8e5`); healthy, in-netns /56 route present, no /64 flagged in the first minutes (the old rule had flagged 142 of 256 in two hours). Side by side the test container (no rotation, so IPv4 egress) validated its PO token and served TV_SIMPLY URLs (206 on 4 uncached videos), while the live container on the /56, old image and new alike, got LOGIN_REQUIRED "not a bot" on WEB and mostly on ANDROID_VR: YouTube is rejecting the /56 as a whole, not single /64s |
| `2026.11.24-master-730ce09` | `master` @ `730ce09`: codec-family ladders skip HDR formats (pulls declare SDR only, YouTube refuses HDR). On HDR uploads (mjsMqasGhKU) `?video=vp9` took VP9.2 and `?video=av01` 10-bit AV1, hung ~20 s and fell back to byte-range; now VP9 is SDR to 2160p (313) and AV1 is empty, so the default ladder answers at once. Tested 2026-11-24: 15 tests; mjsMqasGhKU SDR VP9 2160p indexes, seg-1/2/60 byte-exact |
| `2026.11.24-master-08d05d0` | `master` @ `08d05d0` (+ `3da56ef`): per-family SABR VOD ladders. `manifest.mpd?video=vp9` serves the VP9 ladder as WebM DASH to 2160p (new `lib/sabr/ebml.ts`: the init's Cues give the SegmentTimeline; a segment is the Clusters from one cue to the next), `?video=av01` the AV1 fMP4 ladder; ids `<family>-v<height>`. The default stays H.264 (the "AV1 above 1080p is the default" rule, in production 2026.11.24 only, is gone). Pulls declare H264/VP9/AV1 with yt-dlp's codec ids (2/4/8). Tested 2026-11-24: 28 tests (`sabrWebm_test.ts`, `sabrLadder_test.ts`), aqz-KE-bpKQ vp9 123 segments, seg-1/2/60 byte-exact, decode as 3840x2160 in ffmpeg and Chromium MSE (also after a seek); av01-v2160 init + seg-60 decode; mjsMqasGhKU (HDR) still all-avc1, v1080 segments 200. Safari played 4K through OwnTube on the same code as `2026.11.24-vp9webm-cues` (built from copied files, not a commit) |
| `2026.11.20-master-a464d38` | `master` @ `a464d38` (+ `8f9ccc6`): SABR video pulls send `clientAbrState.mediaCapabilities` declaring 8-bit SDR only (new `mediaCapabilities` start option in the vendored `SabrStream`), and a reload demand's `reloadPlaybackParams.token` is echoed as `playbackContext.reloadPlaybackContext` in the next VISIONOS/ANDROID_VR player request. Before, on HDR uploads (mjsMqasGhKU), every SDR format (H.264 ladder, 8-bit VP9) drew a reload demand while VP9.2 and 10-bit AV1 were served; `prepare()` delegated to byte-range URLs, revoked ~1 min in, so OwnTube stuttered. Tested side by side 2026-11-20: mjsMqasGhKU manifest 200 in 0.3 s (was a 302 after 56 s), all-avc1 ladder, v1080 80/80 and audio 47/47 segments 200; dQw4w9WgXcQ SABR segments, `/api/manifest/dash` and captions (`WEBVTT`) same as the old image. Deployed 2026-11-20; OwnTube `/hls/mjsMqasGhKU/master.m3u8` is SABR, v720 80/80 segments 200. Live/DVR not exercised (it does not use `pullSabrTrack`) |
| `2026.11.20-master-350216f` | `master` @ `350216f`: SABR VOD ladder is one codec (H.264 when present, highest bitrate per height within it) and segment pulls fetch the advertised itag. Before, 623yFeM1LwQ advertised `v144 codecs="av01.0.00M.08"` for H.264 segments (init `avcC` 4D400C), and the OwnTube TV (hardware AV1) stuck on that rung. Tested side by side 2026-11-20: 7/7 `sabrLadder_test.ts`, fmt/lint clean; 623yFeM1LwQ manifest all avc1 (v144 = avc1.4D400C), v144/v720 `init.mp4` codecs match the manifest, segments 200; GuAJ3wIC_9Y manifest identical apart from `check=`; dash, captions (`WEBVTT`), `/videoplayback` 1 MB range (206) and live 4xDzrJKXOOY (two segments 200, `tfdt` same as the old image) unchanged. Deployed 2026-11-20; OwnTube `/dash/623yFeM1LwQ/manifest.mpd?maxHeight=720` has no av01, v144/v720 init + seg-1 200. Post-live DVR not exercised |
| `2026.11.18-master-dc8d803` | `master` @ `dc8d803`: merge of upstream `07ae73c` (see above). Tested side by side 2026-11-18 (player, `/videoplayback` 1-byte/2-byte/12 MB ranges: 12 MB in 1.1 s chunked vs 14.1 s unchunked) and deployed; OwnTube HLS 200 for four videos. `noclen` live/DVR segments were not exercised (no such video at hand) |
| `2026.11.18-master-3e20b25` | `master` @ `3e20b25`: rotation skips /64s YouTube answered "not a bot" (`NETWORKING_IPV6_FLAG_TTL_MS=86400000`). Deployed 2026-11-18 together with the block move: YouTube had flagged all of 2a02:a45d:15fe:15::/64, so `NETWORKING_IPV6_BLOCK=2a02:a45d:15fe:f00::/56`, a /56 outside every VLAN that OPNsense routes to naggon (gateway `NAGGON_MEDIA_V6` = 2a02:a45d:15fe:15::11, alias `NET_COMPANION_V6` in `EGRESS_OPEN`). ndppd stopped and disabled; `companion-ipv6-rotation` uses the /56. Verified: player and `/sabr` serve uncached videos, 11/11 rotation tests |
| `2026.11.18-master-ffa12c2` | `master` @ `ffa12c2`: `YOUTUBEJS_LOG_LEVEL` (default error) and no request lines for media paths (`SERVER_LOG_MEDIA_REQUESTS`). Deployed 2026-11-18; the container now uses the daemon's log rotation (json-file 20m × 3) instead of 1G × 4 |
| `2026.11.13-master-62bc59c` | `master` @ `62bc59c`: `/videoplayback` sends a segment's HEAD, redirects and POST from the stream URL's own `ip=` when it is inside `NETWORKING_IPV6_BLOCK`. Deployed 2026-11-13. Did not stop the TVHTML5_SIMPLY byte-range URLs being revoked after ~1 min of media (that is YouTube-side; OwnTube now plays VOD over `/sabr`), kept because the URL is bound to that address. Also: `companion-ipv6-rotation.service` now has `PartOf=docker.service` and a `docker.service.wants` link, after a docker stop left it down for a week |
| `2026.11.03-master-5432f07` | `master` @ `5432f07`: SABR sessions each use one random `NETWORKING_IPV6_BLOCK` address (`src/lib/sabr/egress.ts`). Deployed 2026-11-03 with `NETWORKING_IPV6_BLOCK=2a02:a45d:15fe:15:fffe::/80`, `sysctls: net.ipv6.ip_nonlocal_bind: 1`; host side: ndppd (`/etc/ndppd.conf`) + `companion-ipv6-rotation.service` |
| `2026.11.03-master-7421b77` | `master` @ `7421b77`: PO-token validation by two-byte ranged GET (200/206). Deployed 2026-11-03 **anonymous** (cookies env_file commented out) with `/etc/gai.conf` from `companion-gai.conf` so YouTube is reached over IPv6: our IPv4 is flagged "not a bot", the IPv6 exit 2a02:a45d:15fe:15::11 is not. Working: PO token validates, `/youtubei/v1/player` and `/sabr` serve uncached videos |
| `2026.11.03-master-4638bf8` | `master` @ `4638bf8`: fallback clients keep going when one throws, signatureCipher formats are not a fallback reason, config dump redacts cookies and secret key, signed-in session PO token bound to the DataSync ID (deployed 2026-11-03 with `env_file: ./companion-cookies.env`). Signed-in MWEB stream URLs still 403 on HEAD as of 2026-11-03 |
| `2026.11.01-master-2e7b63f` | `master` @ `2e7b63f`: PO-token validation errors name YouTube's playability status/reason (deployed 2026-11-01, with `JOBS_YOUTUBE_SESSION_FREQUENCY=7 * * * *`, `cpus: 2`, `mem_limit: 6g`) |
| `2026.09.23-master-8ea6aec` | `master` @ `8ea6aec`: VISIONOS VOD sessions, pull abort, reload handling, bounded read-ahead (built and verified side by side 2026-09-23; deploy pending) |
| `2026.09.23-camoufox-471fa2e` | `master` @ `471fa2e` (deployed 2026-09-23) |
| `2026.09.21-master-ad8b441` | `master` @ `ad8b441` (deployed 2026-09-21) |
| `2026.09.21-sabr-live-4090006` | tag `deployed/2026.09.21-sabr-live-4090006` |
| `2026.07.29-dvrfix-captionfix` | the older `invidious-companion-dvrfix` tree |
