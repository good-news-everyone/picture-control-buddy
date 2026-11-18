# Results

dE2000 to the target. Target: the finished exports of the preset (Astia Look base, contrast/highlight/HSL/grading edits).

## Georgia: the ceiling on 60 frames

Held-out frames, targets with individual edits.

| Variant | dE |
|---|---|
| Embedded JPEG with KEktr | 7.86 |
| Plus own WB and exposure | 5.46 |
| Plus a shared profile, approximate NP3 model | 5.14 |
| Plus a shared 3D LUT | 5.20 |
| Own LUT per frame | 3.18 |

Conclusion: KEktr is almost at the ceiling, the difference from `gain` is -0.32 [-0.52, -0.08]. The main difference comes from per-frame edits. After this, a tilted-crop bug was found; the table was not recomputed.

## Manual fitting

Chart: 188 patches without clipping.

| Version | Chart, render | Prediction | Frames, render |
|---|---|---|---|
| Neutral | 9.58 | — | 10.89 on 11 frames |
| FIT1 | 3.73, p95 6.99 | 3.67 | — |
| FIT2 | 3.06, p95 5.78 | 3.19 | 7.23 with ADL, 5.13 without ADL (4 frames) |
| FIT3 | 3.20, p95 6.63 | 3.20 | 3.05 (6 frames), 3.20 (8 frames) |
| FIT4 | 2.89, p95 6.09 | 3.04 | 3.16 (8 frames), 3.24 (11 frames) |

Pairwise difference of FIT2 and FIT1 on the chart: -0.67 [-0.89, -0.44].

### FIT3 and FIT4 by frames

| Frame | FIT3 | FIT4 |
|---|---|---|
| DSC_4902 | 4.26 | 3.84 |
| DSC_5118 | 3.02 | 3.05 |
| DSC_6132 | 2.60 | 2.67 |
| DSC_6203 | 3.09 | 3.10 |
| DSC_6456 | 3.34 | 3.59 |
| DSC_6522 | 3.28 | 3.23 |
| DSC_6582 | 2.85 | 2.74 |
| DSC_6702 | 3.15 | 3.05 |

DSC_6582 and DSC_6702 did not take part in the FIT3 fitting. DSC_4902 and DSC_5118 took part in neither.

| Metric | FIT3 | FIT4 |
|---|---|---|
| Reds | 4.50 | 3.33 |
| Bright highlights, target Y 0.75-0.9 | 7.78 | 5.21 |
| Sky, tones 270-315 | 2.60 | 3.15 |
| Blown DSC_4902 (target 5.4%) | 23.9% | 0% |
| Blown DSC_6522 (target 5.1%) | 11.5% | 6.1% |
| Blown DSC_6702 (target 0%) | 1.8% | 0% |
| Skin DSC_4902 | 4.87 | 4.36 |
| Skin DSC_5118 | 3.71 | 3.58 |

## Camera check

`NPF-FIT4`, ADL Off, indoor and night frames, ISO 2800-12800, the profile has not seen them.

| Comparison | 6755 | 6756 | 6757 | Mean |
|---|---|---|---|---|
| Camera JPEG vs NX | 0.97 | 0.83 | 1.11 | 0.97 |
| Camera JPEG vs target | 3.90 | 3.96 | 3.22 | 3.69 |
| NX vs target | 3.72 | 3.80 | 2.97 | 3.49 |

## How many pairs are needed (prediction)

Fitting by k pairs, scoring on the rest. Neutral 10.89, FIT4 by the same model 4.02.

| Pairs | dE | Spread |
|---|---|---|
| 1 | 4.10 | 3.60-4.57 |
| 2 | 3.77 | 3.64-4.01 |
| 3 | 3.70 | 3.56-3.77 |
| 5 | 3.60 | 3.37-3.84 |
| 8 | 3.37 | — |

## The automatic process, real renders

Frames outside the fit. M1 fitted from DSC_6755, M3 from DSC_4902, DSC_6456, DSC_5118.

| Profile | dE | Prediction | FIT4 on the same |
|---|---|---|---|
| M1 | 4.98 | 4.57 | 3.20 |
| M1b, correction by 1 frame | 4.28 | 4.49 | 3.20 |
| M3 | 4.40 | 3.56 | 3.15 |
| M3b, correction by 3 frames | 2.84, p95 6.71 | 3.31 | 3.15 |

| Frame | FIT4 | M1 | M1b | M3 | M3b |
|---|---|---|---|---|---|
| DSC_4902 | 3.84 | 4.39 | 4.19 | 3.90 | 3.47 |
| DSC_5118 | 3.05 | 5.69 | 5.02 | 4.57 | 2.53 |
| DSC_6132 | 2.67 | 4.79 | 3.84 | 4.39 | 2.75 |
| DSC_6203 | 3.10 | 6.80 | 5.67 | 5.17 | 2.94 |
| DSC_6456 | 3.59 | 5.16 | 4.89 | 2.61 | 2.63 |
| DSC_6522 | 3.23 | 4.98 | 4.10 | 4.77 | 3.16 |
| DSC_6582 | 2.74 | 5.89 | 5.21 | 5.39 | 2.83 |
| DSC_6702 | 3.05 | 3.45 | 2.55 | 2.89 | 2.26 |
| DSC_6755 | 3.68 | 3.18 | 2.79 | 3.99 | 2.62 |
| DSC_6756 | 3.88 | 4.13 | 3.57 | 4.14 | 3.18 |
| DSC_6757 | 2.85 | 4.54 | 3.75 | 4.45 | 2.95 |

M3b on all 11 frames 2.85, FIT4 3.24. Neutral tones 2.53 vs 3.14. Reds 6.34 vs 3.40: there was no saturated red in the three pairs. M1 and M3 are yellower than the target, b* from +2 to +4.

## The `--scene` mode (prediction)

There were no other cameras: target exports were distorted (crop, scale, tilt, perspective, 4:3, noise) or neighboring frames were taken. dE on the other frames.

| Case | Blocks | Exact pair |
|---|---|---|
| Different geometry, DSC_6203 | 3.87 | 3.81 |
| Different geometry, DSC_6132 | 3.94 | 4.46 |
| Neighboring frame with people, 4901 -> 4902 | 5.15 | 3.81 |
| Unaligned frame, 5119 -> 5118 (alignment 0.17) | 9.71 | 3.60 |
| Two scenes, 5116 -> 5118 and DSC_6203 | 4.01 | — |

