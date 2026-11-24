# Decisions, dead ends, limitations

## Decisions made

- **The fitting target is a specific preset, not a series of frames.** On Georgia the difference comes from per-frame edits, not from a shared profile.
- **The model is empirical.** The response is measured with probes, Nikon's tables are not used.
- **The render computes the step-based model from NX exports, not the on-screen chart.** The on-screen chart underfit a single slider on real frames. The model structure was taken from pair measurements, no neural network is needed: there is an algorithm in NX.
- **Saturation stays at 0.** The response is nonlinear, the blender sets the chroma.
- **The blender is limited to ±60.** The probes measured only this range. The cost on the chart is about 0.1 dE.
- **The curve end is pinned to white.** The chart does not reach the highlights. Real frames define the end more precisely.
- **In FIT3 the shadows were held.** Without the constraint the fit crushed them into black, the cost 4.30 -> 4.37.
- **FIT4 was chosen over FIT3.** The mean is almost equal, but the highlights, reds, skin and the overexposure are better. The cost: the deep sky.
- **The third iteration over the chart was not done.** The remainder in the highlights there is intentional.
- **Feedback is mandatory for accuracy.** The draft gives 4.4-5.0, the correction by a render 2.84.
- **WB and exposure from the XMP are subtracted.** They are not part of the profile. If the preset itself sets them, they are subtracted too: this cannot be told from the file. On `test2/` this hurt: the exposure -0.79 worked together with its own curve and Whites +70, and the NP3 curve went into white at an input of about 150.
- **Warnings about a camera that is not a Z f are not needed.** The user decided so.
- **Profile strength is made as separate files.** There is no slider in NP3.
- **ADL in NX exports is "as shot"** (sidecar value 1): the development was trained this way. Turning ADL off in NX makes frames shot with camera ADL about 0.3 stop brighter. The `sweep.py` packs set `adl_as_shot`.
- **Detail is a separate step after color, over Y' only.** Color and fitting (`match.py`, `compare.py`) run without it: `Renderer.apply(..., sharp=True)` enables the step only for a frame in `render.py` and `ui.py`. The model is trained per export scale separately (2: the full `--full` development, 4: the 1600 px preview): small-radius sharpening after shrinking is not the same mask with radius/k. If a tool at a scale does not improve the Y' error by at least 2% of the export noise, it is stored as zero there. Sharpening stays linear: nonlinear variants are not better on held-out frames, the remainder is limited by the export noise.
- **No automatic frame exclusion and no "harmful frame" flag in the wizard, only a tip** (2026-11-23). Leave-one-out over 7 sets of 6 frames (the user's session plus 6 random sets from the 34 SA pairs, 49 fits) measured how much each frame hurts the 28 frames outside its set. Harm above 0.1 dE happened in 2 cases of 42, both in the user's session (night DSC_6151 +0.17, light portrait DSC_6397 +0.13); in random sets the maximum was +0.07 and an average frame helps (-0.03). Harm depends on the set: DSC_6151 helps in another set (-0.07). Nothing computable from the session predicts it: the frame's own leave-one-out gap r = 0.0, the effect on the other frames of the set r = 0.35 (and it misses both cases), the tone deviation of the frame from the set r = 0.38 (one hit in its top 4). A wrong flag costs as much as a right one gains (removing a good frame -0.12). The wizard's pair recommendations say instead: for a universal profile, pick different but typical scenes.
- **`--refine` accepts one name.** The previous one is the profile the render was made with, the result goes to `name_r1`, `name_r2`. The form with two names remains, the forms differ by argument parity.

## What did not work

| Attempt | Result |
|---|---|
| A per-channel curve model, by the lightness ratio, in Oklab | Worse than Y' Rec.601 |
| Matrix and curve as development | dE 4.82 on the chart |
| Response scales from real renders (`calibrate.py`) | 3.02 -> 3.01, validation worse, removed |
| Grading on lightness after the curve | 3.02 -> 3.45 |
| Grading as a function of lightness before the curve | 3.02 -> 3.10 |
| Blender suppression on neutrals | 3.02 -> 2.89, not added |
| A free grid-table search | Catches multiple periods, initial values needed |
| The FaceDetect tag for finding portraits | Not present on the Z f, portraits were found by the skin-tone share |

## Found bugs

- A manual entry of the NP3 base gave 396 bytes instead of 392: the blocks were generated from `third_party/base.ts`.
- Aligning portrait frames gave ncc around 0: there is no orientation in the XMP, a rotation search is needed.
- A tilted crop was computed by the frame sides, but they are corners: the alignment was 0.36-0.65, became 0.75-0.85.
- The fit stalled on flat curve segments: a zero jacobian, the step blew up. A lower bound on the diagonal was added in `fit.lm`.
- The inverse curve is unstable on flat segments: a small slope was added in `fit_photos.Photo.predict`.
- Lens correction ruined the alignment at a scale above 3%: a radial model was added.
- `match.py` crashed without a name in the command: the name became optional, argument checks added.
- Without XMP edits silently went into the profile: a warning was added.
- All 8 `nekit_examples_*` profiles were named `NPF-NEKIT_EXAMPLES_` inside: the name was cut from the start, the frame was lost. Now the end of the name is taken. Old files are not renamed, tell them apart only by the folder.
- `--refine` did not save `pairs.json`, and on the second round the WB and exposure take-out silently disappeared: the file is now copied.
- A TIF path instead of a profile name crashed with a traceback: profile and file checks added.
- The Fuji targets on 5 frames were with the Astia Look, and the draft target was without the Look: the Look preset does not reset, Astia remained from the previous processing. The targets were re-exported, `out/fuji160_r1` is obsolete.

## Limitations

- **Z f only.** Development, probes and frame fields are tied to the camera. Another one needs a one-off calibration, and the camera must support Flexible Color.
- **NEFs from the Z 8 in `test2/` are not read:** LibRaw 0.22.3 writes "Unsupported file format", `rawdev.py` crashes. By size (31 MB for 45 MP) it looks like High Efficiency, the compression is not confirmed.
- **DNG:** supported in `match.py`, WB is taken from `AsShotNeutral`. Tested on DNGs assembled from Z f NEFs, a real DNG from Adobe DNG Converter was not tried. LibRaw does not open phone DNGs. The Temperature/Tint to coefficients relation is trained on the Z f, on other cameras the WB take-out will be shifted.
- **Not tested:** NEF High Efficiency on the Z f, smaller RAW formats, 1:1 and 16:9 frame formats, ISO above 12800.
- **Color and tone only in the fit.** Sharpening, noise, grain, vignetting and local corrections are not compared and are not carried into NP3. The render computes Clarity, Sharpening and Mid-range (`detail.py`), they do not enter the fit.
- **The render maximum is half the sensor.** `rawdev.py` develops with `-h` (3024 px), so sharpening is visible only at scale 2. By band energy our development at x2 matches the NX export within 10% (spec/camera-response.md), NX noise is not emulated.
- **There is no WB in NP3.** The match depends on the camera WB.
- **One preset.** Everything is measured on the preset with Astia. Strong processing beyond ±60 may behave differently.
- **Colors outside the pairs are not fitted.** Different scenes are needed.
- **DNG as a target:** only the preview inside the file is read (256x171 for a DNG from Adobe DNG Converter), the alignment is worse (0.71-0.76). Better give the target as JPEG or TIFF.
- **Pairs must be with one preset.** Different manual edits per frame are not repeated by one profile; on `test2/` outside the fit dE is 9.0.
- **The `Fuji 160C 2N` camera profile was not applied** by the export tool, `fuji160/DSC_4837.tif` has `MissingCameraProfile`. The Fuji targets are the base rendering without a Look plus the preset settings. For a real Fuji 160C 2N, the camera profile, new exports and a new draft are needed.
- **`triage.py` does not write `pairs.json`.** A `--refine` from such a profile without copying the file will send WB and exposure into the profile.
- **The `triage.py` verdict does not check the transfer.** The thresholds were tuned on the same 11 Z f pairs, not validated on independent pairs. Alignments from 0.6 to 0.88 pass without a warning. The NP3-vs-LUT gap, grading strength and Dehaze, Clarity, Texture from XMP do not take part in the verdict.
- **Dehaze, Clarity, Texture are local.** NP3 has no place for them, the fit tries to replace them with the curve and the blender.
- **The curve is not constrained outside the data.** On underexposed frames the top of the curve is undefined, and on normal frames such a profile will blow out.
- **Strength changes color and tone together.** It softens the blowout but not its cause: `test_nekit_autumn` at 30% still raises the midtones, 94 -> 118.
- **The solution is ambiguous.** Different profiles give a close error at different settings.
- **Another camera is not tested.** The `--scene` mode was tested only on the Z f.
- **In-camera RAW processing** as an NX Studio replacement was not tested.
- **The WB and exposure take-out** was not verified against a real render.
- **Color chart:** the sheets for printing exist (`print_chart.py`), automatic patch finding is not there yet, the plan is in [charts.md](charts.md) (moved to the np3-fit-charts project). Shooting a chart off a screen does not work for different cameras.
- **Zone grid, 2026-11-23:** the fit ran into Blending 0-4 with zone brightness -100/+67, where the old mask model was off from NX by 2-3 dE (`renders/sweep/nxcheck`). Eight probe packs (`sweep.py zones` .. `zones8`) measured zone brightness, zone color on eight hues and three chroma levels, color + brightness of one zone and two zones at once on a Blending x Balance grid; `profile_model.train_zone_grid` replaces the masks off 50/0 and adds a chroma term (details in `spec/tools/profile_model.md`). zones5 showed that color at Blending 10 had been interpolated wrongly (up to 6-8 dE at |Balance| >= 75) and that one color table for all hues cost 0.2 dE. zones6 showed that NX adds the color of several zones up; the multi-zone error came from color at Balance ±20/±50, measured on one hue only until zones7 (1.26 -> 0.83). zones8 made the chroma term a table per Blending x Balance cell (chroma 80: 1.20 -> 1.04). Remaining: high chroma in several zones (random recipes with chroma 40-80 in all zones 2.5 dE), mostly the sum of per-zone errors that scale with chroma; single-zone color is 0.83 cross-validated against 0.65 in-sample, so the next step for the model would be more frames, not more cells. The web model (`profile.bin`) is 6.4 MB with the LUT tables as int8.
- **Fit: Cauchy loss and a second start, 2026-11-24** (`match.ROBUST`, `match.STARTS`/`STUCK`, the same in `web/lib/fit.js`). Each pixel's weighted dE goes through a Cauchy loss (c = 6). Measured with the zone grid model on 34 SA pairs (8 sets of 4-17 frames, held-out = the other frames): on 4-10 frames the held-out error is unchanged on average (-0.07..+0.04), the yellow house 6973 is better in every set (-0.03..-0.23); on 17 frames the plain fit converges badly (train 3.66, held-out 3.43) and the Cauchy fit does not (3.10 / 3.07). A second start (zone brightness shadows -50 / midtone +30) on every fit changed nothing on random sets and on the user's six frames won by 0.5% of cost while losing 0.07 dE held out, so it runs only when the first run is stuck (fewer than 5 accepted iterations; no run of 18 was). The fit time is unchanged. Real NX renders against the LR targets (`renders/sweep/fitcheck`, 12 SA frames, `_local/research/fitcheck`): the user's current profile (old model and engine, six frames) 2.71 on its frames / 3.38 on six held-out frames; the new model and engine on the same six frames 2.39 / 2.86; on four frames without the night and the portrait 2.49 / 2.46 (yellow house 6973: 2.83 -> 2.31 / 2.05; sky 4.37 -> 3.57 / 3.39, dark blues 3.60 -> 3.48 / 2.91). Sidecars made by NX for rated frames carried an active Brightness +0.28 (about +9 L); the check pack turns it off, as in all sweep packs.
- **Profile model, 2026-11-09:** grading is computed before the blender, blender color shares from a table of single-color probes of each color, grading with its own LUT per each of the 8 hue directions. Finished profiles outside the training: 1.69 -> 1.07. The on-screen chart shot was not taken into training: it made the validation worse.
- **`match.py` on the step model:** development `devmodel_render.npz`, vignetting before the crop, `--refine` computes the model difference between versions from a real render. The old on-screen chart model remains only for comparison (`Renderer(profile="patches")`).
