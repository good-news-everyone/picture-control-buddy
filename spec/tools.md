# Tools

Python, numpy and PIL only. External programs: `dcraw_emu`, `unprocessed_raw`, `raw-identify` (LibRaw). No Node, scipy, rawpy, exiftool.

## Workflows

### The same shot: a NEF or DNG and a finished JPEG

A Bayer DNG is suitable, without JPEG XL.

```
# 0. Candidate analysis: colors, lightness, ADL, suitability, a set recommendation -> out/<name>/analysis.json
python3 match.py --analyze name [--adl Off] a.NEF a.jpg b.NEF b.jpg ... (any number of pairs)

# 1. A draft from 3 different pairs, the name is optional; prints coverage and a region report
python3 match.py name a.NEF a.jpg b.NEF b.jpg c.NEF c.jpg

# 2. In NX Studio: the same NEFs, profile out/<name>/NIKON/CUSTOMPC/PICCON01.NP3, Active D-Lighting as shot, export TIFF

# 3. Correction against renders
# <name> is the profile the render was made with; the result goes to out/<name>_r1
# by analysis.json it advises which frame renders to add, and prints regions before and after
python3 match.py --refine name render_a.TIF a.jpg render_b.TIF b.jpg render_c.TIF c.jpg

# Any NX renders vs targets by regions
python3 analyze.py render_a.TIF a.jpg [...]

# NEF/DNG only, without targets: colors by our Nikon neutral, lightness, ADL, a set recommendation (~1 s per frame, parallel)
python3 analyze.py [--adl Off] [--save name] a.NEF b.NEF folder/ ...
```

Rules for pairs:
- Different scenes that together cover the needed colors: sky, skin, saturated red.
- Lightroom export with all metadata.
- WB and exposure from the XMP are subtracted automatically; for `--refine` they are taken from `out/<name>/pairs.json`, so the paths to the finished shots must match. The correction copies `pairs.json` into the new version. Profiles from `triage.py` have no such file.
- A custom version name can be given first: `--refine name2 name render.TIF a.jpg`. Existing folders are not overwritten by the auto-name.
- `--refine` needs both files per frame: an NX Studio render with the previous profile and a Lightroom export with the preset. The export can be JPEG or TIFF.
- The name in the command is not verified against the render: the code assumes the TIF was made with profile `name`. There is no profile name in a TIF, the sidecar stores only the last assignment.
- A frame not from the draft with WB or exposure edits needs a `pairs.json` entry, otherwise the edits go into the profile. Frames with As Shot and zero exposure have nothing to take out.
- Profiles from `triage.py` lack `pairs.json`: copy the file from the shared profile before the correction.
- Before exporting check the Look: a preset without its own Look leaves the previous one on the frame. Compare the metadata with the draft target.

### Different shots of one scene, another camera

```
python3 match.py --chart name folder|patches.npz [--hold sheet=N|series=N|ev=N]   # printed sheets, see charts.md in np3-fit-charts
python3 match.py --scene name a.NEF a.jpg [b.NEF b.jpg ...]
python3 match.py --scene-refine name render_a.TIF a.jpg [...]
```

Shoot from a tripod at one spot, close focal length, a static scene, the same exposure and WB. XMP is not used, exposure and WB are not aligned between cameras.

### Pair triage

```
python3 triage.py folder [folder ...]
```

For each pair in a folder (DNG or NEF next to JPEG or TIFF) its own profile `out/<folder>_<frame>` is fitted, a summary in `data/triage_<folder>.json`. Columns: neutral difference, NP3 residual, own-LUT ceiling per frame, alignment, input, where the curve reaches white, color count.

Thresholds were tuned on 11 Z f pairs: NP3 up to 3.7 is good, above 5 is bad, LUT above 4 means local processing, white before 230 means blowout. Few colors and a blender at its limit go as a note.

### Profile strength

```
python3 strength.py name|folder|file.NP3 30 50 70
```

There is no strength slider in NP3, so each strength is a separate file and a separate camera slot. Files go to `out/<name>_strength/NIKON/CUSTOMPC/PICCON01...`, names like `NPF-...-50`. Blender, grading and sliders are multiplied by the fraction, the curve is blended with the identity, sharpening is not changed. Above 100 strengthens the profile.

### Viewing a render without NX Studio

