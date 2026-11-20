# Work plan: full RAW + target fitting interface

Requirements: [ui.md](ui.md). Current product baseline: [ui-manual-mvp.md](ui-manual-mvp.md) and the completed sections of [ui-manual-mvp-plan.md](ui-manual-mvp-plan.md).

The result is one static browser application covering the whole flow:

`Start -> fit RAW + JPEG pairs -> Compare -> Manual adjustment or More frames -> Refit -> Save NP3`.

NX Studio, Python and a computation server must not be needed at runtime. Python remains the source of truth and generates reference fixtures. This document is a plan only; it does not change the implementation.

## 1. Existing base and actual gaps

### Reuse without reimplementing

- `web/lib/loader.js`, `raw-worker.js`: local NEF/DNG loading, WASM decoding in a Worker, camera warnings and stale-result rejection.
- `web/lib/renderer.js`, `neutral.js`, `profile.js`, `detail.js`, `lut-worker.js`: the complete NP3 preview, including curve and detail, interactive/final LUT sizes and caching.
- `web/lib/np3.js`, `curve.js`, `strength.js`: all NP3 fields, byte-compatible serialization, curve operations and non-destructive strength.
- `web/lib/panels.js`, `curve-editor.js`, `blending.js`, `grading.js`: the manual editor for every NP3 tool, clipping highlights and keyboard-accessible controls.
- `web/lib/transfer.js`: atomic NP3 import and local Blob export.
- `web/lib/color.js` and the CPU `profile.Pixels`: Lab, dE2000 and per-pixel profile evaluation needed by fitting and reports.
- `web/lib/i18n.js` and the level 1-8 test harness in `web/test.mjs`/`web/test.html`.

### Missing or not reusable unchanged

- The application state in `web/lib/app.js` is a single-RAW editor state, not a fitting session. There are no pairs, workflow steps, selected versions or fit baselines.
- The target side is absent: no JPEG/TIFF decoder, ICC/EXIF handling, XMP parsing or WB/exposure compensation.
- There is no browser port of `devpairs.build`/`pairs.align`: crop, orientation, radial correction, scale/shift search, aligned masks and NCC.
- The fitting path needs linear aligned samples and development trust, not a readback of the already rendered canvas. There is no CPU development model, density export, sampling or LM solver in JavaScript.
- The current comparison is only NP3 against Nikon neutral. There is no target viewer, shared zoom/pan, curtain, thumbnails or region highlighting.
- There is no `analyze` report, error map, aggregate report or JSON download.
- There is no version history, refit, candidate recommendation, pair inclusion/removal or coverage advice.
- Undo exists, but redo is deliberately absent. Reset currently means neutral NP3 defaults, not the selected fitted version.
- Only single-NP3 export exists; strength-set export is absent.
- The fitting reference devignettes before alignment (`devpairs.build(..., devignette=True)`), while the manual application renders without vignette correction. The fitting worker therefore cannot simply reuse the current preview output and claim Python equivalence.

### Implementation language: JavaScript first, optional Rust/WASM optimization

No new component has to be written in Rust for the first working full flow. Keep the existing Rust/WASM RAW decoder in `web/raw` as is. Implement the new numerical modules as pure JavaScript over `TypedArray`, run them in Workers and validate them against Python fixtures before optimizing.

Rust/WASM remains an implementation option for measured hotspots:

- LM residuals and the numerical Jacobian: 56 parameters, thousands of pixels and tens of iterations make this the primary candidate;
- pair alignment: repeated warp/resize and NCC evaluation;
- per-pixel reports and error maps, but only if the JavaScript Worker is demonstrably too slow;
- TIFF decoding through an existing Rust codec if that is the selected decoder strategy. This does not remove the need for ICC, EXIF and XMP handling, and TIFF does not inherently require Rust.

The required sequence is: pure JS module -> Python golden tests -> real-pair profiling -> optional WASM replacement behind the same Worker API. WASM does not replace the Worker because a long WASM call can still block its thread. Do not introduce a second numerical implementation before the JavaScript reference path is correct, and do not optimize at the cost of the level-9 quality target.

### Reusing the manual editor in the full flow

The manual MVP already implements most of step 3.1. Reuse its tools and rendering pipeline rather than building a second editor.

Components reused directly or with only wiring changes:

- `panels.js`: Basic, Details, Strength, common slider behavior and clipping highlights;
- `curve-editor.js`, `blending.js`, `grading.js`: all specialized NP3 tools;
- `renderer.js`, `profile.js`, `detail.js`, `lut-worker.js`: interactive/final preview with no repeated RAW decode;
- `np3.js`, `curve.js`, `strength.js`: profile state operations and strength-correct serialization;
- `transfer.js`: existing single-NP3 import/export as the base for the full-flow export actions;
- existing level 4-8 conformance and UI tests as regression coverage.

Required adaptations:

- make Reset configurable: fitted field/group/profile baselines in the fitting flow, existing neutral defaults in standalone editing;
- extract edit history from `app.js`, add redo and associate changed-field marks with an immutable selected fit version;
- pass the selected version as the manual baseline without mutating version history;
- add strength-set export as independent `scaled()` operations around the existing single export;
- wrap the existing renderer with target geometry, comparison compositing and report overlays;
- keep the current Nikon-neutral before/after as an optional extra mode, but implement the primary comparison as RAW + NP3 versus JPEG/TIFF.

The substantial rewrite belongs to orchestration (`app.js`), page composition (`index.html`) and the new session/pair/version/report state, not to the NP3 controls themselves.

## 2. Decisions to fix before implementation

These points must be recorded in `ui.md` when the corresponding implementation starts, rather than left as accidental UI behavior.

> **Status 2026-11-19: done.** All six decisions are recorded in the "Decisions" section of [ui.md](ui.md), with the recommended defaults from this section. `ui.md` is updated in the same edit: the strength preset buttons and the `-70` name suffix are removed (slider only, unchanged name), the resolved open questions are struck through, the strength-set export stays with unique file names.


1. **Specification drift.** `ui.md` requires strength preset buttons and a `-70` name suffix; the newer manual MVP deliberately removed both. Recommended default: keep the newer behavior (slider only, unchanged profile/file name) and update `ui.md`. Do not implement both variants.
2. **Reset semantics.** In the fitting flow, field/group/profile reset returns to the selected fitted version. Standalone manual editing keeps the existing neutral reset behavior. Changed-field marks and undo/redo use the fitted baseline.
3. **Refit initialization.** For the first reference-compatible version, run a new deterministic fit from the same zero initialization as `match.py`, over all selected pairs. Keep the previous version unchanged. Warm-start from the previous control or from manual edits is a separate quality experiment, not an implicit UI decision.
4. **Versions and persistence.** Keep immutable fit versions in tab memory: draft, `_r1`, `_r2`, etc. Do not write `out/` and do not add server storage. Full-size pixel buffers are not duplicated per version; versions store controls and fit metadata. Session export/autosave is outside this plan unless requested separately.
5. **Strength.** Keep 0-150%, apply it after every fit/refit without fitting at anything other than 100%, and do not add separate color/curve strengths. Single and batch exports always scale from the base control, never from an already scaled result.
6. **Open product items.** Disclaimer copy remains `DISCLAIMER` until approved. Hold-out validation is not part of the first full-flow delivery. No arbitrary version-retention limit is introduced until memory measurements show a need.

