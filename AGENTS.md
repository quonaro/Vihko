# Vihko

Clean-room reimplementation of the Paper (FiftyThree/WeTransfer) sketching app
as a hybrid app: Vue 3 + TypeScript frontend, Go→WASM ink engine, wrapped with
Capacitor 8.5 for Android/iOS. Based only on public screenshots/descriptions —
no decompiled code is used.

## Commands

- `pnpm install` — install deps
- `pnpm build:wasm` — build `public/engine.wasm` + copy `wasm_exec.js`
  (requires Go; `wasm_exec.js` lives at `$(go env GOROOT)/lib/wasm/`)
- `pnpm dev` — Vite dev server on :7357
- `pnpm build` — wasm + typecheck + `vite build` → `dist/`
- `pnpm typecheck` — vue-tsc (also typechecks `*.test.ts`)
- `pnpm lint` — Biome check (lint + format verify) over the repo;
  `pnpm lint:fix` — apply safe fixes and reformat; `pnpm format` — format
  only. Style: single quotes, no semicolons, trailing commas, 2-space
  indent (`biome.json`). `noUnusedImports`/`noUnusedVariables` are off for
  `*.vue` — Biome doesn't see `<template>` usage.
- `pnpm test` — Vitest (jsdom): ink engine fallback, renderer, RYB mixing,
  store, anim, i18n, component tests. `pnpm test:go` — `go test` for the
  engine (pure logic lives in `engine/ink.go`, build-tag-free).
- `pnpm cap:sync` — build web bundle and sync into `android/` + `ios/`
- `pnpm cap:android` — sync + open Android Studio (needs Android SDK)
- `pnpm cap:ios` — sync + open Xcode (**macOS only** — iOS cannot be built on Linux)

