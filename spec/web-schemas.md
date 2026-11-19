# Web fitting data schemas (Stage 0 contracts)

Status: draft 2026-11-19, from the Stage 0 of [ui-plan.md](ui-plan.md). Scope: the
three serializable contracts of the browser fitting flow — **PreparedPair** (port of
`devpairs.build(..., devignette=True)` as consumed by `match.py`), **FitResult** (the
56-parameter `match.py` fit) and **Report** (the `analyze.py` region report). Python
is the source of truth; every field lists the function that produces its reference
value. All schemas share the common envelope in §1.

Conventions: `H3×W3` is the shrunk working geometry (`max(W3,H3) ≤ 256`, see §2.1).
Arrays are transferred as detached `TypedArray` buffers (transferable). JSON fixtures
use little-endian raw binary next to JSON metadata, as in `web/golden/`
(`web/make_golden.py` `save_f32`).

## 1. Common envelope

Every message object (Worker result, session state entry, fixture root) carries:

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | int | `1`. Bump on any breaking field/shape change. |
| `kind` | string | `"preparedPair"` \| `"fitResult"` \| `"report"` |
| `id` | string | Pair id (e.g. `"dsc_6550"`) or version id (`"name_r2"`); opaque, unique within session. |
| `files` | object | `{ "raw": "DSC_6550.NEF", "target": "DSC_6550.jpg" }` — **base names only, no paths**. |
| `generation` | object | `{ "session": int, "pair": int, "task": int }`. Monotonic counters owned by the main thread. A result whose `generation` is older than the current session/pair/task generation is stale and must be discarded (stale-result rejection, same rule as `web/lib/raw-worker.js`). |
| `cancelled` / `superseded` | bool (writer-side) | Workers must observe a cancellation flag between stages (decode → devignette → crop/orient → radial → align → shrink for pair-prep; Jacobian → solve → accept for LM; per-map-chunk for reports) and between inner iterations, and exit without posting a result. This is a requirement on the modules, not a wire-protocol detail. |
| `warnings` | string[] | Human-readable, already localized strings (i18n keys resolved on the main thread; workers post message codes, see §2.6). |

Non-deterministic fields (`createdAt`, progress timestamps) are **not** part of the
schema and must not appear in fixtures.

## 2. PreparedPair

Full output of the browser port of `devpairs.build(nef, target, devignette=True)`
(`devpairs.py`) plus the metadata `match.py` attaches (`match.prepared`,
`match.edit_gain`, `match.edit_warnings`).

### 2.1 Geometry and transform

Working size from `devpairs.matched`: `k = 768 / max(target.size)` (devpairs.LONG=768),
working size `(W, H) = (round(w·k), round(h·k))`; after `shrink(…, BOX=3)`
the aligned arrays are `H3 = floor(H/3)`, `W3 = floor(W/3)`, `max(W3,H3) ≤ 256`.

| Field | Shape / type | Range | Python reference | Notes |
|---|---|---|---|---|
| `size` | `{w: int, h: int}` (working, pre-shrink) | — | `devpairs.matched` | Display geometry for compare view. |
| `x` | Float32Array `H3·W3·3`, row-major RGB | ≈ [0, 1.5], unclamped | `build()["x"]` | Aligned **linear** camera RGB after devignette, XMP crop, orientation, radial+affine warp, 3×3 box shrink. `match.py` casts to float64, reshapes `(-1,3)`. |
| `y` | Float32Array `H3·W3·3`, row-major RGB | [0, 1] | `build()["y"]` | Target sRGB /255 (ICC-normalized, LANCZOS to working size). |
| `ncc` | float | [-1, 1] (blocking < 0.6, `analyze.NCC_BAD`) | `build()["ncc"]` = `pairs.align` value | Edge-correlation NCC at half working resolution. |
| `transform` | object | see below | `build()` + internals | Everything needed to re-render the browser RAW into target geometry (compare view, report overlays). |

`transform` fields (names fixed; the Python `build()` returns only the two products —
the fixture generator must export the components, they are all computed inside
`devpairs.build`):

