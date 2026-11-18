# Tool documentation

One page per utility: what it does, how to run it, what arguments it takes, how it works inside.
The workflows that chain the tools and the data layout are in [../tools.md](../tools.md);
measurements in [../results.md](../results.md).

## Fitting and analysis

| Tool | Purpose |
|---|---|
| [match.md](match.md) | The main command: fits an NP3 profile from NEF/DNG + finished-shot pairs |
| [analyze.md](analyze.md) | Candidate scoring for the fit, region reports |
| [strength.md](strength.md) | Profile versions at different strengths |
| [scene.md](scene.md) | Alignment of different shots of one scene (`match.py --scene`) |
| [ceiling.md](ceiling.md) | The ceiling: how much of the look one shared transformation reaches |

## Models and training

| Tool | Purpose |
|---|---|
| [profile_model.md](profile_model.md) | The step-based profile model (blender, grading, curve, tools) |
| [devmodel.md](devmodel.md) | NEF development -> the Nikon neutral |
| [detail.md](detail.md) | Clarity, Sharpening, Mid-range sharpening |
| [model.md](model.md) | The old on-screen chart model (kept for comparison) |
| [sweep.md](sweep.md) | Probe packs for NX Studio and `.npz` dataset extraction |
| [make_pack.md](make_pack.md) | The 29-probe pack and the on-screen chart image |
| [vignette.md](vignette.md) | Vignette correction from the NEF and the embedded JPEG |
| [wbmap.md](wbmap.md) | XMP Temperature/Tint -> WB_RBLevels for the WB take-out |

## Development and pairs

| Tool | Purpose |
|---|---|
| [rawdev.md](rawdev.md) | The LibRaw wrapper: linear RGB from a NEF/DNG |
| [render.md](render.md) | Approximate render of a frame with an NP3 |
| [pairs.md](pairs.md) | Finished export + NEF -> aligned pairs, XMP parsing |
| [devpairs.md](devpairs.md) | NEF + neutral NX render -> aligned development pairs |
| [pick_frame.md](pick_frame.md) | NEF choice for probe shooting by color coverage |

## Libraries

| Tool | Purpose |
|---|---|
| [np3.md](np3.md) | The NP3 binary format + `test_np3.py` (the only always-on test) |
| [fit.md](fit.md) | Parameter packing and the LM solver |
| [color.md](color.md) | sRGB/Oklab/Lab, dE2000 |

## Browser port

| Tool | Purpose |
|---|---|
| [web.md](web.md) | `web/export_model.py` and `web/make_golden.py` |

The local-only tools live in `_local/` (not in the repository): `ui.py`, `compare.py`,
`triage.py`, `check.py`, `eval_path.py`, `how_many.py`.