Correction by blocks on three distorted frames: draft 4.34, blocks 3.36, exact correction 3.24.

## The model vs a real render

| What is compared | dE |
|---|---|
| Probe 29, half value | 0.22 |
| Probe 28, everything at once | 2.57 |
| FIT1 prediction on the chart | 2.5 |
| FIT2 prediction with the correction on the chart | 1.33 |
| Prediction from a NEF, FIT4 render, 11 frames | 2.98 |
| Development to neutral on held-out frames | 1.85 |

## The first check on someone else's frame

`test1/DSC_5584`: WB 5450 K, +14 and exposure -0.20 taken out from the XMP. Neutral-vs-JPEG difference 9.06 -> 6.70, shadow grading 44 -> 34, highlight grading 20 -> 14, curve in midtones 121 -> 103 instead of 93. Profiles `out/test1`, `out/test1b`. The take-out was not verified against a real render.

## Z 8, `test2/`, DNG (prediction)

4 frames SKL_3000, 3024, 3027, 3030. LibRaw does not read the NEFs, DNGs from Adobe DNG Converter are read. Without a Z 8 calibration, there is no real render.

| Frame | Neutral, no take-out | Neutral, with take-out | Prediction, all 4 in the fit | Outside the fit |
|---|---|---|---|---|
| SKL_3000 | 9.23 | 7.20 | 4.88 | 6.71 |
| SKL_3024 | 13.53 | 8.84 | 7.51 | 11.13 |
| SKL_3027 | 12.48 | 11.36 | 8.04 | 9.95 |
| SKL_3030 | 10.41 | 12.12 | 6.62 | 8.23 |

Mean outside the fit 9.0. Alignment 0.89-0.97. Profile from all four: `out/skl`.

Fitting by SKL_3030 only (`out/test_nekit_autumn`): neutral 12.23, prediction on the same frame 3.54. The curve reaches white at an input of about 150 of 255.

The per-frame settings of the targets differ:

| Setting | 3000 | 3024 | 3027 | 3030 |
|---|---|---|---|---|
| Exposure | -0.88 | -0.88 | -1.14 | -0.79 |
| Highlights | +65 | +37 | +37 | +21 |
| Shadows | -9 | -30 | -30 | +11 |
| Whites | +19 | +70 | +70 | +70 |
| Blacks | -16 | -16 | -16 | +33 |
| Texture | 0 | +28 | +28 | +28 |
| Clarity | -11 | +12 | +12 | +12 |
| Dehaze | +9 | +39 | +39 | +18 |
| Vibrance | +65 | +70 | +56 | +56 |

Shared: Contrast -25, Saturation +5, own 20-point curve, grain 10, WB Custom.

## DNG check

DNGs assembled from Z f NEF sensor data, uncompressed.

| Check | Result |
|---|---|
| NEF and DNG development | Difference 0 |
| WB from NEF and DNG | Matched |
| Profile fitting | Parameter difference 0.0006 |
| Frame with crop and tilt | Prediction 3.97, NEF 4.09 |
| `--scene` | Works |

## Profile strength (prediction)

FIT4 on the chart, prediction without the render correction. The real FIT4 at 100% gave 2.89.

| Strength | From neutral | To target |
|---|---|---|
| 0% | 0.00 | 9.58 |
| 25% | 2.32 | 7.66 |
| 50% | 4.66 | 5.94 |
| 75% | 7.08 | 4.66 |
| 100% | 9.42 | 4.47 |

The `test_nekit_autumn` curve by strength:

| Strength | Input 94 | Input 148 | Input 174 |
|---|---|---|---|
| 100% | 174 | 254 | 255 |
| 70% | 150 | 222 | 231 |
| 50% | 134 | 201 | 214 |
| 30% | 118 | 180 | 198 |

At 100% `strength.py` reproduces the original profile exactly. Strength was not verified against a real render.

## Z 8, `nekit_examples/`, 8 pairs (prediction)

DNG and JPEG, without a Z 8 calibration, without a real render. `DSC_9253` has no JPEG. Full log: `data/nekit.log`. Processing differs by frame: exposure from -0.09 to +2.37, Dehaze 18-86, Vibrance 42-88. Shared: Contrast -25, Clarity -10 or -11, grain 10-15.

| Frame | Neutral no take-out | With take-out | Own profile | Own on the others | Outside the fit (7 others) | Shared from 8 |
|---|---|---|---|---|---|---|
| DSC_0468 | 10.20 | 9.86 | 4.44 | 13.60 | 9.94 | 8.16 |
| DSC_1091 | 4.22 | 6.57 | 2.42 | 7.52 | 5.67 | 4.96 |
| DSC_1133 | 6.94 | 7.48 | 3.39 | 8.14 | 6.69 | 5.40 |
| DSC_8564 | 8.04 | 8.35 | 5.92 | 7.16 | 7.86 | 7.26 |
| DSC_9526 | 8.92 | 12.18 | 5.23 | 9.42 | 9.14 | 7.68 |
| DSC_9545 | 20.38 | 8.50 | 4.02 | 6.95 | 4.82 | 4.56 |
| DSC_9547 | 10.33 | 8.57 | 4.00 | 7.12 | 5.34 | 5.02 |
| DSC_9916 | 8.17 | 11.30 | 3.44 | 9.39 | 7.48 | 6.34 |

Mean: neutral 9.65 without the take-out and 9.10 with it, outside the fit 7.12, shared profile 6.17. Curves without blowout. Coverage: purple 0, magenta 0.007, red 0.017.

The exposure take-out helped a lot on DSC_9545 (+2.37). On DSC_1091, where only WB is taken out, it got worse: 4.22 -> 6.57. This looks like a shift of the WB relation trained on the Z f.

Profiles: `out/nekit` (shared), `out/nekit_examples_<frame>`.

## Pair triage (prediction)

`triage.py`, own profile per frame, log `data/triage.log`. The Z 8 is computed without its own calibration. "Good" here means a successful fit on its own frame; the transfer to other frames is not checked.

