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

- [x] `color.py`: sRGB <-> linear round-trips, Oklab/Lab conversions on reference values
      (e.g. sRGB (0.5, 0.2, 0.8) -> Lab), `de2000` against published dE2000 reference pairs
      (Sharma et al. test set), `de2000_weights` consistency with `de2000` (<= 2% as documented).
- [x] `np3.curve_table`: identity curve, endpoints, clamping at 0..255, monotonicity on near-linear
      point sets (arbitrary unevenly spaced monotone data is NOT monotone-preserving for a natural
      spline, so the claim is tested where it holds); the spline reproduces `make_pack.curve_from`
      samples within 2 spline nodes (260/32767).
- [x] `strength.scaled`: 100% reproduces the input control; 0% gives the neutral defaults;
      scaling commutativity (`scaled(scaled(c, a), b) == scaled(c, a*b/100)` within rounding);
      fields that must not change (grading hue, Blending, Balance, sharpening) do not.
- [x] `fit.py`: `unpack` round-trip on random parameter vectors (curve tolerance 2e-3: the
      20-anchor double-interpolation loss); `lm` recovers a known linear model from synthetic
      data; the diagonal bound keeps a flat-segment fit from diverging (regression for the found
      bug, `spec/decisions.md`).
- [x] `fit.XS` anchors match `np3` curve point positions.

### 2. Format and packing round-trips — extend `test_np3.py`

- [x] `make_pack.py`: every generated probe serializes/deserializes byte-exact and has a valid
      name (asserted in `test_np3.py` instead of only at pack build).
- [x] `strength.save` output names fit 19 chars and the suffix logic
      (`base[:19-len(label)] + label`).

### 3. Model smoke tests with committed weights — `test_models.py`

Loads `data/profile_model.npz`, `data/devmodel.npz`, `data/detail_model.npz` and asserts
invariants, so a bad retrain fails in CI instead of downstream:

- [x] `profile_model.Model`: identity control (`np3.Control()`) leaves a color grid unchanged
      (<= 1e-4); the order grading -> saturation -> curve holds on synthetic cases recomputed
      from the LUTs; LUT baking changes the result by <= 0.30 dE at p95 (the max sits on a few
      extreme saturated colors, up to ~1.3 on real fitted profiles; the bound is per `test_models.py`).
- [x] `devmodel.Dev`: a neutral-ish input maps into a plausible sRGB range (no NaNs, no
      negative luminance); output bounds only, round-trip stability is not required.
- [x] `detail.Detail`: an all-flat image is unchanged by any tool (to 1e-9); plus sharpening
      lifts and minus lowers the high-frequency energy of a step edge (bidirectional on
      mid_sharpening and Clarity; Sharpening minus at scale 4 is sub-pixel noise shaping,
      only plus is asserted).
- [x] `render.Renderer.unrendered` lists nothing for the official samples in
      `third_party/samples` (no new committed fixture was needed: the samples all carry
      Sharpening 2 / Mid 1 / Clarity 0.5 and the committed detail model covers all tools).

### 4. XMP and pair parsing — `test_pairs.py`

Small synthetic fixtures (generated in the test, not committed):

- [x] `pairs.xmp_values` on a JPEG with a crafted XMP block: WhiteBalance, Temperature,
      Tint, Exposure2012, crop; absence of the block gives the documented empty result.
- [x] Tilted-crop diagonal-corner math (`spec/np3-format.md` formulas) against a hand-computed
      example.
- [x] Alignment (`pairs.align`, the core of `pairs.build`) on a shifted/scaled synthetic image
      recovers the shift and scale within tolerance (scale 0.005: the synthetic target is itself
      a bilinear warp, the peak is biased by about one resample).

### 5. Fitting regression with a committed mini-fixture — `test_match.py`

The only true end-to-end safety net for `match.py` without NX Studio:

- [x] One small aligned-pair fixture in `data/test/`: `pair_dsc6366.npz` (606 KB, 256 px on the
      long side: linear NEF data with the WB/exposure gain applied, the finished target in
      sRGB, the XMP summary) — the fit2 pair DSC_6366, built once through `match.prepared`.
- [x] Run the `match.py` fit on it and assert: the run completes, the written NP3 round-trips,
      the fitted blender/grade stay within sane bounds, and the prediction dE beats the neutral
      dE by a margin (4.6 -> 1.8 at the time of writing: a regression threshold, not an
      absolute number).
- [x] Same for `analyze.py` coverage/recommend on the fixture: the recommended set is
      non-empty and the report prints.

### 6. Sweep and pack generators — cheap structural checks

- [x] `sweep.py`: the self-contained pack profile sets (colors, tools, detail) contain `NEUTRAL`
      with unique tags and byte-exact round-trips (full/colors_sa need fitted profiles from
      `out/` and are not callable in a fresh clone); sidecar writing on a synthetic `.nksc`
      produces the expected base64 blocks and `PictureControl` = 1; `extract` on a synthetic
      folder writes the documented `.npz` keys.
- [x] `pick_frame.coverage`: a synthetic hue wheel scores higher than a grey image (grey keeps
      nothing: (0, 0, 0.0)).

### 7. Keep the browser suite green

- [x] After steps 1-6 land, add the new Python fixtures to `web/make_golden.py` only where the
      browser has a paired module; otherwise the Python tests are the single source. (Nothing
      was added: the new tests cover modules the browser does not port, so the Python tests
      stay the single source; `node web/test.mjs` passes unchanged.)
- [x] Record in [web-tests.md](web-tests.md) any tolerance change with a reason. (No browser
      tolerances were changed.)

## Definition of done

- `python3 test_np3.py && python3 test_core.py && python3 test_models.py && python3 test_pairs.py && python3 test_match.py && python3 test_sweep.py` passes in a fresh clone.
- `node web/test.mjs` still passes (levels needing `_local/` skip themselves).
- The suite runs in under a minute and needs no network, no NX Studio, no LibRaw for steps 1-3
  (steps 4-6 need LibRaw only if extended to real decodes; synthetic fixtures by default).
