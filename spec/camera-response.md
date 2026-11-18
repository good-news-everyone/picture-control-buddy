# What is measured about the processing

All measurements on the Z f, NX Studio 1.11, the `out/pack1/chart.png` chart shot off the screen (`DSC_6754.NEF`, ISO 1000, 1/30, f/8, ADL Off).

## NP3 settings response

| Setting | Behavior | Evidence |
|---|---|---|
| Curve | Changes only Y' Rec.601, leaves Cb and Cr alone | The model gives dE 0.55, a per-channel one 2.8 |
| Curve on grey | Matches the given function in encoded sRGB | The difference is about 0.005 |
| Identity curve | Matches neutral | dE 0.03 |
| Blender | Linear in the slider value | A half-value probe predicted with dE 0.22 |
| Blender, plus and minus | Different tables | Symmetry gives dE 1.65 |
| Saturation | Nonlinear | At -22 the response is about half of linear. Not used in the fit |
| Several settings at once | The sum is approximate | Control probe 28: dE 2.6 vs 6.9 for neutral |
| Curve and color order | The difference is small | Curve first 2.57, last 2.97 on probe 28 |

## Response on frames, the `sweep.py` pack

NX exports: 10 frames, 120 profiles, 1512 px, comparison at 378 px. The models are fed the real NX neutral, so the development error is not included.

| Group | Probe | On-screen chart model dE | No model dE |
|---|---|---|---|
| Curve | 60 | 0.45 | 4.23 |
| Blender ±20 / ±40 / ±60, hue | 40 per level | 0.91 / 1.59 / 2.29 | 1.48 / 2.79 / 4.10 |
| Blender, chroma | 40 per level | 0.76 / 1.29 / 1.89 | 1.11 / 2.01 / 2.97 |
| Blender, brightness | 40 per level | 0.64 / 0.98 / 1.36 | 0.98 / 1.71 / 2.45 |
| Highlight / midtone / shadow grading | 80 each | 1.21 / 2.14 / 1.09 | 5.41 / 9.12 / 3.72 |
| Random combinations | 500 | 4.30 | 10.41 |
| FIT4 / PORTRA / FUJI | 10 each | 2.53 / 1.64 / 1.38 | 10.36 / 6.67 / 4.76 |

- The on-screen chart response of the blender and grading underfits already at one slider, the error grows with the level.
- The curve is computed exactly. 0.45 is close to the NX noise threshold.
- Two exports of one profile differ: 0.58-0.63 dE at 756 px, 0.28 at 189 px, the mean shift is zero. The cause is not found.
- Exporting in NX takes about 3 s per file: 1200 files in 65 minutes.

## How NX combines sliders

Pairs of the second pack against the sum of two single probes of the first, level 40, 5 frames. Threshold: two neutrals of different packs differ by 0.41, across three shots the noise is about 0.6.

| Pair | Sum in sRGB | Sum in LCh: hue adds, chroma multiplies |
|---|---|---|
| Hue and brightness, chroma and brightness of one color | 0.60-0.65 | 0.61-0.71 |
| Neighboring colors, sets A and B | 0.57-0.68 | 0.61-0.73 |
| Hue and chroma of one color | 0.81-1.46 | 0.68-0.83 |
| All three attributes | 1.06-1.67 | 0.83-1.05 |
| Blender and curve | 0.60-0.63, curve before or after 0.44-0.55 | |
| Grading of two zones | 0.58-0.79 | 2.36-11.7 |
| Blender and grading | 0.93-1.85 | 1.07-2.70 |

- One slider is linear in the level: |d40|/|d60| 0.66-0.67, |d20|/|d60| 0.33-0.35.
- The blender works as a hue rotation and a chroma scale, grading is added in RGB, the curve is independent.
- The blender with grading does not add up either way. The step order in the model does not affect the result, the cause remains.

## Blender color sectors

