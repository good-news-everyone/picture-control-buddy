# Work plan: 100% zoom and display sharpening on Compare

> **Status 2026-11-24: Z1, Z2 (code) and Z3 (code) written; browser checks and the wasm rebuild pending.** Scope: the fitting wizard's Compare screen
> and its quick editor (`picture-control-jpg-fit.html`, `lib/compare-view.js`, `lib/fit-app.js`). The
> mobile page is not touched; the desktop profile editor got the same zoom afterwards (section "Profile editor"). No Python change (D10).

## Goal

1. **100% zoom.** A zoom level where one sensor pixel of the RAW is one device pixel of the screen,
   with the RAW side developed from a real demosaic of the visible region, not the ~1512 px compare
   render stretched.
2. **Display sharpening at the fitted view.** At the default (fit-to-screen) zoom the render looks
   noticeably softer than the target; add a small display-only unsharp mask there.

## Baseline (2026-11-24)

- `web/raw/src/lib.rs` has no demosaic: `develop` makes a superpixel frame (each 2×2 Bayer block ->
  R, mean G, B), crops the MX/MY margins, box-shrinks by `k` and rotates. Its finest output is half the
  sensor (`long = 0`, 3024×2016 on the Z f).
- Pairs are decoded at `long = 1600` (k = 2 on the Z f, ~1512×1008); the compare render
  (`renderCompareSide` -> `viewRemap`, ≤ 2048 px and ≤ the frame) is the same size and is stretched
  by the zoom. The target is decoded full size; its display canvas is capped at `TARGET_LONG` = 4096.
- RAW decodes are serialized: `fit-app.js` `rawQueue`, one `raw-worker.js` with one wasm instance,
  the loader is single-generation (a new `open()` makes the previous one stale) and the worker keeps
  only the latest queued message.

## Decisions (fixed for this plan)

