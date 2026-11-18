# Milestones

Goal: the user gives a NEF and their JPEGs with the wanted look. `match.py` fits an NP3, the interface shows our render next to the JPEG, and the user, if needed, adjusts any NP3 slider by hand. NX Studio is not needed at any step, including the correction.

For that the render must understand the whole Flexible Color tool set, not only what the fitting sets.

State as of 2026-11-11. Numbers: dE2000, details in [results.md](results.md).

## 1. NEF development -> Nikon neutral — done, remainders

`devmodel.py`, `vignette.py`. Trained on 60 neutral NX exports with Active D-Lighting "as shot".

- Our neutral vs the NX neutral on the new South Africa frames: 1.38.
- NX exports for the project are made only with ADL "as shot". Turned-off ADL on frames shot with ADL Normal makes NX about 0.3 stop brighter, and our development and the camera do not do that.
- Remainders: individual frames with a whole-frame lightness error (DSC_7072 is 2-5 L brighter), a local error on DSC_6702, dark magenta on DSC_4946.

## 2. Color model: blender, grading, curve — done

`profile_model.py`, trained on the probe packs of `sweep.py` (`data/sweep.npz`, `data/sweep3.npz`), validation on `data/sweep2.npz`.

- Order: grading -> blender -> curve.
- Blender: a color set's response is a 3D LUT, each color's share by Oklab hue from single-color probes of each color.
- Grading: a LUT per each of the 8 grading directions every 45 degrees.
- On 14 finished profiles outside the training: 1.07, on random recipes 0.86.
- Remainder: the FIT2 and FIT4 greys are warmer than NX by dB of about +0.7.

## 3. Fitting without NX — done

`match.py`, 30-40 seconds for three pairs.

- A profile fitted from three pairs against the original in an NX render on 8 other frames: 1.22 (the previous fitting: 2.66).
- The preset: NX with the fitted profile vs the targets 2.84 on new frames, our render vs NX 1.55. Three frames with a wide color coverage are enough, five and six are not better.
- Light almost-grey pixels pinned in white are accounted for: without them the curve with a white knee ended up lower.

## 4. Correction without NX — in progress

Currently `--refine` against the draft's NX renders improves the result also on new frames: 2.84 -> 2.57 against the targets. So it fixes a systematic error of the model.