| Frame | Neutral | NP3 | Own LUT | Verdict | Reason |
|---|---|---|---|---|---|
| DSC_1091 | 6.57 | 2.42 | 2.05 | good | |
| DSC_1133 | 7.48 | 3.39 | 1.52 | good | blender at its limit |
| DSC_9916 | 11.30 | 3.44 | 2.99 | good | few colors |
| DSC_9547 | 8.57 | 4.00 | 3.60 | doubtful | noticeable residual |
| DSC_9545 | 8.50 | 4.02 | 3.53 | doubtful | noticeable residual |
| DSC_0468 | 9.86 | 4.44 | 3.63 | doubtful | noticeable residual |
| DSC_9526 | 12.18 | 5.23 | 4.20 | bad | large residual, local processing |
| DSC_8564 | 8.35 | 5.92 | 5.11 | bad | large residual, local processing |
| SKL_3000 | 7.06 | 2.36 | 1.81 | bad | the curve blows the highlights |
| SKL_3024 | 8.62 | 5.17 | 4.27 | bad | the curve blows the highlights |
| SKL_3027 | 11.21 | 7.76 | 7.40 | bad | the curve blows the highlights |
| SKL_3030 | 12.27 | 3.59 | 2.02 | bad | the curve blows the highlights |
| DSC_5584 | 6.74 | 1.91 | 1.42 | good | few colors |

The reference 11 Z f pairs with one preset: NP3 1.40-3.63, own LUT 0.99-3.90, alignment 0.88-0.96.

## Portra 400 and Fuji 160, correction by 5 frames (prediction)

Z f, `--refine` from `portra400` and `fuji160` against real NX renders. Targets: As Shot, exposure 0, no masks. On the left is the error of the previous version's render, on the right the prediction. Not verified by renders of `_r2`.

| Frame | portra400 | portra400_r2 | fuji160 | fuji160_r2 |
|---|---|---|---|---|
| DSC_4860 | 5.83 | 4.03 | 5.49 | 2.57 |
| DSC_4973 | 5.11 | 4.14 | 4.17 | 2.33 |
| DSC_5247 | 3.57 | 2.62 | 2.78 | 2.53 |
| DSC_6456 | 6.06 | 3.22 | 6.02 | 2.78 |
| DSC_6522 | 3.79 | 2.95 | 3.84 | 2.08 |
| Mean over 5 | 4.87 | 3.39 | 4.46 | 2.46 |
| DSC_4837, outside the correction | 2.88 | 3.81 | 2.62 | 2.66 |

DSC_4837 was not part of the correction, but a draft was fitted from it, so there is no full transfer check here. The blender is not at its limit, the curves reach white.

`out/fuji160_r1` with the Astia Look on the targets: 6.36 -> 3.88 on five frames, DSC_4837 2.62 -> 4.03. After fixing the targets, DSC_4837 barely changes. `out/portra400_r1` was made separately, not evaluated here.

Checking renders against profile predictions: each of the 10 is closer to its own, the gap 1.74-3.18. ADL is off, this is visible from the sidecars only for the Portra renders: the Fuji assignments were overwritten.

## The step-based profile model

`profile_model.py`, 2026-11-08. The blender rotates hue and scales chroma in CIELab, brightness is added; a color set's response per slider unit: a 9^3 3D LUT over the neutral color. Grading: an additive offset in sRGB. The curve last. Responses are learned only from single probes of `data/sweep.npz`, so the whole `data/sweep2.npz` is outside the training. Real NX neutral at the input, 189 px.

| `sweep2` group | Probe | Old model | Step-based | No model |
|---|---|---|---|---|
| 14 finished profiles x 5 frames | 70 | 2.32 | 1.69 | 11.33 |
| Slider pairs | 175 | 1.97 | 0.87 | 4.74 |
| 150 recipe-like profiles | 750 | 1.88 | 1.37 | 6.34 |

- The first pack, also outside the training: FIT4, PORTRA, FUJI 1.85 -> 1.31, sharp combinations 4.30 -> 3.85. On single training probes 0.86 and 0.93.
- Smoothness: 1e-2 gives 2.25 on finished profiles, 1e-3 1.86, 1e-4 1.72, 1e-5 1.69. A 13^3 grid equals 9^3.
- Grading before or after the blender: 1.85 and 1.86, no difference.
- Baking into a 33^3 LUT changes the result by 0.07-0.30 and does not make it worse against NX. Baking a profile takes 0.18 s.
- The "Profile model" group on the comparison page: 5 frames, 7 finished profiles and 2 combinations, old 2.22, step-based 1.53.

### Second version: each color separately, grading before the blender

2026-11-09. Occasion: skin on DSC_5966 is redder than NX with FIT4 and FUJI160 (face: FIT4 dA +3.7, FIT2 +7.0, TEST_NEKIT_AUTUMN +3.9). Probes of whole sets are accurate at the same time. The `sweep.py colors` pack: 10 frames of the first pack, each of the 8 colors separately (±40 in hue, chroma, brightness) and grading every 45 degrees at 15/25/40 -> `data/sweep3.npz`. The neutrals of the third and first packs match up to NX noise, dE 0.34-0.47.

The ratio of a single probe to a set probe by the Oklab hue of neutral: a color acts in its sector almost like a step, the transition is 4-8 degrees, the sum of a set's colors is about 1. The old boundaries were wrong by up to a 15-degree column:

| Boundary, 15-degree Oklab column | Was | From data |
|---|---|---|
| red / yellow | 2.5 | ≈ 2.8 |
| yellow / cyan | 8.5 | ≈ 9.3 |
| purple / red | 23.5 | ≈ 22.9 |
| magenta / orange | 1.5 | ≈ 0.9 |
| orange / green | 5.5 | ≈ 6.5 |
| green / blue | 10.5 | ≈ 11.8 |

Steps to the result, `sweep2` outside the training:

| Variant | Finished | Pairs | Combinations | Face 5966 FIT4 / FIT2, dA |
|---|---|---|---|---|
| Morning model | 1.69 | 0.87 | 1.37 | +3.7 / +7.0 |
| Only new boundaries (medians of ratios) | 1.67 | 0.87 | 1.36 | +3.0 / +6.8 |
| Grading before the blender | 1.67 | 0.79 | 1.16 | +2.0 / +3.1 |
| + color shares by joint regression | 1.58 | 0.78 | 1.07 | +0.2 / +1.6 |
| + a grading LUT per each of the 8 directions | **1.07** | **0.75** | **0.86** | +0.2 / +1.4 |