Same commands are wrapped in `lota.yml` (`lota dev`, `lota build web|apk`,
`lota wasm`, `lota cap sync|android|ios`, ...). `lota dev` builds the wasm
engine first via `depends`, so `window.Ink` is always the real engine.
`lota build apk` runs web build + `cap sync android` + `gradlew assembleDebug`.
Debug builds get `applicationIdSuffix ".dev"` → they install as `vihko.app.dev`
(launcher name "Vihko Dev") next to the release `vihko.app`, never overwriting
it; only `assembleRelease` (CI) produces the prod package.
`lota dev:android` — live-reload on Android: boots an AVD if none is
connected, rebuilds the web bundle (`vite build`) so the installed APK is
never stale, (re)uses vite on :7357 and runs `cap run android --live-reload`
with `adb reverse`, so the installed WebView loads http://localhost:7357
and vue HMR works on device. The installed APK keeps `server.url` baked in
until a normal build is reinstalled (`cap sync android && gradlew
installDebug`); engine/*.go changes still need `lota wasm` + app reload.
`lota push [tag]` pushes main; with a `v*.*.*` tag it also pushes the tag,
which triggers the GitHub release workflow.

## CI/CD

`.github/workflows/ci.yml` runs on pushes to `main` and on PRs, in four
parallel jobs: `lint` (`biome ci` — lint + format), `typecheck`
(`pnpm typecheck`), `test-web` (`pnpm test`) and `test-go` (`gofmt -l`,
`go vet`, `go test` for `engine/`).

`.github/workflows/release.yml` runs on tag pushes matching `v*.*.*` (and
manually via workflow_dispatch), but only when the tagged commit is an
ancestor of `main` — tag a commit on another branch and the job fails
fast: installs Go/Node/pnpm/JDK 21/Android SDK,
runs `pnpm test` + `pnpm test:go`, builds the web bundle, `cap sync android`,
`gradlew assembleRelease`, then publishes a GitHub Release with
`vihko-<tag>.apk` attached. Requires `contents: write` permission
(granted in the workflow).

App version resolution: the release workflow sets `VITE_APP_VERSION` (web)
and `VERSION_NAME`/`VERSION_CODE` (gradle) from the tag/run number. Local
builds fall back to `git describe --tags --always --dirty` (vite.config.ts,
android/app/build.gradle) and commit count for versionCode, then
package.json/`0.0.1`.

Release signing: `android/app/build.gradle` uses `signingConfigs.release`
when `android/keystore.properties` exists (gitignored; see
`android/keystore.properties` on the build machine — the `.jks` it points
to is the only copy, keep a backup) and falls back to the debug key
otherwise. CI rebuilds `keystore.properties` + `android/app/vihko-release.jks`
from secrets `ANDROID_KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`,
`KEY_PASSWORD` and fails fast if any is missing — without a stable key
every release gets a fresh signature and Android rejects updates
("package conflicts with another package").

## Testing

Tests are required: every behavior change must come with tests, and a change
is only done once `pnpm test`, `pnpm test:go`, `pnpm typecheck` and
`pnpm lint` are green.

- TS tests live next to sources as `*.test.ts` (Vitest + jsdom).
  `src/test.setup.ts` stubs what jsdom lacks: rAF, pointer capture,
  `canvas.getContext`, `document.elementFromPoint`.
- Engine logic belongs in `engine/ink.go` (build-tag-free) so `go test`
  covers it natively; keep `main.go` for the `js && wasm` bindings only.
- The JS fallback (`jsEngine` in `src/ink/engine.ts`) must stay in lockstep
  with the Go engine — update both sides plus the parity assertions.

## Frontend

Frontend work must be mobile-first: design and implement for mobile screens
and touch interactions first, then adapt and verify the experience on larger
screens.

## File Size

- Keep Go source files around 300 lines and below 400 lines. Split larger
  files by responsibility before they exceed the limit.
- Keep Vue single-file components around 600 lines and below 700 lines.
  Move reusable logic and UI into focused modules or components before
  reaching the limit.
- Count physical lines, including blank lines. Generated files are exempt.
- Treat these as limits for new and substantially edited code; avoid unrelated
  churn solely to bring existing files under the limits.

## Capacitor

- `appId`: `vihko.app`, `webDir`: `dist` (see `capacitor.config.ts`)
- Native projects: `android/` (Gradle, needs Android SDK), `ios/` (needs Xcode)
- Data retention on uninstall: `hasFragileUserData="true"` gives the
  "keep app data" checkbox in the uninstall dialog, but
  `allowBackup` MUST stay `false` — verified on Honor 50/MagicOS that an
  existing backup dataset makes the installer run a restore
  ("Unable to finalize restore" in logcat) which wipes the kept data.
  `Filesystem.downloadFile` also ignores `recursive` on Android — parent
  dirs must be `mkdir`'d first (see `src/update.ts`).
- The wasm engine ships inside `dist/` → copied into native web assets by sync

## Layout

- `engine/` — Go WASM ink engine: pointer points → smoothed samples
  `{x,y,w,a}` — a port of the perfect-freehand stroke model adapted to
  incremental centerline sampling: streamline input smoothing, real stylus
  pressure when it varies (auto-detected) or speed-simulated pressure
  otherwise, `radius = dia*(0.5 - thinning*(0.5 - pressure))`, start/end
  tapers (the end-taper tail is buffered and shaped on flush), a min-length
  noise gate, and a full-size dot for taps. `ink.go` holds the pure logic
  (no build tag → covered by `go test`); `main.go` is the thin `js && wasm`
  binding registering `window.Ink` (`begin(tool, size?, stab?)` /
  `addPoint` / `predict` / `end`). `stab>=0` overrides the tool streamline
  (brush stabilizer slider, stored per stroke as `stroke.stab` so replay
  stays deterministic).
- `src/ink/engine.ts` — wasm loader + pure-JS fallback (same algorithm).
  `Ink` also exposes pixel kernels from `engine/px.go` — `floodFill`
  (paper-aware tolerance fill), `boxBlur`, `sharpen`, `adjust`
  (brightness/contrast/saturation) and `wetStroke` (libmypaint-style wet
  mixing: each dab picks up canvas color ahead along the stroke and
  re-deposits the mix) — mirrored in the JS fallback; ops apply them via
  `PageOp {kind:'filter'}` and watercolor strokes with `stroke.wet>0` replay
  through `wetStrokeDabs` in layers.ts. The magic-wand family adds
  `inverseFill` (paints the complement of the seed region) and `eraseColor`
  (clears the contiguous matching region — background removal); the fill
  tool cycles bucket → inverse → erase on second tap (`store.fillMode`,
  badge on the tray icon), committing `fill` with `invert:true` or
  `PageOp {kind:'erase'}` respectively.
- `src/ink/renderer.ts` — Canvas2D painters per tool (solid/pencil/watercolor/eraser).
- `src/ink/ops.ts` — raster page ops replayed in stroke order via `after`
  (flood fill, cutout move, photo collage, clear, filter, erase). Photos
  persist via `imageDataURL` — WebP where supported (alpha-capable),
  PNG/JPEG fallback — downscaled ≤2048px. Cover presets and layer
  thumbnails use the same helper.
- Pages support ordered layers with visibility, opacity, position, scale, and
  rotation; legacy strokes and ops are assigned to the first layer. Layer
  contents rasterize once at a fixed 3072px width (`LAYER_RASTER_W` in
  `src/ink/layers.ts`, cache key `pageId|layerId` — zoom composites via
  drawImage, never re-replays). `layer.blend` (10
  `globalCompositeOperation` modes) applies at composite time;
  `layer.clip` masks a layer to the nearest visible non-clipped layer below
  (destination-in onto its transformed alpha); `layer.alphaLock` confines
  new paint to existing alpha — recorded per stroke/op as `alphaLock` so
  replay stays deterministic (source-atop strokes/photos, fills masked to
  pre-fill alpha; the eraser is never locked). The layer panel shows
  content-cropped thumbnails (`layerThumb`/`buildThumb` in CanvasView via
  `layerRasterCanvas` + `layerContentBounds`).
- `src/ink/path.ts` — Ramer–Douglas–Peucker simplification for cut gestures.
- `src/ink/shapes.ts` — vector paths for the shape tool (rectangle, ellipse,
  line, arrow, triangle, diamond).
- `src/ink/mix.ts` — RYB subtractive color mixing, hue rotation, and HSV
  conversion for `src/components/ColorPicker.vue` (SV square + hue strip +
  hex input in a `MobileSlider` dialog, opened via the tray swatch; dropping
  a palette dot on the swatch still blends it in).
- `src/pageSpace.ts` — canonical page coordinate space (`PAGE_W`×`PAGE_H`
  units, matching the 300×380 preview viewBox at 0.28). Pages may declare
  `page.w`/`page.h` (page units — `pageSize(page)` resolves them, presets in
  `PAGE_SIZE_PRESETS`, chosen at creation in JournalView via
  `store.pageSize`; `coverViewport`/`clampOffset` take the page size and the
  layer raster scales to the page aspect). All stroke points and
  op coords are stored in page units; the editor viewport is a cover-fit
  window onto the sheet (`coverViewport`/`clampOffset`), pannable with the
  `move` tool and zoomable via the `+`/`−` buttons (`view.s = cover * zoom`;
  `clampOffset` centers the sheet on axes where it fits inside the viewport).
  Committed strokes+ops are cached in an offscreen snapshot (`ensureSnap` in
  CanvasView, ~3200px cap) so pans/zooms blit instead of replaying — watchers
  on `strokes`/`ops`/`pageId` (flush:'sync') invalidate it; appended strokes/ops
  take a fast path that draws only the new entry onto the snapshot. Legacy screen-px
  saves are rescaled once by `migrateToPageSpace` in `store.ts`
  (flag `vihko:page-space`).
- `src/three/` — real 3D (three.js/WebGL) journal + shelf views: `stage.ts`
  (`FramePump` = render-on-demand: the loop only runs while a scene reports
  motion, so an idle view costs nothing; quality tiers pick PCF vs VSM
  shadows and skip the MSAA+FXAA composer on low-tier GPUs). Textures and
  geometries are disposed on `setPages`/removal (page textures evicted from
  `texCache` when their page disappears).
  holds the shared renderer + lighting rig; `layout.ts` the pure fan/curl
  math and `shelfLayout.ts` the pure shelf math (book poses, pointer tilt,
  scroll limits — both unit tested); `pageTexture.ts` rasterizes a page
  (strokes via ink engine + ops) and `coverTexture.ts` a journal cover
  (color/photo, spine, title) into canvas textures;
  `journalScene.ts` is the WebGL spread (raycast picking, animated page
  turn), `shelfScene.ts` the WebGL shelf (books as rounded board+pages sandwiches,
  per-book tilt from pointer position, drag/wheel pan, projected anchors
  for DOM overlays). Lazy-imported by JournalView/ShelfView — three.js
  ships as a separate chunk; these views require WebGL and display an
  unavailable message rather than switching to a 2D rendering mode.
- `src/store.ts` — journals/pages/strokes model, undo/redo, and persistence:
  native Android/iOS use SQLite (with one-time migration from the prior
  localStorage save; `src/persistence.ts` enables WAL and checkpoints +
  VACUUMs on open to reclaim space from overwritten journal blobs);
  browser development continues to use localStorage.
- `src/covers.ts` — generated, local cover-art presets for the cover picker.
- `src/router.ts` — tiny history-API router: two-way sync between the URL and
  `store.view`/`journalId`/`pageId`/`journalMode` (`/` shelf,
  `/journal/<id>[/overview]`, `/journal/<id>/page/<pageId>` canvas), popstate
  handling, and a `vihko:nav` localStorage copy of the last position that
  `initRouter` restores when booting on `/` (the native WebView always starts
  there; a dev-server reload keeps the deep link).
- `src/views/` — ShelfView (search, journal actions, cover picker) →
  JournalView (page fan / two-page spread) → CanvasView.
- `refs/` — reference screenshots (not shipped).

## Tools & gestures (CanvasView)

- Tools: eraser, draw, sketch, outline, write, color (watercolor),
  shapes (context menu + drag-to-draw), fill (tap-to-fill),
  cut (loop → lift → drag), move (pan the sheet), transform (drag the active layer).
- Brush size uses a vertical left-rail slider, stored per tool and with each
  stroke. Ink tools also get a stabilizer slider (0..1 streamline override,
  stored as `stroke.stab`). Tapping the active ink tool again opens the brush
  panel (`BrushPanel` in ToolTray): size/opacity/stabilizer/blend, texture tip
  (`noise`/`airbrush`/`marker` stamps — `renderStamped` in renderer.ts with
  spacing/jitter/scatter/angle) and named presets (`store.brushPresets`,
  persisted to `vihko:brushes`). Per-tool params live in `store.brush`; a
  snapshot lands on each stroke (`brushSnapshot` → flat `stroke.opacity`,
  `tip`, `spacing`, ... fields) so replay stays deterministic.
- The layer manager is a modal supporting add/select/rename/hide/delete,
  thumbnails, opacity, blend mode, alpha lock, clipping mask, layer alpha
  masks (`layer.mask` + `stroke.mask` strokes replayed into a mask raster —
  ink reveals, eraser hides; edit mode via `store.maskEdit`), and grip-drag
  reordering. The on-canvas transform frame has resize and rotation handles.
- Symmetry (`store.symmetry` v/h/xy, cycled from the top bar) mirrors strokes
  across the page-center axes — mirrored copies are pushed as extra strokes.
  Drawing guides (`store.guide` line/arc, `snapToGuide`) snap ink points onto
  a straightedge or a circular french curve; the overlay draws in page space
  and its handles drag the anchor, the line angle, or the arc radius.
- Zoom: `+`/`−` buttons bottom-right zoom around the viewport center (×1.4 per
  tap, clamped to [contain·0.9, cover·5]); two-finger pinch zooms around its
  moving midpoint and pans. The move tool remains a one-finger grab. A fit
  button appears when the view diverges from cover-fit and restores it.
  Each page remembers its own view.
- Tray extras: `+` new page, photo import (file picker → centered collage),
  `⌫` clear page (undoable).
- Top chrome: `×` close, `↶`/`↷` undo/redo buttons, `⤓` PNG export.
- 1 pointer: draw (pen pressure supported; touch ignored while pen active;
  `getCoalescedEvents` feeds all queued points, `getPredictedEvents` paints
  a speculative tail that is re-blit from the snapshot on the next event),
  or grab with move/transform
- 2 pointers: pinch zoom + midpoint pan
- Edge swipe (from left/right ~34px zone, horizontal >60px): prev/next page
- Ctrl/Cmd+Z / +Shift+Z: undo / redo

Undo/redo is unified: `page.strokes` (vector) + `page.ops` (raster, tagged
with `after` = stroke count at the time) replay interleaved on `reRender`.

Shelf and journal organization: tap the `⋯` journal control to select it,
then rename/export/delete or change its cover from a preset/uploaded photo.
Shelf search opens a modal listing matching journals by title (tap a result
to open it). Journal view toggles between the fan and
book spread.

## MCP

`.devin/mcp_config.json` wires `pyghidra-mcp` (Ghidra at `/opt/ghidra`) —
optional, for analyzing the original app's binary if a decrypted build is
ever obtained. `ghidra-projects/` holds the Ghidra project files.

## Environment notes

- Toolchain present on this machine: Node 24, pnpm, Go 1.27, JDK 21, Rust —
  Android SDK at `~/Android/Sdk` (`ANDROID_HOME` set) with AVD
  `Medium_Phone_API_37.0`; boot it with
  `~/Android/Sdk/emulator/emulator -avd Medium_Phone_API_37.0` before
  `gradlew installDebug` / `cap run android`. No macOS/Xcode, so iOS is out.
- pnpm prints "Ignored build scripts: esbuild" — harmless, esbuild ships its
  binary via an optional dep; dev/build verified working without approve-builds.
- UI verification: a Chrome with remote debugging runs at `127.0.0.1:9222`;
  the `chrome-devtools` MCP can drive it (navigate, snapshot, synthetic
  PointerEvents to test drawing).
