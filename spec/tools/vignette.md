# vignette.py

Vignette correction: estimates the lens vignetting from the NEF and its embedded JPEG and lifts
the frame corners, so that development training does not mix brightness with color.

## Usage

```
python3 vignette.py
```

No arguments. Estimates the coefficients for all NEFs of the development sets
(`devpairs.SETS`) and prints them (`a`, `b` of the radial model and the corner lift in stops);
the results are cached in `data/vignette/`.

## How it works

NX Studio lifts the frame corners by 0.3-1.3 stops (more at an open aperture); our development
did not, and trained on a different brightness of one color. `estimate(nef, lin)` derives the
correction from the NEF vs embedded JPEG difference — the embedded JPEG is already corrected by
the camera — so the lens does not need to be known. The model is a radial surface
(`a*x^2 + b*y^2`-like) over the frame; no embedded JPEG (or Vignette Control off) means no
correction.

With the correction the development-only dE improves (1.92 -> 1.51 on the 60-frame validation,
see "Vignetting" in `spec/results.md`).