| Field | Type | Python reference | Meaning |
|---|---|---|---|
| `crop` | `null` or `{hasCrop: bool, left: f64, top: f64, right: f64, bottom: f64, angleDeg: f64, angleSign: int}` | `pairs.xmp_values` + `pairs.apply_crop` | XMP crop rectangle (fractions of uncropped frame), angle in degrees, applied sign ∈ {+1, −1}. |
| `orientation` | int 0…3 | `devpairs.oriented` | `np.rot90` count of the chosen variant. |
| `lensRadial` | `null` or `{scale: f64, k: f64}` | `devpairs.lens_corrected` | Radial correction fitted against the embedded JPEG, applied **before** the crop. Discarded by the current Python return value — re-exported for the fixtures. |
| `radialScale` | f64 | `devpairs.matched` → `fit_radial` | Radial scale fitted at half working resolution, applied after orientation. |
| `radialK` | f64 | same | Radial distortion coefficient; the `k` returned by `build()`. |
| `scale` | f64 | `build()["s"]` = radialScale × `s2` | Combined scale; the `s` returned by `build()`. |
| `warpScale` | f64 | `pairs.align` → `s2` | Affine scale from the align search. |
| `shiftX`, `shiftY` | f64, full working-resolution pixels | `pairs.align` dx,dy × 2 | `pairs.align` searches at half resolution; the applied shift is `dx*2, dy*2`. Store the **applied** values. |
| `vignette` | `{a: f64, b: f64}` | `vignette.coefficients` | Devignette coefficients: gain `2^(a·r² + b·r⁴)`, `r` normalized so the corner = 1. (0, 0) when the frame has no embedded JPEG. |

### 2.2 Masks

| Field | Shape / type | Semantics | Python reference |
|---|---|---|---|
| `clipMask` | Uint8Array `H3·W3` | 1 where any target channel ≥ 0.98 — overexposed/pinned target pixels, excluded from fitting (`match.sample` keep) and counted as "white" in analysis (`analyze.frame`). | `t.max(1) >= 0.98` |
| `reportMask` | Uint8Array `H3·W3` | 1 where target max channel < 0.99 — pixels entering `analyze.region_sums`. | `t.max(1) < 0.99` |
| `validMask` | Uint8Array `H3·W3` | 1 where the aligned sample is inside both frames (warp did not clamp at the border / crop). | **No Python reference exists** — `devpairs.build` never marks invalid pixels. Defined as all-ones for full-frame targets; the Python fixture generator adds it by tracking warp source coordinates. |
| `nearWhiteMask` | Uint8Array `H3·W3` | 1 where target max ≥ 0.98 **and** min ≥ 0.8 — the near-white pinned set for the one-sided curve-knee penalty. | `(t.max(1) >= CLIP) & (t.min(1) >= NEAR_WHITE)` |

Masks are derivable from `y` alone; they are materialized and cached because the
report and fit worker need them repeatedly and the report worker runs in a different
thread. Values are 0/1.

### 2.3 Development metadata (for the fit worker)

| Field | Shape / type | Reference | Notes |
|---|---|---|---|
| `gain` | Float64Array 3 | `match.edit_gain` | Linear RGB coefficients: WB (R,B from `wbmap.predict` − `wbmap.multipliers`, exponentiated) × `2^Exposure2012`. (1,1,1) when XMP is As Shot / absent. |
| `gainNote` | string or null | `match.edit_gain` second return | e.g. `"WB 6500 K, +12 (R x1.032, B x0.981), exposure +0.50"` — displayed as a warning. |

### 2.4 Pre-fit check metadata

| Field | Type | Reference | Blocks? |
|---|---|---|---|
| `camera` | string or null | raw-identify (camera model string) | warning if ≠ "NIKON Z F" (`ui.TRAINED_ON`) |
| `adl` | string | `analyze.adl` (exiv2 `Exif.Nikon3.ActiveDLighting`) | informational; `"?"` when the browser decoder cannot expose it (report honestly, per ui-plan Stage 1) |
| `targetSize` | `[w, h]` | `match.edit_warnings` | warning if `max < 1000` (`MIN_TARGET`) — preview-in-DNG |
| `xmpHasLightroom` | bool | `"Temperature" in x` (`edit_warnings`) | warning when false |
| `xmpMasks` | bool | `x["_masks"]` (`pairs.xmp_values`) | warning |
| `xmpVignetteAmount`, `xmpGrainAmount` | f64 | `PostCropVignetteAmount`, `GrainAmount` | warning when ≠ 0 |
| `blocked` | `null` or `{code: "raw_unreadable" \| "ncc_low" \| "target_too_small" \| "target_unreadable", detail?: string}` | render/rawdev exit, `ncc < analyze.NCC_BAD` | blocks the pair from fitting |

`edit_warnings` strings are composed by the main thread from these structured fields
(i18n), not shipped as strings.

### 2.5 Analysis block (Stage 7 input; port of `analyze.frame`)

