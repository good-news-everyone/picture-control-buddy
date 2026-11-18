# detail.py

The detail model: Clarity, Sharpening and Mid-range sharpening — spatial filters over the Rec.601
Y' luma in encoded sRGB, leaving chroma untouched. Empirical, from NX Studio probes
(`spec/camera-response.md` has the measurements).

## Usage

```
python3 detail.py collect tools     # renders/sweep/tools exports -> data/detail_tools.npz (scale 4)
python3 detail.py collect detail    # renders/sweep/detail exports (full size) -> data/detail_full.npz
python3 detail.py                   # train -> data/detail_model.npz and a dE report
```

## How it works

The model: `dY' = value * sum_sigma g_sigma(Y') * (Y' - Gauss_sigma(Y'))` — a tone-weighted
high-pass at one or two radii. Radii are given in pixels of the full Z f frame (6048 on the long
side) and divided by the working scale; the gain table `g_sigma` over the source pixel's tone is
separate for plus and minus and is trained per export scale separately (after shrinking, a
small-radius mask is not the same as radius/k). Trained per tool from the `detail_*` collections
by instrumental variables (two neutrals `NEUTRAL`/`NEUTRAL-B` of the pack instrument each other,
net of the NX export noise). A tool at a scale that does not improve the Y' error by at least 2%
of the export noise is stored as zero there.

The step runs after color and curve and is applied only in `render.py`/`ui.py`
(`Renderer.apply(..., sharp=True)`), not in fitting.

## Data

Needs the `tools` pack exports (via `sweep.py extract tools` equivalent — `collect` reads
`renders/sweep/<name>/tif`) and the full-size `detail` pack (export TIFF at full size in NX).