The chart columns by response minima (24 columns around the hue circle):

| Color | Columns |
|---|---|
| red | 0-2 |
| orange | 2-5 |
| yellow | 3-8 |
| green | 6-10 |
| cyan | 9-16 |
| blue | 11-21 |
| purple | 17-23 |
| magenta | 22, 23, 0, 1 |

The sectors are unequal and partially overlap. Probe sets: A (red, yellow, cyan, purple), B (orange, green, blue, magenta).

## Detail: Clarity, Sharpening, Mid-range sharpening

The model in `detail.py`: dY' = value * sum_sigma g_sigma(Y') * (Y' - Gauss_sigma(Y')), lightness only, after color and curve.
Radii sigma in full-frame pixels (6048), the g table over tone is separate for plus and minus, separately per export scale.

| What | Result | Evidence |
|---|---|---|
| Clarity, radius | A sigma pair 56 + 180 px of the full frame; a single 112 px mask is almost the same (1.09 vs 1.10). At full size it raises all bands from 1 to 128 px | The tools pack, 1512 px, 10 frames, ±2 and ±5; the detail pack, 4 frames at full size |
| Clarity, tone | The gain grows almost linearly with Y' (0.02 per unit in shadows, 0.10 at Y' 0.8) and fades at clipping | A table by the pixel's Y' is better than by the blurred Y': R^2 0.82 vs 0.73 |
| Clarity, level and sign | Linear in the slider, plus and minus symmetric, light and dark edges the same | Separate tables do not improve the validation |
| Clarity, chroma | Cb and Cr change at the export-noise level | rms 0.002-0.003, as between two exports |
| Clarity, dE | ±2: 1.22 -> 1.02, ±5: 2.0 -> 1.2 | NX noise between two neutral exports at 1512 px: dE 1.0, Y' rms 0.008 |
| Clarity, response share | 84% (x4), 90% (x2) | On held-out frames, by Y', net of export noise |
| Mid-range, bands | An even rise ~0.06 per unit from 0.5 to 16 px, at +5 another 0.26 in the 16-32 px band, almost zero above 32 px. Minus is weaker than plus: 0.23 vs 0.37 at ±5 | The detail pack, IV over two neutrals, full size |
| Mid-range, model | sigma 12 px (x2), 16 px (x4); explained 78% and 85% | Held-out frames |
| Sharpening, bands | A narrow band at sigma 0.5-1 px of the full frame, does not lift the finest (< 0.5 px). The per-unit gain is 0.82 at +1, 0.60 at +9 | Full size, IV |
| Sharpening, nonlinearity | At x2 the per-unit gain is 0.34 / 0.33 / 0.30 / 0.27 at +1 / +3 / +6 / +9; at small edges 0.67 of the peak, at the strongest edges 0.78; the peak by tone is around Y' 0.4. Minus is a blur of -0.42...-0.65 independent of the edge | IV, bins by level, |hp| and Y' |
| Sharpening, model | sigma 1.4 px (x2), 0.5 px (x4); explained 53% and 37%. A table by edge magnitude and a quadratic term by level are worse or the same on held-out frames | Cross-validation by frames |

