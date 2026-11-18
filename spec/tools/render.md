# render.py

Approximate render of a NEF/DNG with an NP3 profile: development to the Nikon neutral + the
step-based profile model, baked into a 33^3 3D LUT, plus the detail pass.

## Usage

```
python3 render.py frame.NEF name|file.NP3 [output.jpg] [--full]
```

## Arguments

- `frame.NEF` — a NEF or DNG path.
- `name|file.NP3` — a profile: a folder name in `out/` (as in `strength.locate`) or a direct
  path to an `.NP3` file.
- `output.jpg` — where to save (default: `<frame stem>.jpg` in the current folder).
- `--full` — full-resolution development (`linear(raw, 10^6)`); by default the half development
  is used, as everywhere in the pipeline.

## How it works

`Renderer.neutral` develops the RAW (`rawdev.develop` + rotation/crop from `render.linear`,
vignette correction) and applies `devmodel` (the neutral model). `Renderer.apply` runs the profile
through `profile_model.Model` and, with `sharp=True`, the `detail.Detail` pass (Clarity,
Sharpening, Mid-range). The profile is baked into a 33^3 LUT first (0.18 s), the per-pixel model
is not used at render time.

## Notes

- The render is approximate: about dE 1.85 from a real NX Studio render on frames outside the
  development training (numbers in `spec/results.md`).
- Sharpening, clarity, lens correction and NX noise reduction are modeled only inside the detail
  step; what is not modeled is listed by `Renderer.unrendered` (printed as "no model, not applied").
- Needs `data/devmodel_render.npz`, `data/profile_model.npz`, `data/detail_model.npz`.
