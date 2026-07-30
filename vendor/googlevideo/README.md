# Vendored: googlevideo 4.1.1 + nedworks patches

`dist/` output of https://github.com/LuanRT/googlevideo (MIT) at 4.1.1 with the
patches from `owntube/spikes/sabr-dash/googlevideo-seek.patch`:

- seek: requested start position no longer reset to 0 before format init
- `bufferedRanges` accumulates for the session instead of sending deltas
- millisecond ticks labelled `timescale: 1000` instead of the media timescale
- `VIDEO_ONLY` expressed as bitfield 0 + client-side discard (2 is not a SABR value)
- media-header times read from `timeRange` ticks; init segments not recorded

Imported via the `gv/` map in deno.json (-> `vendor/googlevideo/src/exports/`).
Regenerate by building the fork (`./node_modules/.bin/tspc`) and copying `dist/*`
here. Do not edit in place.
