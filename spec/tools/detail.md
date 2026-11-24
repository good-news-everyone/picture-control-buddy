# detail.py

The detail model: Clarity, Sharpening and Mid-range sharpening — spatial filters over the Rec.601
Y' luma in encoded sRGB, leaving chroma untouched. Empirical, from NX Studio probes
(`spec/camera-response.md` has the measurements).

## Usage

```
python3 detail.py collect tools     # renders/sweep/tools exports -> data/detail_tools.npz (scale 4)
python3 detail.py collect detail    # renders/sweep/detail exports (full size) -> data/detail_full.npz
python3 detail.py                   # train -> data/detail_model.npz and a dE report
```

## How it works

The model: `dY' = value * sum_sigma g_sigma(Y') * (Y' - Gauss_sigma(Y'))` — a tone-weighted
high-pass at one or two radii. Radii are given in pixels of the full Z f frame (6048 on the long
side) and divided by the working scale; the gain table `g_sigma` over the source pixel's tone is
separate for plus and minus and is trained per export scale separately (after shrinking, a
small-radius mask is not the same as radius/k). Trained per tool from the `detail_*` collections
by instrumental variables (two neutrals `NEUTRAL`/`NEUTRAL-B` of the pack instrument each other,
net of the NX export noise). A tool at a scale that does not improve the Y' error by at least 2%
of the export noise is stored as zero there.

The step runs after color and curve and is applied only in `render.py`/`ui.py`
(`Renderer.apply(..., sharp=True)`), not in fitting.

## NX base detail (`python3 detail.py base`, spec/ui.md decision #18)

NX Studio's own export is crisper than our development at the same size even with Sharpening,
Mid-range and Clarity at 0. On the 10 `NEUTRAL` exports of the `tools` pack (1512 px, scale 4) the
NX / ours amplitude of Y' is 1.0 below 0.2 cycles/px and rises in the top octave to 1.06-1.47 at
Nyquist (geometric mean 1.21). A full AHD demosaic shrunk with Lanczos is no crisper than our
half-size development, so this is NX's resampling / its own detail step. Part of it is NX export
noise (two exports of one frame differ; on DSC_6456 at full size shrunk x4 the noise is 34-43 % of
the signal amplitude at 0.3-0.5 cycles/px), so the extra detail is mostly not coherent with ours:
a filter matches the look (the amplitude), not the pixels.

The `base` part of `data/detail_model.npz` is that filter in the Part form: value 1, a constant
gain table, at the Sharpening x4 radius (`BASE_SIGMA` = 0.5 full-frame px), fitted by least
squares to the geometric-mean amplitude ratio over `BASE_FREQS`: gain 2.70 (leave-one-frame-out
2.27-2.95). After it the per-frame ratio at Nyquist is 0.88-1.22 (before 1.06-1.47). It applies only
within `BASE_RANGE` (x1.5) of the measured scale, i.e. to the 1512-1600 px frames of the web pages
and `render.py`; other scales are unchanged. `Detail.__call__(..., base=True)` adds it;
`render.Renderer.apply(sharp=True)` and the web `Renderer.render` pass base, the level-6 fixtures
test both (`make_golden.DETAIL_BASE`). `python3 detail.py` (retraining the tools) keeps the trained
base part.

    python3 detail.py base    # renders/sweep/tools/*-NEUTRAL.NEF + .TIF -> the base part (needs dcraw_emu)

## Data

Needs the `tools` pack exports (via `sweep.py extract tools` equivalent — `collect` reads
`renders/sweep/<name>/tif`) and the full-size `detail` pack (export TIFF at full size in NX).

## Fitting the detail tools (research, then the fit engine, 2026-11-24)

Scripts and how to rerun: `research/detailfit/README.md`. Measured against real NX exports of SA
frames (fitcheck NEW4 at 1512 px; full-size packs `detailcheck`, `detailcheck2`) and LR targets.
NX and LR geometry match exactly at x4 (scale 1.000, no shift on 12 frames); at full size the local
shift is up to ±2 px (lens correction), so full-size work aligns per 768 px crop.

