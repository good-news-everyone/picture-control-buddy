# rawdev.py

The RAW decoder wrapper (thin CLI around LibRaw).

## Usage

```
python3 rawdev.py file.NEF|file.DNG
```

Prints the shape, min/max and the per-channel mean of the developed linear RGB.

## How it works

`develop(raw)` runs `dcraw_emu -w -o 0 -4 -h -t 0` in a temporary directory (a symlink with a
plain ASCII name, so paths with spaces/symbols do not break it) and reads the 16-bit PPM:
camera linear RGB, 0..1, half size (3024 px on the long side of a Z f frame), not rotated.
`-w` uses the camera WB, `-o 0` keeps the raw colorspace, `-4` is linear 16-bit, `-h` is the half
development, `-t 0` disables the orientation flip.

On an unreadable file it exits with an explanatory error (for a NEF High Efficiency it advises
converting to DNG without JPEG XL).

## Data

LibRaw must be installed (`dcraw_emu`, `unprocessed_raw`, `raw-identify`). Frames are decoded at
half size everywhere in the pipeline; `--full` paths in `render.py`/`devmodel.py` pass a large
sample count instead.