Computed once per prepared pair, cached, immutable:

```
analysis: {
  name: string,                 # RAW base name without extension
  ncc: f64,                     # rounded to 3 decimals as in Python
  adl: string,
  groups: {greys, skin, "warm saturated", "warm muted", yellows, greens,
           "teal/water", sky, "dark blues", purple}: f64,   # shares over reportMask pixels
  L: f64, dark: f64, light: f64, clipped: f64,   # from target Lab (analyze.frame)
  lift: f64 | null,             # mean (target L − neutral L) over ok pixels
  verdict: {state: "good"|"caution"|"bad", reasons: string[]},   # analyze.verdict
  warnings: string[]            # resolved codes
}
```

`lift`/`verdict` require the developed neutral — the fit worker returns these after
development. Constants for Stage 7: `analyze.ENOUGH=0.05`, `FEW=0.01`, `MAX_FRAMES=6`,
`GAIN_STOP=0.15`, `LIFT_OUTLIER=2.0`, `LIFT_PENALTY=0.7`, `INFO_ONLY=("grain","vignette")`.

## 3. FitResult

Output of the browser port of `match.Matcher.fit` + `match.control`.

### 3.1 The 56-parameter vector

Order is exactly `np.r_[x[:NB+NG+NC], extra]` with `NB=24, NG=6, NC=20`
(`fit.py`), `NX = 50`. Zero initialization: blender/grade = 0, curve =
`[0, diff(XS)]`, extra = `EXTRA_DEFAULT`.

| # | Name | Layout | Meaning | Bounds | Reference |
|---|---|---|---|---|---|
| 0–23 | blender | 8 colors (`np3.COLORS` order: red, orange, yellow, green, cyan, blue, purple, magenta) × 3 attrs (hue, chroma, brightness), color-major | signed slider units | LM clips each to ±60 (`fit.LIMIT`); control rounds and `np3.serialize` clamps to ±100 | `x[:24].reshape(8,3)` in `fit.unpack` |
| 24–29 | grade | 3 zones (`np3.ZONES` order: shadows, midtone, highlights) × 2 cartesian components (u, v) | hue = `atan2(v,u)` deg, chroma = `hypot(u,v)` | LM normalizes each (u,v) pair to length ≤ 60 (`fit.lm`); chroma/brightness clipped ±100 in `match.unpack` | `x[24:30].reshape(3,2)` |
| 30–49 | curve | 20 increments at anchors `XS[i] = round(i·255/19)/255`, i = 0…19 | monotone knots `k = cumsum(|c|)`; table = `clip(interp(linspace(0,1,257), XS, k), 0, 1)` | increments unbounded; `fit.WHITE=30` penalty pins `k[-1] → 1` | `fit.knots`, `fit.table` |
| 50 | saturation | scalar | Saturation slider | clip ±100 (`match.EXTRA_LOW/HIGH`) | `match.unpack` |
| 51–53 | gradeBrightness | shadows, midtone, highlights | zone Brightness | clip ±100 | `match.unpack` → `grade_bright` |
| 54 | blending | scalar | Grading Blending | clip [0, 100] | `match.unpack` |
| 55 | balance | scalar | Grading Balance | clip [-100, 100] | `match.unpack` |

`XS` (exact, 20 values): `[0, 13, 27, 40, 54, 67, 81, 94, 107, 121, 134, 148, 161, 174, 188, 201, 215, 228, 242, 255] / 255`.

### 3.2 FitResult fields

| Field | Type | Reference | Notes |
|---|---|---|---|
| `fitVector` | Float64Array 56 | `Matcher.fit` return (`fit.lm`) | Transferred as one Float64Array. |
| `cost` | f64 | `fit.lm` second return | `r @ r` of the full residual vector (§3.4). |
| `iterations` | `{requested: int, run: int, costs: f64[], lambdas: f64[]}` | `fit.lm` (Python records none — the browser adds the history; fixtures store it for convergence comparison only, tolerance applies) | LM: `lam0 = 1e-2`, success ÷3 (min 1e-6), failure ×3, ≤ 12 inner tries, stop when an outer iteration makes no step; `iters=30`. |
| `jacobianSteps` | Float64Array 56 | `fit.lm` `steps` | Central-difference step per parameter: 1.0 for #0–29, 2e-3 for #30–49, 1.0 for #50–55. |
| `seed` | int | `np.random.default_rng(seed)` | `Matcher(seed=0)` default. |
| `control` | object (§3.3) | `match.control` | The resulting profile at 100% strength. |
| `scores` | `{neutral: f64, prediction: f64}[]` per pair | `Matcher.score` | Mean dE2000 on the 3000-pixel uniform test sample: neutral-vs-target and prediction-vs-target. |
| `pairs` | string[] | pair ids | The exact pair ids included (refit input per ui.md Decisions §3). |
| `init` | `"zero"` | ui.md Decisions §3 | Refits start from the same zero init, never from the previous version. |

