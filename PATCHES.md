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

## Settings

| env | default | |
|---|---|---|
| `SABR_LIVE_MANIFEST_TTL_MS` | 20000 | re-fetch interval for YouTube's live manifest. We run **5000**: players only see segments the manifest lists. |
| `SABR_POT_URL` | — | PO token provider for WEB sessions (dubbed audio); ANDROID_VR needs none |
| `NETWORKING_IPV6_FLAG_TTL_MS` | 86400000 | how long a /64 that drew "not a bot" is avoided by rotation |
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
