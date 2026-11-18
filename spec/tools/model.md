# model.py

The first (on-screen chart) Flexible Color response model — a library, no CLI.

## What it is

A per-slider response measured on the probe pack (`make_pack.py` + a chart shot off the screen):
the color stage is a sum of offsets from neutral in encoded sRGB, linear in the slider value,
with separate plus and minus tables. The curve changes only Y' (Rec.601), leaving Cb/Cr alone.
The blender moves the probe sets A and B as a whole; a color's sector boundaries are the minima
of its set's response (`COLS_OF`).

## Status

Superseded by the step-based model (`profile_model.py`, trained on real NX exports via
`sweep.py`): the on-screen chart underfit a single slider on real frames. `model.py` remains only
for comparison (`Renderer(profile="patches")`) and is loaded through `model.load()`.

## Notes

No tests; kept as the reference for the old numbers in `spec/results.md`.
