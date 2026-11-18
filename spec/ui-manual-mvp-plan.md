# Work plan: manual NP3 adjustment MVP

Requirements and acceptance criteria: [ui-manual-mvp.md](ui-manual-mvp.md). The implementation is a static application in `web/`. `ui.py` and server APIs for it are not used.

## Architecture decisions

- **The server only serves statics.** HTML, JavaScript, WASM and binary models are loaded by plain GETs. There are no endpoints for RAW, NP3, rendering or saving.
- **All user data stays in the browser.** RAW and NP3 are read from a `File` via `arrayBuffer()`, export is created via `Blob` and an object URL. State is kept in the tab memory.
- **Python is the reference and the offline model exporter.** It is needed for `make_golden.py`, `export_model.py` and conformance checking, but is not part of the application runtime.
- **The base profile is separated from strength.** The state keeps the full `Control` at 100% and a separate `strength`. For rendering and export a new resulting `Control` is created; the base is not mutated.
- **The existing browser pipeline is extended.** `web/raw.wasm`, `lib/raw.js`, `lib/neutral.js` and the shared WebGL helpers are used. New modules do not duplicate the already working decoding and neutral.

## 1. NP3 in the browser

Create `web/lib/np3.js` per `np3.py` and [np3-format.md](np3-format.md):

- parsing and writing of the base block, the comment and the curve extension;
- all scalar fields, 8 x 3 blender values, 3 x 3 grading, Blending and Balance;
- full `curve.raw` (257 values) and `curve.points`;
- the same rounding, clamp, byte order and mutually exclusive tonal fields as in Python;
- clear exceptions for short, corrupt and unsupported files;
- a factory of a new profile `NPF-MANUAL` with default `np3.Control` values.

Add level 4 to `web/make_golden.py` and `web/test.mjs` (checks run in Node, no GPU needed). In Node, check all project NP3s and official samples: fields vs Python and exact byte equality after writing.

**Readiness:** import -> export without changes matches byte for byte on 11/11 official samples and selected profiles with a curve/comment; erroneous files are rejected without a partial state change.

**Status 2026-11-17: done.** `web/lib/np3.js`, level 4 in `make_golden.py`/`test.mjs`, all 99 profiles: fields vs Python and the byte-exact round-trip are green. The lenient Python behavior was recorded: trimming the extension of a file without a comment reads as a profile without a curve, trimming inside the curve with a live comment header is an exception (the port repeats this).

## 2. Curve and strength as pure operations

Create `web/lib/curve.js` and `web/lib/strength.js` without DOM coupling:

### Curve

- point normalization and sorting, coordinate and point-count limits;
- identity curve enable, disable, reset;
- a single function `points -> curve.raw + curve.points`;
- the interpolation was confirmed on 2026-11-16 on official samples without NX renders: a natural cubic spline through the points with a 0..255 clamp, `raw[i] = round(spline(i*255/256)*32767/255)` — bit-exact on all 5 samples with curves. The algorithm is written down in [np3-format.md](np3-format.md); no need to duplicate it here.

### Strength

Port `strength.scaled`:

- scaling of only the intended fields;
- blending the curve with the identity and a consistent regeneration of points/table;
- keeping sharpening, Hue, Blending and Balance;
- the name suffix and truncation to 19 ASCII;
- a list of fields whose values were clipped.

**Readiness:** Node tests compare the resulting NP3 fields with Python for 0, 30, 50, 70, 100, 150%, a curve and its absence. Re-changing strength does not modify the base `Control`. Curves after a manual edit pass the consistent golden tests.

**Status 2026-11-17: done.** Reference `np3.curve_table(points)` (natural spline, bit-exact on 6 official samples, verification in `test_np3.py`), ports `web/lib/curve.js` and `web/lib/strength.js`, strength fixtures in `web/make_golden.py` (5 bases x 6 strengths), level 4 in `web/test.mjs` green. Found: project profiles have points that are 20 even `make_pack.curve_from` samples, the spline over them does not recover steep tables (up to 852/32767 ≈ 2.6%), so the editor keeps the imported table as is until the points are touched.

## 3. Full browser profile render

Close levels 5 and 6 from [web-tests.md](web-tests.md), needed for a user RAW and all tools. Vignetting does not take part: there is no vignetting setting in NP3, and the interface is a visual NP3 editor, not an emulator of the whole camera pipeline. The preview computes the neutral without vignette correction. Golden tests of the neutral and frames still take a, b from Python, because they compare with `render.py`, which does apply vignetting; this does not contradict excluding vignetting from the application.

### 3.1. Color and tone

The first and main subsection: without it the profile preview is impossible.

