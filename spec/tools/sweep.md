# sweep.py

Training-data preparation: builds packs of NEF copies with a profile written into each sidecar,
so that NX Studio renders the whole pack in one action. `extract` collects the exports into
`.npz` datasets for training.

## Usage

```
python3 sweep.py pilot        # 2 frames, 6 profiles: check that NX accepts such sidecars
python3 sweep.py full         # 5 frames, 200 profiles: slider pairs, 14 finished profiles, 150 recipe-like
python3 sweep.py colors       # 10 frames, 97 profiles: each blender color separately, grading every 45 deg
python3 sweep.py tools        # 10 frames, 118 profiles: Saturation, tonal sliders, grading brightness,
                              #   Blending, Balance, Clarity, pairs and 30 random recipes
python3 sweep.py detail       # 4 frames, 29 profiles: Sharpening, Mid-range, Clarity, pairs, order with curve
                              #   (export TIFF at FULL size, then: python3 detail.py collect detail)
python3 sweep.py colors-sa    # 6 South Africa frames, 103 profiles: strong +-100 of blue, cyan, orange, red
python3 sweep.py chart        # continuous-tone chart image for shooting off the screen
python3 sweep.py chart-pack DSC_xxxx   # the "colors" profile set on a chart shot
python3 sweep.py extract [colors|colors_sa|tools]   # collect exports -> data/sweep<N>.npz
```

## How it works

Each pack is a folder under `renders/sweep/<name>/`: copies of the chosen NEFs plus rewritten
`.nksc` sidecars (`NKSC_PARAM/<name>.NEF.nksc`). The NP3 is base64-inserted into the
`nikon::PictureControl` filter of the sidecar; a sidecar with a built-in profile is brought to the
custom form (a `Custom` block is added, `PictureControl` = 1). ADL is set "as shot" (`adl_as_shot`).
The writing matched real NX sidecars byte for byte (88/89; the mismatch is the identity-curve
probe). The probe table (`NEUTRAL`, `NEUTRAL-B`, singles, pairs, recipes) is generated in code,
so packs are reproducible.

`extract` reads the exported TIFFs from `<pack>/tif/` (TIFF 8 bit, sRGB, long side 1512 px, no
other settings changed), shrinks them and writes `data/sweep<N>.npz` together with the NP3 bytes
of every profile.

## Notes

- After `sweep.py <pack>`: open the folder in NX Studio, select all, export into `tif/`.
- The first pack (`full_v1`, 10 frames, 120 profiles) was deleted; its exports live in
  `data/sweep.npz`. Of `full` only the NEUTRAL and R-* TIFFs remain (`data/sweep2.npz`).
- Needs the frames locally in `_local/` (see `FRAMES`, `FRAMES_V1`, `SA_FRAMES`, `DETAIL_FRAMES`).
