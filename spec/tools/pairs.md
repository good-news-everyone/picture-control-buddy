# pairs.py

Pair preparation (library + a small CLI): reads a finished export and its NEF, extracts the XMP
edits, crops/aligns, and saves aligned pairs for training and the ceiling.

## Usage

```
python3 pairs.py <done_folder> <nef_folder> [nef_folder ...]
```

- `done_folder` — a folder with finished exports (`*.jpg`); each `<stem>.jpg` is matched with
  `<stem>.NEF` in the NEF folders.
- For every pair an aligned sample is computed and saved to `data/pairs/<stem>.npz` (skipped if
  it already exists); prints the NCC alignment, scale and shift per pair.

## How it works

`xmp_values` reads the XMP block (`crs:` settings): WhiteBalance, Temperature, Tint, Exposure2012,
crop (the tilted-crop diagonal-corner formulas are in `spec/np3-format.md`), masks, grain,
vignetting. `build` crops the development by the XMP crop, aligns it with the target
(scale/shift/rotation search, then a warp) and returns the aligned arrays plus the alignment
quality (`ncc`) and the XMP summary.

Used by `ceiling.py`, `devpairs.py` and `analyze.py`.