- Extend `web/export_model.py`: export the `profile_model.Model` parameters into versioned JSON/BIN under `web/model/`.
- Create `web/lib/profile.js`:
  - the operation order as in `profile_model.Model`: grading -> Saturation -> blender -> own curve or the tonal-slider curve;
  - building a 33^3 LUT from the resulting `Control`;
  - applying the LUT in WebGL2 with the same trilinear interpolation as in Python; do not replace it with hardware interpolation of a different precision;
  - LUT caching by the full profile and strength state, invalidated on any edit.
- Keep the existing neutral format; when models change, rebuild the golden files.

**Status 2026-11-17: done (LUT on CPU; WebGL application — in 3.3).** `web/lib/color.js` (port of srgb/Lab/dE2000), `web/lib/profile.js` (full port of Pixels/Model: buildLUT 33^3, trilinear applyLUT), `web/model/profile.json` + `profile.bin` via the extended `export_model.py`. Level 5 in make_golden/test.mjs: 75 controls (8 finished profiles, 12 random seed 5, extreme slider values), reference `Model(grid33, c)` float32. The actual divergence ≈ 0.0000 dE2000 (only float32 rounding), the 0.05/0.5 tolerance was not relaxed. The remember/CACHE cache from Python was not ported — an optimization for fitting. The level-5 fixtures take ~31 MB (75 x 431 KB).

### 3.2. Detail

Create a browser analog of `detail.Detail` for Sharpening, Mid-range sharpening and Clarity:

- export the `detail.Detail` parameters through the same `web/export_model.py`;
- GPU passes with scaling and zero tools as in Python;
- correct work at the interactive size and the regular 1600 px;
- a warning if a specific model is not loaded, not a silent difference from NP3.

