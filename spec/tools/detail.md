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

## NX base detail (`python3 detail.py base`, spec/ui.md decision #18)

NX Studio's own export is crisper than our development at the same size even with Sharpening,
Mid-range and Clarity at 0. On the 10 `NEUTRAL` exports of the `tools` pack (1512 px, scale 4) the
NX / ours amplitude of Y' is 1.0 below 0.2 cycles/px and rises in the top octave to 1.06-1.47 at
Nyquist (geometric mean 1.21). A full AHD demosaic shrunk with Lanczos is no crisper than our
half-size development, so this is NX's resampling / its own detail step. Part of it is NX export
noise (two exports of one frame differ; on DSC_6456 at full size shrunk x4 the noise is 34-43 % of
the signal amplitude at 0.3-0.5 cycles/px), so the extra detail is mostly not coherent with ours:
a filter matches the look (the amplitude), not the pixels.

The `base` part of `data/detail_model.npz` is that filter in the Part form: value 1, a constant
gain table, at the Sharpening x4 radius (`BASE_SIGMA` = 0.5 full-frame px), fitted by least
squares to the geometric-mean amplitude ratio over `BASE_FREQS`: gain 2.70 (leave-one-frame-out
2.27-2.95). After it the per-frame ratio at Nyquist is 0.88-1.22 (before 1.06-1.47). It applies only
within `BASE_RANGE` (x1.5) of the measured scale, i.e. to the 1512-1600 px frames of the web pages
and `render.py`; other scales are unchanged. `Detail.__call__(..., base=True)` adds it;
`render.Renderer.apply(sharp=True)` and the web `Renderer.render` pass base, the level-6 fixtures
test both (`make_golden.DETAIL_BASE`). `python3 detail.py` (retraining the tools) keeps the trained
base part.

    python3 detail.py base    # renders/sweep/tools/*-NEUTRAL.NEF + .TIF -> the base part (needs dcraw_emu)

## Data

Needs the `tools` pack exports (via `sweep.py extract tools` equivalent — `collect` reads
`renders/sweep/<name>/tif`) and the full-size `detail` pack (export TIFF at full size in NX).
