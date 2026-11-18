---
name: np3-fit-project
description: "Fitting Nikon NP3 from photo examples: ~/expirements/np3-fit — what is done, the ceiling on Georgia, waiting for probe renders"
metadata:
  node_type: memory
  type: project
  originSessionId: 0f1a47e5-7570-4631-b198-bcf19353e820
  modified: 2026-11-04T21:06:14.808Z
---

2026-11-05: ~/expirements/np3-fit — our own Flexible Color NP3 fitter. np3.py (byte-exact 13/13 on ssssota samples), pairs.py (NEF -> LR export pairs by the XMP crop), ceiling.py (the ceiling), make_pack.py -> out/pack1: 29 probes + chart.png + instructions. No Node, numpy+PIL only; no scipy/rawpy.

The ceiling on 60 Georgia frames, held-out frames, dE2000: source 7.86; own WB/exposure 5.46; shared NP3-like 5.14; shared 3D LUT 5.20; own LUT per frame 3.18. The shooting used the custom PC profile KEktr-100-skinfixG2, and it is already near the ceiling: a new shared profile gives only -0.32 dE [-0.52, -0.08]. The embedded JPEG in such NEFs contains this recipe, it is not a neutral base. There is no full recipe in a NEF, only the name and the base.

2026-11-05: the user shot the chart (out/pack1/DSC_6754.NEF, 28 patches clipped, not reshot) and rendered all 29 probes themselves: out/pack1/raw/copies/*.TIF; Lightroom target out/pack1/raw/target/target.tif (Adobe Standard + Astia Look + edits). extract_chart.py -> data/chart.npz, model.py, fit.py. Measured: the curve changes only Y' Rec.601, leaves Cb/Cr alone (dE 0.55); the blender is linear (V-HALF dE 0.22); saturation is nonlinear, not fitted; V-RANDOM predicted with dE 2.6 vs 6.9 for neutral. out/fit1 = the first fitted profile NPF-FIT1: the model gives 9.6 -> ~3.7, ~5.0 on held-out tone blocks. Camera vs NX on neutral dE 0.96.

FIT1 really rendered in NX Studio: dE to the target 3.73 (neutral 9.58), model vs render by patches dE 2.5. out/fit2 = NPF-FIT2, correction via `python3 fit.py fit2 fit1` (render-vs-model difference as a constant correction), prediction 3.19.

FIT2 really rendered: dE to the target 3.06, p95 5.78 (pairwise vs FIT1 -0.67 [-0.89, -0.44]); model with the correction vs render dE 1.33. FIT2 is the current candidate, one more chart iteration is not done: the residual is mostly in the highlights, where the curve end is pinned to white without measurement.

2026-11-05: renders/check/ obtained (4 NEFs, nxstudio/ and lightroom/, check.py compares). With FIT2 dE 7.23, but the comparison is unfair: all 4 shots were taken with ADL Normal, the chart with ADL Off; the validation sidecars have ApplyActiveDLightingFilter=true. The .nksc sidecar: nine:NineEdits is escaped XML, the probe name in base64 inside the nikon::PictureControl filter, ADL there too.

ADL Off: FIT2 on frames dE 5.13. out/fit3 = NPF-FIT3 (fit_photos.py: chart + 4 frames): real render, renders/check/nxstudio_fit3, ADL off (verified): all 6 frames dE 3.05, p95 7.14; 2 new frames outside the fit DSC_6582 2.85, DSC_6702 3.15; chart 3.20. This is the final candidate. Sidecar: ActiveDLightingFilter 1 = Off with Apply=true.

FIT3 residual: highlights with target Y 0.75-0.9 (1.5% of pixels) NX is brighter by 0.135; blowout DSC_6522 11.5% vs 5.1% — this is the R channel on the red car, not lightness; reds dh -7; blues 225-270 dL +5.3.

out/fit4 = NPF-FIT4 (`python3 fit_photos.py fit4 fit3`, sampling biased to highlights and clipping). Real renders, ADL Off: 8 frames dE 3.16 (FIT3 3.20), chart 2.89 (3.20); portraits outside the fit DSC_4902 3.84 (4.26), DSC_5118 3.05 (3.02); skin 4.36 and 3.58, slightly darker than the target, L -3, b -2. Reds 4.50 -> 3.33, highlights Y 0.75-0.9 7.78 -> 5.21, DSC_4902 blowout 23.9% -> 0% (LR 5.4%). The cost: sky 270-315 2.60 -> 3.15, DSC_6456 3.34 -> 3.59. FIT4 chosen as the final one; no further iterations over the chart and frames.

2026-11-05: the camera accepted NPF-FIT4 with a curve, 3 frames DSC_6755-6757 (warm indoor light and night, ISO 2800-12800, ADL Off): embedded JPEG vs NX dE 0.97, JPEG vs LR 3.69, NX vs LR 3.49. The project is closed on FIT4; the LR exports of these frames live in renders/check/done/, not lightroom/. Only color and tone were compared on shrunk frames, sharpening and noise were not checked (the profile has sharpening 2.0, mid 1.0, clarity 0).

2026-11-05: the "NEF + finished shot -> NP3" tool is assembled: rawdev.py (dcraw_emu), devpairs.py (alignment with radial distortion), devmodel.py -> data/devmodel.npz (development to Nikon neutral, LUT 25, 1.85 dE on held-out frames), match.py (`python3 match.py name a.NEF a.jpg ...`), eval_path.py, how_many.py. Real renders from scratch, frames outside the fit: M1 (1 pair DSC_6755) dE 4.98, M3 (3 pairs) 4.40, FIT4 on the same 3.2; neutral 10.89. The prediction was optimistic by 0.4-0.8. The model from a NEF vs the real render dE ~3 (development 1.85 + additivity); response-scale calibration and the grading order did not help, the calibration was removed. Systematics: the chart grey is not neutral (b -9), real M1/M3 renders are yellower than the target, b +2..+4.

Feedback by a render: `match.py --refine new old render.TIF target ...`. Real renders outside the fit: M3b 2.84 (M3 4.40, FIT4 3.15), M1b 4.28 (M1 4.98); M3b on all 11 frames 2.85, but reds 6.34 vs 3.40 for FIT4: there was no saturated red in the three pairs. Workflow: 3 different pairs -> draft -> render these NEFs in NX -> --refine. match.py accounts for the XMP crop and warns about masks, vignetting, grain, different exposure and colors out of frame; verified on JPEGs from Georgia.

match.py takes WB and exposure out of the XMP: wbmap.py relates Lightroom Temperature/Tint to the NEF WB_RBLevels (21 As Shot frames, log error 0.004), the coefficients are applied to the linear development before the neutral. out/<name>/pairs.json keeps NEFs for --refine, and the correction for these edits is there too; --refine understands the crop via devpairs.build_render. The take-out was not verified against a real render. The name in match.py is optional.

scene.py + `match.py --scene name a.NEF a.jpg ...`: different shots of one scene, possibly another camera: alignment by edges (scale, rotation, homography), 14 px blocks stable to shift, at most 12 per color cell, a second pass without the worst 15%. Verified only on the Z f: different geometry of the same frame as an exact pair (3.87 vs 3.81, 3.94 vs 4.46), a neighboring frame with people is worse (5.15 vs 3.81). `--scene-refine` is a correction by an NX render with the same blocks. Not verified with a real other camera; the mode does not align exposure and WB between cameras. The user has no chart, practical frames later.

2026-11-05: no open NEF + NP3 renderer was found. The closest is b-z/Nikon-Recipes-to-LR-Profiles (MIT): a synthetic NEF with 24 720 patches (make-target, generator for Z 8), inserting NP3 into .nksc for batch NX rendering (prepare-nx). Idea for us: such a NEF instead of the on-screen chart as a way to measure the response more precisely; we have not read their code, have not tried it on the Z f.

2026-11-06: the full project specification lives in ~/expirements/np3-fit/spec/ (README, format, measurements, tools, results, decisions, plan). test2/ got 4 SKL_* pairs, not processed.

2026-11-06: match.py accepts DNG (WB from AsShotNeutral), the user does not want warnings about a camera that is not a Z f. Z 8 NEFs from test2/ are not read by LibRaw, probably High Efficiency; a real DNG from Adobe DNG Converter was not tried.

2026-11-06: strength.py — profile strength (`python3 strength.py name 30 50 70`), not verified by a render. test2 (Z 8, DNG): 4 frames with different manual processing, 9.0 dE outside the fit; the exposure take-out of -0.8 hurts, the curve goes into white from 148.

2026-11-06: nekit_examples (8 Z 8 pairs, DNG, different manual processing): prediction outside the fit 7.12 at neutral 9.10, shared out/nekit 6.17, data/nekit.log. The WB take-out on the Z 8 seems to hurt (DSC_1091 4.22 -> 6.57): the relation is trained on the Z f; better compute it via DNG matrices.

2026-11-06: the user considers different processings different profiles, no need to average them: the goal is to weed out bad pairs. triage.py: own profile per frame, own LUT ceiling, thresholds NP3 3.7/5, LUT 4, white 230. Good from nekit_examples: DSC_1091, 1133, 9916; bad DSC_8564, 9526 and all SKL_*.

2026-11-07: `--refine` accepts one name (`name_r1`, `name_r2`), `pairs.json` is copied, the NP3 gets the end of the name. Correction over 5 frames: portra400_r2 4.87 -> 3.39, fuji160_r2 4.46 -> 2.46 (prediction, not verified by a render), DSC_4837 2.88 -> 3.81 and 2.62 -> 2.66. The Fuji preset does not reset the Look, Astia remained on the targets: fuji160_r1 is obsolete, the targets were re-exported. Fuji 160C 2N is not in Lightroom.

**Why:** real frames cover colors poorly (best 26/48 cells), so an on-screen chart is needed; we measure the camera model ourselves.
**How to apply:** do not take the tables from the firmware-derived files of jolchmo/Z30 into the project: rights not confirmed. Only the idea of the structure was taken from them: the response is linear in the slider value, the plus and minus tables are separate, this must be confirmed with a probe of 29. Related to [[lightcraft-lr-profiles]].