### 3.3 `control` object (np3.Control, `match.control`)

JSON shape identical to `control_json` in `web/make_golden.py`:

```
{ name, comment, sharpening, mid_sharpening, clarity, contrast, highlights, shadows,
  white, black, saturation, blender: {color: [h, c, b]}, grade: {zone: [hue, chroma, bright]},
  blending, balance, curve: null | {raw: int[257], points: [int, int][] } }
```

Fixed values from `fit.control`: `sharpening=2.0, mid_sharpening=1.0, clarity=0` (the
default detail values); `contrast/highlights/shadows/white/black = 0` (ignored whenever
a curve exists); `name = "NPF-" + name.upper()[-15:]` (`match.write`).
Blender/grade hue/chroma/brightness, saturation, blending, balance are
`int(round(·))` — **Python banker's rounding** (`np.round` semantics); the browser must
round half-to-even, not `Math.round`. Curve = `make_pack.curve_from`:
`raw[i] = round(clip(f(i/256),0,1)·32767)` for the 257-entry table and 20 points at
`XS·255`, `y = round(f(x/255)·255)`.

### 3.4 Residual definition (must be reproduced exactly)

For pair `q` with `n_q` fit pixels and `P` pairs (browser port of `Matcher.fit.fn`):

1. Main: `W = de2000_weights(tlab, KC=0.5, FLAT_L=true) · sqrt(mult)` per pixel
   (`match.py`, `color.py`); residual = `weighted(W, srgb_to_lab(pred) − tlab).ravel() / sqrt(n_q · P)`.
2. Near-white clip penalty (only for pairs with `nearWhiteMask` samples, ≤ 3000,
   `CLIP_PIXELS`): `100 · where(cmask, min(pred−target, 0), pred−target).ravel() / sqrt(n_q · P)`,
   `cmask = target ≥ 0.98`.
3. Regularization tail (shared, appended once): `SMOOTH·100·diff(k,2)·BEND` (18 terms;
   `SMOOTH=0.3`, `BEND = [1×14, 0.25×4]`), `RIDGE·x[0:30]` (`RIDGE=0.012`),
   `RING·(blender − roll(blender,1)).ravel()` (24 terms, `RING=0.02`), `WHITE·(k[-1] − 1)`
   (1 term), `RIDGE·(x[50:56] − EXTRA_DEFAULT)` (6 terms).

## 4. Report

Port of `analyze.region_sums` and its presentation per ui.md "Report". Computed on
the aligned pair over `reportMask` pixels, in target geometry.

### 4.1 Per-prepared-pair cached pixel data (computed once, immutable)

| Field | Shape / type | Reference | Notes |
|---|---|---|---|
| `targetLab` | Float32Array `H3·W3·3` (L, a, b) | `color.srgb_to_lab(y)` | Needed for groups, bins, dE maps. |
| `groupLabels` | Uint8Array `H3·W3` | `analyze.labels` | Index into `analyze.GROUPS` (order: greys, skin, warm saturated, warm muted, yellows, greens, teal/water, sky, dark blues, purple); 255 where `reportMask = 0`. |
| `bins` | Uint8Array `H3·W3` | `analyze.bins` | 0…76 (`analyze.NBINS=77`): chroma/10 (0…5) × 12 + hue/30 for chroma ≥ 5; greys separately `72 + clip(L//20, 0, 4)`. |
| `masks` | see PreparedPair §2.2 | — | `reportMask`, `validMask`, `clipMask` reused. |

The neutral-vs-target summary is cached independently of profile edits (recomputed
only when the pair or development changes).

### 4.2 `regionSums` object (the per-frame report DTO, sums not means)

Port of `analyze.region_sums` **extended** per ui-plan Stage 5 with the mean-Lab sums
for the swatches (the Python reference must be extended; do not derive swatches from
unrelated sums):

