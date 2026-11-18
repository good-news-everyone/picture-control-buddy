# make_pack.py

Builds the probe pack for measuring the camera response: 29 single-setting NP3 profiles, a
continuous-tone chart image (`chart.png`) for shooting off the screen, and a manifest.

## Usage

```
python3 make_pack.py     # -> out/pack1/
```

No arguments. The output mimics an SD card: `out/pack1/NIKON/CUSTOMPC/PICCONxx.NP3` plus
`out/pack1/manifest.json` and `out/pack1/chart.png`.

## How it works

`probes()` generates single-tool controls (each slider separately, plus and minus, and a few
combinations) as `np3.Control` objects. Every profile is serialized, deserialized and serialized
again — the round-trip must be byte-exact and the name 19 characters or fewer. The manifest lists
the file, the profile name and what the probe sets. `chart()` draws a hue circle in lightness x
chroma rows with a gray scale (Oklab max-chroma colors) for a screen shot (`DSC_6754.NEF` is the
project's chart shot, see `spec/camera-response.md`).

## Notes

The pack is copied to a card (`NIKON/CUSTOMPC`), the chart is shot off the screen and everything
is rendered in NX Studio; the exports are the training data of the first response model
(`model.py`, the on-screen chart model — kept only for comparison).
