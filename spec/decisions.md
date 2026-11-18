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
- **ADL is off** for shooting and rendering.
- **Detail is a separate step after color, over Y' only.** Color and fitting (`match.py`, `compare.py`) run without it: `Renderer.apply(..., sharp=True)` enables the step only for a frame in `render.py` and `ui.py`. The model is trained per export scale separately (2: the full `--full` development, 4: the 1600 px preview): small-radius sharpening after shrinking is not the same mask with radius/k. If a tool at a scale does not improve the Y' error by at least 2% of the export noise, it is stored as zero there. Sharpening stays linear: nonlinear variants are not better on held-out frames, the remainder is limited by the export noise.
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
- **DNG as a target:** only the preview inside the file is read (256x171 for a DNG from Lightroom), the alignment is worse (0.71-0.76). Better give the target as JPEG or TIFF.
- **Pairs must be with one preset.** Different manual edits per frame are not repeated by one profile; on `test2/` outside the fit dE is 9.0.
- **The `Fuji 160C 2N` profile was not applied.** Lightroom did not find it, `fuji160/DSC_4837.tif` has `MissingCameraProfile`. The Fuji targets are Adobe Standard without a Look plus the preset settings. For a real Fuji 160C 2N, a profile in Lightroom, new exports and a new draft are needed.
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
- **Profile model, 2026-11-09:** grading is computed before the blender, blender color shares from a table of single-color probes of each color, grading with its own LUT per each of the 8 hue directions. Finished profiles outside the training: 1.69 -> 1.07. The on-screen chart shot was not taken into training: it made the validation worse.
- **`match.py` on the step model:** development `devmodel_render.npz`, vignetting before the crop, `--refine` computes the model difference between versions from a real render. The old on-screen chart model remains only for comparison (`Renderer(profile="patches")`).
