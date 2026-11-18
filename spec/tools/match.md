# match.py

The main command: fits an NP3 profile to target renders from NEF/DNG + finished-shot pairs.

## Usage

```
python3 match.py name a.NEF a.jpg [b.NEF b.jpg ...]          # draft from pairs (name optional)
python3 match.py --analyze name [--adl Off] a.NEF a.jpg ...  # candidate analysis -> out/<name>/analysis.json
python3 match.py --refine name render_a.TIF a.jpg ...        # correction by NX renders of the previous version
python3 match.py --refine name2 name render.TIF a.jpg ...    # the same with a custom result name
python3 match.py --scene name a.NEF a.jpg [...]              # different shots of one scene / another camera
python3 match.py --scene-refine name render.TIF a.jpg [...]  # correction by an NX render, block-based
```

Files always come in pairs: a NEF/DNG and its finished export (JPEG or TIFF). The name may be
omitted in the draft: it is taken from the first shot.

## Arguments

- `name` — the profile version; the result goes to `out/<name>/` (`out/<name>_r1`, `_r2`... for
  auto-named corrections). 1-19 ASCII characters go into the NP3 name, the end of the folder name.
- `--adl Off|Low|Normal|...` (with `--analyze`) — recommend only frames with this in-camera ADL.
- `--refine` — `name` (or `name2 name`) followed by pairs "NX Studio render with the previous
  profile + target export". The WB/exposure take-out is read from `out/<name>/pairs.json`, so the
  target paths must match the draft's; `pairs.json` is copied into the new version.
- `--scene` / `--scene-refine` — the targets are different shots of the same scene (possibly from
  another camera); XMP WB/exposure is not used and not aligned.

## How it works

1. The NEF is developed into linear RGB (`devpairs.build`, vignetting removed, WB/exposure from
   the XMP subtracted via `wbmap`).
2. `data/devmodel_render.npz` turns the development into the Nikon neutral.
3. The frame is aligned with the target and shrunk to 256 px on the long side (cache `data/match/`).
4. ~4000 pixels per pair are sampled with weights: area x rare-color weight (`analyze.rarity`) x
   development trust (`devmodel` density).
5. Color with a profile is computed by the step model `profile_model.py`.
6. The fit (Levenberg-Marquardt, `fit.py`): 24 blender values, 3 grading zones, 20 curve points,
   Saturation, three zone brightnesses, Blending and Balance; residual over the dE2000 components,
   kC = 0.5, FLAT_L; regularization: curve smoothness, pull to zero, neighbor pull, curve end to white.
7. Light almost-grey pixels (a channel >= 0.98, darkest >= 0.8, up to 3000 per pair) enter with a
   one-sided penalty on the pinned channel, so a white-knee curve is not pulled down.
8. The NP3 is written with sharpening 2.0, mid-range 1.0, clarity 0 (defaults, not fitted), plus
   `analysis.json` and `pairs.json` in `out/<name>/`.

In `--refine` the prediction is `real render + model(n1, new) - model(n0, previous)`: development
and model errors mostly cancel in the difference. `--refine` prints the `now` line (the error of
the previous version's render) and the region report before/after.

## Output

`out/<name>/NIKON/CUSTOMPC/PICCON01.NP3`, `analysis.json`, `pairs.json`; a region report, coverage
and set advice (`--analyze`), warnings about masks, vignetting, grain, per-frame edits.

## Data

Needs `data/devmodel_render.npz`, `data/profile_model.npz`, `data/wbmap.json` and LibRaw
(`dcraw_emu`). Calibrated for the Nikon Z f only.