```
python3 ui.py [port]                               # http://127.0.0.1:8765, the address #DSC_6203 opens a frame
python3 render.py frame.NEF name|file.NP3 [a.jpg]  # a single frame to a file
python3 compare.py                                 # data/compare/index.html: prediction vs NX renders
```

### The browser NP3 editor (MVP, a static application)

```
# serve the project root with any static server and open /web/index.html
python3 -m http.server 8000                        # then http://127.0.0.1:8000/web/index.html
```

`web/index.html` is a visual NP3 editor per `spec/ui-manual-mvp.md`: loading NEF/DNG (Worker + WebAssembly), NP3 import/export, all sliders, a curve editor, strength 0-150%, before/after. All computation runs in the browser, the server only serves statics; Python is not needed. Checks: `node web/test.mjs` (level 8 — the end-to-end UI of the real page in headless Firefox). The stands `web/bench.html` (neutral vs reference) and `web/test.html` (the test executor) are internal, not the UI.

### Profile model data without manual assignment

```
python3 sweep.py full       # renders/sweep/full: NEF copies, profile written into the sidecar
python3 sweep.py extract    # exports from renders/sweep/full/tif -> data/sweep2.npz
python3 profile_model.py    # step-based profile model -> data/profile_model.npz and validation
```

In NX Studio open the folder, select all and export into `tif/` or right into the pack folder: TIFF 8 bit, sRGB, long side 1512 px. Do not change the settings.

`ui.py` finds frames and finished frames in the project folders, profiles in `out/`. The curtain compares the neutral, the prediction, the target and the NX renders. Strength changes on the fly, "Save NP3" puts the file into the next free `out/<name>_strength` slot. The development cache lives in `data/ui/`, it can be deleted.

The render is approximate, numbers in `results.md`. A real render is needed for the profile decision: sharpening, clarity, lens correction and NX noise reduction are not computed.

### Checking a profile on frames

```
python3 check.py renders/check/<folder with NX renders>
```

Targets are taken from `renders/check/lightroom/` and `renders/check/done/`. Pairs are saved to `data/check.npz`. Not suitable for own frames: the XMP crop and the WB/exposure take-out are not accounted for. The render error on one's own frame is shown by the `now` line in `--refine`.

### Preset calibration by the chart (the manual FIT1-FIT4 path)

```
python3 extract_chart.py          # patches of 29 probes and targets -> data/chart.npz
python3 fit.py fit1               # fitting by the chart
python3 fit.py fit2 fit1          # correction by the FIT1.TIF render
python3 fit_photos.py fit3 fit2   # the chart and frames from data/check.npz
```

(the chart path now lives in the np3-fit-charts project)

## Modules