- Find out what exactly the correction changes and build it into the model, so that the draft comes out like that right away.
- Breakdown of the preset draft on 11 frames (our render vs NX 1.60): development vs NX neutral 1.45, our profile model on the NX neutral itself 0.79.
- The correction raised the curve midpoint by about 4/255 and shifted yellow, red and blue in the blender by 5-10.
- Lightness: on the three fitting frames our development is brighter than NX by +0.3...+0.9 L (mean +0.66), on the validation frames around zero and of different sign. A single frame's development error goes into the curve.
- Color: the profile model for this profile gives dA +0.8 in the yellow-greens (24% of pixels) on all 11 frames. On 14 finished profiles this shift is of different signs (-0.6...+1.6), so it is not curable by a shared correction; the error depends on the profile parameters.
- Plan: (a) check what a perfect development gives — fitting from the NX neutral instead of ours; (b) protect the fit from a single frame's lightness error; (c) find in which parameters the profile model errs on real profiles (candidate: blender together with grading, 0.9-1.9) and retrain on the already available NX renders of real profiles.
- Step (a), 2026-11-11: fitting from the NX neutral instead of our development, profiles `out/lr_test_nxdev` (with all tools) and `out/lr_test_nxdev0` (without the new ones, like refine). The NXDEV0 curve almost matched the refine curve (midpoint 114/129 vs 114/129, the draft's 109/123), the blender matched partially (shift correlation 0.38). Our prediction from the NX neutral on the validation frames gained almost nothing (2.83 -> 2.79), the check in NX: pack `renders/sweep/lr_test_nx_dev`, 22 files.
- Check in NX (`lr_test_nx_dev`, vs the preset): NXDEV0 2.81, NXDEV 2.85 on the validation frames (refine 2.57, ALL 2.75). The perfect development fixes the curve but overall does not beat refine: frames without ADL got better, 7155/6635/6088 got worse. The spread from the choice of three frames is ±0.5-1 per frame.
- Sky and blue-greens (noticed by eye, confirmed): in NX the sky is more magenta and less blue than the target (dA +0.6...+3.6), in the other tones the difference is small. Causes: (1) the sky share in the three fitting frames is 5%, 0%, 1%; (2) the fit minimizes dE76, where a blue hue error costs almost nothing, while dE2000 and the eye notice it; (3) the warm highlight grading (31 deg/19) tints the sky too, while in the target the same grading barely touches the sky. Without the highlight grading the sky dA is +0.2, but greys and skin get worse. Fitting by the sky only: sky dE 2.45, over all pixels 3.5 — this is a trade with the other colors.
- The fit residual over the dE2000 components (weights at the target color, agreement with dE2000 0.99-1.01): prediction from the NX neutral on the validation frames 2.74 -> 2.65, sky dA +2.6 -> +1.9. Equal weight of rare colors (2.74 -> 2.83-2.94) and a bigger sky weight (a trade with greys and purples) are worse.
- `match.py` switched to dE2000 with kC 0.5. The preset, prediction from the NX neutral: 2.74 -> 2.62, sky dA +2.3 -> +1.4 at the previous dB. 14 `match_check` profiles, same prediction: 1.50 -> 1.47; better for FIT2 (1.90 -> 1.55) and PORTRA400_R2 (1.81 -> 1.42), worse for profiles with a white-knee curve TEST2_SKL_3027 (2.07 -> 2.34) and TEST2_SKL_3030 (2.01 -> 2.16): dE2000 is softer on a lightness error in the highlights. Check in NX: packs `renders/sweep/lr_test_nx_de2k` (22) and `renders/sweep/match_check_D` (112).
- In NX: the preset KC5 2.67, KC7 2.66 on the validation frames (ALL 2.75, refine 2.57), best on the frames with sky 6635 (3.07 -> 2.72) and 7247 (3.19 -> 2.91). `match_check` D (kC 0.5) 1.25 vs T 1.22: FIT2 1.57 -> 1.22, FIT4 1.34 -> 1.27, PORTRA400_R2 1.62 -> 1.15, but worse on the white knees (TEST2_SKL_3027 1.61 -> 1.94, TEST2_SKL_3030 1.74 -> 1.95, TEST_NEKIT_AUTUMN 1.69 -> 1.95).
- Lightness without SL (`FLAT_L`: hue and chroma per dE2000, lightness even as in dE76), prediction: `match_check` 1.47 -> 1.44, TEST2_SKL_3027 2.34 -> 2.09, FIT2 and PORTRA400_R2 stay; preset 2.62 -> 2.61, sky dE 3.47 -> 3.34. Adopted in `match.py`. Check in NX: `renders/sweep/match_check_F` (112), `renders/sweep/lr_test_nx_de2k_f` (11).
- In NX with `FLAT_L`: the preset 2.62 on the validation frames (KC5 2.67, refine 2.57; 7155 1.94), `match_check` F 1.18 — the best fit without NX (T 1.22, D 1.25): the white knees returned (TEST2_SKL_3027 1.53, TEST2_SKL_3030 1.77, TEST_NEKIT_AUTUMN 1.81), FIT2 1.25 and PORTRA400_R2 1.15 stay. The preset profile `out/lr_test_kc0.5_flat` is written to the card as `PICCON01_lr_preset.NP3` (name NPF-LR_PRESET).
- Readiness criterion: a draft without NX is no worse than the current NX correction (2.57 on the targets).

## 5. The remaining color and tonal tools — done

Saturation, Contrast, Highlights, Shadows, White Level, Black Level, Color Grading brightness, Blending, Balance. The `sweep.py tools` pack, `data/sweep4.npz`.

- The render understands all these tools: on 30 recipes with all tools outside the training 1.00 (without the model 6.86). Balance is the weakest, 1.42 on single probes.
- Order: grading (zone color and brightness by masks) -> Saturation -> blender -> curve (own or from the tonal sliders).
- `match.py` fits Saturation, zone brightness, Blending and Balance. It does not fit the tonal sliders: the curve is more flexible and they are incompatible with it in NP3.
- On the preset the gain is small: in NX on new frames 2.84 -> 2.75 (refine via NX gives 2.57). Our render vs NX with all tools is 1.56, as without them.
- The grading zones in `np3.py` were swapped (0x170 is shadows, 0x178 is highlights), verified in NX and fixed.

## 6. Clarity, Sharpening, Mid-range sharpening — later, separately

Spatial filters, they cannot be computed per pixel.

- Model: Gaussian blur and high-pass with fitted radii and weights, and their combinations.
- Data: full-resolution TIFFs, not the shrunk copies from `data/sweep*.npz`. Clarity probes at ±2/±5 are already in the `tools` pack. Sharpening and Mid-range need their own pack on frames with fine texture and sharp edges, with several levels of each.
- Criterion: the render with these filters vs NX is no worse than the render without them on frames with zero sharpening, and the difference is noticeably smaller on the sharpening probes.

## 7. Interface — after milestones 5 and 6

The base exists: `web/bench.html` loads its own NEF/DNG and renders the neutral in the browser (WebAssembly + WebGL2); `ui.py` remains an internal Python viewer. The user interface is static, all computation runs in the browser.

**2026-11-17, the manual-adjustment MVP is done:** `web/index.html` per `spec/ui-manual-mvp.md` — RAW loading in a Worker, NP3 import/export, all sliders, an SVG curve editor, strength 0-150%, before/after. Reference check: `node web/test.mjs`, level 8 is the end-to-end UI of the real page (plan: `spec/ui-manual-mvp-plan.md`). Not done from this milestone: auto-fitting from the interface and reports (that is the full-product scenario of `spec/ui.md`).

- After fitting: our render next to the user's JPEG, a curtain, dE over the frame and an error map.
- Sliders of all NP3 tools with a render recomputation: the profile is baked into a color table in a fraction of a second, a 1600 px frame computes in about a second.
- Saving the NP3 after a manual edit, copying to a card for the camera.
- Running `match.py` from the interface: NEF and JPEG pairs, profile name.