- Grading before the blender: on "blender + grading" pairs 1.49 -> 1.12. The first version did not see this: the check ran over four grading directions.
- Color shares: a table of 96 cells of 3.75 degrees. Single color probes give the shape, set probes at three levels keep the sum, the regressor is taken from the set LUT. Regression on the measured set probe underestimated the shares where the response is small (NX noise in the regressor).
- Shares by random profiles of the first pack made the validation worse: 1.87 -> 2.02 on finished.
- Grading: the response by chroma is almost linear, at 25 the shift is 1.65x that at 15, at 40 2.45-2.69x. But by direction the response is uneven: in midtones at chroma 40 the shift at 45 degrees is 12, at 135 degrees 31, at 225 degrees 15. The basis (1, cos, sin) trained on 8 directions: finished 1.24, but grading at 0/90/180/270 degrees at 40 is worse (1.52 vs 0.91). The double angle and C^2 barely help (1.20-1.24). A LUT per direction with trigonometric interpolation between them: 1.07, linear interpolation 1.05 on finished, but 0.90 on combinations vs 0.86.
- The continuous-tone chart shot (`sweep.py chart`, DSC_8272, the same 97 profiles) in color shares made the validation worse: 1.07 -> 1.12 on finished, 0.86 -> 0.91 on combinations. The set LUT learns on real frames, on screen colors it extrapolates. The shot is not part of training, the data is in `data/sweep_chart.npz`.
- The face of 5966 with all 14 finished profiles: dE 0.6-1.5, was up to 4.3.
- The "Profile model" group on the comparison page, 5 frames x 9 finished profiles: morning 1.72, new 1.14. TEST_NEKIT_AUTUMN 2.85 -> 1.44, FIT2 2.37 -> 1.59.
- Full NEF render vs NX, 21 pairs: 1.96 -> 1.85 (fit4 2.15 -> 2.11, portra400 1.64 -> 1.53, fuji160 1.88 -> 1.57). Neutral without a profile 1.74: the main error is now in development.

## Fitting against NX renders

2026-11-09, `match_check.py`. For each of the 14 finished profiles `match.py` fits an NP3 from three pairs "NEF + NX export with this profile" (DSC_5966, 6203, 6522). On 8 frames of other scenes (4860, 4946, 5118, 5247, 6132, 6299, 6702, 7072) NX renders the original and the fitted profiles; dE2000 between the two NX renders. Development and the model do not take part in the scoring, sharpening is zero.

| Profile | Neutral | New `match.py` | Old |
|---|---|---|---|
| FIT2 | 9.20 | 1.59 | 2.45 |
| FIT4 | 9.91 | 1.36 | 2.21 |
| FUJI160 / _R2 | 4.96 / 6.95 | 0.95 / 0.97 | 1.33 / 2.12 |
| M1B / M3B | 11.12 / 10.16 | 0.81 / 0.86 | 2.29 / 2.25 |
| NEKIT | 7.42 | 0.70 | 2.43 |
| PORTRA400 / _R2 | 7.13 / 8.04 | 1.09 / 1.57 | 1.21 / 1.09 |
| SKL | 13.00 | 2.13 | 3.63 |
| TEST1 | 7.33 | 0.70 | 3.19 |
| TEST2_SKL_3027 / 3030 | 19.14 / 15.47 | 2.23 / 2.76 | 6.17 / 3.43 |
| TEST_NEKIT_AUTUMN | 15.57 | 2.80 | 3.41 |
| **Mean** | **10.39** | **1.47** | **2.66** |

By frames the new fit is 1.01-1.76, the old 1.64-3.21. Worst are the profiles whose curve blows everything above 0.6 into white (TEST_NEKIT_AUTUMN, TEST2_SKL, SKL): shadows are 1-2 L brighter, highlights 2-4.5 L darker. `match.py` used to drop target pixels pinned in white, and the curve above 0.6 was led smoothly (0.91-0.93 instead of 1.0). Now such pixels enter the fit with a one-sided penalty: the prediction must not be darker. The curve of TEST_NEKIT_AUTUMN at 0.6/0.7/0.8: original 1.00/1.00/1.00, was 0.91/0.93/0.93, became 0.95/0.99/1.00. Fits with this fix (`C-*`, NX render): mean 1.47 -> 1.32. TEST_NEKIT_AUTUMN 2.80 -> 2.15, TEST2_SKL_3030 2.76 -> 2.03, TEST2_SKL_3027 2.23 -> 1.86, SKL 2.13 -> 1.65, the rest within ±0.08, except FIT4: 1.36 -> 1.63. FIT4's midpoint is 1.3-1.5 L brighter: the per-channel penalty caught saturated colors, where one channel is at the ceiling, and pulled the curve up. The penalty is now only for white pixels (all channels ≥ 0.98): FIT4's curve error vs the original 0.016 -> 0.006, the blowout ones unchanged. The `W-*` fits (NX render): mean 1.35, FIT4 1.34. For the blowout ones W is slightly worse than C (SKL 1.96 vs 1.65, TEST2_SKL_3030 2.24 vs 2.03), but their curves match to hundredths. What diverges is the shadow grading and the blender (SKL shadows 293 deg/12 vs 305 deg/8): the shadow hue is determined unstably from three frames, and a different pixel sample gives a 0.2-0.3 difference. The common residual of these profiles: the midtones and highlights are 1.5-3 L darker, the curve does not repeat the sharp knee to 1.0 at input 0.6 (0.71 and 0.91 at 0.45 and 0.6 vs 0.76 and 0.94): the curve smoothness in the fit smooths the knee.