| File | Purpose |
|---|---|
| `np3.py` | NP3 reading and writing |
| `color.py` | sRGB, Oklab, Lab, dE2000 |
| `make_pack.py` | 29 probes, `chart.png`, manifest |
| `fit.py` | The shared fitting core: parameter packing, the Levenberg-Marquardt solver |
| `rawdev.py` | Linear development of NEF and DNG via `dcraw_emu -w -o 0 -4 -h -t 0` |
| `devpairs.py` | Alignment: rotation, crop, distortion, shift |
| `sweep.py` | A pack for NX Studio: NEF copies with a profile in the sidecar, export in one action. `pilot`: check that NX accepts such files; `full`: 5 frames, 200 profiles (slider pairs, 14 finished profiles without sharpening, 150 recipe-like); `extract` collects `data/sweep2.npz`; `colors`: 10 frames, 97 profiles (each blender color separately at 40, grading every 45 degrees at 15/25/40), `extract colors` -> `data/sweep3.npz`; `tools`: 10 frames, 118 profiles (Saturation, Contrast, Highlights, Shadows, White, Black at ±25/50/100, grading brightness, Blending, Balance, Clarity, pairs and 30 random recipes), `extract tools` -> `data/sweep4.npz`. A sidecar with a built-in profile is brought to the custom form: a `Custom` block is added, `PictureControl` = 1 |
| `profile_model.py` | The step-based profile model: grading, blender, curve. Trained on single probes `data/sweep.npz`, `data/sweep3.npz` and `data/sweep4.npz` (Saturation, tonal sliders, zone masks, grading brightness) -> `data/profile_model.npz` (about 5 minutes), validation on `data/sweep2.npz`. It is used by `render.py`, `ui.py`, `compare.py`, `match.py`. `Pixels` precomputes everything that depends only on the neutral and remembers blender inputs by grading, and the pre-curve result by grading and blender: the numerical jacobian moves one parameter at a time. Fitting FIT4 from three pairs: 25 s instead of 313 |
| `vignette.py` | Vignette correction from the NEF and the embedded JPEG, cache `data/vignette/` |
| `devmodel.py` | Training NEF development -> Nikon neutral; `--render` writes `data/devmodel_render.npz` for `render.py` and `match.py` |
| `wbmap.py` | Lightroom Temperature/Tint <-> NEF WB_RBLevels |
| `match.py` | The main command |
| `strength.py` | Profile versions at different strengths |
| `render.py` | Approximate NEF or DNG render with an NP3: development and a baked 33^3 3D LUT |
| `ui.py`, `ui.html` | Local viewer, stdlib only (kept locally in `_local/`) |
| `compare.py`, `compare.html` | A page comparing the prediction with NX renders (kept locally in `_local/`) |
| `triage.py` | Pair triage: a profile per frame and a fit assessment (kept locally in `_local/`) |
| `scene.py` | Alignment of different shots and color blocks |
| `check.py` | Checking NX renders against Lightroom exports (kept locally in `_local/`) |
| `match_check.py` | Fit validation by NX renders: `fit` fits 14 finished profiles from three pairs with NX exports, `pack` puts the original and fitted profiles onto 8 other frames into `renders/sweep/match_check`, `eval` compares the NX renders of the fitted and original |
| `eval_path.py` | Prediction from a NEF against the real FIT4 render (kept locally in `_local/`) |
| `how_many.py` | How many pairs are needed (kept locally in `_local/`) |
| `pairs.py` | Embedded JPEG, XMP, crop, alignment |
| `ceiling.py` | The ceiling on Georgia |
| `pick_frame.py` | NEF rating by color coverage |
| `analyze.py` | Candidate scoring for fitting, region reports |
| `test_np3.py` | Checks |

The chart-specific modules (`chart_patches.py`, `charts.py`, `print_chart.py`, `extract_chart.py`, `fit_photos.py`, `test_charts.py`) live in the np3-fit-charts project, as do the training-data collections (`data/sweep*.npz` etc. locally in `_local/`).

## How `match.py` works

