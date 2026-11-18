# devmodel.py

Training of the NEF development: linear camera RGB -> the Nikon neutral (the NX Studio render
with a neutral profile and Active D-Lighting "as shot").

## Usage

```
python3 devmodel.py           # cross-validation report (matrix+curve, LUT 17/25/33)
python3 devmodel.py --render  # train the render model -> data/devmodel_render.npz + data/devmodel_density.npy
python3 devmodel.py --density # recompute only the density -> data/devmodel_density.npy
```

## How it works

Training frames come from `devpairs.SETS` (`renders/dev/`, `renders/dev_africa/`...): NEFs with
neutral NX exports, aligned and shrunk (`data/<set>/*.npz` caches via `devpairs.py`).

The model `Dev` is a linear matrix (least squares), a monotone tone curve in Y', and a residual
3D LUT (`ceiling.Lut`, the render variant uses 25 knots) trained on warm-color frames in addition
to the random sample, because rebalancing the whole sample trades reds against green/magenta.

`--render` trains on all frames and saves `data/devmodel_render.npz` (used by `render.py` and
`match.py`) plus the development density `data/devmodel_density.npy` — training data density in
color cells, used by `match.py` as the pixel trust weight.

Accuracy: dE 1.85 on held-out frames for the LUT-25 variant (see `spec/results.md`).

## Data

Needs the neutral renders in `renders/<set>/neutral/` and NEFs locally; see `spec/tools.md`.
