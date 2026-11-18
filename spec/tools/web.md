# web/export_model.py + web/make_golden.py

## export_model.py

Exports the Python models into the flat binary files the browser port loads:

```
python3 web/export_model.py     # data/*.npz -> web/model/*.json + *.bin
```

No arguments. Writes `web/model/dev.json`/`dev_lut.bin` (the development),
`profile.json`/`profile.bin` (the step-based profile model, reference-test level 5) and
`detail.json`/`detail.bin` (the detail model, level 6). Offsets are in float32 elements,
little-endian; table order is the C order of the numpy arrays. Run it after retraining any
model; `spec/web-tests.md` describes when the fixtures need a rebuild after that.

## make_golden.py

Builds the reference fixtures for the browser suite from the current Python code:

```
python3 web/make_golden.py      # -> web/golden/ (manifest.json + raw/synthetic/frames/np3)
```

No arguments. Writes the linear RGB inputs (`raw/*.f32`), the synthetic color grid and its
neutral, the frame neutrals with vignetting (`frames/*.png`), the full NP3 field breakdown for
level 4 (`np3/*.json`) and `manifest.json` with the case list and tolerances (tolerances are
edited in the TOL dict of this script, not in the manifest by hand). Python is the source of
truth: after changing a paired Python module, rebuild the fixtures, then `node web/test.mjs`
shows whether the browser has caught up.

Needs LibRaw and the de-identified frames (see the FRAMES list; levels 1/1a/2a skip themselves
without the raw files).
