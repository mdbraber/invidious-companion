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
  `/sabr`:
  - `GET /sabr/:id/manifest.mpd`: DASH for SABR-only VOD; for live and
    post-live DVR it proxies YouTube's own dynamic manifest from an ANDROID_VR
    session, BaseURLs rewritten to `live/<check>/<index>/`;
  - `GET /sabr/:id/live/:check/:rep/*`: live segments. `check` travels in the
    path because relative segment URLs drop a query string;
  - `GET /sabr/:id/:track/(init.mp4|seg-N.m4s)`: VOD segments;
  - `GET /sabr/:id/download?itag=`, `GET /sabr/:id/watch` (test player page).
  - Guarded by `SERVER_VERIFY_REQUESTS` like the other routes.
- **Build**: the Dockerfile copies `vendor/` (the SABR code imports it).

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
| `SABR_SEED_HEIGHT` / `SABR_MAX_HEIGHT` | 360 / 1080 | SABR VOD ladder |
| `SABR_SEGMENT_WAIT_MS`, `SABR_SESSION_TTL_MS`, `SABR_RETAIN_SEGMENTS`, `SABR_FORWARD_WINDOW`, `SABR_READER_IDLE_MS` | see source | SABR VOD reader tuning |

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
| `2026.09.21-master-ad8b441` | `master` @ `ad8b441` (deployed 2026-09-21) |
| `2026.09.21-sabr-live-4090006` | tag `deployed/2026.09.21-sabr-live-4090006` |
| `2026.07.29-dvrfix-captionfix` | the older `invidious-companion-dvrfix` tree |
