# profile_model.py

The step-based profile model: how an NP3 profile transforms the Nikon neutral color. Trained on
the probe packs of `sweep.py`; used by `render.py`, `ui.py`, `compare.py` and `match.py`.

## Usage

```
python3 profile_model.py     # train -> data/profile_model.npz, then validation on data/sweep2.npz
```

No arguments.

## How it works

Training data: single probes from `data/sweep.npz`, `data/sweep3.npz` (each blender color
separately, grading every 45 degrees) and `data/sweep4.npz` (Saturation, tonal sliders, zone
masks, grading brightness); validation on `data/sweep2.npz` (outside the training). Takes about
5 minutes.

Structure (order of steps):

1. Zone grading: an additive color offset, a LUT per each of the 8 hue directions (trigonometric
   interpolation), masks over the neutral Y' (Blending/Balance shift the masks).
2. Saturation: Cb/Cr multiplication in Y'CbCr.
3. Blender: hue rotation + chroma scale in CIELab with brightness added; a color set's response is
   a 3D LUT over the neutral color, a single color's share — by Oklab hue sectors from
   single-color probes.
4. The curve last (only Y' Rec.601, Cb/Cr untouched); the tonal sliders are Y' curves of their own,
   incompatible with a curve in NP3.
5. Zone brightness: a 3D table over color per zone and sign.

The response is linear in the slider value up to ±60 (`fit.LIMIT`). On 14 finished profiles
outside the training the model gives dE 1.07 vs 2.32 for the old on-screen chart model
(details in `spec/results.md`).

## Interface

- `Model.train()` / `Model.load()` — training and loading `data/profile_model.npz`.
- `Model(grid, c)` — colors of a knot grid under a control `c` (used for LUT baking).
- `Pixels(model, fb)` — precomputes everything that depends only on the neutral (blender inputs by
  grading, pre-curve result by grading and blender), so the numerical jacobian in `match.py` moves
  one parameter at a time; fitting FIT4 from three pairs: 25 s instead of 313.
