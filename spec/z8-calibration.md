# Z8 calibration: shot list and procedure

A field checklist for calibrating the pipeline for the Nikon Z8 (project camera so far: Z f).
State as of 2026-11-18.

## Known Z8-specific issues (from earlier experiments)

- **NEF in High Efficiency is not read** by LibRaw (`dcraw_emu` crashes with
  "Unsupported file format", `spec/decisions.md`). Shoot **Lossless compressed**,
  or convert to DNG via Adobe DNG Converter (the DNG path of `match.py` is tested on Z8).
- **WB take-out (`wbmap`) is trained on the Z f and hurts on the Z8** (observed on
  `test2/` and `nekit_examples/`). Re-train it on Z8 frames, or implement the roadmap
  item: WB via DNG matrices instead of the Z f relation.
- All training models are Z f-only: `devmodel`, `profile_model`, `wbmap`.
  `detail.py`/`vignette.py` follow the same logic.

## Shot list (one shooting session)

1. **Development set, ~30-35 frames** — the most important part. Diverse scenes
   covering: sky, skin, saturated reds/oranges, yellows, greens, teal, purples,
   magenta; varied brightness, daylight and shadows; no blown highlights
   (blowout breaks the fitted curve). Low ISO, ADL Off for all frames, no in-camera crop.
2. **Sweep frames, 10** — ordinary frames for the probe packs; may overlap with set 1.
   Static scenes, some with fine texture (needed for the `detail` pack).
3. **Fitting pairs, at least 3** — NOT needed for the neutral (identity profile).
   Only shoot these if non-neutral profiles will be fitted for the Z8 later:
   three different scenes that together cover sky / skin / saturated red.
   Targets: export from NX Studio with the desired look, not the camera JPEG
   (the embedded JPEG carries the shooting profile and ADL and is not neutral).

## Procedure

1. **Shooting** per the list above. NEF Lossless only.
2. **NX Studio, batch 1 (neutrals):** set Neutral on the development set,
   export TIFF sRGB without resizing -> `renders/dev_z8/neutral/`.
   Keep the XMP block in exports (default); WB/exposure are taken from it.
3. **Code:** run `devpairs.py` for the new set, add it to `devpairs.SETS`,
   then `python3 devmodel.py --render` -> a Z8 `data/devmodel_render.npz` + density.
4. **NX Studio, batch 2 (probes):** `sweep.py pilot` first (check that NX accepts
   the sidecars), then `full` / `colors` / `tools` / `detail`. Open each pack folder
   in NX Studio, select all, export into `tif/` (~3 s per file; the full set is
   ~3000 exports, several hours — can start with pilot + full).
   Then `sweep.py extract ...` and `python3 profile_model.py` to re-train the
   profile model. The `detail` pack is exported at FULL size.
5. **WB:** collect frames shot at varied white balances and re-train `wbmap.py`
   on the Z8 data (or do the DNG-matrix variant from the roadmap).
6. **Fitting the profile** — not needed for the neutral; only for future
   non-neutral targets: `python3 match.py --analyze name ...` on the candidate
   pairs, draft from 3 pairs (`python3 match.py name a.NEF a.jpg ...`),
   then NX Studio renders with the draft profile and correction rounds
   `python3 match.py --refine name render.TIF a.jpg ...` — the standard workflow
   from `spec/tools.md`.
7. **Camera check:** copy the NP3 to the card `NIKON/CUSTOMPC/`, shoot a JPEG in-camera.
   NX Studio and the camera match (dE ~0.97, `spec/camera-response.md`), so an NX
   render check is sufficient for profile decisions.

## Scope (decided 2026-11-18)

"Neutral" = all NP3 sliders at zero, i.e. an identity profile. Fitting pairs and
`match.py` are NOT needed: a zero-slider profile adds nothing to the development.
The deliverable is the calibrated development itself — our render of a Z8 NEF with
an all-zero NP3 must match the NX Studio render with a zero/Neutral profile.
So the required steps are 1-3 (shooting, neutral exports, devmodel) plus 5 (WB).

The sweep packs (step 4) are only needed later, for fitting non-neutral profiles
on the Z8 (`profile_model.py`); for the neutral itself they are optional.
An all-zero NP3 file itself is trivial to generate (like the NEUTRAL probe in
`sweep.py` packs); the calibration is what makes it accurate.