## 3. Target architecture

Keep numerical code as pure JavaScript modules and Workers as thin lifecycle wrappers. Do not put fitting mathematics into DOM modules.

Proposed modules, with final names adjusted to existing conventions:

- `target.js`: target decoding, ICC/sRGB normalization, orientation, XMP metadata and warnings.
- `pair-prepare.js`: the pure port of `devpairs`/`pairs` geometry, resampling, NCC and aligned valid/target-clip masks.
- `analyze.js`: groups, bins, shares, rarity, coverage, recommendation, region sums and per-pixel report metrics.
- `fit.js`: parameter packing, deterministic sampling, development evaluation, residuals, regularization and the LM solver.
- `report.js`: immutable report DTO creation and JSON serialization; no DOM.
- `session.js`: session/version operations, next version naming, selection and fit-baseline rules.
- `compare-view.js`: target/render compositing, side-by-side/curtain/toggle modes, shared zoom/pan and overlays.
- `report-view.js`: summary, sortable table, error-map controls and NP3 parameter view.
- `pair-worker.js` and `fit-worker.js`: preparation and fitting with progress messages, cancellation/generation checks and transferable arrays. Report evaluation may share the fit worker or use a separate worker if profiling justifies it.

The main thread owns the session, File objects, DOM and WebGL renderer. Workers own aligned working arrays and fitting state. Reuse the existing RAW and LUT Workers. All asynchronous results carry a session/pair/report generation; stale completion cannot replace a newer pair, version, strength or manual edit.

Suggested session shape:

```text
session = {
  step: start | compare | manual | more,
  pairs: [{ id, rawFile, targetFile, raw, target, prepared, warnings, included, report }],
  selectedPairId,
  versions: [{ id, name, control, parentId, kind: fit | refit, pairIds, fitVector }],
  selectedVersionId,
  strength,
  manual: { baseVersionId, control, undo, redo } | null,
  generation, status
}
```

Keep prepared pairs at the fitting/report working resolution. Keep only the active full-size target and render buffers where possible; release replaced ImageBitmaps, textures, arrays and object URLs explicitly.

## 4. Implementation stages

### Stage 0. Contracts and reference fixtures

- Resolve the decisions in section 2 and add small fixtures for JPEG and TIFF, with and without XMP, ICC profiles, crop/rotation, masks, grain, vignette and clipping.
- Define serializable prepared-pair, fit-result and report schemas. Include schema versions and input file names, but no server paths.
- Add Python fixture generation for aligned arrays, geometry, masks, sampled data, fit vectors/controls and report sums/maps. Do not relax existing level 1-8 tolerances.

**Readiness:** the fixtures exercise every pre-fit warning and both blocking checks, and their schemas are stable enough for Worker and UI tests.

