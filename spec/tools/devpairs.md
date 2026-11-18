# devpairs.py

Development-pair alignment (library + a small CLI): builds the cached aligned pairs of NEFs
against their neutral NX renders, which the development model trains on.

## Usage

```
python3 devpairs.py     # for every set in devpairs.SETS: renders/<set>/*.NEF + neutral/*.TIF
                        #   -> data/<set>/<stem>.npz (skipped if cached)
```

No arguments. Prints the NCC, scale and radial distortion coefficient per frame.

## How it works

`build(nef, target)` develops the NEF (linear RGB), removes vignetting (`vignette.py`), crops by
the XMP crop and orientation, and aligns with the target accounting for rotation, crop, radial
distortion (a plain scale was not enough: lens correction reaches scale 1.07) and shift.
`build_render(render, tif)` is the same for NX renders in `--refine` (already rotated; the XMP
crop is in sensor-frame coordinates). The cached record carries the aligned arrays, `ncc`, the
scale, the distortion `k` and the XMP summary.

`SETS` lists the training sets (`renders/dev/`, `renders/dev_africa/`); adding a new shoot means
adding a set there.