```
regionSums: {
  n:   f64[10],   # pixels per group (bincount over reportMask pixels)
  de:  f64[10],   # sum dE2000 per group
  dL:  f64[10],   # sum (L_pred − L_target)
  dC:  f64[10],   # sum (C_pred − C_target)
  dh:  f64[10],   # sum hue difference deg, only where target chroma > 8
  nh:  f64[10],   # count of pixels with target chroma > 8 (dh denominator)
  bn:  f64[77],   # pixels per color bin
  bde: f64[77],   # sum dE2000 per bin
  all: f64,       # mean dE2000 over all reportMask pixels
  tLabSum: f64[10][3],   # sum of target Lab per group (swatch)
  pLabSum: f64[10][3]    # sum of predicted Lab per group (swatch)
}
```

Reference values: `analyze.region_sums` gives `n, de, dL, dC, dh, nh, bn, bde, all`;
`tLabSum`/`pLabSum` are the new per-group Lab sums of `srgb_to_lab(target)` and
`srgb_to_lab(clip(pred,0,1))` over the same group masks. `dh` uses
`(h_pred − h_target + 180) mod 360 − 180` wrapped to ±180. Table rows shown when
`n[i] ≥ max(0.01·Σn, 20)` (`analyze.REPORT_SHARE`, `region_line`); hue shown only
when `nh[i] > 20`.

### 4.3 Report object

```
report: {
  ...envelope (kind: "report", id = versionId + ":" + pairId or "aggregate"),
  strength: int,                    # 0..150, the strength the report is computed at
  summary: {
    renderDE: f64,                  # mean dE2000 prediction vs target (regionSums.all)
    neutralDE: f64,                 # mean dE2000 neutral vs target (cached, independent of edits)
    binMean: f64,                   # analyze.bin_mean(regionSums, min_n=50)
    fittedDelta: f64 | null         # step 3.1: renderDE − fitted-version renderDE; null at step 2 draft
  },
  table: [ {group: string, share: f64, n: int,
            targetLab: [f64,f64,f64], renderLab: [f64,f64,f64],   # means = sums / n
            dE: f64, dL: f64, dC: f64, dh: f64 | null} ],        # one per group above REPORT_SHARE
  aggregate: { ...regionSums-shaped totals..., table: [...] } | null,   # analyze.total over included pairs
  parameters: {                     # NP3 parameters view
    base: control-object (§3.3),    # the version control at 100%
    result: control-object,         # strength applied (port of strength.scaled)
    deltas: {...} | null            # vs previous version after refit
  },
  maps: {                           # per-pixel metrics, reportMask pixels only
    dE:  Float32Array H3·W3,        # C.de2000(pred, target), NaN where masked out
    dL: Float32Array, dC: Float32Array, dh: Float32Array,
    mode: "dE" | "dL" | "dC" | "dh"
  }
}
```

`aggregate` = `analyze.total`: element-wise sums of all `regionSums` fields,
`all = mean of per-frame all`; its `binMean` uses the same `bin_mean`.
`bin_mean` = mean over bins with `bn ≥ 50` of `bde/bn`, NaN when no bin qualifies.

### 4.4 JSON download format

