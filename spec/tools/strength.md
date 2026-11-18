# strength.py

Profile strength: NP3 has no strength slider, so each strength is a separate file (a separate
camera slot).

## Usage

```
python3 strength.py name|folder|file.NP3 30 50 70
```

## Arguments

- `name|folder|file.NP3` — the source profile: a folder in `out/<name>/`, a `_strength` folder or
  a direct path to an `.NP3` (`strength.locate` resolves it).
- percents — one or more whole percents (also above 100, to strengthen). The browser UI uses
  0..150%.

## How it works

`strength.scaled(base, percent, name)` multiplies Saturation, the five tonal sliders, the blender
and the grading chroma/brightness by the fraction, blends the curve with the identity, and leaves
grading hue, Blending, Balance, Sharpening, Mid-range sharpening and Clarity unchanged. Each
strength is serialized into `out/<name>_strength/NIKON/CUSTOMPC/PICCONxx.NP3` (slot = argument
order), the profile name gets a `-<percent>` suffix (the base name is truncated to fit 19
characters). The round-trip through deserialize/serialize is asserted byte-exact.

At 100% `strength.py` reproduces the original profile exactly (verified in `test_np3`-adjacent
checks and web test level 4).
