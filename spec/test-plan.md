# Test plan

What is covered today, what is not, and the steps to close the gaps. Metric conventions and
rules live in [web-tests.md](web-tests.md).

## Current coverage

| Layer | What covers it | Kind |
|---|---|---|
| `np3.py` (de)serialization | `test_np3.py` — byte-exact round-trip on 13 official samples + the curve spline vs stored tables | Python, always runs in a fresh clone |
| The browser port (decoder, shaders, NP3, profile LUT, detail, full render, UI) | `web/test.mjs`, levels 1-8 | reference tests against Python fixtures |
| `strength.scaled`, `np3.curve_table` | web test level 4 (browser vs Python) | indirect: the Python side is the reference, not asserted by a Python test |
| `match.py` end-to-end quality | `match_check.py` (local): fits 14 finished profiles from three pairs, compared in real NX renders | manual, needs `_local/` data and NX Studio |

Everything else has **no automated tests**: `color.py`, `fit.py`, `analyze.py`, `pairs.py`,
`devpairs.py`, `scene.py`, `ceiling.py`, `devmodel.py`, `profile_model.py`, `detail.py`,
`render.py`, `strength.py`, `sweep.py`, `make_pack.py`, `pick_frame.py`, `vignette.py`,
`wbmap.py`. The trained models are validated by held-out-frame numbers inside their training
scripts, but there is no regression gate.

## Principles

1. A fresh clone must run the whole suite: only committed fixtures
   (`third_party/samples`, `web/golden`, small `.npz` in `data/`), no `_local/`.
2. A test does not retrain models and does not call NX Studio; where behavior depends on trained
   weights, the committed `data/*.npz` are the fixture.
3. Tolerances are stated per test and recorded with a reason when relaxed.

## Steps (in priority order)

### 1. Golden-value tests for the pure libraries — `test_core.py`

No data files needed; the highest value per effort.

- [ ] `color.py`: sRGB <-> linear round-trips, Oklab/Lab conversions on reference values
      (e.g. sRGB (0.5, 0.2, 0.8) -> Lab), `de2000` against published dE2000 reference pairs
      (Sharma et al. test set), `de2000_weights` consistency with `de2000` (<= 2% as documented).
- [ ] `np3.curve_table`: identity curve, endpoints, clamping at 0..255, monotonicity on random
      point sets; the spline must reproduce `make_pack.curve_from` samples.
- [ ] `strength.scaled`: 100% reproduces the input control; 0% gives the neutral defaults;
      scaling commutativity (`scaled(scaled(c, a), b) == scaled(c, a*b/100)` within rounding);
      fields that must not change (grading hue, Blending, Balance, sharpening) do not.
- [ ] `fit.py`: `unpack(pack(p)) == p` round-trip on random `model.Params`; `lm` recovers a
      known linear model from synthetic data; the diagonal bound keeps a flat-segment fit from
      diverging (regression for the found bug, `spec/decisions.md`).
- [ ] `fit.XS` anchors match `np3` curve point positions.

### 2. Format and packing round-trips — extend `test_np3.py`

- [ ] `make_pack.py`: every generated probe serializes/deserializes byte-exact and has a valid
      name (the checks exist in `main`, assert them in the test instead of only at pack build).
- [ ] `strength.save` output names fit 19 chars and the suffix logic
      (`base[:19-len(label)] + label`).

### 3. Model smoke tests with committed weights — `test_models.py`

Loads `data/profile_model.npz`, `data/devmodel.npz`, `data/detail_model.npz` and asserts
invariants, so a bad retrain fails in CI instead of downstream:

- [ ] `profile_model.Model`: identity control (`np3.Control()`) leaves a color grid unchanged
      (<= 1e-4); the order grading -> saturation -> blender -> curve holds on a synthetic case;
      LUT baking changes the result by <= 0.30 dE (the measured bound).
- [ ] `devmodel.Dev`: a neutral-ish input maps into a plausible sRGB range (no NaNs, no
      negative luminance); round-trip stability `dev(dev(x))` no-op is NOT required — only
      output bounds.
- [ ] `detail.Detail`: an all-flat image is unchanged by any tool; plus sharpening increases
      the high-frequency energy of a step edge, minus decreases it.
- [ ] `render.Renderer.unrendered` lists nothing for a control built from the fitted profiles
      in `out/` fixtures (add one small committed NP3 pair).

### 4. XMP and pair parsing — `test_pairs.py`

Small synthetic fixtures (generated in the test, not committed):

- [ ] `pairs.xmp_values` on a JPEG/TIFF with a crafted XMP block: WhiteBalance, Temperature,
      Tint, Exposure2012, crop; absence of the block gives the documented empty result.
- [ ] Tilted-crop diagonal-corner math (`spec/np3-format.md` formulas) against a hand-computed
      example.
- [ ] `pairs.build` alignment on two shifted/scaled synthetic images recovers the shift and
      scale within tolerance.

### 5. Fitting regression with a committed mini-fixture — `test_match.py`

The only true end-to-end safety net for `match.py` without NX Studio:

- [ ] Commit one small aligned-pair fixture (shrunk 256 px arrays + XMP summary, a few hundred
      KB) into `data/test/`.
- [ ] Run the `match.py` fit on it and assert: the run completes, the written NP3 round-trips,
      the fitted blender/curve stay within sane bounds (|value| <= LIMIT+slack), and the
      prediction dE beats the neutral dE (regression threshold, not an absolute number).
- [ ] Same for `analyze.py` coverage/recommend on the fixture: the recommended set is
      non-empty and the report prints.

### 6. Sweep and pack generators — cheap structural checks

- [ ] `sweep.py`: every pack profile set contains `NEUTRAL`; sidecar writing on a synthetic
      `.nksc` produces the expected base64 blocks and `PictureControl` = 1; `extract` on a
      synthetic folder writes the documented `.npz` keys.
- [ ] `pick_frame.coverage`: a synthetic image with known hue coverage scores higher than a
      grey image.

### 7. Keep the browser suite green

- [ ] After steps 1-6 land, add the new Python fixtures to `web/make_golden.py` only where the
      browser has a paired module; otherwise the Python tests are the single source.
- [ ] Record in [web-tests.md](web-tests.md) any tolerance change with a reason.

## Definition of done

- `python3 test_np3.py && python3 test_core.py && python3 test_models.py && python3 test_pairs.py && python3 test_match.py` passes in a fresh clone.
- `node web/test.mjs` still passes (levels needing `_local/` skip themselves).
- The suite runs in under a minute and needs no network, no NX Studio, no LibRaw for steps 1-3
  (steps 4-6 need LibRaw only if extended to real decodes; synthetic fixtures by default).
