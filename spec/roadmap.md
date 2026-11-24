# What is next

## Proposed, no decision yet

**Interface after the fit-engine research (2026-11-24): agreed, deferred.** Primary frame weight,
effective tone curve, flat-region error in the report, an optional flat-region weight in the fit, a check
frame instead of a "harmful frame" flag. Details and numbers: [ui.md](ui.md) "Planned, not implemented".

**A synthetic NEF instead of the on-screen chart.** Write the values straight into the sensor data, as in NRLR.

- 24 720 patches instead of 216, without clipping, a screen and non-grey greys.
- Batch assignment of NP3 by inserting into `.nksc`: done, `sweep.py`.
- May bring the draft closer to the `--refine` result and remove NX Studio from the daily workflow. No guarantee: part of the error comes from development and from the interaction of settings.
- The NRLR generator is made for the Z 8. We have not read their code, have not tried it on the Z f.
- First step: generate such an NEF for the Z f and check that NX Studio opens it. Then one batch export of probes.

## Waiting for data

- Renders of `portra400_r2` and `fuji160_r2` on 6 frames (5 from the correction plus DSC_4837), ADL off: real dE instead of a prediction. For Portra, decide whether to add DSC_4837 as the sixth pair: the prediction on it is 2.88 -> 3.81.
- Practical shots from another camera (Fuji and Nikon): a static scene from a tripod, 2-3 subjects with sky, greenery and skin, the same exposure and WB. Nikon NEF for Nikon, JPEG with the needed profile for the second camera.
- Another preset: three different pairs to check the universality of the process.

## Data that has already arrived

`test2/`: 4 pairs SKL_3000, 3024, 3027, 3030, Z 8. LibRaw does not read the NEFs, the DNGs next to them are read. The run is done; this is different manual processing, not one preset. For an honest check, pairs with one preset and its own Z 8 calibration are needed.

`out/test_nekit_autumn_strength/`: versions 30, 50, 70. Waiting for renders of properly exposed shots in NX Studio and a strength choice.

`nekit_examples/`: 8 Z 8 pairs, profiles `out/nekit`, `out/nekit_examples_*`, prediction in `results.md`. There are renders `DSC_0468.TIF` and `DSC_1091.TIF`, waiting for `--refine`. Which profile made them is not established: by pixels the closest is `nekit_examples_DSC_1091` (3.49 and 3.26), then `nekit` (4.23 and 3.80), its own profile for DSC_0468 gave 6.55. For a shared profile take pairs with a "good" verdict, do not take DSC_8564 and DSC_9526.

## In progress

- Goal: an interface where after fitting you see our render next to the JPEG and can turn any NP3 slider by hand, without NX. For that the render must understand all tools, including Clarity, Sharpening and Mid-range sharpening.
- Clarity, Sharpening, Mid-range sharpening: a separate milestone. A model via Gaussian blur and high-pass with fitted radii and weights, from the full-resolution TIFFs. Clarity probes at ±2/±5 are in the `tools` pack; Sharpening and Mid-range need their own pack on frames with fine texture.
- Development is now the main error source: neutral 1.74 vs full render with a profile 1.85. On the South Africa frames with ADL "as shot" the neutral is 1.38, the render with a profile 1.55.
- Fitting a preset without NX: 2.84 against the targets in NX, 2.75 with all tools, 2.57 with the correction by NX renders, the ceiling of a shared color table is around 2.3. More fitting frames do not help. For the NX correction to become unnecessary, the model must fix by itself what `--refine` fixes: find out what exactly it changes (candidate: the FIT2/FIT4 greys are warmer than NX).
- Fitting against NX renders: 1.22 (old 2.66). Remainders: worst TEST2_SKL_3030 1.74 and TEST_NEKIT_AUTUMN 1.69, the curve at the knee is still 0.02 below the original; the shadow hue is unstable between runs (0.2-0.3); PORTRA400_R2 is 1.60 with the new fit vs 1.09 with the old.
- The FIT2 and FIT4 greys are warmer and greener than NX: dB +0.7, dA -0.65, the other finished ones are around zero. Things that did not help: blender response by neutral, saturation addition instead of multiplication, color shares by saturation, a different grading interpolation (linear reduces it to +0.4...+0.6 but is worse on recipes), the grading zone after the curve (much worse).
- The blender and grading add up with an error of 0.9-1.9, the cause is not found.
- The step model on single training probes gives 0.86 at a noise threshold of about 0.5.

## Possible improvements

- Running `match.py`, `--refine` and `triage.py` from `ui.py`.
- Neutral renders from other shoots: 9 of the 14 validation frames are by numbers from the same trip as the new training frames. Separately, dark magenta as on DSC_4946.
- Find the cause of the red chroma shortfall on FIT4: blender probes at several values instead of ±60.
- Brightness offset by profile: fuji160 is darker than NX more than portra400 on the same frames.
- The residual brightness offset per frame is ±0.1-0.2 stops, the cause is not found.
- `triage.py` writes `pairs.json`, `--refine` warns about frames without the take-out data.

- Translating Temperature/Tint into WB coefficients via DNG matrices instead of a relation trained on the Z f. On the Z 8 the current WB take-out seems to hurt.
- Exposure and WB alignment between cameras in `--scene`.
- A flag that keeps the WB and exposure when the preset itself sets them. Together with it, constrain the curve where the shots have no data. First candidate: removes the blowout on `test2/`.
- Separate strength for color and curve in `strength.py`.
- Fitting from printed chart sheets: the sheets, `charts.py` and `match.py --chart` are ready and verified on synthetic data, see [charts.md](charts.md) (in the np3-fit-charts project). Waiting for a trial shoot of one sheet by both cameras.
- Camera settings in a separate profile to support other Nikons.
- FIT5: only the top of the curve, if white in the shots looks muted (the curve ends at 247 of 255).
- Fitting sharpening and clarity.
- Recomputing Georgia after the crop fix.