Smoothness turned out to be irrelevant: with the penalty 3 and 10 times weaker, general or where the frames have data, the knee is the same (TEST_NEKIT_AUTUMN 0.91/0.94 at 0.55/0.6 vs 0.97/1.00). The development on the training frames differs from the NX neutral by ±0.02 in Y', the model with the original profile is brighter than NX by +0.01: also little. The cause is in the sampling: at the knee almost all target pixels have a channel at the ceiling, the main sample drops them, and the white penalty took only pixels with all three channels at the ceiling. Knee pixels with a lower output remained. Now light almost-grey pixels (a channel ≥ 0.98, the darkest ≥ 0.8), up to 3000 per pair, enter entirely: the pinned channel one-sidedly, the rest as usual. The curve error vs the original: TEST_NEKIT_AUTUMN 0.023 -> 0.016, TEST2_SKL_3027 0.028 -> 0.017, 3030 0.023 -> 0.016, SKL 0.020 -> 0.014, the rest unchanged. The 0.6 threshold instead of 0.8 gives the same, 800 pixels instead of 3000 help half as much. NX renders of the `T-*` fits: mean 1.35 -> 1.22. SKL 1.96 -> 1.47, TEST2_SKL_3027 1.90 -> 1.61, 3030 2.24 -> 1.74, TEST_NEKIT_AUTUMN 2.28 -> 1.69, the rest within the fit noise (±0.1).

| | Neutral | Old | New | + white pixels |
|---|---|---|---|---|
| Mean over 14 profiles, 8 frames | 10.39 | 2.66 | 1.47 | 1.35 |

The result with the light almost-grey pixels (`T-*`): **1.22**.

## Fitting a preset without NX and Active D-Lighting

2026-11-10. A new preset (Rich Tone Portrait base, grain 18) on 11 South Africa frames, new for the development. `match.py` from three (6248, 6840, 5940) in 31 s, on the fitting frames the prediction vs the preset is 2.6-3.1. The NX pack `renders/sweep/lr_test_nx` with ADL off (0) in NX:

| | Fit, 3 | Validation, 8 |
|---|---|---|
| NX of the fitted vs the preset | 3.75 | 3.52 |
| Our prediction vs the preset | 2.82 | 3.00 |
| Our render vs NX, same profile | 3.04 | 2.65 |
| Our neutral vs the NX neutral | 2.98 | 2.42 |

On 6550, 6088, 5940, 6248, 6366 our neutral is darker than NX by 3.2-6.1 L evenly across all zones and radii. All five were shot with ADL Normal in the camera. The development was trained on exports with ADL in NX equal to 1 for all 60 frames (26 Low, 21 Normal, 13 Off in the camera): this is "as shot". On frames with ADL Off in the camera, turning ADL off in NX changes nothing (±0.7), on frames with ADL Normal NX with ADL off is about 0.3 stop brighter. The `sweep.py` packs now set ADL "as shot" (`adl_as_shot`), the instruction is fixed. With ADL "as shot" (`renders/sweep/lr_test_nx_adl`), the same profile:

| | Fit, 3 | Validation, 8 |
|---|---|---|
| NX of the fitted vs the preset | 2.68 | 2.84 |
| Our prediction vs the preset | 2.82 | 3.00 |
| Our render vs NX, same profile | 1.74 | 1.55 (not worse than 2.0) |
| Our neutral vs the NX neutral | 1.64 | 1.38 |

The `match.py` prediction (3.00) matches what NX gives (2.84): the NX-render correction adds almost nothing, the second step through NX is not needed. Ceiling: a 9^3 3D LUT from our neutral to the preset, own per frame, on the held-out half of pixels 1.91 (1.51-2.36). The NP3 residual above the ceiling is about 0.9.

More fitting frames, the same 5 held out (7100, 6635, 7247, 6878, 6088), our prediction vs the preset: 3 frames 2.98, 5 frames 3.08, 6 frames 2.99. On the fitting frames 2.90, on the held-out 2.99: the fit does not overfit, the mean shifts by zones and colors are up to 1-2. One shared color table for all frames (the honest ceiling of global processing) on the same held-out: 9^3 by 3 frames 2.64, by 6 frames 2.48; 17^3 by 3 frames 2.49, by 6 frames 2.34. NP3 lags it by 0.5-0.65 and does not gain from the number of frames, the table gains 0.15. The rest is done by the preset's local processing: Highlights -18, Shadows -19, Whites -39 are adaptive in the target's processing, plus grain 18 and sharpening 40. Three frames with a wide color coverage are enough for the fit.

The `--refine` correction by the draft's NX renders on the three fitting frames (`out/lr_test_r1`, pack `renders/sweep/lr_test_nx_r1`), vs the targets, 8 validation frames: NX draft 2.84 -> NX correction 2.57, our render 3.00 -> 2.83. On the fitting frames NX 2.69 -> 2.21. The correction transfers to new frames: it fixes a systematic error of the model, not noise. Our render vs NX for the correction is 1.26-2.11, as for the draft. The previous conclusion "the NX correction adds almost nothing" is wrong: the gain is about 0.27.

## Region breakdown, rare-color weight, frame analysis

2026-11-10. The preset, 11 frames, NX renders `KC5F` (`lr_test_nx_de2k_f`) vs the targets. An NX substitute for comparing fits: the NX neutral (`lr_test_nx_adl`) through our profile model, 2.63 vs the real NX 2.58.

The region errors of `KC5F` in NX repeat across frames: saturated warm colors (vest, car) are darker by 3-7 L (6840 orange L -6.7, red -5.9; 7155 vest L -4.8 and C +8.9); skin is darker by 2-5 L at the same chroma, hence redder; the sky is lighter and paler (6248 L +3.5 C -4.8, 6635 L +3.5 and +16 degrees toward magenta); teal and water are -14...-21 degrees toward green. Per pixels 2.58, per color bins 3.15.

| Ceilings, 11 frames (NX neutral) | dE |
|---|---|
| LUT 17^3 over all, on themselves | 1.73 |
| own 9^3 LUT per frame | 1.69 |
| LUT 17^3 without the validated frame | 2.31 |
| NP3 (model) over all 11, on themselves | 2.40 |
| NP3 without the validated frame | 2.62 |

A table per frame is almost no better than a shared one: the preset is essentially global. The NP3-to-table gap is about 0.3 on new frames. Even over all 11 frames the sky stays at L +2.3...+3.5 with the blue brightness at -20: pale blue is not darkened by the blender (in our model; not checked in NX).

