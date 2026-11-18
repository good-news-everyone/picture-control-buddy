# ceiling.py

The ceiling on the Georgia set: how much of the target look can be expressed as one shared
transformation, and how much comes from per-frame edits.

## Usage

```
python3 ceiling.py
```

No arguments. Reads the aligned pairs from `data/pairs/` and `_local/pairs/` (built by
`pairs.py`, NCC >= 0.6), trains each model on one half of the frame blocks and measures on the
other, and writes `data/ceiling.json`.

## Models (least to most freedom)

- `gain` — per-frame WB/exposure only.
- `curve` — + a shared lightness curve and shared saturation.
- `np3` — + 8 colors (hue/chroma/brightness) and 3 grading zones, a structural approximation in
  Oklab (not the camera response).
- `lut` — + a shared 17^3 3D LUT: an upper bound for any global profile.
- `own-lut` — a 3D LUT per frame: the ceiling for global color grading at all.

## Output

A table of mean dE2000 on held-out frames, overall and split by masked/unmasked frames; the
per-frame numbers land in `data/ceiling.json`. The conclusion that drove the project: per-frame
edits, not the shared profile, carry most of the difference (see `spec/results.md`).

## Data

Needs the Georgia pairs locally (`_local/pairs/`, gitignored).
