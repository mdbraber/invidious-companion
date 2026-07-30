/**
 * Optional on-disk cache for prepared tracks, so a restart does not re-pull
 * everything.
 *
 * Only **completed** tracks are persisted. A partially pulled track is cheap to
 * abandon (the media refills in the background and segment requests wait on
 * individual segments), whereas resuming one from disk means reconciling a
 * half-filled buffer with a live pull — complexity that buys little.
 *
 * Disabled unless `SABR_DISK_CACHE_DIR` is set, because the companion
 * deliberately restricts `--allow-write`: the chosen directory must be added to
 * that allow-list or every write here fails.
 */
const DIR = Deno.env.get("SABR_DISK_CACHE_DIR") || "";
const BUDGET_BYTES = Number(Deno.env.get("SABR_DISK_CACHE_MB") || 4096) *
    1024 * 1024;

export const diskCacheEnabled = () => Boolean(DIR);

/** Video ids and track names are already validated, but be explicit. */
const safe = (s: string) => /^[\w.-]+$/.test(s);

const trackDir = (videoId: string, track: string) =>
    `${DIR}/${videoId}/${track}`;

/**
 * Everything about a track that cannot be recovered from its bytes: codec
 * string, bitrate, dimensions. Reconstructing these from the session works for
 * video (the rendition list has them) but not for audio, whose codecs and
 * bandwidth live only on the pulled format — so persist them explicitly.
 */
export interface TrackMeta {
    mimeType: string;
    codecs: string;
    width?: number;
    height?: number;
    bandwidth: number;
    isVideo: boolean;
}

const META = "meta.json";

export async function loadTrack(
    videoId: string,
    track: string,
): Promise<
    { files: Map<string, Uint8Array>; meta: TrackMeta } | undefined
> {
    if (!DIR || !safe(videoId) || !safe(track)) return undefined;
    const dir = trackDir(videoId, track);
    try {
        const files = new Map<string, Uint8Array>();
        let meta: TrackMeta | undefined;
        for await (const entry of Deno.readDir(dir)) {
            if (!entry.isFile) continue;
            if (entry.name === META) {
                meta = JSON.parse(
                    await Deno.readTextFile(`${dir}/${META}`),
                ) as TrackMeta;
                continue;
            }
            files.set(entry.name, await Deno.readFile(`${dir}/${entry.name}`));
        }
        // A track without its init segment or metadata is unusable — treat as a
        // miss rather than serving a manifest with an empty codec string.
        if (!files.has("init.mp4") || !meta) return undefined;
        // Touch so pruning sees this as recently used.
        try {
            const now = new Date();
            await Deno.utime(dir, now, now);
        } catch { /* utime is best-effort */ }
        return { files, meta };
    } catch {
        return undefined;
    }
}

export async function saveTrack(
    videoId: string,
    track: string,
    files: Map<string, Uint8Array>,
    meta: TrackMeta,
): Promise<void> {
    if (!DIR || !safe(videoId) || !safe(track)) return;
    const dir = trackDir(videoId, track);
    // Write to a temporary directory and rename, so a crash mid-write cannot
    // leave a half-written track that later looks complete.
    const tmp = `${dir}.tmp-${performance.now().toString(36).replace(".", "")}`;
    try {
        await Deno.mkdir(tmp, { recursive: true });
        for (const [name, bytes] of files) {
            await Deno.writeFile(`${tmp}/${name}`, bytes);
        }
        await Deno.writeTextFile(`${tmp}/${META}`, JSON.stringify(meta));
        await Deno.remove(dir, { recursive: true }).catch(() => {});
        await Deno.rename(tmp, dir);
    } catch (err) {
        console.log(
            `[WARN] [sabr] disk cache write failed for ${videoId}/${track}: ${
                (err as Error).message
            } (is ${DIR} in --allow-write?)`,
        );
        await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
}

/** Drop least-recently-used videos until the cache fits its byte budget. */
export async function prune(): Promise<void> {
    if (!DIR) return;
    try {
        const videos: { path: string; mtime: number; bytes: number }[] = [];
        for await (const v of Deno.readDir(DIR)) {
            if (!v.isDirectory) continue;
            const path = `${DIR}/${v.name}`;
            let bytes = 0;
            let mtime = 0;
            for await (const t of Deno.readDir(path)) {
                const tp = `${path}/${t.name}`;
                const st = await Deno.stat(tp).catch(() => null);
                if (st?.mtime) mtime = Math.max(mtime, st.mtime.getTime());
                for await (const f of Deno.readDir(tp)) {
                    const fs = await Deno.stat(`${tp}/${f.name}`).catch(() =>
                        null
                    );
                    bytes += fs?.size ?? 0;
                }
            }
            videos.push({ path, mtime, bytes });
        }

        let total = videos.reduce((n, v) => n + v.bytes, 0);
        videos.sort((a, b) => a.mtime - b.mtime);
        for (const v of videos) {
            if (total <= BUDGET_BYTES) break;
            await Deno.remove(v.path, { recursive: true }).catch(() => {});
            total -= v.bytes;
            console.log(`[INFO] [sabr] disk cache evicted ${v.path}`);
        }
    } catch {
        // A missing or unreadable cache directory is not fatal.
    }
}