Frame lightness: lift (target vs neutral) from -9.0 to -12.5 L. Removing the frame lightness shift: 6840 2.63 -> 1.85, 7247 2.90 -> 2.22. The dark ones are mostly frames with ADL Off (6840, 6878, 7100, 7247), frames with ADL Normal have almost no shift.

Development vs the NX neutral by training density in the color cell: < 1e-6 dE 3.87, < 1e-5 2.87, >= 3e-5 1.4-1.7. Vest 7155 is C +11.7 for us, sky 6248 L +5.3.

Check on frames outside the fit (NX substitute), halves A = 5940 6248 6840 7155 6635 6366 and B = 6088 6550 6878 7100 7247:

| Fit -> validation | as before | development trust | trust + rare weight 0.5 |
|---|---|---|---|
| A -> B, per pixels / per colors | 2.82 / 3.29 | 2.79 / 3.27 | 2.76 / 3.23 |
| B -> A | 2.64 / 3.33 | 2.63 / 3.32 | 2.61 / 3.28 |

On five frames outside all fits (6088 6366 6550 7100 7247): `KC5F` 2.72 / 3.29, the same three frames with the new weight 2.80 / 3.27 (sky 3.1 -> 2.8, greys L -0.1 -> -0.7), the `--analyze` advice (7155 6878 6635) 2.72 / 3.36 (sky 2.2, saturated warm 3.7 -> 4.8). Conclusions:
- The rare-color weight with development trust: the gain is small (0.03-0.06), the error moves from large areas to rare colors. Adopted: the eye sees the sky, skin and the vest, not the mean.
- More frames and color coverage on new frames do not help. What matters is the set's lift: fitting by the half with darker targets made the other half darker by 1.2 L. The set advice keeps the mean lift at the median.
- Colors in the target argue with each other: the target's processing compresses a very saturated orange (vest) and does not touch a less saturated one (car); NP3 cannot do that, a frame with the vest in the fit spoils the other warm colors.
- Profiles `out/lr_test_p0.5_old`, `_off`, `_all` for checking in NX.

## South Africa pack: sky and bright colors (sweep5)

2026-11-11. `sweep.py colors-sa`: 6 South Africa frames (7203 vest against the sky, 6975 orange wall, 6455 deep blue sky, 6474 boats, 6296 portrait, 6593 water), chosen by `analyze.py` from 1284 NEFs not closer than ±40 to the validation ones. 103 profiles: blender sets and colors as in training, ±100 of blue, cyan, orange, red in chroma and brightness, `KC5F` and `P0.5_OFF`. `data/sweep5.npz`.

The model before retraining on these new frames: sets 0.67, colors ±40 0.51, ±100 0.77, finished 0.77 (without the model 2.26 / 1.08 / 2.02 / 10.81).

- **NP3 darkens the sky, the model knows it**: blue brightness -100 on the sky in NX L -10.2, the model -9.7. The fit does not darken the sky because of the trade: blue darkens saturated blues more than the pale sky. A profile over 11 frames, blue brightness -20 -> -60: sky L +3.2 -> +1.4, dark blues L +0.6 -> -4.5, mean 2.40 -> 2.43. The sky is lighter than the target on all frames (+3.2...+4.5, except 7247). This is the limit of NP3, not of the model.
- **Saturation at ±100 is nonlinear**: blue CH -100 on the sky in NX -23...-32, the model -17...-23; CH +100 NX +18...+25, the model +24...+35; orange the same. The model is linear in the level and learns up to ±60, the fit is limited to ±60 (`fit.LIMIT`), so it does not affect current profiles.
- **Retraining** (`profile_model.EXTRA_DATA`): on the held-out half of frames 0.73 -> 0.72 and 0.60 -> 0.63 (sets), finished 0.83 -> 0.81 and 0.71 -> 0.66 — within noise. On all six: `lr_test` 0.77 -> 0.76 (dark blues 0.8 -> 0.6), `sweep2` 1.07 / 0.75 / 0.86 -> 1.08 / 0.76 / 0.86. Adopted as the working one, the previous one in `data/profile_model_pre_sa.npz`.
- Development retrained on 11 NX neutrals of `lr_test` (`data/lr_test/`): 1.44 -> 1.42 on held-out frames, not adopted. Vest 7155: 43% of pixels outside sRGB after the matrix, with the frame in training C +11.7 -> +5.1. Sky 6248 L +5.2 also with the frame in training: not global, probably local ADL Normal.

## The remaining NP3 tools

2026-11-11, the `sweep.py tools` pack (10 frames, 118 profiles, `data/sweep4.npz`). The neutral matches the `colors` pack up to NX noise (0.34-0.46).

- **Contrast, Highlights, Shadows, White, Black**: a Y' curve, like an own NP3 curve. The residual after fitting the curve is 0.41-0.71 (noise), a per-channel curve is worse (0.56-3.51), saturation does not change. Intermediate values: linear interpolation between the ±25/50/100 levels. Two sliders together: the sum of the curve shifts, 0.43-0.45. Incompatible with a curve in NP3.
- **Saturation**: Cb and Cr in Y'CbCr are multiplied by k, Y' does not change; residual 0.52-0.94. k at -100/-50/-25/+25/+50/+100: 0, 0.53, 0.77, 1.31, 1.61, 2.23. Stands after grading (0.75 vs 3.58 of the first), with the blender both orders are close (0.97 / 1.04), with the curve it commutes. Order: grading -> Saturation -> blender -> curve. The previous conclusion "Saturation is nonlinear" was an artifact of the on-screen chart.
- **Zone grading**: each zone has a mask over the neutral Y', the color offset is shared, the three zone masks sum to 1 and do not depend on hue. By blurred lightness is worse (the mask is computed from the pixel itself), L* and linear lightness give the same as Y'.
- **The zones in `np3.py` were swapped**: field 0x170 grades the dark places of Y' 0.05-0.5, 0x178 — the light ones, and they were named the other way around. In NX the probe `GBHP50` (+50 in 0x170) shows shadow brightness +50. Since 2026-11-11 0x170 is `shadows`, 0x178 is `highlights`, the `np3.ZONES` order from dark to light, the positions in the fit vectors are unchanged. The letters H and S in the probe names remain the old ones (`np3.ZONE_TAG`: H is shadows, S is highlights), to match the exports; the pack generators produce byte-identical NP3s, the retrained model matches the old one.
- **Blending, Balance**: change only the masks. Model: the previous zone tables plus (mask - default mask) x the shared offset; masks at Blending 0/25/50/75/100 and Balance -100/-50/0/50/100, interpolation between them, Blending and Balance add up. Single probes: Blending 0.81, Balance 1.42 (without the model 6.3).
- **Grading brightness**: own 3D table over color per zone and sign, linear in value (trained on ±50, 0.49-0.52 at ±100). A Y' shift by pixel lightness alone gave 1.4: the response depends on color.
- **Clarity**: not in the model, ±2/±5 give 1.21 against neutral.

