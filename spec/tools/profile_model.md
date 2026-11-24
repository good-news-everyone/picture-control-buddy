# profile_model.py

The step-based profile model: how an NP3 profile transforms the Nikon neutral color. Trained on
the probe packs of `sweep.py`; used by `render.py`, `ui.py`, `compare.py` and `match.py`.

## Usage

```
python3 profile_model.py         # train -> data/profile_model.npz, then validation on data/sweep2.npz
python3 profile_model.py zones   # zone grid -> data/zone_grid.npz (about 8 minutes)
```

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
6. Zone grid (`data/zone_grid.npz`, 2026-11-23): off Blending 50 / Balance 0 zone grading goes
   through tables on a Blending {0, 10, 25, 50, 100} x Balance {-100, -95, -85, -75, -50, -35,
   -20, 0, 20, 35, 50, 75, 85, 95, 100} grid instead of the tools masks (which do not add up at
   hard masks). Brightness: a 3D LUT per cell, zone and sign (`tb`), bilinear between cells, added
   as `tb(b, l) - tb(50, 0)` to the brightness table. Color: a shift of the zone mask over Y' per
   cell pooled over all hues (`tm`) plus a per-channel 3D-LUT multiplier for each of the eight
   GRADE_HUES, linear between neighbouring hues (`tc`, on the Balance columns with multi-hue
   probes: {-100, -95, -85, -75, -50, -20, 0, 20, 50, 75, 85, 95, 100}; ±35 is interpolated). At Blending 10 / Balance ±95 color is measured only together with zone
   brightness and is taken against the brightness-only grid. Two zones at once: a 3D LUT of what
   the pair adds beyond the single zones, per unit of the product of the two strengths (`ti`,
   Blending {0, 10, 25} x Balance {-75, -35, 0, 35, 75}, zero at Blending 50 and 100). Chroma: the
   color push of a zone is multiplied by `1 + ((c/40)^2 - c/40) * tq[zone, hue]` (a 3D LUT on four
   hues, linear between; zero effect at chroma 0 and 40), everywhere including Blending 50 /
   Balance 0; the chroma term is a table per cell too (Blending {0, 10, 25, 50, 100} x Balance
   {-75, -50, -20, 0, 20, 50, 75}, clamped outside). Trained by `train_zone_grid` on `sweep.py
   zones .. zones8` (`data/sweep6..13.npz`, looked up in `data/` then `_local/`; about 8 minutes;
   zones6 is validation only). Stored with `tm` as float16 and the LUT tables `tb`, `tc`, `ti`,
   `tq` as int8 with a float32 scale per LUT (`quantize_lut`, under 0.3/255 in sRGB); the web
   model ships the same values (`profile.bin` 6.4 MB). Without the file the
   model behaves as before.

Zone grid accuracy against NX, cross-validated by frame (train on 3 of 4 frames, test on the 4th),
old model -> grid: zone brightness 1.9-2.4 -> 0.64-0.70 dE at any Blending x Balance; zone color
on four hues 2.1-2.6 -> 0.79-0.83, on the in-between hues 2.2 -> 0.87, at Blending 10 2.3 -> 0.85-0.90,
at Balance ±20/±50 (eight hues) 0.73/0.83; chroma 15 / 60 / 80: 0.97 / - / 3.16 -> 0.54 / 1.16 / 1.04; color +
brightness of one zone at hard masks and extreme Balance 3.6 -> 1.00; two zones of brightness
2.3-3.5 -> 0.88; color in two zones 2.1-3.2 -> 1.09-1.26, in three 3.1 -> 1.55; fit-like
combinations 1.95 -> 0.88; random recipes (zones .. zones7) 1.45/2.14/2.40/3.04/3.31/3.46/- ->
0.96/1.15/1.30/1.22/1.97/1.75/1.59 (grading only; NX export noise is about 0.5-0.7). NX adds the
color of several zones up (zones6: a pair against the sum of its single zones differs by 0.5-0.8,
the noise of three exports), so there is no color interaction table; the error of multi-zone
recipes grows with chroma: per zone the error scales with chroma, and the errors of three zones
add up (three zones in-sample 1.33, cross-validated 1.55; NX itself is non-additive by 0.8-2.2 at
Blending 100). Single-zone color is 0.65 in-sample against 0.83 cross-validated: more frames would
help more than more grid cells now. Random recipes with chroma 40-80 in all zones: 2.54. The fitted profiles of
`renders/sweep/nxcheck` (frames partly outside the grid training): Blending 4 with strong zone
brightness 2.35 -> 1.30, Blending 0 1.96 -> 1.13, Blending 50 unchanged.

The response is linear in the slider value up to ±60 (`fit.LIMIT`). On 14 finished profiles
outside the training the model gives dE 1.07 vs 2.32 for the old on-screen chart model
(details in `spec/results.md`).

## Interface

- `Model.train()` / `Model.load()` — training and loading `data/profile_model.npz` (`load` also
  picks up `data/zone_grid.npz` as `Model.zgrid`).
- `train_zone_grid(model)`, `save_zone_grid`, `load_zone_grid`, `grid_cell` — the zone grid.
- `Model(grid, c)` — colors of a knot grid under a control `c` (used for LUT baking).
- `Pixels(model, fb)` — precomputes everything that depends only on the neutral (blender inputs by
  grading, pre-curve result by grading and blender), so the numerical jacobian in `match.py` moves
  one parameter at a time; fitting FIT4 from three pairs: 25 s instead of 313.
