import { Log } from "youtubei.js";

// YouTube.js logs a full class dump (~45 lines) every time YouTube changes a
// node it knows ("InterstitialView changed!"), on every player request. Those
// are warnings meant for YouTube.js developers, not for this server's log.
// YOUTUBEJS_LOG_LEVEL: none | error (default) | warning | info | debug.
const LEVELS: Record<string, number[]> = {
    none: [Log.Level.NONE],
    error: [Log.Level.ERROR],
    warning: [Log.Level.ERROR, Log.Level.WARNING],
    info: [Log.Level.ERROR, Log.Level.WARNING, Log.Level.INFO],
    debug: [
        Log.Level.ERROR,
        Log.Level.WARNING,
        Log.Level.INFO,
        Log.Level.DEBUG,
    ],
};

export function applyYouTubeJsLogLevel(): void {
    const name = (Deno.env.get("YOUTUBEJS_LOG_LEVEL") ?? "error").toLowerCase();
    Log.setLevel(...(LEVELS[name] ?? LEVELS.error));
}

// Media requests (segment and byte-range fetches) arrive by the hundred per
// video; logging each one buries everything else. SERVER_LOG_MEDIA_REQUESTS=true
// logs them again.
const MEDIA_PATH =
    /\/videoplayback(\/|$)|\/sabr\/[^/]+\/(live\/.+|[^/]+\/(init\.mp4|seg-\d+\.m4s))$/;

export function isQuietMediaPath(path: string): boolean {
    return Deno.env.get("SERVER_LOG_MEDIA_REQUESTS") !== "true" &&
        MEDIA_PATH.test(path);
}