**Status 2026-11-17: done.** `web/lib/detail.js`: a port of `Detail.__call__` (Y' luma, nearest scale in log space, delta `value*sum_s table_s(Y)*(Y - Gauss_s(Y))`, clip 0..1) and the export of `web/model/detail.json` + `detail.bin` in `export_model.py`. The Gaussian is a kernel from the same frequency response as FFT-Python (`exp(-2(pi*sigma*k/N)^2)`, Fourier sum, reflect edges): for subpixel sigma the discrete Gaussian is noticeably narrower than FFT and level 6 did not pass with it. Two paths with one math: `applyDetailGL` (WebGL2, programs/textures cached on the context) and `applyDetailCPU` (the shader reference, a future Worker). Level 6 in `make_golden.py`/`test.html`/`test.mjs`: 80 cases on 512^2 cutouts (5 frames x 2 positions x 8 controls, including the zero one — identity), mean ≤ 0.32, max ≤ 1.23 8-bit levels at the 0.5/8 tolerance. There is no `%` with negative numbers in the shader — it is not portable in GLSL ES and broke the edge in Firefox.

### 3.3. Frame assembly

Create `web/lib/renderer.js` combining:

1. the decoded linear RGB;
2. `neutralGLSL` without vignetting;
3. the LUT of the resulting profile;
4. detail;
5. output to the canvas.

The neutral and the linear frame are reused on every edit. Changing only the profile does not call `raw.develop`.

**Readiness:** levels 3, 5, 6 and 7 of `web/test.mjs` are green; finished, random and extreme profiles, own curve and different strengths pass the tolerances vs Python. On a real frame, changing every tool goes through the full browser pipeline.

**Status 2026-11-17: done.** `web/lib/renderer.js`: neutral (per-frame cache) -> trilinear 33^3 profile LUT (cache of up to 4 by the serialized control) -> detail. The invariant is verified by counters: repeated `setProfile`+`render` do not touch develop/neutral (the "7 render invariant" test). Three bugs while debugging level 7: the `uBase` sampler looked at the empty texture unit 2 instead of 7; in the test the fixture lost a `/ 255` on the third channel; the float detail path flips the frame once by itself, a manual flip before it is redundant. Level 7: 15 frames x strengths, skin/green/sky ≈ 0.23-0.28 dE2000 at the 0.3 tolerance.

## 4. RAW loading and task management

Extract loading one's own file from `web/bench.html` into a reusable module:

- input and drag-and-drop for `.NEF`/`.DNG`;
- reading `File.arrayBuffer()` without upload;
- running `raw.develop` in a Worker; do not duplicate WASM and the source bytes without need;
- passing the result to the GPU and releasing old ArrayBuffers/textures when replacing the RAW;
- showing `info` from rawler and a warning for a camera that is not a Z f;
- translating the error codes `nef_high_efficiency`, `not_bayer`, `decode_failed` into clear messages.

Introduce a monotonic `generation` for asynchronous operations. A Worker result, a model load or a LUT build applies only if the generation is still current. Operations that cannot be physically interrupted finish without updating the UI.

**Readiness:** one's own file works from a static page; quickly picking two RAWs leaves the last; repeated edits cause no decoding; an error of a new file keeps the previous frame and profile.

**Status 2026-11-17: done.** `web/lib/raw-worker.js` (a module Worker, a single wasm instance, a queue until ready, on an initialization failure late requests get an error instead of hanging) and `web/lib/loader.js` (`createRawLoader`: monotonic generation, file bytes and rgb travel as transfers without copies, stale results are silently discarded, `cameraWarn` for non-Z f, busy/ready/error events). `web/bench.html` is switched to the loader: develop in a Worker, the previous frame is kept on an error, re-picking a size goes through the saved File/URL instead of holding bytes. Verified in headless Firefox (a programmatic drop): a Z f NEF without a warning, a Z 8 DNG with a warning, a race of two files leaves the last, a corrupt file gives an error code and keeps the frame. Pitfall: `initRaw(fetch(...))` without await silenced the whole Worker. Moving the result to the GPU and releasing old buffers — via the existing `uploadLinear`/texture overwrites at the place of use (step 5).

## 5. Static application and editor

> **Step 5 log (2026-11-17).** Scheme: three sequential subagents — **AB** (frame+panel), **CD** (curve+import/export), **EF** (before/after+end-to-end tests). The contracts below were fixed before the start and are not changed by the parts.
>
> **Progress: AB — done (agent-3).** `web/index.html`, `web/lib/app.js`, `web/lib/panels.js`; state per contract (+`nameValid`), the full pipeline on a 2D canvas, correct group order, strength/name/clipping highlight work, a smoke in headless Firefox is green, `node web/test.mjs` is green. Hooks: for CD — buttons `#import`/`#export` (disabled), `#curve-slot` in the panel, `panel.refresh()`, `window.__np3app = {state, panel, renderer, loader, renderCurrent}`; for EF — `#ba-slot`, `state.showNeutral` already works in `renderCurrent()`.
>
> **Progress: CD — done (agent-4).** `web/lib/curve-editor.js` (switch, SVG editor: dblclick/drag/numeric x/y/delete/reset, clamping of interior points between neighbors without jumping, keyboard, locking of the five tonal sliders) and `web/lib/transfer.js` (atomic import, export Blob->object URL; buttons activated). Hooks in panels.js/app.js are minimal: `setTonalLocked()`, `onNameValid`, `panel.refresh()` calls `curveEditor.sync()`. Important: export at 100% strength serializes the base control directly, not `scaled(c, 100)` — otherwise the regeneration of curve points into 20 even samples would break the byte-exact round-trip of official samples (their points are the real editor points); at != 100% — exactly `scaled()`. Verified: `node web/test.mjs` green, smoke in headless Firefox (drop RAW, import/export, curve edit, 978-byte round-trip byte-exact, rejection of garbage) — 24/24.
>
> **Progress: EF — done (agent-5).** `web/lib/before-after.js`: a held "Before/after" button in `#ba-slot` + the "Before — neutral"/"After — NP3" captions; holding space outside input fields; pointerup/pointercancel/capture loss and keyup always return "after"; the button is disabled until a successful RAW development; showing the neutral goes through the `renderer.neutralRGBA()` cache without building a LUT and without recomputing RAW (verified by the stats.luts counter). Level 8 in `web/test.mjs`: end-to-end checks on the real `web/index.html` in headless Firefox — panel layout, export without RAW (NPF-MANUAL), dropping a RAW via DataTransfer, moving all sliders without a repeated develop, Saturation changes the canvas and the NP3, LUT cache only for a new control, strength 150% (frame/base/name), before/after by button and space (neutral, captions, profile untouched), a race of two RAWs (the last wins), field import + byte-exact round-trip + re-import of edits, corrupt NP3/RAW without losing state, statics by GET only without request bodies.
>
> **Small front-end edits (2026-11-17).** Following the panel-uniformity remarks: (1) the strength panel was renamed to **Profile** and turned into a collapsible group of the common style (`details.grp`), the order and `data-group="strength"` kept; (2) strength is the same slider as the others: full width, the name "Strength" on the left, percents on the right above the slider, the preset buttons 30/50/70/100% removed (from the spec too); (3) the NP3 name was unchanged; (4) a **Reset** button was added at the bottom of the panel — the `np3.Control` default neutral (sliders, curve off, strength 100%), the name and comment are kept; (5) the tracks of all sliders are filled with color up to the value via `--fill`/`--fill-color` (`panels.js` + `index.html`). Level 8 extended: collapsibility/the Profile caption, no presets, Reset to neutral with unlocking the tonal sliders and keeping the name, `--fill` at min/max values.
>
> **First-frame bugfix (2026-11-17).** Symptom: the first render after loading the page (the first RAW) went to a black canvas until any interaction; the second file rendered fine. Cause: `applyDetailGL` with `srcTex` received the input texture bound by the caller to unit 0, but the first initialization of the context cache (`ctxOf`, detail.js) rebinds units 0-8 to its own textures — the first luma pass and the combine read the empty `c.tex.img`. Fix: `srcTex` now takes a texture object and is bound to unit 0 inside `applyDetailGL`, after `ctxOf` (the neutral dev-LUT was unaffected: 3D and 2D bindings on a unit are stored separately). Regression in level 8: the frame from the ready handler must match a repeated render. Also the empty state: the canvas is hidden until the first frame (`#c[hidden]`), the approximate-render caption is pinned to the bottom of the viewer area.
>
> **Performance optimizations P1-P3 (2026-11-17).** The review remarks from the "Performance review" section are closed (marked [x] there): the 33^3 LUT is built in `web/lib/lut-worker.js` (the model once, a transferable result, the `lutSeq`/`state.renderPending` generation, the previous frame until ready); the LUT key is only the fields of `profile.paramsOf` (`lutKeyOf`), the name causes no render at all; LUT cache eviction (≤4) with an explicit `gl.deleteTexture` (`stats.lutDrops`); detail caches the luma/blurs between edits of only values (`_detailMatch`, `stats.detailSkips`), with zero tools — a blit without passes; the final frame in the "final" texture, before/after is `blitFinal`; the neutral without a mandatory readback (`_ensureNeutral`/`neutralRGBA` lazily, `stats.reads`); stale RAWs are not decoded (generation after `arrayBuffer()`, the Worker queue keeps only the last request). The level-8 tests extended: `settle()` waits for `state.renderPending`, the perf block checks all counters. Levels 5-7 are green without relaxing tolerances — the operation order and precision did not change. Not done: a repeated interactive Firefox profiling (measurements before the optimization: 14-43 ms/frame, buildLUT 17^3/33^3 ~16/70 ms, with blender/grading ~89/179 ms — all of this moved to the Worker).
>
> **UI-2 interface edits (2026-11-17).** The second package of look edits following Lightroom; descriptions in [ui-manual-mvp.md](ui-manual-mvp.md) "Interface edits 2026-11-17 (UI-2 package)", gradient references — [sliders/](sliders/). All items completed, level 8 green:
>
> - [x] 1. The Import/Export buttons are under the frame info (`#info`), not under the drop zone (`web/index.html`).
> - [x] 2. The "Before/after" button removed; a hint "Hold Space to compare with neutral" in the viewer area; the space behavior and the "Before — neutral"/"After — NP3" captions kept (`web/lib/before-after.js`).
> - [x] 3. LR-style gradient tracks: Saturation (Basic) — rainbow; Color Blender/Grading — per the references (`--track` on `input[type=range].grad`, CSS in `index.html`, track helpers in `panels.js`/`grading.js`).
> - [x] 4. Color Grading: the new `web/lib/grading.js` — the HSL / Color switch; HSL is Hue/Saturation/Luminance rows by zones with gradients; Color is three wheels (drag sets Hue+Saturation by radius/angle) with Luminance under each and Blending/Balance under the wheels; the duplicate mode fields are cross-synced (`syncPeers`). Point Color is not implemented.
> - [x] 5. Color Blender: Hue / Saturation / Luminance sections x 8 colors, rows "name — track — value" (`panels.js`).
> - [x] 6. Renames: Blender/Grading Chroma -> Saturation, Brightness -> Luminance (labels only; the internal NP3 names and the keys `blender.<color>.<i>`, `grade.<zone>.<i>` are unchanged — the LUT cache and clipping work as before).
> - [x] 7. Details and Curve swapped: Profile, Basic, Curve, Details, Blender, Grading (`panels.js`).
> - [x] 8. By default only Profile and Basic are open (`group(..., open)` in `panels.js`).
> - [x] 9. In Profile: the Result name row removed; strength does not affect the name — the `-<percent>` suffix is not added in the UI, the file name, or the NP3 bytes (`transfer.js: finalControl/finalName`); NP3 NAME is the first field of the Profile group (`data-group="name"` inside `data-group="strength"`).
>
> **Gradient and structure tuning per the refs [color-blending/](color-blending/) and [color-grading/](color-grading/) (2026-11-17, the same package):** the saturation of all track gradients was reduced by ~30 points (`GSAT = 65`); the global Saturation is grey -> rainbow with saturation growing along the whole track (a noticeable grey section on the left); Hue in the per-color breakdown is only the spectrum ±55 degrees around the row color, not the whole circle. The tool structure was brought to the refs: the new `web/lib/blending.js` is the Adjust HSL/Color switch; HSL is Hue/Saturation/Luminance/All tabs of 8 colors, Color is 8 color dots (color selection) + Hue/Saturation/Luminance of the selected color. `web/lib/grading.js` is the zone selector Adjust: Shadows/Midtones/Highlights + HSL/Color; Color is a single wheel of the selected zone with a "Hue … Sat …" readout, Luminance, Blending and Balance below it (instead of three wheels). The duplicate mode fields are cross-synced (`syncPeers`); external editors register clipping-highlight rows via `panel.clipRow`. Style tuning (the same package): zone/attribute tabs are LR-style text (no borders and fill, hover highlights the text, the selected one is bright text with an underline, the `.tabbtn` class); the HSL/Color switches are a single toggle button with the current mode (`.tgl`, a click switches) and always first, in Color Grading the "Adjust:" label removed; Color Blender defaults to the Color mode; the grey section of the Saturation gradient takes ~1/3 of the track; the Reset button sticks to the bottom of the panel (`position: sticky`).
>
> **Ctrl+Z edit history and the space bugfix (2026-11-17).** Ctrl+Z: snapshots of `control + strength` on every finished action (a push in `scheduleRender(false)`), up to 20 in `sessionStorage` (`np3hist`), survives a tab reload; changing the RAW (the loader ready) and importing an NP3 (`transfer.onReset`) reset the history with a new base snapshot; there is no redo — a new action cuts off the undone (`hist.stack` is truncated at `idx`); Ctrl+Z in the name text field is the native input undo. Bugfix: the space before/after did not work when the focus stayed on a slider after dragging — `input[type=range]` is excluded from `editableTarget` (it is not a text field). Spec: the "Edit history (Ctrl+Z)" section, criterion 13, undo/redo removed from "Not included". Level-8 tests: space with focus on a slider, a double undo with values returning, no step before the start of history, the ≤20 limit in sessionStorage, reset on a RAW change and an import.
>
> **Toggle group, Reset footer and slider UX (2026-11-18).** The HSL/Color switches are a toggle group per the ref [toggle/ref.png](toggle/ref.png): one container with a border, the active button filled `.tgl` (in `blending.js`/`grading.js`, first; Color Blender defaults to Color). The panel is split into `#panel-scroll` (content) and `#panel-foot` — Reset in a separate footer always pinned to the bottom (a `flex` column, `createPanel({scroll, foot})`). UI-2 spec tuning: a hotkey legend at the bottom of the left panel (`#hotkeys`: space — neutral/before-after, Ctrl+Z — undo); the caption at the name field in Profile removed; double click on a slider resets to the default (`opts.def` in the slider helpers); the numeric value is an editable `input[type=number].val` clamped to the range (panels/blending/grading). Tests: double click (Sharpening 9->2), typing a number (4.5), input clamping (99->9), the strength value as `value`.
>
> **Color Grading: color preview and markup cleanup (2026-11-18).** Blending/Balance are shared NP3 fields (`blending`, `balance`), moved from the Color mode body into the shared `.gr-shared` container — visible in both modes, one row each (duplicate `.sub` headings removed). Zone names above the wheel and above the HSL rows removed — the active zone is read from the tabs. A resulting-color preview window `.gr-preview` was added under the zone buttons (Hue + Saturation at the zone's lightness, 42 px high). The Saturation/Luminance gradients are tinted with the selected Hue and repainted on its change (`syncAll`). The chroma clipping highlight is bound to the zone's Saturation slider. Level-8 tests: the preview exists, one Blending label, zero `.gr-name`/`.sub` in grading, `.gr-shared` not hidden.
>
> **Color Grading: Color mode tuning (2026-11-18).** The color preview is only in the HSL mode (the window inside `#grading-hsl`). Blending/Balance are separated by a `.gr-divider` — they are global and do not depend on the zone. In the Color mode Luminance is full width (moved out of the 140px wheel wrapper), Hue/Saturation are editable numeric inputs `.gr-nums` (0..359 / 0..100, clamped), synced with the wheel dot. Tests: the preview's parent is `grading-hsl`, one divider, 6 numeric inputs.
>
> **Slider style: muted fill and disabled (2026-11-18).** The track fill (`--fill-color`) is grey `#b4b4b4` instead of the white `var(--accent)`; the thumb stayed white. Disabled sliders: `opacity .3` (was .45) + a grey thumb `#5a5a5a` — visually clearly darker than the active ones. Regression and fix: after switching the numeric values to inputs, `setTonalLocked` disabled only the first `input` (the numeric one) — the tonal slider lock did not work; now both inputs of the row are disabled, the test counts range and number separately.
>
> **Curve: single note and backdrop histogram (2026-11-18).** The explanation of the tonal-slider lock was removed from Basic, kept only at the curve editor (it was already there — now without the duplicate). The backdrop under the plot: the Y' luma histogram (`detail.YW`) of the neutral frame, 256 bins, peak = 1, drawn only when the curve is on; `renderer.lumaHistogram()` is a lazy readback of the neutral (the `neutralCache` cache) once per frame + binning ~1-5 ms, counted in `stats.reads` as before. The histogram helper is passed to the editor via the `histogram` option, `curveEditor.sync()` is called from the ready handler (a new frame). Tests: the note only at the curve, a histogram with dozens of nonzero bins.
>
> **Curve: histogram and note always (2026-11-18).** The backdrop histogram is drawn in either checkbox state (with a frame loaded). The note at the curve editor is always visible, rephrased as a format limitation: "When the curve is used, Contrast, Highlights, Shadows, White level and Black level are disabled — you can't use both. This is an NP3 format limitation." Tests: the note and the histogram are in place with the curve on and off.
>
> **Curve: point controls (2026-11-18).** The `x`/`y` inputs are in the common numeric-value style (transparent until focused, right-aligned, no spinners). "Delete point" is pushed right (`margin-left: auto`), no fill and no border — only underlined text, hover highlights. The "Reset curve" button removed: the reset is turning "Custom curve" off and on (a fresh identity is created). Test: one button in the controls row.
>
> Level-8 tests extended: group order and default openness, LR blender sections (24 sliders), the Saturation gradient track, HSL/Color modes and three wheels, buttons under `#info`, the space hint, space before a development without "before", name without a suffix in the NP3 at 150%. Old checks of the button and the suffix removed.
>
> - State contract (app.js): `{ raw: {bytes,image,info,name}|null, control, strength, showNeutral, generation, status, renderPending }`. The panel always shows the base `control`; strength is applied only via `scaled(control, strength)` at render and export.
> - The `Control` shape — as returned by `deserialize` from `web/lib/np3.js` (fields: name, comment, sharpening/mid_sharpening/clarity in 0.25 steps, contrast/highlights/shadows/white/black, saturation, blender: {color:[h,c,b]}, grade: {zone:[hue,chroma,bright]}, blending, balance, curve: {raw, points} | null).
> - i18n: the key is the English string; only `data-i18n`/`data-i18n-ph` and `t()`; no Russian hardcoded in markup.
> - The palette is from `web/bench.html` (a neutral grey, CSS variables). Group order: strength -> name -> basic -> details -> curve -> blender -> grading.
> - File ownership: AB — `web/index.html`, `web/lib/app.js`, `web/lib/panels.js`; CD — `web/lib/curve-editor.js` + the curve hook in panels.js + `web/lib/transfer.js` (import/export in app.js via callbacks); EF — `web/lib/before-after.js` + end-to-end tests in test.mjs/test.html.
> - API for the parts: `createRawLoader` (lib/loader.js, busy/ready/error events + cameraWarn), `Renderer` (lib/renderer.js: setFrame/setProfile/render/neutralRGBA), `scaled` (lib/strength.js), `curveTable/normalizePoints` (lib/curve.js), `serialize/deserialize` (lib/np3.js), `fetchDetail` (lib/detail.js).

Create `web/index.html` and small JS interface modules. The neutral grey palette of `ui.html` and `web/bench.html` is the visual base.

### State

```
{
  raw: { bytes, image, info, name } | null,
  control: Control,       // base at 100%
  strength: 100,
  showNeutral: false,     // only the temporary "before" display
  generation: number,
  status: string
}
```

Keep the full profile, including the comment and the curve. Do not use a reduced thumbnail as the export source.

### Components

1. RAW loading/drag-and-drop, NP3 import, an export button and statuses.
2. The profile panel strictly in the order: **strength at the very top**, name, **basic**, **details**, curve, Color Blender, **Color Grading last**.
3. Strength 0..150% (step 5%) — the Strength slider in a collapsible **Profile** group in the common panel style (no separate preset buttons), clipping warnings; the name with a 1-19 ASCII check and a separate display of the resulting name.
4. Collapsible slider groups with a label, numeric values and keyboard control; slider tracks filled with color up to the current value (`--fill`/`--fill-color` in `panels.js`/`index.html`).
5. An SVG/canvas curve editor: enable, add, select, move, numeric `x/y`, delete and reset points; locking of the five tonal sliders when the curve is on.
6. A canvas preview and a held "Before/after" button with space support. With `showNeutral` the shader outputs the already-ready neutral and bypasses the LUT, detail and strength; on release the result returns. Captions "Before — neutral"/"After — NP3", without changing the canvas size and without recomputing the RAW.
7. A note about the approximate render, the Z f and unsupported browser capabilities.
8. A **Reset** button at the very bottom of the panel: all editable values to the `np3.Control` default neutral (sliders, curve off, strength 100%); the name and comment are kept.

During slider/point movement update the interactive preview; after `change`/release of a drag — the regular one. Schedule the expensive LUT building via `requestAnimationFrame` or a Worker and discard stale results; do not start RAW decoding on every `input` event.

NP3 import atomically replaces `control` only after a successful parse and sets strength to 100%. Export serializes a snapshot of the current state, creates a Blob, starts a download and then revokes the object URL.

**Readiness:** scenarios 1-11 of the specification are passed manually, including the panel order, the curve, strength, before/after, export without RAW, import before RAW, fast edits and errors without losing state.

**Status 2026-11-17: done (AB+CD+EF).** The interface is assembled: `web/index.html`, `web/lib/app.js`, `web/lib/panels.js` (AB), `web/lib/curve-editor.js`, `web/lib/transfer.js` (CD), `web/lib/before-after.js` (EF). Scenarios 1-11 are covered by the level-8 automation (see section 6): `node web/test.mjs` is green, including end-to-end checks of the real page in headless Firefox.

**Perf (2026-11-17, after the Firefox profiler).** It was ~170-215 ms per frame while moving a slider (a 1008x1512 frame): buildLUT 33^3 ~88 ms on every move, neutral upload of 24 MB ~15-50 ms, CPU readback between passes ~20 ms, detail with a repeated upload ~65 ms, putImageData. It became 14-43 ms interactive: (1) the final detail pass is drawn straight into the default framebuffer of the visible canvas (`toScreen` in `renderer.render`/`applyDetailGL`, uFlip for orientation) — readback and putImageData removed completely; (2) the neutral texture after `neutralRGBA()` is already on the GPU — the extra upload removed; (3) the storage of the pass textures (profOut, y/h/b0-3/out) is allocated once per size, not realloced on every render; (4) during continuous movement the LUT is built 17^3 (~13 ms) instead of 33^3 (~88 ms), the full 33^3 — after `change` (allowed by the spec "Preview"). Pitfalls: an UNSIGNED_BYTE readPixels from a float attachment is INVALID_OPERATION per the WebGL2 spec (rolled back); the between-passes GPU path is 2x faster than CPU readback+upload at the same result (level 7 green).

### Performance review (2026-11-17)

A static review of `web/lib/app.js`, `renderer.js`, `profile.js`, `detail.js`, `loader.js`, `raw-worker.js`, `panels.js` and `before-after.js`. A spot Node measurement of `buildLUT` on this machine: a regular profile — ~16/70 ms for 17^3/33^3, a profile with the blender and grading active — ~89/179 ms. This is not a browser benchmark; absolute values depend on the machine. The remarks below are fixed by now.

- [x] **P1 — remove LUT building from the main thread.** Done 2026-11-17: `web/lib/lut-worker.js` (a module Worker, the model `profile.json/bin` loads once, the result is a transferable `Float32Array`, stale generations are not sent), `renderer.uploadLut/hasLut/lutCacheKey` accept a ready LUT; the synchronous `buildLUT` remains a fallback for tests and a Worker failure. `app.js`: the `lutSeq` generation + `state.renderPending` — while the LUT builds, the previous frame stays on the screen; a response not for the current generation is discarded. The render catches up in `lutWorker.onmessage`.
- [x] **P1 — narrow the LUT invalidation and extra renders.** Done 2026-11-17: the LUT cache key is built only from the fields `profile.paramsOf` reads (`renderer.js: lutKeyOf` — grading, Saturation, blender, curve/tonal sliders, Blending, Balance); it does not include the name, comment and detail. Editing the name in the panel starts no render at all; editing Sharpening/Mid-range/Clarity reuses the LUT. Verified by a level-8 test ("name and Sharpening build no LUT").
- [x] **P2 — explicitly free evicted LUT textures.** Done 2026-11-17: `renderer.uploadLut` calls `gl.deleteTexture` before evicting from the cache (limit 4), the `stats.lutDrops` counter; a level-8 test (a stress of 8 unique LUTs: cache ≤4, explicit deletions).
- [x] **P2 — reduce repeated full-frame detail passes.** Done 2026-11-17: with zero tools `render` bypasses detail with a blit of the profile frame; the luma and blurs are cached between edits of only values/tables (same frame, same LUT, same sigmas — `renderer._detailMatch`, the `stats.detailSkips` counter, the `reuseLuma/reuseBlurs` flags in `applyDetailGL`); the final frame is kept in the "final" texture (RGBA8), before/after returns with `blitFinal` without a full render (`renderer.hasFinal`).
- [x] **P2 — remove the mandatory CPU readback of the neutral from the application path.** Done 2026-11-17: `renderer._ensureNeutral` builds a GPU texture without a readback; `neutralRGBA` does a lazy readback once per key and only on request (tests/external API), the `stats.reads` counter; a level-8 test verifies that load/before-after/render do no readback.
- [x] **P3 — do not decode stale RAWs.** Done 2026-11-17: `loader.open` does not send a request to the Worker if the generation went stale during `arrayBuffer()`; the `raw-worker.js` queue until the wasm is ready keeps only the last waiting request.

**Improvement order:** executed in the listed order: first the LUT invalidation and the Worker, then explicit texture freeing; after them — detail, the neutral readback and the RAW queue. The optimizations do not change the operation order and the precision of levels 5-8.

**Optimization readiness:** done 2026-11-17, covered by level-8 tests (`node web/test.mjs`): changing the name/detail does not increase `stats.luts`; a stress series of 8 unique LUTs leaves no more than four live cached textures and explicitly deletes the rest (`stats.lutDrops`); editing only detail reuses the luma/blurs (`stats.detailSkips`); loading a RAW and before/after in the application path cause no CPU readback (`stats.reads` grows only on an explicit `neutralRGBA()`); stale LUT- and RAW-Worker results still do not change the frame (the `lutSeq`/`loader.generation` generations). Not done: a repeated interactive Firefox profiling on a 1008x1512 frame — the `buildLUT` measurements in the plan (16/70 ms for 17^3/33^3, 89/179 ms with blender/grading) moved to the Worker, the expected effect is that the UI is not blocked by LUT building; profiling remains for a manual check.

## 6. End-to-end automatic checks

Extend the existing `node web/test.mjs`, without creating a parallel test framework:

- NP3 read/write and malformed input in Node;
- curve and strength vs Python golden;
- LUT, detail and full render in Firefox via puppeteer-core;
- the real `web/index.html` page: programmatic File/Blob for RAW and NP3, changing controls, checking the canvas and the downloaded NP3;
- before/after: while the button or space is held the canvas matches the neutral without a profile, and after release — the resulting render;
- no network requests with user data: only GETs of static resources are allowed in the test;
- changing a RAW during a Worker task and applying only the last generation;
- re-importing the downloaded file and comparing all fields.

Before delivery:

```
python3 test_np3.py
python3 web/make_golden.py
node web/test.mjs
```

`make_golden.py` is needed when models/fixtures change, not on a regular application run.

**Status 2026-11-17: done.** Everything in `node web/test.mjs` is green: NP3 read/write and malformed input (level 4), curve and strength vs golden, LUT/detail/full render in Firefox (levels 5-7), the end-to-end UI of the real `web/index.html` page (level 8): programmatic File/Blob via DataTransfer-drop and `transfer.importFile`, changing controls changes the canvas and the exported NP3, before/after by button and space vs the neutral without a profile, changing a RAW during a Worker task leaves the last generation, an export->import round-trip (fields and byte-exact matching for an unmodified profile), errors without losing state, statics by GET only without request bodies.

Manual acceptance on real data:

1. Serve `web/` and the needed models with any static HTTP server; make sure the application needs no Python API.
2. Check the panel order: strength on top, details after basic, Color Grading last.
3. Load `test1/DSC_5584.NEF` (locally in `_local/`) via the file dialog and again via drag-and-drop.
4. Import `out/fit4/NIKON/CUSTOMPC/PICCON01.NP3`; change the curve points, blender, grading, Saturation and details.
5. Check strengths 30...150% (step 5%) with the Strength slider, value clipping, the resulting name and returning to 100% without changing the base.
6. Hold the "Before/after" button and space: compare the neutral with the profile off, then check the result returns after release.
7. Export, import back and compare the fields; for unmodified official samples compare the bytes.
8. Check a profile without a curve, enabling/disabling the curve and the availability of the tonal sliders.
9. Check `test2/SKL_3024.NEF` (locally in `_local/`), a non-Bayer DNG, a corrupt NP3 and disabled WebGL2.
10. In the browser Network tab confirm there are no POSTs and no file-content transfers.

## 7. Documentation and completion

- Update [web-tests.md](web-tests.md): level 3-7 statuses, new golden for the curve/strength and the end-to-end UI.
- In [tools.md](tools.md) describe running the static application and separate it from the old internal `ui.py`.
- Leave [ui.md](ui.md) the specification of the full product; do not move reports and auto-fitting into the MVP.

- Mark the passed manual scenario in [stages.md](stages.md), without declaring the other interface items done.
- Delete temporary files created by the checks and review the change set; the repository must keep only the needed sources, models, golden tests and documentation.

**Status 2026-11-17: partially.** Updated the level statuses in [web-tests.md](web-tests.md) (all done ones are "works"). Remaining: running the application in [tools.md](tools.md), a mark in [stages.md](stages.md), the final cleanup — after sections 4-6.

The work is considered finished only after the green automatic checks and all twelve acceptance criteria of the specification.