- **Clarity and Mid-range at x4: coherent band regression** (sigma 1.4-45 px at x4) of the target
  Y' on LUT(NX Y') + sum v·H_tool, the LUT fitted jointly. A LUT fitted first soaks up about half of
  Clarity (band energy ratios: +2 -> 1.5, +5 -> 3.0). On NX probes the joint form recovers Clarity
  +2 as 2.0-2.3 and -5 as -4.5..-5.2 with Mid-range near 0.
- **Sharpening only from full size or x2.** NX's band transfer of Sharpening hardly depends on the
  frame (band 0-0.5 px: S0 0.63-0.69, S4 1.28-1.33, S6 1.48-1.58 of S2), so a per-band table is
  enough. Gains use a repeat export as the instrument: target / NX = <T, X2B> / <X, X2B>.
  NX Sharpening also lifts the 2-4 px band (S6 +7..+9 %).
- **SA preset** (LR Clarity +2, Sharpening 40): Clarity +0.23, Mid-range +0.43 (10 frames,
  leave-one-out 0.18-0.28 / 0.36-0.46), Sharpening +1.5..+1.8 at ISO 100: the defaults are within
  1-5 % amplitude. Higher ISO reads as more Sharpening (ISO 800 +2.5, ISO 3200 +4..+5): LR Luminance
  NR 0 against NX's noise reduction, not sharpening. Night frames pull Clarity negative (LR's local
  adaptive operations).
- **LR variants on 4 frames** (SA + one change): Clarity +50 -> Clarity 1.0 / Mid 1.5;
  Clarity -40 -> Clarity -2.75 / Mid 0.25; Texture +50 -> Mid 2.1, Clarity ~0; Sharpening 150 ->
  Sharpening ~+7.7 / +7.1 / +5.0 in the 0-0.5 / 0.5-1 / 1-2 px bands (ISO 100).
- **Checked with NX renders of the fitted values** (`detailcheck2`), x4 band residual vs NEW4:
  Clarity -40: -38..-42 % on all frames, full-size band gains 0.65-0.82 -> 0.82-1.01; Clarity +50:
  -2..-6 %; Texture +50: -1..-6 % (LR's positive Clarity and Texture lift 1-8 px more than the NP3
  tools can); Sharpening 7: the finest band matches (0.98-0.99), 1-4 px overshoot by 11-15 %.
- **In the engine** (`detailfit.py`, `web/lib/detail-fit.js`; `match.py` and the wizard, spec/ui.md
  decision #19): Clarity and Mid-range after the color fit, on our render of the fitted profile
  (match.py: 1536 px from the half-size development, detail applied on the grid; the wizard: the
  1600 px compare grid). Production form of the regression: the Young-van Vliet recursive Gaussian
  with q solved for the exact variance (the paper's q(sigma) is 10-25 % wide), band sigma 5.6-179
  full-frame px, a cubic tone term per pair instead of the 16-knot LUT, each pair normalized by its
  band energy, signs enumerated, values rounded to 0.25 within ±5. On the research data it matches
  the research form: NX probes Clarity +2 -> 2.0, +5 -> 5.0, -2 -> -1.75, -5 -> -4.75; SA 12 frames
  0.0 / 0.5; the LR variants 1.0 / 1.25, -3.0 / 0.25, -0.25 / 2.25.
- **Calibration (`CAL`, `CAL_WEB`).** Our renders carry more band contrast than NX's render of the
  same profile: fitted against NX's NEW4 exports the uncalibrated step returns Clarity +0.25 /
  Mid-range +0.05 (match.py, 7 frames) and +0.23 / -0.20 (wizard, 12 frames) instead of 0 / 1
  (medians; spread about ±0.4, the night frame -2.2). The excess is taken out as plus-table
  responses: `CAL` = (-0.25, +0.95), `CAL_WEB` = (-0.25, +1.2). With it the wizard on the 4 LR
  variant frames gives SA -0.25 / 1.0, Clarity -40 -3.25 / 1.0, Clarity +50 0.75 / 1.75,
  Texture +50 -0.5 / 2.75 — Clarity within 0.25 and Mid-range within 0.5 of the fit on NX's renders.
- **Not yet:** Sharpening together with Mid-range on x2 / full-size bands of the target (one
  Sharpening value cannot follow LR's band shape); a robust joint over frames; fine bands only from
  low-ISO frames. The web render is at most x2, so Sharpening needs a calibration of our x2 render
  against NX x2 (re-export `detailcheck`).