1. The NEF is developed into linear RGB, vignetting is removed before the crop (`devpairs.build(devignette=True)`, WB and exposure corrections from the XMP are applied.
2. The development `data/devmodel_render.npz` makes the Nikon neutral, as in `render.py`.
3. The frame is aligned with the target and shrunk to 256 pixels on the long side. Cache `data/match/`, the key carries the `v2` version. Color shares are not lost (vest 7155: 2.35% at 768 px, 2.33% at 256), and noise, grain and edge mismatch are smaller (dE 2.27 vs 1.94 on the same frame).
3a. Sampling: about 4000 of ~43k frame pixels go into the fit. Rare colors are sampled more often with a correction multiplier, so a pixel's weight is area x `analyze.rarity` (set bin frequency to the power -0.5, at most 10) x development trust (`devmodel.trust`: development training density in the color cell, `data/devmodel_density.npy`, full at >= 3e-5). Without the trust, the weight of rare colors taught the profile the development error: vest 7155 is C +11.7 more saturated than the NX neutral for us, and the profile was damping the orange.
4. Color with a profile is computed by the step model `profile_model.py`.
5. Fitted: 24 blender values (±60), 3 grading zones, 20 curve points, Saturation, three zone brightnesses, Blending and Balance. The tonal sliders are not fitted: they are incompatible with the curve in NP3.
6. The residual over the dE2000 components (`color.de2000_weights`: lightness, chroma, hue with weights at the target color and the RT rotation for blues; agrees with dE2000 within 2%), since 2026-11-11 instead of a Lab difference. The chroma weight `KC` = 0.5, stricter than the standard: at kC 1 the sky paled. Lightness with an even weight (`FLAT_L`), without SL: otherwise the curve's white knee fit worse. The same in `--refine`.
7. Regularization: curve smoothness, pull of values to zero, pull of neighboring wheel colors towards each other, curve end to white.
8. Light almost-grey target pixels (a channel >= 0.98, the darkest >= 0.8), up to 3000 per pair: a pinned channel is penalized one way (prediction not darker), the rest as usual. Without them, at the white knee only pixels with a lower output remained, and the curve came out lower. Saturated colors are not included: the penalty on their channel pulled the FIT4 curve up.
9. The NP3 is written with sharpening 2.0, mid-range 1.0, clarity 0. These are default values, not fitted.
10. Warnings: a blender color below 1% of pixels and sky (light blues and cyans) below 3% in the fitting frames.
11. Analysis (`analyze.py`): target color groups (greys, skin, warm saturated, warm muted, yellows, greens, teal, sky, dark blues, purple), lightness, white, camera ADL, "lift" — target vs neutral in L. The draft writes `analysis.json` with the fitting frames (`fit`), `--analyze` adds candidates to it, `--refine` advises frames by it. The set is recommended greedily: close the groups and keep the mean lift of the set at the candidate median, because the curve is shared and the fitting frames set the lightness of the rest.
12. Region report: per group dE, dL, dC, dhue and the mean over color bins; the pixel mean hides small objects.

In `--refine` the prediction is the real render plus model(n1, new) - model(n0, previous). n0 is the neutral from the NEF (by `pairs.json`), n1 is the same with the target's WB and exposure corrections. Without a NEF and in `--scene-refine` the neutral is recovered from the render by inverting the model, 8 iterations. Development and model errors mostly cancel in the difference.

The `--refine` output: `now` is the error of the previous version's render, with the WB and exposure difference accounted for. `prediction` is the forecast on the fitting frames, not a validation. `pairs.json` is copied to the new version.

The NP3 gets the end of the folder name, 15 characters: the frame and the correction number live there.

## How `--scene` works

1. Alignment by edges: rotation by 90 degrees, scale 0.6-1.6, tilt ±4 degrees, then a homography from the local shifts of tiles.
2. Blocks of 14 pixels on a 1024 frame. A block is taken if its color barely changes under a 4-pixel shift: edges are filtered out, grass and foliage stay.
3. At most 12 blocks per color cell, otherwise the sky drowns out the rest.
4. A second pass without the worst 15% of blocks.

## `match.py` warnings

Unreadable file, poor alignment, no XMP, masks, vignette, grain, colors almost out of frame (less than 1% of colorful pixels in the sector).

## Data

| Path | What is there |
|---|---|
| `out/pack1/` | Probes `NIKON/CUSTOMPC`, `chart.png`, `manifest.json`, chart NEFs (gitignored, generated) |
| `out/fit1...fit4/`, `out/m1`, `m1b`, `m3`, `m3b`, `test1`, `test1b` | Profiles (gitignored) |
| `portra400/`, `fuji160/` | NEFs, Lightroom targets, NX renders (gitignored, local) |
| `out/portra400*`, `out/fuji160*` | Profiles. Working `_r2`, `out/fuji160_r1` was fitted to wrong targets (gitignored) |
| `renders/check/` | 11 NEFs and renders by `nxstudio*` folders; Lightroom exports in `lightroom/` and `done/` (gitignored) |
| `renders/dev/` | 35 NEFs and neutral renders `neutral/` for development training (gitignored) |
| `renders/dev_africa/` | 25 NEFs from South Africa and neutral renders `neutral/` for development training: magenta, red, orange, skin, sky. A new set is added to `devpairs.SETS` (gitignored) |
| `renders/sweep/` | NEF copies and sidecars of `sweep.py`, export into `<set>/tif/`. `pilot`: 12 copies, export in the folder root (gitignored) |
| `data/sweep.npz` | The first `full_v1` pack: 10 frames, 120 profiles, 378 px, and the NP3 of each profile. The exports themselves are deleted (local, `_local/`) |
| `data/sweep2.npz` | The second pack, after export (local, `_local/`) |
| `data/devmodel.npz` | Trained development (reference export, `devmodel_render.npz`) |
| `data/wbmap.json` | WB coefficients |
| `data/dev/`, `data/match/` | Aligned-pair caches |
| `data/check_*.npz` | Render-target pairs by versions (local, `_local/`) |

## NX Studio export settings

TIFF 8 bit or maximum-quality JPEG, sRGB, no resizing. Change only the Picture Control and ADL. The file name as in the NEF.
