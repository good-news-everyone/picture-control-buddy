# analyze.py

Candidate scoring for fitting and region reports. Two modes.

## Usage

```
python3 analyze.py render_a.TIF a.jpg [render_b.TIF b.jpg ...]   # any NX render vs targets, by regions
python3 analyze.py [--adl Off] [--save name] a.NEF [b.NEF folder/ ...]
```

The mode is chosen by the arguments: an even number of render/target files, or raw files
(directories are scanned for NEF/DNG).

## Arguments (raw mode)

- `--adl Off|Low|Normal|...` — recommend only frames with this in-camera ADL.
- `--save name` — merge the result into `out/<name>/analysis.json` (created if absent).
- files — any mix of NEF/DNG paths and folders; folders are scanned recursively.
  About 1 s per frame, processed in parallel (`fork` pool).

## How it works

Raw mode develops each frame (`rawdev` + `devmodel` neutral, WB/exposure from the XMP subtracted),
aligns it with its embedded JPEG to judge suitability, and prints per frame: color coverage by
groups (greys, skin, warm saturated, warm muted, yellows, greens, teal, sky, dark blues, purple),
lightness ("lift" vs neutral), the white share, camera ADL, masks/grain/vignette warnings. With
several frames it prints the joint coverage and the recommended fitting set: greedily close the
color groups while keeping the mean lift at the candidate median (the curve is shared, the fitting
frames set the lightness of the rest).

Render mode compares finished NX renders against targets over `analyze.GROUPS`: per group dE, dL,
dC, dh and the mean over color bins; the pixel mean hides small objects.

## Used by

`match.py` (frame records, coverage, `recommend`, `lift_median`, region sums for reports).