- The noise of two NX exports at 1512 px (NEUTRAL of the tools and colors packs): dE 0.98-1.04 on 4 frames. Below this the detail model cannot be validated.
- **NX export noise.** Every export gets its own random noise: two identical full-size neutrals differ by Y' rms 0.019, at x2 by 0.0098 per export (dE 1.76 between exports), at x4 by 0.0059 (dE 0.99). Independent of tone and edges. This explains the previous 0.58 dE between two exports. So the fit uses instrumental variables (features from NEUTRAL, instruments from NEUTRAL-B and vice versa), prediction and validation from their mean, and the response share is computed net of 1.5*sigma^2 of the noise.
- The noise enters before sharpening, not after: on SHAM3 the model residual (rms 0.0148 at full size) is below the noise of two neutrals (0.0167), minus Sharpening blurs it. Plus raises the noise weaker than the linear filter. So on the Sharpening probes the unexplained share is mostly this noise, and the sharpening model cannot be validated more precisely on this data: at full size a linear band model explains only 24% (SHAP9), at x2 — 46%.
- **Our development vs the NX neutral at x2** (DSC_6456, DSC_6000, frame center): the Y' band energy from 0.5 to 16 px matches the NX export together with its noise within 10%. Against NX without noise we have more fine detail: x1.2-1.4 in the < 0.5 px band, x1.1-1.3 in 0.5-1 px, then 1.0. This is the half-development sensor noise; by visible sharpness the neutrals match, and a sharpening mask on our render gives the same order of effect.
- Pixel-exact matching with the NX export is limited by geometry: NX corrects distortion, on DSC_5966 the dY' correlation is 0.5 at the same amplitude, on DSC_6522 0.9.
- Frames for sharpening probes are chosen by focus sharpness on the half development (a thin sigma 0.7 strip on the most textured tiles, net of the flat-area noise). The 1512 px export texture does not show it: DSC_6008 and DSC_5966 look textured there, but by sharpness they are 71st and 68th of 71. For Clarity this does not matter, the radius is large.
- In the `detail.py` report the response share is not shown ("in noise") if a probe's response is below a quarter of the export noise: on SHAP1, MIDP1 and weak minuses it jumped from -115% to 227%.
- A code check on a synthetic full-size pack: the given sigmas 1.0 and 112 px and their tables were recovered; a 1 px mask after a 4x shrink is invisible and is stored as zero.

## Camera and NX Studio

- Against the neutral the embedded JPEG differs from NX by dE 0.96.
- With the FIT4 profile on three frames: 0.97.
- So measurements in NX Studio transfer to the camera.

## Active D-Lighting

- ADL is applied in NX Studio when rendering a NEF shot with ADL.
- It changes lightness differently on different scenes, it cannot be compensated in NP3.
- The effect on FIT2: dE 7.23 with ADL and 5.13 without it, the shots are 5-7 L* brighter than the target.
- To match Lightroom, ADL must be off for shooting and rendering.

## The on-screen chart: what it does not show

- The brightest patch is only at 42% of the sensor saturation, the real highlights are not measured.
- 28 of 216 patches are partially clipped, these are light greens, cyans and blues. It looks like individual pixels land on bright screen subpixels. The cause was not checked.
- The chart's grey is not neutral, b* from -8 to -9.
- Screen colors differ from real-scene colors: FIT2 gave 3.06 on the chart, 5.13 on the photo.

## NEF development to neutral

- The embedded JPEG is not suitable for this: it has the shooting profile and ADL.
- Matrix and curve from the chart: dE 4.82.
- Matrix and curve from 35 frames: 2.22 on held-out frames.
- With a residual 3D LUT: 17 knots 1.89, 25 knots 1.85, 33 knots 1.86.

## Lightroom

- Temperature and Tint are related to the camera's WB_RBLevels. Over 21 As Shot frames the log(R/G) and log(B/G) error is about 0.004.
- Features: 1, mired, mired^2, tint, tint*mired.
- Georgia was shot with the PC profile `KEktr-100-skinfixG2`, the validation shots with `Modern Chrome Hi g2`, so their embedded JPEGs are not neutral.

## Geometry

- NX Studio applies distortion correction. On some lenses the scale reaches 1.07 and the radial coefficient up to ±0.08, a plain scale is not enough.
- The embedded JPEG is already corrected by the camera and uncropped, so it can be used as a geometry reference.

## Structural ideas from third-party code

From the firmware-derived sources of jolchmo/Z30 only the idea was taken: the response is linear in the slider, the plus and minus tables are separate, tables over tone. Linearity is confirmed by our probes. Nikon's own tables must not be taken into the project: rights not confirmed.