> **Status 2026-11-19: done.** The section-2 decisions are recorded in [ui.md](ui.md) "Decisions". The three contracts (PreparedPair, FitResult with the full 56-parameter layout, Report) and the fixture plan are specified in [web-schemas.md](web-schemas.md), including the residual definition, the browser/Python equivalence gaps (PRNG → shipped sampled indices; resampling kernels; trust=1 mode; banker's rounding; TIFF-vs-JPEG orientation asymmetry; ICC-by-description quirk) and the minimal golden fixture set per stage. `web/export_model.py` additionally exports the WB map (`model/wbmap.json`); the devmodel density stays unused (not committed, reference runs with `trust = 1`).
>
> Fixtures generated and self-checked: `web/make_fit_golden.py` → `web/golden/{pair,sample,fit,lm,report}/` (real `devpairs.build` + real `Matcher(seed=0)` fits: single cost 12.0645, two-pair cost 139.3662; pairs `dsc_6550` good / `skl_3024` warnings / `skl_3024__dsc_5584` blocked ncc 0.025; 3.53 MB) and `web/make_target_golden.py` → `web/golden/target/` (16 JPEG/TIFF cases with XMP/ICC/orientation/crop/masks/grain/vignette/clipping variants, 708 KiB). `analyze.region_sums` extended additively with `tLabSum`/`pLabSum` (§4.2). `test_np3.py` and `node web/test.mjs` green; `manifest.json` wiring and the consuming tests are left to the stages that implement the browser modules.

### Stage 1. Session shell, Start screen and target loading

- Refactor `app.js` around the session state while preserving the current manual editor and its level-8 behavior.
- Build the Start screen: disclaimer, pair recommendations, RAW and target pickers/drag-and-drop, default name from the first RAW, immediate 1-19 ASCII validation and Fit.
- Load targets locally with `createImageBitmap` where appropriate. Apply EXIF orientation and normalize ICC color to sRGB; reject unreadable or dimensionally incompatible files atomically.
- **TIFF (decision 2026-11-19): not accepted in the browser.** The interface loads JPEG targets only; TIFF pairs stay supported by the Python CLI (`match.py`/`devpairs`). The TIFF decoder investigation (all real files are one flavor: LE classic uncompressed 8-bit RGB, single strip) is recorded in [web-schemas.md](web-schemas.md) §8 should the decision ever be revisited.
- Port XMP extraction and `match.edit_gain`/`edit_warnings`; export the WB map needed by the browser. Report unknown ADL honestly until the browser RAW metadata exposes it.
- Preserve the last valid session on any new-file error. All new strings use `t()`/`data-i18n`.

**Readiness:** a user can assemble and validate one or several pairs, see accurate metadata/warnings and return to the manual editor without regressions. No fitting is claimed yet.

> **Status 2026-11-19: done.** Target loading is JPEG-only per the §8 decision; `web/lib/target.js` (spec/web-schemas.md §7.1, pure half + `decodeTarget`) is implemented and verified: levels **1b** (Node: XMP/ICC/gain/warnings/orientation vs golden jsons, exact strings) and **1c** (headless Firefox: JPEG decode vs PIL reference grid, max 0.000 levels, tolerance 0.5) in `web/test.mjs`, rows registered in [web-tests.md](web-tests.md). Notable: Firefox applies EXIF orientation even with `imageOrientation:"none"` — `decodeTarget` rewrites tag 274 to 1 in a byte copy before decoding (PIL parity, §6.3). The session shell has landed: `app.js` is refactored around the §3 session shape (step start | edit; pairs with raw/target/warnings/included/blocked; `web/lib/session.js` — the pairing rule and the name rule, `web/lib/history.js` — the extracted edit history, `web/lib/start.js` — the Start screen), level 8 covers it end to end (same-name/in-order pairing, camera/edit-gain/XMP warnings, blocked pairs, atomic rejections, the name rule, the honest Fit stub, Start ⇄ editor navigation). Stage-1 guard until pair preparation exists: a target whose aspect ratio does not match the RAW frame (±2%, either orientation) is rejected. Remaining in later stages: pair preparation and pre-fit checks (stage 2).

### Stage 2. Pair preparation and pre-fit checks

> **Status 2026-11-19: done (stage 2).** `web/lib/resample.js` (pure TypedArray ports of PIL resize/rotate/transform and numpy radial/shrink) is implemented and **bit-exact** against PIL references: level **1d** in `web/test.mjs` (13 cases, tolerances float max 1e-5 / u8 exact; the only non-zero cases are 1-ulp libm effects, documented in [web-tests.md](web-tests.md)). Reverse-engineered conventions (Pillow 13 Resample.c/Geometry.c): separable convolution with support widening on downsample, pass-order rule, int32-quantized 8-bit weights per pass; transform/rotate = point-sampled inverse map, no antialiasing, edge-row duplication, u8 bicubic truncates; numpy float64 promotion in radial. **Loud finding:** the target path (`pick_geometry`/`align`/target resize) resamples in **8 bit** — the aligned `y` is quantized to 1/255 by construction; the port carries both float (`resizeF`) and 8-bit (`resizeU8`) paths. The `devpairs.build(..., devignette=True)` port is `web/lib/pair-prepare.js` (pure, Node+Worker safe) with `web/lib/pair-worker.js` (thin lifecycle wrapper, one task at a time, cancel between stages, transferables out): level **1e** runs the three shipped input sets (`pair/<key>.in.json` — the level-1 linear fixture + `unrotate`, the ≤768 px embedded JPEG, the working-size 8-bit target; the reference is `build_dbg` replayed on these exact inputs, the honest gap vs the full-res build recorded in `vsBuild`) and compares x/y (max ≤ 1e-5, measured 1–2 ulp), ncc (≤ 1e-6, measured ≤ 1e-7), the full transform, masks and the blocked state — see [web-tests.md](web-tests.md). On the Start screen Fit now runs the preparation per pair (progress stages, the aligned NCC on the card, `ncc_low`/`target_too_small` block the pair, cancel/replace on a mid-flight re-drop) and still honestly stops before fitting — level 8 covers it. (Stage 3 refined the Fit-lock rule: a blocked pair no longer locks Fit, it is excluded from the fit — see the stage-3 status.) Remaining: the fitting engine (stage 3).

- Port the `devpairs.build` path used by `match.py`, not the simpler embedded-JPEG-only `pairs.build` path: development crop margins, devignetting, XMP crop, orientation selection, radial correction, scale/shift search, warp and 256-pixel working arrays.
- Export/port the missing development and vignette data required for equivalence. Reuse RAW decoder output without repeated decode.
- Produce target RGB, aligned linear RGB, NCC, transform parameters, valid-alignment mask and target-overexposure mask.
- Run stages in a Worker with visible development/alignment progress. RAW decode failure and NCC < 0.6 block the affected fit; camera, XMP edits, masks/grain/vignette and excessive clipping remain warnings as specified.

**Readiness:** browser arrays, transforms, masks and NCC match Python fixtures within recorded numerical tolerances. Good, warning and blocked pairs behave correctly in the real page.

### Stage 3. Browser fitting engine

- Port `match.Matcher`/`Pair` sampling: target frequency, rare-color weighting, development density/trust, regular and highlight samples, scoring samples and near-white one-sided penalties.
- Add the CPU development-model evaluation needed by the fit worker; reuse `profile.Pixels` and `color.js` rather than evaluating a 33^3 display LUT.
- Port the full 56-parameter packing (blender, grading, 20 curve increments, Saturation, zone brightness, Blending and Balance), bounds, regularization and conversion to `np3.Control`, including default detail values.
- Implement LM with a numerical Jacobian and a pivoted small dense linear solver. Add focused solver tests for singular/flat cases before comparing photo fits.
- Use a deterministic PRNG and seed. Emit iteration/cost progress, support supersession/cancellation and transfer only necessary results.
- Run initial fitting at 100% strength, create the immutable draft version and retain the user's selected strength for display/export.

**Readiness:** reserved web test level 9 compares browser and Python on the same prepared inputs. The result is not required to be bit-exact, but must satisfy the specified quality bar: no region worse than Python by more than 0.1 dE, with runtime and convergence recorded. Exported NP3 passes the existing exact serializer tests.

> **Status 2026-11-19: done (stage 3).** `web/lib/sample.js` `runFreeFit` — the free port of `match.main`'s Matcher flow: the shared rarity `freq` over the non-clipped target pixels (`match.target_frequency`), one seeded mulberry32 stream consumed pair by pair in the Matcher draw order (§6.4 — PCG64 cannot be reproduced, so free sampling is validated only through the quality bar), the LM fit from the zero init, `controlOf` + the per-pair scores at the rounded control. `web/lib/fit.js` `lm` grew optional lifecycle hooks (`shouldCancel` between outer iterations and between the Jacobian columns, `onIteration` after every accepted outer iteration) — behavior without hooks is unchanged (levels 1f/1e still green). `web/lib/fit-worker.js` — the thin module Worker (progress per LM iteration, cancel between iterations, stale generation discarded, FitResult per §3.2 with the transferred fitVector); the page sends prepared-array copies with transferred buffers, so the session's prepared pairs survive any outcome. Start-screen wiring: Fit prepares the included pairs (stage 2) and runs the fit Worker — progress in the status line, Fit locked as "Fitting…", cancel on a re-drop or on entering the editor; on success the immutable session draft version (`{id:"draft", name, control, parentId:null, kind:"fit", pairIds, fitVector}`, `selectedVersionId="draft"`, strength kept) is created — blocked/excluded pairs never enter `pairIds` (refining the stage-2 rule: a blocked pair no longer locks Fit, it is simply not fitted); a failure/cancel keeps the previous session state. Entering the editor from a fitted pair loads the draft control into the existing manual editor (reset-to-fitted and version history are stage 4/6). Level **9** in `web/test.mjs` — see [web-tests.md](web-tests.md); level 8 extended: the Fit progress/lock, the mid-flight cancel, the draft version fields, the editor loading the draft control. Remaining: the Compare screen and versions UI (stage 4), reports (stage 5), refit/history (stage 6/7).

### Stage 4. Comparison screen and versions

- Render the selected pair with the selected version and current strength, transformed into the same target geometry used for the report.
- Implement side-by-side, curtain and key-toggle modes with shared zoom/pan; keep the last good frame during recomputation.
- Add pair thumbnails and selected/aggregate view state.
- Add strength control without changing base controls or restarting RAW decoding/fitting.
- Add draft/`_rN` history, selection and return to any previous version. Version changes update manual baselines and reports.
- Wire both exits: manual adjustment and more frames.

**Readiness:** all comparison modes show the same geometry and zoom, pair/version/strength changes cannot apply stale renders, and refit versions remain independently selectable.

> **Status 2026-11-19: done (stage 4).** `web/lib/compare-view.js` — the step-2 screen: the pair strip (a blocked marker on excluded pairs, a click selects and re-renders), the three modes (side-by-side, curtain with a draggable divider, hold-Space key toggle), the shared zoom/pan (wheel zooms to the cursor, drag pans, a reset button), the strength slider (0–150, session-owned, re-renders only — the report hook is documented in app.js), the immutable version list (badges: kind + pair count; selecting re-renders and sets the manual editor's baseline control without touching the history) and the two exits — "Looks good" opens the existing editor with the selected version as the baseline, "Continue fitting" opens an honest stage-7 stub screen. **The geometry decision (the §6 risk "Preview/report geometry"):** the render side is produced at the aligned working geometry H3×W3 — app.js develops the frame through the renderer (neutral + profile LUT + detail), then the new `warpToWorking()` in `web/lib/pair-prepare.js` applies the pair's fitted transform chain (unrotate, devignette — the prepared x is devignetted, the renderer's frame is not — the embedded-JPEG lensRadial, the XMP crop, the orientation, the box resize to the working size, the radialScale/radialK warp, the align affine warp with the stored shift, the 3×3 box shrink) with the same parameters pair-prepare computed. Pixel (y, x) of the render side == pixel (y, x) of the prepared x/y arrays and of the future report (stage 5), so the error map can overlay these exact pixels; everything on screen is an upscaling of that grid (pure presentation zoom), and the target bitmap (full color, its own resolution) is fit into the same viewport mapping. Session/app wiring: steps `start | compare | edit | more` (the manual step keeps its established name "edit"); a successful Fit lands on Compare (spec/ui.md scenario), the Start screen's Comparison button requires a fitted version, leaving Compare keeps the prepared pairs and the versions, the strength lives in the session and survives the step changes. Stale protection: every render request carries a generation; a superseded result never applies and the previous good frame stays on the screen while the LUT builds. **Found and fixed along the way:** the renderer's profile/final/neutral passes rebind texture units 4/5/7 between renders, which the detail combine samples as its blur textures — the detail-reuse path (same LUT, second render) silently combined against the wrong textures (level 8 asserted only the reuse counter, not the pixels). `applyDetailGL` now rebinds its combine inputs explicitly; the full path is numerically unchanged (levels 2/2a/6/7 re-verify). Level **8** extended — see [web-tests.md](web-tests.md); `before-after.js` space-hold is guarded to the edit step so the key is free for the compare swap. Remaining: reports and error maps (stage 5), refit/history (stage 6/7).

### Stage 5. Reports and error maps

- Port `analyze.region_sums`, `bin_mean`, grouping and aggregation. Extend the Python reference to return target/render mean Lab sums required by the swatches; do not derive them from unrelated sums.
- Cache target Lab, group labels, bins and masks per prepared pair. Cache neutral-vs-target summaries independently of profile edits.
- Compute summary (strength, render/neutral mean dE2000, bin mean, fitted-baseline delta), sortable group table, swatches and aggregate rows.
- Generate dE/dL/dC/dh maps with the specified sequential/diverging legends and separate overexposed/unaligned colors. Clicking a table row displays its region mask.
- Show all NP3 parameters in base and strength-result columns, curve thumbnail, zero muting and refit/manual deltas.
- Download a versioned JSON report containing summary, table, parameters and file names.
- During dragging use the aligned working resolution and reduced preview; on release produce the final report. Worker generations prevent stale reports.

**Readiness:** summary, means, table, masks and maps match Python fixtures, including empty/small groups and fully clipped or unaligned pixels. Every fit, strength change and completed manual edit updates the report.

> **Status 2026-11-19: done (stage 5A, the compute engine).** `web/lib/analyze.js` — the pure port of `analyze.region_sums` (extended additively with the per-group `tLabSum`/`pLabSum` swatch sums), `bin_mean`, `total`, `labels`, `bins`, the §4.3 maps (dE/dL/dC/dh, NaN outside the reportMask) and the §4.4 `downloadDoc`; `web/lib/report-worker.js` — the thin Worker with the §4.1 per-pair caches (targetLab, labels, bins, the developed neutral and the neutral-vs-target sums), progress/cancel between map chunks, generation-stale discard. Verified in the new level **1g** (Node, vs `web/golden/report/*` — sums/summary/table/aggregate/download within 1e-4, edge cases, the Worker end to end incl. cache reuse and cancel) — see [web-tests.md](web-tests.md). The report DTO per pair: the envelope + `strength`, `summary` (renderDE/neutralDE/binMean/fittedDelta), `table`, `regionSums`, `maps`, `parameters` (base/result/deltas); `state.reportAggregate` = the totals + binMean + table. Remaining: the report UI (stage 5B).
>
> **Status 2026-11-19: done (stage 5B, the report UI).** `web/lib/report-view.js` — the report panel per ui.md, one component on the Compare screen and beside the manual editor (step 3.1): the summary (strength, render/neutral/bin-mean dE, `fittedDelta` when a fitted baseline exists), the sortable color-match table with Lab→sRGB swatches (a click highlights the group's pixels on the compare image through the stage-4 geometry), the H3×W3 error map with the dE/dL/dC/dh switch and the separate overexposed/unaligned colors (plus an optional overlay on the image), the two-column NP3 parameters view (profile/result at the current strength, zero muting, clipping highlights, the curve thumbnail), the aggregate switch and the §4.4 JSON download (Blob, the transfer.js pattern). Lifecycle: the previous report stays dimmed under an "updating…" badge while the Worker recomputes; stale results never apply (the `reportGen` rule); pair/version/strength switches refresh everything. Level **8** extended — see [web-tests.md](web-tests.md). Deviations recorded there: the map hides in the aggregate scope (it is per-pixel), the download `generator` is the constant `np3-fit web dev` until release builds wire a git describe. Remaining: stage 6 (full manual baselines/export) and stage 7 (more frames, refit, recommendations).

### Stage 6. Full manual adjustment and export

- Embed the existing editor with the selected fit version as its immutable baseline.
- Extend history with redo and preserve stale-task protection. Add reset of a field, group and whole profile to fitted values plus changed-field marks; retain the current standalone neutral reset outside the fitting flow.
- Keep interactive 17^3/final 33^3 rendering and the existing no-redecode/cache invariants.
- Keep single NP3 Blob export with strength applied. Add strength-set export (default 30/50/70/100%) using independent `scaled()` calls and valid unique file names.
- Warn before returning to fitting if manual edits will be discarded. Do not silently carry them into refit.

**Readiness:** every NP3 field remains editable; undo/redo/reset/changed marks work across sliders, curve, strength and version changes; single and batch NP3s match Python field-for-field.

> **Status 2026-11-19: done (stage 6), level 8 not yet run in Firefox.** **Baseline:** `state.baseline = {versionId, control}` (a deep copy of the selected version's control) in the fitting flow, `null` in standalone editing; `getBaseline()` in app.js returns `{control, fitted, versionId}` (standalone: the neutral defaults, `fitted:false`) and is passed as the `getBaseline` option to `createPanel`/`createCurveEditor`/`createBlendingView`/`createGradingView`; `setBaseline(version|null)` reloads the control from the version, refreshes every widget and mark and resets the edit history — called on a Compare version selection and in `enterEditor`; versions are never mutated. `web/lib/baseline.js` (pure) holds the field paths shared with the report view (`"saturation"`, `"blender.red.0"`, `"grade.midtone.2"`, `"curve"`) and `changedKeys`/`resetKeys`/`isDirty`/`fieldDeltas`; `web/lib/mark.js` the mark and reset-button DOM helpers. **Reset:** the slider option `def:` became `base: () => value` — a double click resets a field to the baseline; group resets (panel groups, the curve, a blending color, a grading zone) and the whole-profile Reset return to the version in the flow (the session strength is kept) and to the neutral defaults standalone (strength 100%, unchanged). Name and comment are never reset; resetting the curve to a baseline without a curve also restores the five tonal fields (one unit in NP3). **Marks:** a focusable mark per changed slider (panels, blending, grading — the blending color dot and the grading zone button carry it too), one mark for the whole curve; strength has none; the marks refresh on every edit, undo/redo, import, reset and version change. **Leave warning:** leaving the editor for Start/Compare with a fitted baseline and edits (a rename counts) opens an in-page `alertdialog` (never `window.confirm`) — "Keep editing" stays, "Discard edits" restores the baseline and continues; edits never reach a refit. A "Back to Comparison" button (`#ed-to-compare`) appears in the editor when versions exist. **Addition beyond the plan:** in the flow every finished edit and undo re-runs the report on the manual control (`"<vid>+manual"`, with field deltas). **History:** `web/lib/history.js` gained `redo()` (Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y; the text-field exemption as for undo), `canUndo`/`canRedo` and `onChange`; a new action still cuts off the redo future; the sessionStorage format is unchanged. **Strength set:** `web/lib/strength-set.js` — percents are integers 0–150, deduplicated and sorted (invalid lists throw, nothing is downloaded); every member is an independent `scaled(base, p)` from the base control (never chained, never from the slider's current strength), the NP3 internal name stays the base name, the file name is `<stem>-<p>.NP3` (the stem is the name with control characters and `< > : " / \ | ? *` replaced by `_`, outer spaces/dots trimmed, `profile` when empty; a case-insensitive `_2`, `_3` guard). `transfer.exportSet(percents = [30,50,70,100])` builds every file first, then downloads them one by one 250 ms apart as separate Blobs; the `#export-set` button follows the name-validity rule of `#export`. Verified: level **1h** (Node, byte-for-byte vs `strength.scaled` + `np3.serialize`, plus the history unit checks) and the stage-6 scenarios of level **8** — see [web-tests.md](web-tests.md). Known gaps: level 8 has not run in Firefox yet (written and syntax-checked; a Chromium smoke of the same flows passed); the manual `fittedDelta` is set only with exactly one usable pair (the report worker takes one `fittedRenderDE` per task); Chrome asks once per site to allow multiple downloads; level 8 does not yet click `#export-set` or redo in the page; the single export still names the file `<name>.NP3` without the stem cleanup.

### Stage 7. More frames, recommendations and refit

- Add multiple pairs through the same loading/check path; allow inclusion, exclusion and removal without losing other prepared pairs.
- Port `coverage`, `suggest`, `lift_median`, `verdict` and `recommend`. Show missing-color advice and a recommended set of at most `MAX_FRAMES`, while allowing the user to override the selection.
- Surface high-error pairs as candidates for exclusion without automatically deleting user data.
- Refit over all selected prepared pairs from the stage-2 initialization decision, create the next `_rN` version and return to Compare. Preserve strength and all prior versions.

**Readiness:** adding/removing pairs updates advice without refitting; refit uses exactly the displayed selected IDs, produces the expected next version and leaves previous versions reproducible.

> **Status 2026-11-19: done (stage 7A, the pure logic).** `web/lib/advice.js` — a pure, code-returning (no English prose) port of `analyze.py` `frame`, `verdict`, `coverage`, `level`, `value`, `lift_median`, `recommend`, `suggest` and the notes of `print_coverage` (`buildFrame`, `verdict`, `coverage`, `level`, `value`, `liftMedian`, `recommend`, `suggest`, `coverageNotes`; constants `ENOUGH`, `FEW`, `MAX_FRAMES`, `GAIN_STOP`, `LIFT_OUTLIER`, `LIFT_PENALTY`, `CLIPPED_BAD`, `NCC_BAD`, `INFO_ONLY`), plus `infoWarnings`, `exclusionCandidates` and Python-style half-even formatting helpers (`pyFixed`, `pyRoundTo`). **Frame mapping:** `targetSrgb` = the prepared pair's `y` (Python `raw["t"]`), `neutralSrgb` = `develop(dev, x·gain)` (the report worker's per-pair neutral; not yet returned to the main thread — the stage-7 UI must expose it), `ncc` = `prepared.ncc` rounded to 3 digits half-even, warnings = the pair's warning codes. **Gaps:** ADL is always `"?"` (the browser RAW metadata does not expose Active D-Lighting, so `adlOnly` and the `adl_mixed` note stay inert); warnings are classified by code (`small_target` bad; `grain`/`vignette` info only; `no_lr_settings`/`masks` caution) instead of Python's substring match on the whole string; browser-only warnings (`camera`, `gain_note`, `raw_error`) are dropped; `recommend` keys frames by object; `value()` sums groups in `GROUPS` order (Python iterates a set — at most a last-bit difference, the generator pins `PYTHONHASHSEED=0`). **Codes for the UI:** verdicts `good`/`caution`/`bad`; reasons `ncc_low`, `clipped`, `warning` (+ the edit-warning code), `lift_outlier`; coverage levels `enough`/`little`/`none`; the suggestion `weak_group {group, coverage, level, candidates}`; notes `set_lift {delta, significant, direction}` and `adl_mixed`; exclusion `high_error {id, renderDE, median, ratio}`. **Exclusion rule:** over the fitted pairs' stage-5 `summary.renderDE`, at least 3 finite values; M = the median (the pair itself included); a pair is flagged when renderDE > 2·M and renderDE − M ≥ 1.0 dE; highest ratio first; it only flags, never removes. **`web/lib/session.js` additions:** `nextVersionName(versions, prevName)` (= `match.next_name`: `foo` → `foo_r1`, the next free `_rN`; the base is truncated, never the suffix, to stay a valid 19-character NP3 name), `nextVersionId(versions)` (`r1`, `r2`, …; the draft keeps `draft`), `refitPairIds(session)` (included, decoded, not blocked pairs in display order) and `makeRefitVersion(versions, parent, result)` (`kind: "refit"`, inputs not mutated). Verified by level **1i** (Node, vs `web/make_advice_golden.py`) — see [web-tests.md](web-tests.md). Remaining (stage 7B): the More-frames screen, include/exclude/remove, the advice display, the refit wiring to the next `_rN` version.
>
> **Status 2026-11-20: done (stage 7B, the UI; level 8 green in headless Chromium, not yet run in Firefox).** `web/lib/more-view.js` — the More frames step replaces the stub: the pair list reuses `createStart` in mode "more" over its own ids (no name field, no Fit; per-card Remove, verdict + reasons, the high-error hint), adding pairs goes through the same `addRawFile`/`addTargetFile` path and checks as Start, every complete pair is prepared as soon as both files decode so its advice is ready before a refit. Include/exclude/remove recompute the advice from cached data and never fit; remove keeps the other pairs' preparation and every version; a selection change during a refit cancels it. Advice: per-group coverage (enough/little/none) of the selected pairs, the weak groups, `suggest` lines, the lift/ADL notes, the recommended set (≤ `MAX_FRAMES`) with "Use the recommended selection" (the user can override), and `exclusionCandidates` hints (only flags). **Frame data route:** the report worker already caches each pair's developed neutral, so a `{type:"frames"}` message builds the `advice.buildFrame` record there and returns only the record (no second develop); records are keyed by the preparation generation. **Refit:** over exactly `refitPairIds(session)` (shown under the button), unprepared selected pairs are prepared first, zero init + seed 0 (decision #3), `makeRefitVersion` with `nextVersionName`/`nextVersionId` (`<parent>_r1`, id `r1`, kind "refit"), appended and selected, the editor baseline follows, back to Compare, strength kept; cancel/superseded leaves the session unchanged. The editor gets `#ed-to-more` through the stage-6 leave warning. `report-worker.js` takes `fittedRenderDE` as a number or a per-pair map — the manual `fittedDelta` now works with several pairs. Fixed along the way: a worker-cache race (a pair marked as held before its arrays were posted) — entries are built right before posting, the worker registers arrays on arrival and answers `cache_miss`, the main thread resends. Deviations: the high-error hints use `renderDE` at the current strength/version; More lists every complete pair, including ones excluded from the first fit; the level-8 second pair is a renamed duplicate of DSC_5584. **Open (stage-2 preparation, seen in Chromium only):** DSC_6550.NEF + JPEG fails with "The source image could not be decoded."; SKL_3024/SKL_3000 + their JPGs get NCC 0.000 (Python: valid with warnings) — to be checked in Firefox. A refit finishing while the user is on Start still jumps to Compare (as Fit does).

### Stage 8. End-to-end hardening and documentation

Extend the existing test suite rather than creating a parallel framework:

- pure target/XMP/geometry/analyze/solver tests and Python golden comparisons;
- level 9 fitting quality, new report levels and a full-flow browser level after level 8;
- the complete Start -> Fit -> Compare -> Manual -> More -> Refit -> Save path on real `web/index.html`;
- JPEG targets, warnings/blockers, pair and version selection, every comparison mode, report table/map/JSON, undo/redo/reset and strength sets;
- races during RAW decode, alignment, LM, LUT building and reports; cancellation leaves the latest valid state;
- memory/resource cleanup and responsive UI during long fits;
- only static GET requests, no user-data request bodies and no runtime Python/NX dependency.

Run the standard checks on the final deliverable:

```sh
python3 test_np3.py
python3 web/make_golden.py   # when references/models/fixtures changed
node web/test.mjs
```

Update `web-tests.md`, `tools.md`, `stages.md` and the relevant UI specifications only as features actually pass. Perform the manual acceptance run on local real pairs in addition to de-identified fixtures.

> **Status 2026-11-20: done (stage 8), pending the user's Firefox run of level 8b.** The full flow is covered by the new browser level **8b** (`web/test-level8b.mjs`, after level 8): Start -> Fit -> Compare -> Manual -> More -> Refit -> Save with byte-exact single and strength-set exports, redo in the real page, the race scenarios (report generations, version switches during LUT builds, cancel-then-refit, a RAW dropped during a decode), resource accounting (object URLs, page Workers, ImageBitmaps) and locality (static GET only) — instrumented from the test, no app hooks. The user's Firefox run of levels 1–8 (2026-11-20) was green before this stage. **Two real stage-2 bugs were found while probing the other local pairs and fixed (every browser, not Chromium-only):** (1) `extractEmbeddedJpeg` accepted a fake "48382×15468 SOF15" byte run inside DSC_6550/DSC_6132 sensor data as the widest preview → "The source image could not be decoded."; the candidate check is now a port of PIL's `Image.open` acceptance (full marker walk, 8-bit precision, 1/3/4 components, quantization tables, size limits), matching Python's pick on all 34 local RAWs (DSC_6550 NCC 0.974 vs golden 0.9737). (2) The target ICC path in `web/lib/target.js` inverted the matrix, mis-evaluated parametric curve types 3/4 and returned linear light — every Display-P3 target came out white (SKL_3024/SKL_3000 NCC 0.000); now ICC-spec curves, profile → D50 → D65 (Bradford) → sRGB, `srgbEncode` — ≤ 0.59 levels vs littleCMS, SKL_3024 NCC 0.851 = Python 0.8514. The level-1c ICC reference was a mirror of the same JS formulas and is now the real `pairs.to_srgb`; regression level **1j** fails 15 checks against the old code. Remaining notes: Jacobian helper Workers inside `fit-worker.js` are not observable from the page; in Firefox (BiDi) request bodies cannot be read, so locality there is method + host only; levels 8 and 8b both fit in the page concurrently (higher CPU on the test machine); the level-1j real-RAW list points at `_local/_cloud_transfer/` copies of DSC_6550/DSC_6132 and skips if they are removed.
>
> **Follow-up 2026-11-20 (user report: the compare render looked very low-res).** The stage-4 render side was the H3×W3 report grid itself — 256 px on the long side, upscaled to the canvas next to a full-resolution target. `warpToView` (web/lib/pair-prepare.js) now runs the same transform chain into the same working rectangle at k× the working size (k = min(2048 / long side, the developed frame's extent / the working size) — about 1600 px for the 1600-px RAW develop), with the stored align shift scaled by k and no 3×3 shrink; `warpToWorking` (the report grid) is unchanged and is literally its k = 1 path + the shrink. The overlays still land on the same image-space pixels. Level 1e checks the bit-identity at k = 1 and the k = 2 alignment (6×6-shrunk mean |Δ| ≤ 5e-4; measured 1.2–1.7e-4, an unscaled shift gives 1.67e-3); the level-8 geometry check now asserts the render side covers the working rectangle at ≥ the working resolution. Cost: ~280 ms per render-side update in Node for a 1600-px frame (was ~160 ms). The render side is still bounded by the 1600-px develop, the target by its own resolution.
>
> **Follow-up 2026-11-20 (user reports: a portrait pair compared rotated by 90°; slow pair switches; a brighter render than the target).** (1) `pair-worker.js` never passed `unrotate` to `preparePair` — the preparation ran in the decoder's (EXIF-rotated) frame while the compare render undid the turn: every camera-rotated RAW compared rotated by 90°, and with an XMP crop (defined in the sensor frame) the alignment failed outright (SKL_3024 NCC 0.05 in the page vs 0.851 in Node/Python — the "Chromium-only NCC 0" of stage 7 was this). Fixed; level 8b now prepares SKL_3024/SKL_3000/DSC_6550 through the page and asserts NCC ≥ 0.6 plus `warpToWorking(page frame, app unrotate)` ≈ prepared x (luminance correlation > 0.98). (2) The compare render now develops `x · gain` (the target's XMP exposure/WB compensation) like the fit and the report — a −0.88 EV target showed a render ~0.9 EV brighter. (3) Pair switches: the strip rebuilt every thumbnail from the full-resolution float target on each refresh (~0.5 s per pair) and the render side ran warpToView's seven passes (~1–1.4 s). Now the target display canvas (≤ 4096 px) and thumbnail are built once per target, the warpToView geometry is one cached inverse map per preparation (`viewRemap` + `applyRemap`, ~30 ms gather; level 1e: ≤ 2 % mean |Δ| vs warpToView, measured ≤ 1.1 %), and an LRU of 6 finished render sides keyed by (preparation, version, strength) makes revisits instant. Measured in headless Chromium/SwiftShader: a first visit 1.7 s (software GPU develop + readback), revisits ~130 ms (was 2.3–4.3 s). (4) The compare canvas redraws on a ResizeObserver of its box (a step switch could leave a buffer sized for an old layout, stretched by CSS).


### Stage 9. RAW-first pair assembly

Spec: [ui.md](ui.md) decision #7 (2026-11-20, user review of the Start screen). Not started.

Tasks:

- `web/lib/session.js`: drop the stage-1 pairing rule (`same base name`, then arrival order) and the `included` flag; a pair is created only by a RAW; `attachTarget(pair, file)` / `replaceTarget(pair, file)` for one card; `refitPairIds` = every decoded, prepared, unblocked pair in card order; the duplicate-RAW rule (retry a decoding/failed card, skip a ready one).
- `web/lib/start.js`: the six card states; the "Add JPEG" slot (button + card drop target, one file, rejection on the card); "Replace JPEG"; "Remove from fit" on every card in both modes; no checkbox, no "Edit"; the "{n} pairs will be fitted / {m} without a JPEG, {k} blocked — skipped" line under Fit.
- The wizard page (`web/index.html` until stage 11, then `picture-control-jpg-fit.html`): remove `#target-drop` / `#target-file`; one RAW zone. The mobile page has no Start screen (stage 11), nothing to change there. The global `drop` router: a JPEG outside a card is skipped with a status message.
- `web/lib/app.js`: `addTargetFile` takes the card's pair; removal releases decode/preparation/advice/worker caches and cancels a fit/refit that uses the pair; replacement cancels and restarts the pair's preparation; remove `enterEditor` from Start, the editor's own RAW drop and the standalone (neutral-baseline) path; selection moves on removal.
- `web/lib/more-view.js`: remove "Use the recommended selection" and `onIncludeChange`; mark pairs outside `recommend` as "not recommended".
- i18n: new strings ("Add JPEG", "Replace JPEG", "Remove from fit", "Add the JPEG on its RAW's card", the fit-count line); remove "Include in the fit", "Edit", "Drop JPEG targets here or click to choose".
- Resolve [ui.md](ui.md) open question #7 (NP3 import and `?np3=` links without the standalone editor) before removing the editor's import path.

Tests (level 8 / 8b rewrite, no new golden data):

- RAW-only drop: cards appear in decoding state, no JPEG slot until decoded; a RAW error card offers only removal.
- JPEG via picker and via drop on a card; several files or a non-JPEG on a card are rejected without a state change; a JPEG dropped outside cards is skipped; a JPEG with a different base name is accepted.
- Replace JPEG during and after preparation: the old preparation is discarded, the new NCC is reported, versions unchanged.
- Remove from fit: during decode, during preparation, during a fit/refit (cancelled), after a fit (versions kept, Compare strip without the pair); resources released (object URLs, worker cache entries).
- Fit count line and the disabled Fit with only RAW-only/blocked cards; refit uses exactly the remaining ready pairs.
- More frames: "not recommended" marks, no automatic removal; the editor is reachable only via Compare.

### Stage 10. Compare screen and report panel cleanup

Spec: [ui.md](ui.md) decision #8 (2026-11-20, user review of step 2). Not started.

Tasks:

- `web/index.html` / `web/lib/compare-view.js`: remove the `toggle` mode button, its Space handler and state; remove `#cmp-reset`, bind `dblclick` on the compare canvas to the existing fit-view reset; update the hint string (i18n key changes).
- `web/lib/compare-view.js`: `paintStrength()` on the slider's `input` event (the label shows the live value); audit the other strength labels for the same bug.
- `web/lib/report-view.js`: remove the "Download report" button and its Blob/URL code; `web-schemas.md` §4.4 and the `report/report_download.json` golden become unused — remove them with their test checks.
- Curve thumbnail: square SVG (viewBox 0..255 + padding), identity diagonal, histogram path under the curve; `report-worker.js` adds a 256-bin normalized luma histogram of the cached neutral per pair to the report DTO (`web-schemas.md` §4.3 gains `neutralHist: number[256]`), the aggregate is the sum of the fitted pairs' bins re-normalized; same visual classes as the curve editor's `ce-hist`.

Tests (level 8 additions):

- The mode buttons are exactly side-by-side and curtain; Space does nothing on Compare.
- Double click restores the fitted view after a zoom/pan; no `#cmp-reset`.
- Dragging the strength slider to 40 / 130 shows "40%" / "130%" next to it before any re-render finishes.
- No "Download report" control; no object URL is created by the report panel.
- The curve thumbnail is square; the histogram path exists with and without a curve; switching "This pair" / "All pairs" changes it; the histogram matches `renderer.lumaHistogram` of the same neutral within binning tolerance (Node, on the report grid).

### Stage 11. Page split: wizard, editor, mobile editor, landing

Spec: [ui-pages.md](ui-pages.md), [ui.md](ui.md) decision #9 (2026-11-20). Not started. Best done before stages 9–10 land in markup, or together with them, so the wizard markup is written once.

Tasks, in order:

1. **Split `app.js`** on `feature/np3-fit`: `lib/editor-core.js` (renderer, loader, panels, curve, blender, grading, history, before/after, transfer, `renderCurrent`, `setStatus`), `lib/fit-app.js` (session, Start, Compare, report, More, workers, versions, baseline, step 3.1 mounting the core), `lib/editor-app.js` (one RAW, NP3 import/export/share, neutral reset, drop router with the JPEG hint). Behavior unchanged except what ui-pages.md lists.
2. **Pages:** `picture-control-jpg-fit.html` (today's `index.html` without the standalone-editor entry and without NP3 import; the phone banner), `picture-control-editor.html` (today's editor column layout without Start/Compare/report/More). Level 8/8b → the wizard page; the standalone-editor checks → a new level on the editor page. Green before step 3.
3. **Port the mobile branch** (M0–M3 of [ui-mobile-plan.md](ui-mobile-plan.md)): `common.css`, `mobile.css`, `mobile.js`, `touch.js`, `icons.js`, `view-route.js` with the new `PAGES`, the `history.js`/`before-after.js`/`curve-editor.js`/`panels.js`/`transfer.js` hooks — into `editor-core.js`/`editor-app.js` instead of `app.js`; `mobile.html` → `picture-control-editor-mobile.html` without the Start screen; levels 9a–9d on the new pages (9b without Start checks). Then M4 (devices) as planned.
4. **Share URL** → `picture-control-editor.html?np3=` from every page.
5. **Landing** `index.html`: for now the minimal version of ui-pages.md (two links + the legacy `?np3=` forward, no heavy assets); the real landing after the content is agreed.
6. Docs: `spec/tools.md` / `README.md` run instructions (which page to open), `web-tests.md` page per level.

Tests: see ui-pages.md "Tests".

### Stage 12. Remove the strength-set export

Spec: [ui.md](ui.md) decision #10 (2026-11-20). Not started. Supersedes the strength-set parts of stage 6.

- Remove the "Save strength set" button and its i18n key (`index.html` / the wizard page, the editor pages, `mobile.html` if it has one), `exportSet` and its busy state in `transfer.js`, `web/lib/strength-set.js`, `web/make_strength_set_golden.py` and its golden files.
- Tests: drop the strength-set level-1 checks and the byte-exact strength-set export of level 8b; add one check that no such control exists on any page. Single-NP3 export at a non-100% strength stays byte-exact against `strength.scaled`.

## 5. Delivery milestones

1. **Prepared pair:** Start screen, target loading, metadata, alignment and checks; no fit result yet.
2. **Single-pair vertical slice:** fit, compare, full report, strength, version draft and NP3 export.
3. **Complete editor:** fitted-baseline manual tools, undo/redo/reset and strength-set export.
4. **Full product flow:** multiple pairs, recommendations, refit/history, aggregate reports and final E2E hardening.

A milestone is done only when its reference tests and real-page scenario pass. In particular, a UI that starts a Worker or displays an NP3 is not sufficient evidence of fitting quality; level 9 and the report comparisons are mandatory.

## 6. Main technical risks

- **TIFF/ICC compatibility:** resolved 2026-11-19 by not accepting TIFF in the browser at all (JPEG targets only; TIFF stays CLI-only). Remaining risk: ICC normalization of JPEG targets (non-sRGB embedded profiles), covered by fixtures.
- **Alignment equivalence:** devignette, crop orientation and radial/affine transforms are the largest source of fit/report divergence.
- **LM performance and numerical behavior:** JavaScript needs a deterministic, tested dense solver and cooperative Worker progress; optimize only after level 9 passes.

  > **Performance decision 2026-11-19 (user):** the measured speed is accepted as-is (single pair ~7.5 s, two pairs ~31 s, real in-page pair ~1 min; a maximal 6-pair refit extrapolates to ~1.5–2 min with per-iteration progress and cancellation). No WASM/Rust optimization is planned. **Update (same day):** a pure-JS parallel Jacobian landed anyway — `web/lib/fit-pool.js` + `fit-jac-worker.js` spread the 56 central-difference columns of each LM iteration over helper Workers (nested in `fit-worker.js`, no SharedArrayBuffer/COOP), bit-identical to the single-thread `fit.js` path, plus a staged-Jacobian anchor in `profile.js` (`beforeCurve(p, toned)`) that skips re-grading when only blender/curve parameters move.

  > **Revisited 2026-11-19: JS speed-up without WASM.** Profiling showed ~99% of the fit time in the 112 residual evaluations per LM iteration (the central-difference Jacobian); the normal equations and the 56×56 solve are negligible, and the hot path is dominated by transcendental math (pow/cbrt/exp/trig) that WASM would not accelerate much (estimated 1.5–2.5× for a full Rust port). Two exact changes instead: (1) **staged Jacobian** — `fit.makeResidual` anchors each Jacobian at its base point and reuses the toned stage for the 48 blender evaluations and the whole pre-curve result for the 40 curve evaluations (only the 24 grade/extra evaluations run the full pipeline); (2) **parallel columns** — `lib/fit-pool.js` spreads the columns over nested helper Workers (`lib/fit-jac-worker.js`, one per spare core, at most 8, no SharedArrayBuffer), with a single-thread fallback. Both are bit-identical to the previous fit (level 1f). Measured on a 2-vCPU VM, Node: single pair 18.8 s → 12.1 s (staged) → 10.0 s (+2 helpers), two pairs 78.5 s → 38.0 s → 25.3 s; the parallel gain scales with the core count. Side effect: the fit Worker now awaits the helpers, so a cancel lands between Jacobian columns instead of after the fit. Memory: each helper holds its own copy of the sampled pairs' Pixels tables (estimated ~1.4 KB per sampled pixel, ~7–11 MB per pair).
- **Preview/report geometry:** the displayed render and the analyzed pixels must use the same transform and masks, otherwise the error map can look plausible while being wrong.
- **Specification drift:** naming, reset and refit initialization must be settled explicitly so later manual-MVP improvements are not accidentally reverted.
