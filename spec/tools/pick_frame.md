# pick_frame.py

Chooses the NEF with the widest hue x lightness coverage — the camera response is measured on it.

## Usage

```
python3 pick_frame.py folder/ [folder/ ...]
```

Prints per NEF (read from the embedded JPEG preview, no full decode): the number of covered
hue x lightness cells, the number of hue rows covered, and the mean chroma; sorts by coverage.

## How it works

`preview` scans the first 2.5 MB of the file for an embedded JPEG of a plausible size (the
camera's preview). `coverage` shrinks it to 360x240, converts to Oklab, keeps colorful
non-clipped pixels and counts the covered cells of a 16-hue x 3-lightness grid. A frame for
probes needs many different saturated colors at several lightnesses.
