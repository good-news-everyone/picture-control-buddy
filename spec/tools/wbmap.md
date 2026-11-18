# wbmap.py

The WB take-out: maps the XMP Temperature/Tint of a finished export to the camera's WB_RBLevels
multipliers, so that `match.py` can subtract custom WB from the profile.

## Usage

```
python3 wbmap.py
```

No arguments. Collects As Shot pairs from the training folders (`~/Pictures/2026/georgia`,
`renders/check/`), fits the relation by least squares with leave-one-out validation and writes
the weights to `data/wbmap.json`.

## How it works

`multipliers(nef)` reads WB_RBLevels (MakerNote tag 0x000C) straight from the NEF bytes and
returns log(R/G), log(B/G). The features are `[1, mired, mired^2, tint, tint*mired]`; the
held-out log error over 21 As Shot frames is about 0.004. `match.py` applies the predicted
multipliers to the linear development before the neutral, so a custom WB in the target does not
leak into the fitted profile.

## Limitations

The relation is trained on the Z f; on other cameras the WB take-out is shifted (on the Z 8 it
seems to hurt — see `spec/roadmap.md`).