Versioned, self-contained, file-name only (matches ui.md "summary, table, parameters,
file names"):

```json
{
  "schemaVersion": 1,
  "kind": "report",
  "generator": "np3-fit web <git describe>",
  "files": {"raw": "...", "target": "..."},
  "version": {"id": "draft", "name": "...", "strength": 100},
  "summary": {...}, "table": [...], "aggregate": {...},
  "parameters": {"base": {...}, "result": {...}, "deltas": {...}}
}
```

No pixel maps in the download (too large); sums/means only.

## 5. Python reference map and golden fixtures

### 5.1 Which Python functions produce each reference

| Schema data | Python producer |
|---|---|
| `x, y, ncc, transform.scale/radialK` | `devpairs.build(nef, target, devignette=True)` |
| transform components (`orientation`, `crop`, `lensRadial`, `radialScale`, `warpScale`, `shiftX/Y`) | internals of `devpairs.build` (`oriented`, `lens_corrected`, `matched`) — **fixture generator must re-export these** |
| `vignette {a,b}` | `vignette.coefficients` |
| `gain`, `gainNote` | `match.edit_gain` |
| check metadata | `match.edit_warnings`, `analyze.adl`, `render.linear`/rawdev error |
| `analysis` block | `analyze.frame`, `analyze.shares`, `analyze.verdict` |
| masks | `match.sample` keep-rule, near-white rule, `analyze.region_sums` mask (derivable from `y`) |
| sampled fit data (indices `pick/mult/test`, `b`, `t`, `tlab`, `W`) | `match.Matcher.pair` + `match.sample` with fixed seed 0 |
| `fitVector`, `cost` | `match.Matcher.fit` (zero init) |
| `control` | `match.control` |
| `regionSums` | `analyze.region_sums` (extended with `tLabSum/pLabSum`) |
| summary/aggregate | `analyze.bin_mean`, `analyze.total`; neutral side: `region_sums(dev(x·gain), t)` |
| coverage/suggest/recommend (stage 7) | `analyze.coverage/suggest/lift_median/verdict/recommend`, `match.coverage/sky_share` |

### 5.2 Minimal fixture set (extends `web/golden/`, registered in `manifest.json`)

**Stage 0 inputs** (small, synthetic where possible): 2 JPEG + 2 TIFF targets; XMP
variants: none / WB+exposure edits (`Temperature`, `Tint`, `Exposure2012`) /
crop+angle / `MaskGroupBasedCorrections` / `PostCropVignetteAmount`+`GrainAmount`;
ICC non-sRGB; EXIF orientations; clipped (>30% white) and grainy/vignetted frames.
Names: `target/<case>.jpg` + `target/<case>.json` (parsed XMP/check metadata).
Per §8 the browser consumes the JPEG cases only; the TIFF cases stay as Python-side
reference (the CLI accepts TIFF unchanged).

**Stage 2 — prepared pair**, three real pairs covering good / warnings / blocked
(`ncc < 0.6`):

- `pair/<key>.x.f32`, `pair/<key>.y.f32` — `H3·W3·3` float32 (~256×171×3 ≈ 525 KB
  each), optionally brotli like `raw/*.f32.br`;
- `pair/<key>.masks.u8` — 4 planes (clip, report, valid, nearWhite) packed,
  `4·H3·W3` bytes;
- `pair/<key>.json` — envelope, `size`, `ncc`, full `transform`, `vignette`,
  `gain`, check metadata, `analysis` block;
- `pair/<key>.meta.json` (debug only) — Python component dump (orientation, crop,
  lensRadial) so a mismatch is attributable to one stage.

Two pairs suffice for the fit (see below) if one is reused as the blocked case.

**Stage 3 — sampled data + fit**, on 1–2 of the stage-2 pairs (keeps fixtures small:
sampled arrays ≈ 4800×3):

- `sample/<key>.json` — `pick`, `mult`, `test` (int arrays), `b`, `t`, `tlab`, `W`
  as `.f32` sidecars, plus shared `freq` (77) and `trust`; reference =
  `Matcher(seed=0)` internals. This decouples sampling (PRNG, see §6) from the solver.
- `fit/single.json`, `fit/two.json` — `fitVector` (56), `cost`, `iterations.costs`,
  `scores`, `control` JSON; reference = `Matcher().fit` on the sampled pairs.
- `lm/synth.json` — 2–3 small synthetic residual functions (flat, singular,
  well-conditioned) with `x0`, `x*`, `cost` for focused solver tests (`fit.lm`).

**Stage 5 — report**, on one stage-2 pair at two versions (neutral and a fixed fit):

- `report/<key>__{neutral,fit}.json` — full `regionSums` (both Python and extended
  swatch sums), `summary`, `table`;
- `report/<key>__cache.f32` + `__labels.u8` + `__bins.u8` — the §4.1 per-pixel cache;
- `report/aggregate.json` — `analyze.total` over the two pairs;
- `report/report_download.json` — the exact §4.4 download document.

Existing levels 1–8 tolerances (`web/golden/manifest.json` `TOL`) are not relaxed by
any of this.

## 6. Browser-vs-Python equivalence gaps (need tolerance or approximation)

1. **RAW decoder.** `rawdev.develop` uses LibRaw `dcraw_emu`; the browser WASM
   decoder (rawler) differs slightly. Already covered by level-1 tolerances
   (`raw_nef max 16/65535`); propagates into `x`, vignette coefficients and
   everything downstream.
2. **Resampling filters.** `devpairs`/`pairs` use PIL LANCZOS (target), BOX
   (shrinks), BILINEAR (warp, radial), BICUBIC (crop rotate). The browser must port
   these kernels exactly (do not substitute canvas/`createImageBitmap` scaling);
   expect last-bit differences → compare `x`/`y` with max tolerance ≈ 1/255 and
   `ncc` within 1e-3.
3. **EXIF orientation of the target.** JPEG: PIL does not auto-apply it; `createImageBitmap` defaults to `imageOrientation: "from-image"`. Decode with `{imageOrientation: "none"}` to match Python. **TIFF (found 2026-11-19): the opposite** — Pillow 13 auto-applies orientation on `Image.open` and drops tag 274, so the Python reference sees the TIFF already transposed; the browser must apply TIFF orientation itself (and not apply it a second time if the decoder already did). If the two are mixed up the align search compensates silently and the geometry fixtures fail.
4. **PRNG in sampling.** `match.sample` uses `np.random.default_rng(0)` (PCG64 +
   numpy's `choice` algorithms); a JS `Math.random` port cannot reproduce it. The
   fixtures ship the sampled indices and the browser solver consumes them for
   golden comparison (§6.4 option b, chosen 2026-11-19); free sampling is validated
   only through the final quality bar (no region worse than Python by > 0.1 dE).
5. **Development trust density.** `devmodel.load_density()` reads
   `data/devmodel_density.npy`, which is **not committed** and does not exist in the
   reference working copy — so the reference `match.Matcher` runs with
   `density=None` → `trust = 1` everywhere (`devmodel.Dev.trust`). **Decision
   (2026-11-19):** the browser port and all fixtures run with `trust = 1`; the
   density export to `web/model/` is not needed. If the density file is ever
   committed, export the 17³ float32 (≈19 KB) in `export_model.py` and regenerate
   the fixtures.
6. **WB map.** ~~`data/wbmap.json` (5×2 weights) is not in `web/model/`~~ Done
   2026-11-19: exported by `export_wbmap()` in `web/export_model.py` to
   `model/wbmap.json`; `features = [1, m, m², tint, tint·m]`, `m = 1e6/temp`,
   `predict = features @ w` — exact in JS.
7. **Dense solver.** `np.linalg.solve` (LAPACK) vs the JS pivoted dense solver:
   expect cost agreement within ≈1e-6 relative and vector differences within the
   level-9 tolerance; solver tests on `lm/synth.json` must include singular/flat
   Jacobians (`fit.lm`'s diagonal lower bound `1e-4·max(diag)` must be ported).
8. **Rounding in `match.control`.** Python `int(round(v))` is half-to-even; JS must
   implement banker's rounding or controls will differ by 1 on exact halves.
9. **Vignette coefficients** are fit from the embedded JPEG at runtime
   (SHRINK=6, `vignette.estimate`); small decoder/resampling differences make
   (a,b) approximate → tolerance on `vignette.a/b` (±0.05) and downstream `x`.
10. **ADL string.** `analyze.adl` shells out to exiv2; the browser reports `"?"`
    unless the RAW decoder exposes `Exif.Nikon3.ActiveDLighting` — the schema allows
    this (§2.4), no numeric impact.
11. **`validMask` has no Python reference** (§2.2): all-ones in the generated
    fixtures (§6.11 decision 2026-11-19), excluded from equality assertions until
    warp-source tracking is added.
12. **ICC normalization quirk (found 2026-11-19).** `pairs.to_srgb` decides
    "is this sRGB" by the ICC **description string** (`"sRGB" in description`), not
    the actual gamut. The browser port must reproduce this literally, quirks
    included, or targets with non-sRGB description strings diverge.

## 7. Module APIs (Stage 1+)

Pure functions take `Uint8Array`/plain data and run in Node and Workers (the level-1
convention); DOM/codec-dependent decoding is a thin wrapper. Each function names its
Python counterpart — behavior must match it, quirks included (§6).

### 7.1 `web/lib/target.js`

| Function | Python counterpart | Notes |
|---|---|---|
| `parseXmp(xmpBytes) -> object` | `pairs.xmp_values` | Regex `(?:crs\|tiff):(\w+)="([^"]*)"` over the packet + `_masks` as a bare substring test. Pure. |
| `extractXmp(fileBytes, format) -> Uint8Array \| null` | PIL `im.info["xmp"]` | JPEG: APP1 `http://ns.adobe.com/xap/1.0/` segment; TIFF: tag 700. Pure. |
| `extractIcc(fileBytes, format) -> Uint8Array \| null` | PIL `im.info["icc_profile"]` | JPEG: APP2 `ICC_PROFILE`; TIFF: tag 34675. Pure. |
| `iccDescription(icc) -> string \| null` | `ImageCms.getProfileDescription` | Pure; used for the sRGB-by-description decision. |
| `isSrgbDescription(desc) -> bool` | `"sRGB" in desc` in `pairs.to_srgb` | The quirk of §6.12, literal. |
| `iccToSrgbMatrix(icc) -> {m: number[9], gamma...} \| null` | littleCMS `profileToProfile` for matrix-shaper profiles | Parses v2/v4 matrix profiles (r/g/b XYZ + TRC curves); returns `null` for LUT-based profiles so the caller falls back to browser CMS. Pure. |
| `wbMultipliers(rawBytes) -> [logRG, logBG]` | `wbmap.multipliers` | DNG `AsShotNeutral` (tag 0xC628) / NEF MakerNote `WB_RBLevels` (tag 0x0C); the same IFD walking, endianness included. Pure. |
| `editGain(xmp, multipliers \| null) -> {gain: [r,g,b], note: string \| null}` | `match.edit_gain` | `gain = exp(predict(wbmap, T, Tint) − multipliers)` on R,B × `2^Exposure2012`; `note` composed exactly like Python (`"WB 6500 K, +12 (R x1.032, B x0.981), exposure +0.50"`). Pure. The 5×2 wbmap weights are pure-module state: `setWbMapWeights()` (from `web/model/wbmap.json`) or an optional third argument — no fetch inside the module. |
| `editWarningCodes(name, size, xmp) -> code[]` | `match.edit_warnings` | Returns structured codes (`small_target`, `no_lr_settings`, `masks`, `vignette`, `grain`) with parameters; the main thread localizes via `t()`. A `formatWarning(code)` produces the exact Python English string for golden tests. Pure. |
| `exifOrientation(fileBytes, format) -> int` | PIL behavior per §6.3 | JPEG: raw tag (PIL does not apply it); TIFF: applied by PIL — the decoder wrapper must return pixels already transposed plus the raw tag. Pure parse. **Browser accepts JPEG targets only (§8 decision 2026-11-19); the TIFF branch stays in the Python CLI and is not ported beyond what the pure parser needs.** |
| `decodeTarget(file) -> {width, height, rgb: Float32Array, ...}` | PIL decode + `pairs.to_srgb` | JPEG via `createImageBitmap(..., {imageOrientation:"none"})`. Applies ICC normalization (JS matrix path, browser-CMS fallback). **JPEG only — a `.tif` input is rejected with a clear message.** DOM/codec wrapper. |

`adl` is reported as `"?"` until the RAW decoder exposes
`Exif.Nikon3.ActiveDLighting` (§6.10).

### 7.2 Later modules (fixed names, APIs recorded when implemented)

`pair-prepare.js` (Stage 2), `fit.js` (Stage 3), `analyze.js` (Stage 5),
`report.js`, `session.js`, `compare-view.js`, `report-view.js`,
`pair-worker.js`, `fit-worker.js` — see ui-plan.md §3 for ownership.

## 8. TIFF decoder decision (2026-11-19)

**Superseded the same day: TIFF is not accepted in the browser interface at all.**
Decision (user, 2026-11-19): the UI loads JPEG targets only — nobody loads TIFFs into
a browser; TIFF pairs remain fully supported by the Python CLI (`match.py`/
`devpairs.py`). No browser TIFF decoder is implemented; `web/lib/target.js` is
JPEG-only. The investigation below stays as the record should the decision be
revisited.

Investigation summary: all 4259 real project TIFFs are a single flavor — classic
TIFF 42, little-endian, 8-bit, uncompressed (tag 259=1), photometric RGB (262=2),
3 samples chunky (277=3, 284=1), single full-height strip, no predictor/tiles/alpha.
NX Studio exports add explicit orientation=1 + ICC tag 34675 + XMP tag 700;
Lightroom exports omit orientation and carry different ICC/XMP. Both real ICC
profiles ("Nikon sRGB 4.0.0.3002", "sRGB IEC61966-2.1") take the `to_srgb`
description-string pass-through (§6.12).

The decoder:
- IFD parser is a JS port of `wbmap.tiff_ifd` (types 1,2,3,4,5,7,10, the ≤4-byte
  inline rule), first IFD only.
- Reads tags 256, 257, 258, 259 (assert 1), 262 (assert 2), 273, 277, 278, 279,
  284 (assert 1), 274, 34675, 700; rejects 317 (predictor), 322–325 (tiles) and
  anything else outside the subset with a clear "unsupported TIFF variant" error —
  never a silent fallback.
- Pixel decode = concatenating strips (in practice one `subarray`) — bit-faithful
  by construction, no tolerance spent on the decoder.
- Applies orientation 274 itself (all 8 variants; PIL auto-applies for TIFF, §6.3).
- Browser-native decoding is not viable (Chrome/Firefox do not decode TIFF);
  vendoring UTIF.js/geotiff.js is the documented fallback if compressed/16-bit TIFFs
  ever become in-scope.