| `sweep4` group | Probe | Model | No model |
|---|---|---|---|
| Tonal sliders | 300 | 0.51 | 3.74 |
| Saturation | 60 | 0.70 | 5.99 |
| Grading brightness | 150 | 0.48 | 2.95 |
| Blending | 120 | 0.81 | 6.27 |
| Balance | 120 | 1.42 | 6.30 |
| Tool pairs | 80 | 0.71 | 5.17 |
| 30 recipes with all tools, outside training | 300 | **1.00** | 6.86 |

The previous `sweep2` groups did not change: 1.07 / 0.75 / 0.86. `match.py` now also fits Saturation, three zone brightnesses, Blending and Balance (17 s for three pairs). The preset, our prediction: fit 2.82 -> 2.73, validation 3.00 -> 2.94; the fit took zone brightnesses -32 and -26, Saturation +4, kept Blending and Balance. Check in NX (`renders/sweep/lr_test_nx_all`, vs the preset):

| | fit | validation |
|---|---|---|
| NX, draft without the new tools | 2.68 | 2.84 |
| NX, draft with all tools | 2.60 | 2.75 |
| NX, draft + refine via NX | 2.21 | 2.57 |
| our render vs NX of the same profile | 1.74 | 1.56 |

The gain in NX is a bit bigger than predicted: 0.09 vs 0.06. Our render vs NX holds at the previous level (1.55 for the draft), so the new tools work in the render on live frames too. Refine is still stronger: the gap is mostly not the lack of tools but the model error (milestone 4).

## Fitting the profile model from frames: what did not work

Data `data/sweep.npz`, see `camera-response.md`. The experiment script `data/sweep_lutfit_experiment.py`, arguments: knots, sector margin, space. Held out: frames DSC_6203 and DSC_6663 and profiles RND40-49, FIT4, PORTRA, FUJI. The regularization is chosen by RND30-39 on the training frames.

First attempt, 2026-11-08: own 9^3 3D LUT per slider, 57 tables, anchored to the old response. Rejected as overfitted.

| | Old model | LUT 9^3 |
|---|---|---|
| New frames, combinations | 4.10 | 2.77 |
| New frames, FIT4 / PORTRA | 2.46 / 1.83 | 3.42 / 3.66 |
| Known frames, new combinations | 3.80 | 7.21 |
| Known frames, new FIT4 / PORTRA | 2.54 / 1.59 | 4.33 / 4.66 |

Each color's table covered all colors, and about 40 combinations constrained it. The model memorized the profiles.

A comparison of the old model and the best variant (Lab) with NX exports at 756 px, profiles outside training: FIT4 2.56 and 2.64, PORTRA 1.71 and 1.93, FUJI 1.44 and 1.73, combinations RND40-49 on held-out frames 3.58 and 3.46. Pictures in the "Profile model" group on the comparison page.

Second attempt: a blender color acts only in its own hue sector and on muted colors. Shifts add up in sRGB, in Lab or in polar coordinates (L, hue, log C). The solver converges, residual 1e-5.

| | Old | sRGB | Lab | Polar |
|---|---|---|---|---|
| New frames, combinations | 4.08 | 3.23 | 3.00 | 6.80 |
| New frames, FIT4 / PORTRA / FUJI | 2.47 / 1.84 / 1.30 | 2.12 / 1.98 / 1.83 | 2.11 / 1.92 / 1.74 | 3.36 / 2.90 / 2.00 |
| New frames, blender / grading | 1.19 / 1.43 | 1.34 / 1.19 | 1.21 / 1.16 | 1.63 / 4.35 |
| Known frames, new combinations | 3.80 | 3.67 | 3.59 | 7.06 |
| Known frames, new FIT4 / PORTRA / FUJI | 2.53 / 1.58 / 1.40 | 2.80 / 1.87 / 1.79 | 2.74 / 1.85 / 1.66 | 4.53 / 2.98 / 2.35 |
| Training, combinations | | 3.31 | 3.01 | 7.87 |

- Real profiles got worse, so no variant is adopted.
- Combinations do not fit even the training data: about 3.0. The sum of individual slider responses does not describe NX in any of the three spaces.
- One slider is linear in the level: |d40|/|d60| 0.66-0.67, |d20|/|d60| 0.33-0.35 on all three attributes. So the error is in the interaction of sliders, not in the level.
- The polar variant breaks grading: on almost-grey colors hue is not defined.
- Random combinations in the pack are stronger than real profiles: 70% of sliders in ±60. For training, combinations closer to real ones and a model with interaction are needed.

## Approximate render vs the real NX render

`compare.py`, 2026-11-07. Z f, 14 frames, 21 frame-profile pairs. dE2000 on aligned 256 px pairs. "New frame": the development was trained on 24 frames of 60, without these 14 and without frames with numbers ±40 from them, because a neighboring frame was shot at the same place. "Working": it has seen these frames, so its numbers are understated. The render uses `data/devmodel_render.npz`, not `devmodel.npz`.

| Profile | Pairs | New frame | Working | Neutral |
|---|---|---|---|---|
| fit4 | 11 | 2.15 | 1.99 | 10.43 |
| portra400 | 5 | 1.64 | 1.49 | 6.42 |
| fuji160 | 5 | 1.88 | 1.54 | 4.91 |
| Total | 21 | 1.96 | 1.76 | 8.16 |