- **D1. 100% = one sensor pixel per device pixel** (Z f: 6048 px on the long side). The canvas is
  already HiDPI (decision #15f), so on a dpr-2 screen 100% is 1 sensor px per 0.5 CSS px. The zoom
  readout shows percent of that scale.
- **D2. Source pyramid by zoom.** (a) fit view up to ~25%: the current compare render (+ D9 at the
  fit view); (b) ~25-75%: the visible region (ROI) at half-sensor resolution, the superpixel
  arithmetic of `develop`; (c) from ~75%: the ROI demosaiced at full sensor resolution. Thresholds are
  chosen so the ROI never has more than ~2× the viewport's device pixels; they are tuned in Z3.
- **D3. Demosaic from rawler.** `rawler 0.8` (already our dependency) has
  `imgop::sensor::bayer::ppg::PPGDemosaic` implementing the `Demosaic` trait with a `roi: Rect`
  argument — it demosaics just the region. No GPU demosaic shader, no new crate. Fallbacks if PPG does
  not fit our data: rawler's `bilinear`, or the `demosaic` crate (MIT/Apache, MHC/PPG/AHD).
- **D4. One raw worker; 100% waits for decoding.** The same worker holds the mosaic of the selected
  pair (one pair at a time). Hold and ROI jobs run through `rawQueue`, after any pair decode in
  flight; while a decode runs or the hold is being built, levels (b)/(c) are unavailable: the viewer
  keeps the stretched compare render and shows a small loader, and the ROI appears when the job
  finishes. The jobs are new worker message types: they do not bump the loader generation and are
  not dropped by the worker's "only the latest" queue rule (that rule stays for `develop`).
- **D5. The ROI goes through our Renderer.** Neutral -> the profile LUT (the cached one, same key)
  -> detail at an explicit scale (2 for (b), 1 for (c)). The NX base detail is outside `BASE_RANGE`
  at these scales and is off (it is calibrated at 1512-1600 px, decision #18). The pair's edit gain
  multiplies the ROI as `gainedFrame` does.
- **D6. Clarity's large blurs come from the compare render.** Blurs with sigma above a threshold
  (~4 px of the compare grid) are taken from the compare render's cached blurs (`reuseBlurs`) and
  upsampled into the ROI; small sigmas (Sharpening, Mid-range) are computed on the ROI with a margin
  of ~3 sigma. This avoids a ~540 px margin for sigma ~180 full-frame px.
- **D7. Geometry on the CPU.** `viewRemap` gets a `window` option (a rectangle of the working space)
  and returns the map for it only; `applyRemap` stays the CPU Catmull-Rom gather (~100 ms for 3 MP).
  No GPU remap.
- **D8. Target at 100%.** The visible rectangle is cut from the full `pair.target.rgb` into a small
  canvas; the `TARGET_LONG` display canvas stays for the fit view.
- **D9. Display sharpening.** An unsharp mask on the render side only, only at the fitted view
  (`view.scale === 1`), drawn from a canvas resampled to the on-screen size. Display only: the NP3,
  the report, the fit, the detail fit and the export never see it. The amount is a constant calibrated
  once (top-octave amplitude ratio render/target at the fit-view scale on the SA frames) and recorded
  here.
- **D10. No Python change.** Python is the source of truth for the parts that exist in both copies
  (spec/web-tests.md); this is a web-only display feature built from those already-tested blocks. The
  new checks have no Python reference, like levels 1h / 1k. Optional: a scale-1 case for level 6 in
  `web/make_golden.py` (the detail at full sensor scale; level 6 covers scales 2 and 4 today).
- **D11. Guards.** Desktop wizard only. 100% (c) is off where `MAX_TEXTURE_SIZE` or memory is short
  (the decision #17c rules: `deviceMemory`, cores); a lost WebGL context falls back to the compare
  render. Leaving the pair, removing it or leaving Compare releases the hold and the ROI textures.

## Memory budget (Z f, 24.4 MP; 1 byte/px ≈ 24 MB)

| Item | When | Size |
|---|---|---|
| Held mosaic (u16) in the raw worker | while the selected pair is held | ~49 MB (+ the decode peak while building it) |
| ROI GPU textures (neutral, profile, detail, out) | while at (b)/(c) | ~50-85 B/px × ≤ ~5 MP ≈ 250-420 MB |
| ROI CPU (demosaic out, map, remap, canvas) | while at (b)/(c) | ≈ 70-300 MB, transient |
| Target crop | while at (b)/(c) | ≤ viewport, a few MB |

The full-frame alternative (no ROI) was estimated at ~2 GB CPU + ~2 GB GPU and rejected.

## Stages

Every stage ends with `python3 test_np3.py`, `python3 test_detailfit.py` and `cd web && node test.mjs`
green, a log entry below and one commit (unless the user says otherwise).

### Z1. Display sharpening at the fit view (~0.5 d) - done 2026-11-24

- `lib/display-sharpen.js`: pure `unsharpRGBA(data, w, h, { sigma, amount })`, luma only (Rec.709
  weights on the display-encoded values; the same delta goes to R, G, B, so no color fringes), clamped
  edges, alpha kept, results clamped 0..255. Test: `web/test-node-display-sharpen.mjs`.
- `lib/compare-view.js`: at `view.scale === 1` the render side is drawn from a cached canvas - the
  render bitmap resampled (`imageSmoothingQuality = "high"`) to its exact on-screen size in device
  pixels, sharpened, drawn 1:1 with the translation snapped to whole device pixels. Cache key: render
  canvas identity, device size, dpr, amount. Both modes (side, curtain) use it; other zooms, the
  target, the overlays, the report, the fit and the export are untouched.
  `debug().displaySharpen = { active, sigma, amount, s }`.
- **Rule (adaptive amount).** s = on-screen long side in device px / render bitmap long side.
  sigma = 1.0 device px, amount = clamp((s - 0.9) / 0.6, 0, 1) (was (s - 0.6) / 0.6, see the Log
  entry of the user review); amount 0 means "draw as today" (no
  sharpened canvas). `?dsharp=<amount>` overrides the amount (0 disables; read once, capped at 2).
- **Calibration** (`research/zoom/dsharp_calib.mjs`, SA frames DSC_5932, DSC_6015, DSC_6151, profile
  `out/sa_landing/SA.NP3`; render = compare grid via `detail-fit.renderLuma`, target = LR JPEG
  Lanczos to the device size; Y' only; top octave = DoG 0.6/1.2 px, `rel` = target/render band RMS
  with the DoG 1.5/3.0 band as a contrast reference; medians over 3 frames, 1 = match):

  | device long side (s) | plain | 0.7 / 0.5 | 1.0 / 0.5 | 1.0 / 1.0 |
  |---|---|---|---|---|
  | 900 (s ~ 0.6) | 1.03 | 0.89 | 0.85 | 0.74 |
  | 1800 (s ~ 1.2) | 1.30 | 1.18 | 1.13 | 1.01 |

  At s ~ 0.6 the downscale already gives the render the target's top octave (any mask overshoots);
  at s ~ 1.2 the upscaled render is 1.3x softer and sigma 1.0 / amount 1.0 closes it. The linear ramp
  joins the two measured points; no other point was measured (only 3 frames, 2 sizes), so
  `?dsharp=` is there for tuning by eye. Cost: ~0.1 s per rebuild at 2000 px (render change,
  resize), cached otherwise.
- Browser check still needed (no Firefox here): the fit view at dpr 1 and 2, curtain and side by
  side, a zoom (plain path), `?dsharp=0` against default.
- Tests: Node unit test above. Level 8 (browser, not run here): the fit view reports
  `debug().displaySharpen.active` at a large enough window, a zoom reports false; the report and the
  export are unchanged.

### Z2. Decoder: hold + ROI (~0.5-1 d) — code done 2026-11-24, wasm rebuild pending (`sh web/build.sh`)

As built (`web/raw/src/lib.rs`, `lib/raw.js`, `lib/raw-worker.js`; `develop` is untouched):

- `hold(ptr, n) -> u32`: decodes like `develop` (same error codes: `nef_high_efficiency`, `decode_failed`,
  `not_bayer`; `not_bayer` also for a non-2×2 CFA) and keeps the margin-cropped mosaic as **u16 already
  normalized** exactly like `develop` per mosaic pixel (black per CFA position, WB, scale to 16 bits,
  floor, clamp) — so no black/white/WB are stored and every ROI is plain integer arithmetic. 2 bytes per
  sensor px: 6048×4032 = 46.5 MB on the Z f (Z 8 DNG 8264×5512 = 86.9 MB). The input bytes and rawler's
  `RawImage` are not kept; the mosaic is normalized and cropped in rawler's own buffer (no second copy).
  Info JSON = `develop`'s plus `"held":[W,H]`, `"margin":[8,4]` (sensor px, = 2·MX, 2·MY), `"cfa":"RGGB"`
  (phase at the held origin; the margins are even so it equals the sensor's) and `orientation`.
  A new hold (or a failed one) replaces the previous one.
- `roi(x, y, w, h, level) -> u32`: float RGB 0..1 (`value / 65535`), interleaved, rows top-down, **not
  rotated** (sensor orientation), read through the existing `width/height/data/info_ptr/info_len`.
  Errors in info: `no_hold`, `bad_level`, `roi_bounds`. `release()` drops the hold and the last result.
- **Coordinates.** The held area is the sensor minus the margins, W×H = 2·(w/2 − 2·MX) × 2·(h/2 − 2·MY).
  Level 1 (full sensor resolution): full px (X, Y), 0 ≤ X < W, 0 ≤ Y < H, has its centre at sensor
  (2·MX + X + 0.5, 2·MY + Y + 0.5). Level 2 (half): half px (u, v) covers full px [2u, 2u+2) × [2v, 2v+2) of
  the same held area, i.e. half coordinates × 2 = full coordinates (edge-aligned; the centre of a half px
  is the corner shared by its 4 full px). Orientation is applied by the caller (the info carries it).
- **Level 2** is the superpixel arithmetic of `develop`; the whole level-2 area equals `develop(long = 0)`
  before its rotation, bit for bit, and so does any sub-rectangle.
- **Level 1 is a port of rawler's PPG, not a call to `PPGDemosaic`.** `PPGDemosaic::demosaic` calls
  `std::time::Instant::now()` (panics on `wasm32-unknown-unknown`, and the build is `panic = abort`, so a
  trap) and runs on rayon. The port (`ppg`, `ppg_borders` in lib.rs) is the same passes and arithmetic,
  sequential and in place; natively it is bit-identical to `PPGDemosaic` on whole frames and on ROIs. Output
  is clamped to 0..1 (PPG overshoots slightly). `roi` demosaics the rectangle plus 8 px on each side
  (clipped to the held area): PPG output more than 3 px from the window edge does not depend on the window,
  so the ROI equals the same crop of a full-frame result, also at the held-area borders (there the window
  is the true edge, exactly as in the full frame).
- **JS.** `raw.js` returns `{ develop, hold(bytes) -> { info }, roi(x, y, w, h, level) -> { w, h, rgb, info },
  release(), zoom }`; `hold`/`roi` throw `code = "zoom_unsupported"` when `raw.wasm` lacks the exports
  (`zoom === false`; `release` is then a no-op). `raw-worker.js`: typed messages `{ type: "hold", id, bytes }`
  -> `{ id, info }`, `{ type: "roi", id, x, y, w, h, level }` -> `{ id, w, h, info, rgb }` (rgb
  transferred), `{ type: "release", id }` -> `{ id }`; errors `{ id, error: { code, detail } }`. They are
  answered in arrival order and are never dropped; the "only the latest queued" rule applies to untyped
  develop messages alone (a typed message in the init queue stays, an untyped one only replaces earlier
  untyped ones). **Z3 note:** `lib/loader.js` routes every worker reply by its own `seq` ids and ignores
  unknown ids; the zoom jobs need their own reply routing (separate id space or a loader extension) — not
  done in Z2 (the loader and `fit-app.js` were out of scope).
- Tests: a native Rust harness (not shipped; its numbers are in the Log) and
  `web/test-node-zoom-raw.mjs` (level-2 equality with `develop(0)`, level-1 ROI vs crop of a larger ROI at
  the interior and the four corners, error codes, release; prints stats and timings; skips with exit 0 when
  `raw.wasm` has no hold/roi or no local RAW exists). Proposed level 1m of `test.mjs` = this file.
- Still to do for Z2 itself: `sh web/build.sh` on the user's machine, then `node web/test-node-zoom-raw.mjs`;
  `fit-app.js` hold/ROI jobs belong to Z3.

### Z3. ROI rendering and the zoom UI (~1.5-2 d) - code done 2026-11-24 (needs the renderer's `renderRegion` and a rebuilt `raw.wasm` to show anything; browser levels not run)

As built:

- `lib/pair-prepare.js`: `viewRemap(..., { window })` (done earlier; `test-node-viewremap-window.mjs`, proposed level 1n).
- `lib/zoom-plan.js` (new, pure, Node-testable). `frameGeometry` (decoded frame -> unrotated size `sw` x `sh`, turns,
  k), `levelFrame(geom, level)` (level px per decoded px `s` = k for level 2, 2k for level 1; the level frame is
  `sw*s` x `sh*s`, the same area as the decoded frame, so level continuous coordinate / s = main-frame continuous
  coordinate), `sensorPerWorking(mainMap, geom, W)` (the readout factor: main px per working px along the compare
  map's middle row x 2k), `pickLevel`, `visibleRect`, `planRegion`. `planRegion` calls
  `viewRemap(prepared, fw, fh, unrotate, { k: levelPxPerWorking, window })` (so one output grid px = one level px),
  takes the bbox of the finite sx/sy (+ the bicubic taps floor-1..floor+2 + the detail margin), clips it to the level
  frame, converts it to the unrotated held-area rectangle for `roi()`, shifts sx/sy by the region origin for
  `applyRemap` and returns `lowRes.affine = [1/s, 0, rx/s, 0, 1/s, ry/s]` (region px -> main frame px, rotation
  already applied). `rotateRegion` rotates the unrotated ROI into the decoded orientation (the inverse of
  `develop`'s np.rot90) and multiplies the edit gain.
- **Thresholds (D2).** percent = device px per sensor px (= `base * dpr * view.scale / sensorPerWorking`). No ROI at
  the fitted view or below 30% (the compare render + Z1 sharpening); level 2 (half sensor) from 30%; level 1 (full
  sensor) from 75% when `MAX_TEXTURE_SIZE >= 4096` and `navigator.deviceMemory` is not known to be < 4 (else level 2
  stays). Level 1 at 75% is ~1.8x the viewport's device px, level 2 at 30% ~2.8x.
- **Pad and caps.** The ROI is requested for the visible rectangle of the render viewport with a 25% pad on each side,
  then 12%, then none, until the region and the output window fit 5 MP (`ROI_MAX_PX`); the unpadded ROI is allowed up
  to 8 MP (`ROI_HARD_MAX_PX`); beyond that level 1 degrades to level 2, and level 2 gives up (the stretched render
  stays). Region width / height are also capped by `MAX_TEXTURE_SIZE`. The detail margin around the sampled area, in
  region px: with `lowRes` 3 * 16 sensor px / scale + 4 (52 at level 1, 28 at level 2: the largest blur kept on the
  ROI is Mid-range's 16 px); without `lowRes` (the main compare frame of this pair is not the Renderer's frame)
  3 * 180 / scale + 4 capped at 160 (so Clarity's 180 px blur is truncated there; the Z4 per-blur source removes it).
- `lib/loader.js`: `zoomCall(msg, transfer) -> Promise<reply>`: a separate id space (ids from 1e9) and reply map, no
  generation; rejects with `Error` carrying `code` / `detail` (`zoom_unsupported`, `no_hold`, `roi_bounds`, ...).
- `lib/fit-app.js`: `zoomGeometry(pair)` (cached per preparation), `zoomJob(fn)` (a job on `rawQueue`, after any
  RAW decode in flight; `zoomBusy` counts them), `zoomEnsureHold(pair, epoch)` (hold the selected pair on first need
  by re-reading `pair.rawFile`; `zoom_unsupported` -> `zoomSupported = false` for good, another failure marks that RAW
  state failed and is not retried), `zoomRelease()` (epoch++, memo and `renderer.disposeRegion()`, a queued
  `release` job; called from `syncStep` when leaving Compare, from `removePair` for the held pair and by the
  compare view on a pair change), `zoomTrim()` (region textures only, when the view is back at level 0) and
  `renderZoomSide(pair, version, strength, viewRect, level, gen)` -> `{ rgba (Uint8ClampedArray), w, h, rect, level,
  wanted }` | null. Order inside the job: stale check (a newer `gen`, a release or a removed pair), profile + LUT as
  `renderCompareSideUncached` (the quick editor uses the live control, LUT 17 / 33; a missing LUT is requested and the
  call returns null, the ready path re-renders), hold, `planRegion` (level 1 -> level 2 when too large), `roi`,
  rotate + gain, `renderer.renderRegion` (with `lowRes` iff the Renderer's frame is this pair's compare frame),
  RGBA -> RGB, `applyRemap` with the shifted window map, 8-bit conversion; `await tick()` between the heavy steps so
  the viewer's loader paints. A one-entry memo (not in the quick editor) keyed by pair preparation, version, strength,
  level and the visible rectangle. `zoomApi` is passed to `createCompare` and exposed as `__np3app.zoom`.
- `lib/compare-view.js`: the pyramid. `scheduleRender` drops the ROI (profile, strength or pair changed) and, once the
  new compare render applies, `scheduleZoom()`; zoom / pan / resize / mode change call `viewChanged()` (draw now, the
  ROI request 100 ms after the last input; a level-0 view drops the layers at once). `requestZoom` builds the target
  crop (D8: from the full `pair.target.rgb` around the visible rectangle with a 25% pad, <= 6 MP, only when the
  4096-capped display canvas is coarser than the target) and asks fit-app for the ROI; the result is reused while the
  visible rectangle stays inside its rectangle for the same wanted level. Both layers are drawn over the stretched
  base in the same working-space transform (`drawZoomLayer`), smoothed unless the zoom is >= 3 device px per ROI px
  (then pixelated). While a request is outstanding (including a RAW decode or hold in front of it) `#cmp-spin` shows
  after a 350 ms CSS delay. Controls: "Fit view" and "100%" buttons + a percent readout (`#cmp-zoombar`,
  `#cmp-zoom-val`), keys `Z` (100% at the cursor, or the middle of the render viewport) and `0` (fit) when the canvas
  area is hovered or focused (never from inputs / with modifiers), the wheel up to 400% of D1, the double click stays
  "fit". `debug().zoom = { percent, level, wanted, roiRect, crop, busy }`.
- Degradation: `raw.wasm` without zoom exports or a Renderer without `renderRegion` -> the render side stays the
  stretched compare render (the ROI request resolves null, nothing is shown or logged), the 100% button, the keys,
  the readout, the target crop and the 400% wheel range still work (they need only the compare map).
- `picture-control-jpg-fit.html` + `lib/i18n-fit-{ru,de,fr}.js`: the buttons, the readout and loader tooltips, the
  updated hint (level 1k green).
- Tests run here: `web/test-node-zoom-plan.mjs` (142 plans on the golden pairs dsc_6550 / skl_3024 with synthetic crop,
  geometry, vignette and decoder-orientation variants, levels 1 and 2). Source positions of the ROI plan vs the compare
  map at the same working point: without an XMP crop max 0.02 main px in the interior (0.45 at windows touching the
  image edge, the main map's radial clamp); with a crop up to 1.74 main px (median up to 1.07): `viewRemap` truncates
  the crop origin / size to whole frame px, which costs the 1512 px compare map up to ~1.4 px and the ROI map 2-4x
  less - an offset between the stretched render and the ROI of up to ~4 sensor px at level 1, inherent to the compare
  map, not to the ROI geometry. One output grid px = one level px within 3.4%; the readout factor from the compare
  map vs from a zoom window within 3.4% (radial warp). The unrotated rectangle contains every gather tap; `rotateRegion`
  equals np.rot90 of the whole frame for turns 0..3.
- Still to do: the browser levels (proposed 2b: the ROI box-shrunk to the compare grid vs `renderCompareSide`, two
  adjacent ROIs agree on their overlap; level 8: the 100% button, the readout, the loader during a pair decode, the
  ROI swap-in), `sh web/build.sh`, and the checklist in the Log.

### Z4. Clarity from the compare blurs, guards, polish (~1-1.5 d) - renderer side done 2026-11-24

Renderer side as built (`lib/renderer.js`, `lib/detail.js`; D5/D6; the existing `applyDetailGL` /
`applyDetailCPU` defaults and the level 6/7 paths are unchanged, `gaussCPU` got an interior fast path that
is bit-identical to the old loop):

- **API.** `renderer.renderRegion({ rgb, w, h, scale, lowRes = null }) -> Float32Array RGBA (w*h*4, row 0 =
  top) | null` (null only while the LUT of `lutCacheKey(lutN)` is not uploaded; no synchronous LUT build),
  `renderer.disposeRegion()`, `renderer.regionLowResMinSigma` (= 4 main px, writable) and, as an addition to
  the contract, `renderer.regionMargin({ scale, lowRes: { mainScale?, minSigma? } | null }) -> px` (the
  kernel radius of the largest region-side blur for the current profile: the margin the caller must add;
  0 with no tool on). `rgb`: linear camera RGB w*h*3, gain applied, same units/orientation as `setFrame`;
  `scale`: full-frame px per region px, used for the detail radii exactly like `render({ scale })`
  (`detailPlan(..., { base: true })`, so the NX base detail is off at 1 and 2, no special case).
- **Pipeline.** Same neutral shader as the main frame (vignette 0; `uSize` only feeds the vignette, the
  neutral is per pixel) -> the profile LUT (the cached one) -> detail. The region has its own texture store
  (`createDetailStore`: lin, neutral/output ping-pong, profile, luma, temp, blurs; ~65 B/px at 5 MP with
  no lowRes). It never writes `neutralCache`, `_profSize`, `_detail` or its textures, `finalKey` or the
  final texture; every pass binds the units it samples (the main path rebinds 7/3 for the profile pass,
  0/1/4-7 for the combine, 7 for blits; the only persistent program uniforms are the devmodel ones, which
  are not touched). `render()` records its detail scale in `_lastScale` (the default `mainScale`).
- **lowRes = { affine, mainScale?, minSigma? }.** Region pixel centers (x + .5, y + .5) map to main
  continuous coordinates (mainX = aX + bY + c, mainY = dX + eY + f; main pixel i has its center at i + .5).
  An entry whose sigma_fullframe / mainScale >= `minSigma` (default 4) takes its blurred luma by bilinear
  sampling (manual 4 texelFetch, edges clamped, because linear filtering of R32F needs an extension) of the
  main frame's blur of the same full-frame sigma; the other entries blur the region (reflect edges as
  today); the combine stays `rgb + sum value*table(Y)*(Y - blur)` with the region's own Y. The main blur
  is the main render's cached blur (`_detail` current for the frame, LUT key/size and `mainScale`, same
  sigma) read in place; otherwise computed from the main frame's neutral (the cached one if it is the
  vignette-0 one) -> profile -> luma into region-owned textures (`_regionMain`, up to 4 blurs kept
  between calls while frame/LUT/size are the same) - the main caches are not touched.
- **Threshold.** T = 4 main px. Measured (test below; real frame DSC_6550 half-sensor crop 1800x1400,
  tone-mapped; region 800x600 crop, error vs the same crop of the full-frame CPU detail, 8-bit levels,
  over the region minus the region-side margin): Clarity +-5 (sigma 56 and 180 ff px, main px >= 7 for
  every main scale <= 8) max 0.00-0.04, rms <= 0.009 for region scale 1/2 x main x2/x4; Mid-range +-5
  (12 ff px at region scales 1-2, 16 at 4) max 0.10 (when it falls on the main side: region scale 1, main
  x2, 6 main px) or 0.00 (region side). Sweep for Mid-range +5: T <= 3 gives 0.33-0.41 at 3 main px and 1.4
  at 1.5 main px; T = 4 is exact or 0.10 everywhere, so 4 is the smallest round threshold under the 0.5
  budget with margin; raising it only costs margin (Mid-range at 6 main px would need a 37 px margin). With
  the main frame at x4 (1512 px, Z f) the region side holds only Mid-range (12 ff) and Sharpening: margin
  37 px at region scale 1 (kernel radius of 12 px sigma), 19 px at 2, instead of 541 / 271 for Clarity.
  The test frame is an exact box-shrink of the region image; a real main frame (different demosaic, the
  superpixel render) differs a little more - check on a real pair with `region-check.html` style data in Z3.
- **CPU twin.** `applyDetailCPU(d, rgb, w, h, control, { scale, base, lowRes })`, `lowRes = { affine, mainLuma
  (Float64Array mainH x mainW, luma of the main frame's profile output), mainW, mainH, mainScale, minSigma? }`;
  helpers `lumaOf`, `regionEntries` (the source split), `regionMarginPx`, `REGION_LOWRES_MIN_SIGMA`.
- **Tests.** `web/test-node-region-detail.mjs` (Node, ~140 s, exit 1 on failure; proposed level 1o):
  (1) no lowRes, interior crop with margin = kernel radius vs full-frame: max 3.9e-6 (scale 2, all tools),
  5.7e-14 (scale 1 Clarity), 1.1e-8 (scale 1 Mid/Sharp), of 255; (2) the lowRes table above, 20 cases + a
  threshold sweep + a transposed-affine check (b, d terms; 1.1e-13); (3) all tools 0 -> output = input
  bit for bit at scales 1 and 2 with and without lowRes, no entries (base off) at 1 and 2, base is the only
  entry at 4. `web/region-check.html` (browser, not run here - no Firefox/WebGL): synthetic 3024x2016 linear
  scene, main frame x2/x4 box-shrunk, region scales 1/2; GPU `renderRegion` vs the CPU twin on the same
  inputs (no lowRes, lowRes with the main detail cache reused, lowRes with the blurs computed), tolerance
  0.05 of 255; `render()` / `blitFinal()` bit-identical after region calls and still hitting their caches
  (`stats`), `disposeRegion`, null while the LUT is missing. Serve `web/` and open the page; last line
  `ALL OK` or `FAILED n` (`window.__regionCheck`).
- Still to do in Z4 (other side): the caller passes `lowRes` and the margin from `regionMargin`; guards
  (D11), release on pair switch / removal / leaving Compare (`disposeRegion`); memory and timing measured on
  the Z f frames and recorded here; the optional level-6 scale-1 fixture (D10); tests: 2b re-run with
  Clarity +-5 (seams, agreement with the compare render); level 8: release.

### Profile editor (desktop `picture-control-editor.html`) - code done 2026-11-24

The same 100% zoom on the standalone editor: `lib/editor-zoom.js` (new, desktop page only; `core.isMobile` skips it and
the mobile page has no zoom markup), `lib/zoom-plan.js` (new pure functions), `renderer.renderRegion({ neutralOnly })`,
two optional hooks in `lib/editor-core.js`. Not run in a browser (no Firefox here); the geometry is tested in Node.

- **Base view.** `#c` (the WebGL canvas) stays the source of the current full-frame render and is the only thing shown at
  the fitted view: nothing changes there (CSS-scaled as before). From the first zoom step a 2D overlay canvas `#zv`
  (`position: absolute` over `#c`'s box, `pointer-events: none`) draws `#c` through the view transform
  (`drawImage(c, ...)`: a plain scale + offset, working space = the decoded frame; no `viewRemap`, no pair geometry), so zoom
  and pan never re-render; the wheel / drag / double click listeners sit on `#c`. The overlay is hidden at the fit, in the
  empty state and until the first frame; a window resize / panel change is followed by a `ResizeObserver` (the pan is
  re-clamped). The view is `{ scale >= 1, x, y }` (CSS px from the centre; the wheel does not go below the fit; the pan is
  clamped so the image always covers the box). Max 400%.
- **Units (D1).** percent = device px per sensor px = `base * dpr * scale / (2k)` (`editorPercent`); one decoded frame px =
  2k sensor px (`k` = the decoder's shrink, `info.k`; 2 on the Z f at long = 1600). The readout shows that percent.
- **Overlay.** `#zoomtip` at the bottom right of the image box (JS-placed from `#c`'s rect): the spinner (shown after a
  350 ms CSS delay while a request is outstanding, including a RAW decode / hold in front of it), the readout, "Fit view"
  and "100%"; CSS and markup copied from `#cmp-zoomtip`; the keys moved into the editor dictionaries (`Fit view`,
  `Fit to the screen (0)`, `One RAW pixel per screen pixel (Z)`, `Zoom: 100% is one RAW pixel per screen pixel`,
  `Rendering the detailed view…` left `i18n-fit-*.js`; the wizard still uses them through the editor dictionaries) and a new
  hint line in the left column (`Wheel — zoom, drag — pan, ...`).
- **Controls.** Wheel to the cursor, drag pans, a double click below 100% zooms to 100% at the cursor and at >= 100% returns
  to the fit (same rule as Compare), `Z` (100% at the cursor, else the middle) and `0` (fit) only while `#view` is hovered or
  focused (`#view` has `tabindex="-1"`; a click on the image focuses it), never with Ctrl / Meta / Alt / Shift and never in a
  text field - but a focused slider does not block them (it is not typing, and the focus stays on a slider after a drag), as
  with Space. Space (before / after) and Ctrl+Z are untouched.
- **Detailed layer (D2, as Compare).** From 30% a half-sensor ROI (level 2), from 75% the full-sensor PPG ROI (level 1;
  needs `MAX_TEXTURE_SIZE >= 4096`, no `deviceMemory < 4`). `planEditorRegion` pads the visible rectangle 25% / 12% / 0 against
  the 5 MP (padded) / 8 MP (unpadded) caps of Compare, adds the detail margin of `detailMargin(level, lowRes = true)` and
  returns the integer region, the unrotated rectangle for `raw.roi()`, the layer's rectangle in frame px (`inner / s`) and
  `lowRes.affine = [1/s, 0, region.x/s, 0, 1/s, region.y/s]` (region px centres -> main-frame continuous coordinates; the
  editor frame is the renderer's main frame, so no `renderRegion` arguments beyond Compare's). The job runs on a queue
  (`rawQueue` of editor-zoom.js) behind any RAW decode the editor started (`openRaw` chains the loader's promise), `hold`
  once per RAW (the File is re-read: the loader transfers the bytes away, so editor-app.js keeps it by loader generation),
  `roi`, `rotateRegion` (no gain), `renderRegion` at the committed LUT size 33 (the main path's `lutN` and profile are
  restored around the call), the result is cropped to the inner rectangle and drawn in the stretched base's mapping,
  smoothed unless >= 3 device px per ROI px (400% shows pixels). A request is made 100 ms after the last zoom / pan /
  render; while a LUT is building (`state.renderPending`) nothing is requested (its arrival redraws and re-schedules).
- **Slider edits and strength.** `hooks.onDrawn` fires after every `renderCurrent` that put a frame on `#c`; the content key
  `JSON([control, strength])` changing drops the "after" layer at once and cancels its request (the stretched live render
  shows), and the layer is requested again 100 ms after the last render (so after a slider drag, an undo, an NP3 import).
- **Before / after (Space).** `renderCurrent` shows the neutral on `#c` (the base follows) and the overlay swaps to a
  separate "before" layer: `renderRegion({ ..., neutralOnly: true })` (new opt-in: the neutral pass of the region, no
  profile / LUT / detail, the same values `neutralToScreen` shows; the default path is untouched, `_regionProfile`'s neutral
  block is only moved into `_regionNeutral`). The "before" layer does not depend on the profile, so it survives edits and
  is requested at once (no debounce) the first time Space is held at a view; releasing returns to the cached "after".
- **Releases (D11).** A new RAW (`hooks.onFrame` from `applyEditorFrame`): view reset to the fit, layers, the hold and the
  region textures dropped (a queued worker `release`). A page hide (`visibilitychange`) releases the same and re-requests on
  return; zooming back below 30% trims the region textures (the hold stays). An NP3 import changes the profile only: the hold
  stays and the layer re-renders.
- **Degradation.** `raw.wasm` without the zoom exports (`zoom_unsupported`), a stale worker whose hold reply has no `held`
  (console warning, zoom disabled for good), a failed hold (that RAW state is not retried) or no `renderRegion`: the
  stretched zoom, the readout, the buttons and the keys keep working, no error is thrown.
- **Shared code.** `editor-core.js`: `hooks.onDrawn?.()` after the three draws of `renderCurrent` and `hooks.onFrame?.(st)` in
  `applyEditorFrame` - optional, undefined for the wizard and the mobile page. `renderer.js`: `renderRegion` got `neutralOnly`
  and `_regionNeutral` (extracted, same GL calls in the same order). `zoom-plan.js`: only additions.
- **Test hook.** `window.__np3app.zoom` (null on the mobile page): `debug() -> { percent (100 = 1:1), level (the shown
  layer's), wanted, busy, supported, view, roiRect, held, layers: { after, before } }`, `zoom100()`, `fitView()`.
- **Tests.** `web/test-node-editor-zoom.mjs` (Node, instant, exit 1 on failure): 1476 plans (orientations 0..3 x k 1..3 x
  three frame sizes x held areas larger than the floored decoded size x levels 1 and 2 x seven rectangles at the corners /
  edges / interior / ~1 px) check region / inner / crop / roi consistency and the guards; **the ROI source position vs the
  stretched frame**: a simulated mosaic whose value is its own held coordinate goes through `rotateRegion` and is compared with
  the main frame a simulated develop makes (box-shrink + an independent `np.rot90`), sampled at the position the lowRes
  affine gives: worst 0 - 1e-6 sensor px (tolerance 1e-6; the geometry is exact, unlike Compare's compare map with a crop),
  the layer's drawing position equals the affine; the readout factor, the level thresholds and the view math (zoom keeps
  the cursor's point, the clamped pan, `visibleRect` = the inverse of the draw transform). Mutations of the affine offset
  and of the rotation are caught. Level 8e got a block (zoom API, readout, Z / 0 / double click, Space while zoomed,
  no develop) - written, not run.
- **Browser checklist.** See the Log entry "Profile editor".

Total ≈ 3.5-4.5 days.

## Open questions

- The D2 thresholds (30% / 75%) and the ROI pad (25%, 12%, 0) are first values from Z3, to tune by eye in the browser.
- The D9 curve beyond the two measured sizes (more frames, more sizes; `?dsharp=` to tune).
- Whether zoom beyond 100% (up to 400%) should show pixels (nearest) or smoothed.

## Log

- 2026-11-24 — plan agreed (options: half-sensor only, upscaled sensor pixel, real demosaic; chosen:
  real demosaic by ROI via rawler PPG; one raw worker, 100% waits for pair decoding with a loader).
- 2026-11-24 — Z2 decoder code written (lib.rs `hold` / `roi` / `release`, raw.js wrappers, worker message
  types, `web/test-node-zoom-raw.mjs`); `raw.wasm` NOT rebuilt (no wasm32 target in the build sandbox).
  Native results (x86_64, release; Z f NEFs DSC_6550 orientation 1 and DSC_6474 orientation 8, Z 8 DNG
  SKL_3024 orientation 6): level 2 over the whole held area == `develop(0)` unrotated, 0 differing samples,
  and 0 on 40 random sub-rectangles (all three files); level 1 on flat mosaics (4 CFA phases) reproduces
  the constants exactly; level 1 ROIs (37 per file: interior, borders, corners, 1×1) == crop of the full
  frame result, max diff 0, 0 differing samples; the PPG port == rawler `PPGDemosaic` bit for bit (whole
  frame, and the interior of a ROI window). Box-2×2 mean of level 1 vs level 2 (16-bit units, whole frame,
  expected to differ — different sampling): mean |d| R/G/B 50/14/40 (DSC_6550), 155/34/144 (DSC_6474, a
  sharper frame), rms 77 / 283, max up to ~30000 at hard edges. Timing natively: `hold` 350-390 ms on a 24 MP
  NEF (615 ms on the 46 MP DNG); level 1 ROI 2000×1500 167-193 ms (34 MB out), 1200×800 40-48 ms; level 2
  ROI 1000×750 12-20 ms; a full 24 MP level-1 frame 1.5 s (the wasm will be slower, maybe 2-3×). Memory:
  mosaic 46.5 MB (Z f) / 86.9 MB (Z 8); native RSS after hold ≈ +200 MB because the allocator keeps the
  freed decode buffers (in wasm the linear memory also never shrinks: the decode peak ≈ input + rawler
  image ≈ 80 MB stays reserved). `level 1` / `1a` of the Node suite pass with the unchanged raw.wasm.
- 2026-11-24 - Z1: display sharpening implemented (`lib/display-sharpen.js`, `compare-view.js`); adaptive
  amount from the calibration on 3 SA frames (see Z1). Node test and `node --check` pass, `test.mjs
  --only 1k` green; browser levels not run (no Firefox here).
- 2026-11-24 - Z4 renderer side: `Renderer.renderRegion` / `disposeRegion` / `regionMargin` / `regionLowResMinSigma`,
  region detail path with per-entry blur source (region or the main frame's blur through an affine map),
  `applyDetailCPU` lowRes twin, `web/test-node-region-detail.mjs` (green: no-lowRes crop max 4e-6/255,
  lowRes max 0.10/255 at T = 4 main px, identity at 0 tools) and `web/region-check.html` (GPU vs CPU twin and
  main-path-unchanged check, to be run in a browser: not run here). `gaussCPU` interior fast path
  (bit-identical, checked against HEAD). `test_detailfit.py`, `test-node-detailfit.mjs`, `test.mjs --only 1k` green.
- 2026-11-24 - Z3 code written (`lib/zoom-plan.js`, `loader.zoomCall`, fit-app `renderZoomSide` / hold / release,
  compare-view pyramid, Fit / 100% buttons, readout, `Z` / `0` keys, loader, target crop; strings in ru / de / fr).
  `test-node-zoom-plan.mjs` passes (see Z3); `node --check` on every touched file, `test.mjs --only 1k`,
  `test-node-display-sharpen.mjs`, `test-node-viewremap-window.mjs` pass, `test-node-zoom-raw.mjs` skips (old wasm).
  Not run: any browser level. Browser checklist: (1) with the OLD raw.wasm: zoom works as before, 100% button zooms
  and the readout shows ~100%, no console error, the loader flashes at most briefly; (2) after `sh web/build.sh` and
  the renderer's `renderRegion`: wheel in to >30% -> the loader, then a sharper render swaps in with the same
  colors / tone and without a seam where it meets the stretched render; at >75% the pixels are sensor pixels;
  (3) pan and zoom reuse the ROI inside its pad and re-request outside it; (4) a pair switch, removing the pair
  and leaving Compare release (the worker `release`, region textures; check memory in the browser's task manager);
  (5) the strength slider and the quick editor sliders at 100% (the ROI re-renders after a short delay, no
  stale-colour ROI), Clarity +-5 against the compare render; (6) orientation: a portrait NEF (orientation 6 / 8)
  at 100% matches the compare render; (7) dropping a RAW while zoomed: the loader stays until the decode and the
  hold finish, then the ROI appears; (8) curtain mode, both halves, the target crop sharper than the fit-view
  canvas; (9) keys: `Z` under the cursor, `0`, not while typing in the quick editor's fields; (10) dpr 2: 100%
  is 1 sensor px per device px (readout), HiDPI sharpness; (11) `?dsharp=` and Z1 still work at the fitted view.
- 2026-11-24 — user review in Chrome (dpr 1, fit view s ~ 0.75): with the measured ramp the render looked
  crisper than the target; with `?dsharp=0` still a little crisper. The ramp now starts at s = 0.9 (no
  sharpening while the render is downscaled) and reaches 1 at s = 1.5. The 100% path works after
  clearing the browser cache (a cached `raw-worker.js` answered `hold` as a develop); `fit-app.js` now
  disables the zoom and warns in the console when a hold reply has no `held`, and logs hold/roi errors.
- 2026-11-24 — user review: the zoom controls (loader, readout, Fit view / 100%) moved from the bar into a
  small overlay at the bottom right of the canvas (dark grey, 90% opaque, a light shadow). A double click
  below 100% zooms to 100% at the cursor; at 100% or more it returns to the fit (supersedes "double click
  = fit" of spec/ui.md decision #8; without the zoom geometry it still only fits). The hint text and the
  level-8 reset check follow (the check now double-clicks twice: 100%, then fit).
- 2026-11-24 — Profile editor: 100% zoom on `picture-control-editor.html` (`lib/editor-zoom.js`, `zoom-plan.js`
  `planEditorRegion` & co., `renderRegion({ neutralOnly })`, `editor-core.js` hooks; see the section "Profile editor").
  `test-node-editor-zoom.mjs` passes (24326 checks); `test-node-zoom-plan.mjs`, `test-node-viewremap-window.mjs`,
  `test-node-display-sharpen.mjs`, `test.mjs --only 1k`, `node --check` pass; no browser level run. Browser checklist:
  (1) fitted view looks exactly as before (no overlay canvas, the readout overlay at the bottom right of the image, no console
  error) with the OLD raw.wasm too; (2) wheel zooms to the cursor, drag pans, no empty border, wheel out stops at the fit;
  (3) double click -> 100% at the cursor (readout 100%), again -> fit; `Z` / `0` hovering the image or after clicking it, not in
  the name field; a focused slider does not block them; Space and Ctrl+Z still work; (4) after `sh web/build.sh`: > 30% the
  loader, then a sharper layer swaps in with the same tone / colour and no seam; > 75% sensor pixels; pan / zoom inside the
  pad reuse it; (5) slider drag at 100%: the layer disappears while dragging (stretched live render) and returns after
  ~100 ms with the new colours; strength, undo and an NP3 import the same; Clarity +-5 against the stretched view; (6) Space at
  100%: the neutral layer (sharp) appears, releasing returns to the profile layer; (7) portrait (orientation 6 / 8) and DNG
  files line up with the stretched view; (8) open another RAW while zoomed: back to the fit, the old hold is released;
  dropping a RAW while a layer request waits shows the loader until the decode and the hold finish; (9) hide the tab and come
  back (memory in the task manager); (10) dpr 2: 100% = 1 sensor px per device px; (11) the mobile page and the wizard
  unchanged; level 9a's desktop pixel references (`_local/ui-ref`) need `NP3_UI_REF=write` again - the left column has a new hint line.
- 2026-11-24 — user request: holding Space on Compare (and in the wizard's quick editor) shows the render
  side as the Nikon neutral without the profile, as the profile editor's before view does
  (`renderer.neutralRGBA`: neutral development only, no LUT, strength or detail; at zoom
  `renderRegion({ neutralOnly: true })`); the caption reads "Before — neutral". `before-after.js` now
  also acts on the Compare step (not on a focused button / pair tile there); `fit-app.js` `onRender`
  re-renders the compare side on the hub; the memo keys carry the neutral flag. The Compare hint mentions it.