- Before, 35 frames in the set: 3.59, with an emphasis on warm colors 3.48. Back then neighboring frames were not removed, 21 frames were in the training.
- With the old on-screen chart profile model: 2.46, working 2.37.
- Without vignette correction, 60 frames: 2.75.
- 60 frames, no vignetting, neighbors not removed, 46 in training: 2.77. Neighbors removed, only old frames, 7 in training: 4.58, this is too few for a comparison.
- A baked 33^3 LUT is no worse than the per-pixel `match.py` model: 2.91 vs 2.98 on fit4.
- DSC_6456, a saturated blue sky: was the worst, 5.17-7.01, now 1.99-2.50. The worst frame DSC_6702: 3.92, p95 was not analyzed. Blues with FIT4: DSC_6203 2.85 -> 1.46, DSC_5118 3.27 -> 2.01.
- 9 of the 14 validation frames are by numbers from the same trip as the 25 new ones. The light and scenes may be similar even after ±40, so on other shoots the error may be higher.
- On whole frames without alignment dE is higher: edges diverge due to distortion, on the night DSC_6757 noise adds up.
- Other cameras were not checked: there are no real Z 8 renders with a known profile.

### Development only

`compare.py`, the "neutral" group: NEF through the development vs the NX export with neutral, 60 frames, no profile. Frames are held out in blocks of 10 together with ±40 neighbors, 46-50 frames in training. New frame 1.74, working 1.43. Worst: DSC_6702 4.90, DSC_4946 3.64, DSC_7072 3.48. On DSC_6702 p95 is 18, the cause was not analyzed.

On DSC_5118 and DSC_6203 the new frame gives 0.96 and 1.31, and with FIT4 3.27 and 2.85.

### Blues with FIT4

The shift toward magenta on muted blues comes from the profile model, not development: the development's hue error there is ±0.2 degrees. Chroma 12-22: NX -9...-22 degrees toward cyan, prediction -15...+8 degrees. The saturated sky DSC_6456 matches: -5.2 and -6.0 degrees.

A check with the real NX neutral at the input, FIT4, L from 60: blues C 8-16 NX da -1.4, prediction +2.4; neutral tones C<5 NX +0.9, prediction +2.6. The likely source is the highlight grading, this is not yet proven.

### Vignetting

`vignette.py`. NX lifts the frame corners by 0.3-1.3 stops, more at an open aperture. The render did not do this: the center is 0.14 brighter than NX, the edge 0.15 darker, at f/2.5 the difference reaches 0.5 stops. The development was meanwhile trained on different brightness of one color.

The correction is taken from the NEF vs embedded JPEG difference, the lens does not need to be known. Validation in blocks over 60 frames, development without a profile:

| Variant | dE | Reds | Oranges | Blues | Edge minus center, stops |
|---|---|---|---|---|---|
| None | 1.92 | 1.84 | 2.27 | 1.98 | 0.29 |
| From JPEG | 1.51 | 1.67 | 1.69 | 1.27 | 0.13 |
| Lens and aperture table | 1.52 | 1.55 | 1.72 | 1.19 | 0.12 |
| Exact by NX | 1.46 | 1.55 | 1.64 | 1.09 | 0.11 |

- Corner by JPEG and by NX: correlation 0.87, spread 0.13 stops. Worse on night frames and clear sky.
- No embedded JPEG: no correction. Frames with Vignette Control off in the camera were not checked.
- The residual lightness offset per frame is ±0.1-0.2 stops: DSC_7072 +0.22, DSC_6121 +0.20. Not related to WB and ISO. On such frames the embedded JPEG deviates in the opposite direction, correlation -0.44, this is too little for a correction.
- In the shown pictures the render is darker than NX by 0.05 stops on average. The offset depends on the profile: DSC_4860 with fuji160 -0.19, with portra400 0.00.

### Reds, oranges and magenta in the render

A render error, not NP3 and not NX. Sectors by the Lab hue of the NX neutral, chroma above 15. "New frame" numbers.

| | 35 frames | With the warm balance | + 25 South Africa frames | + vignetting |
|---|---|---|---|---|
| Red hue shift in neutral | -5.6...-6.6 deg | -4.6...-4.9 deg | -0.7...-0.9 deg | -0.5...-0.7 deg |
| dE of reds fit4 / portra400 / fuji160 | 4.35 / 4.37 / 4.70 | 3.95 / 3.82 / 4.02 | 3.58 / 2.43 / 2.17 | 3.62 / 1.97 / 2.37 |
| dE of oranges fit4 / portra400 / fuji160 | 3.07 / 3.82 / 3.12 | 2.89 / 4.09 / 3.51 | 2.93 / 3.75 / 3.05 | 2.65 / 2.69 / 2.45 |

The mean hue shift hides the spread across frames: on DSC_6522 reds go toward magenta by -2.4...-2.7 degrees outside the training and by -0.4 degrees in the working development, on DSC_4860 and DSC_4973 toward orange by +2...+6 degrees, that is already the profile. The red shift is not related to WB, correlation around 0.

- New 25 frames, validation in blocks of neighboring numbers, development without a profile: all 2.24 -> 1.96, magenta 2.79 -> 1.99, reds 1.75 -> 1.63, oranges 2.79 -> 2.78, yellows 3.37 -> 2.48, cyan 4.11 -> 3.14, blues 2.98 -> 1.85. Without the warm balance: all 2.01, magenta 2.28, so the balance is kept.
- Old 35 frames in blocks: all 1.83 -> 1.77, reds 2.17 -> 1.96, blues 3.69 -> 2.39. Magenta 2.13 -> 3.65, hue +7 degrees: almost all of it is on the dark DSC_4946 (L 12), the new magenta is lighter (L 32-72). The working development has this frame.
- On the validation frames with a profile there is little magenta, 377-1050 pixels on 1-2 frames, no conclusion about it.
- A check in blocks over all 35 frames: base 1.90, reds 2.42. Balancing the whole sample: reds 1.98, but all 2.11, green 2.38 -> 3.24, magenta 2.13 -> 3.11, rejected. Warm colors only in the 25-knot LUT: all 1.83, reds 2.19.
- FIT4, reds: the neutral is now accurate (C +0.8, hue -0.7 degrees), so the residual is only in the response. NX raises chroma by +15.4, the prediction by +10.2, the result C -4.9. 8 and 16 neighbors and a chroma-shift scale did not help. The cause is not found. The version "frame reds are more saturated than patches" was not confirmed: patches reach C 88, frame reds are around C 38.
