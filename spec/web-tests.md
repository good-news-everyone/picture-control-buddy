# Reference tests of the browser version

Part of the pipeline lives in two copies: Python (training, fitting, reference) and the browser (Rust -> WebAssembly, GLSL shaders). Python is the source of truth. The browser copy is checked against fixtures made by the current Python code, so after retraining the model the fixtures are rebuilt, and the tests show whether the browser has caught up.

## How to run

```
node web/test.mjs          # from the project root, exit code non-zero on failure
```

- Levels 1 and 1a (RAW decoding) run in Node, levels 2 and 2a (shaders) run on the `web/test.html` page in headless Firefox via puppeteer-core (verified: Firefox uses the GPU, not software rendering).
- Required: node, Firefox (the path can be overridden with the `FIREFOX` variable), `npm install` dependencies in `web/` (installs puppeteer-core). After changing the Rust code: `sh web/build.sh`, then the test.
- The `web/test.html` page runs the manifest frames and returns the metrics in `window.__result`; there is no interface, no need to open it manually. The visual stand is separate, `web/bench.html`.

## When to rebuild what

- A reference Python module changed (rawdev, devpairs, render, devmodel, vignette, profile_model): `python3 web/make_golden.py` -> `node web/test.mjs`. A red test after the rebuild means the browser copy must be brought up to date.
- Only the browser code changed (raw/src, lib/*.js, test.html): just `node web/test.mjs`; the fixtures are not touched. A green test means the browser has not fallen behind.
- A tolerance in `web/golden/manifest.json` is relaxed only with a recorded reason here (as for NEF in item 1). Tolerances are edited in `web/make_golden.py` (the TOL dict), not in the manifest by hand.

## How it is organized

- `web/make_golden.py` — builds the fixtures from the Python code into `web/golden/`: `manifest.json` (what to check, tolerances) and binary files.
- `web/test.mjs` — one command: runs both parts, prints metrics with tolerances, exit code non-zero on failure.
- `web/test.html` — the executor of the shader parts: reads the manifest, runs synthetic and frames, metrics into `window.__result`.
- Timing (decoding, shader) is printed in the stand, not checked in tests.

## Levels

| # | What | Python reference | How we compare | Tolerance | Status |
|---|---|---|---|---|---|
| 1 | RAW decoding (`web/raw`, Rust) | `rawdev.develop` + fields, shrinking, rotation from `render.linear`, without vignetting | linear float32, in 16-bit units | DNG: max ≤ 1, mean ≤ 0.05. NEF: max ≤ 16, mean ≤ 6 (LibRaw subtracts black slightly differently) | works |
| 1a | Decoding rejections | — | error text | NEF High Efficiency* and a linear DNG give a clear error, not garbage | works |
| 2 | Neutral, shader | `devmodel.Dev.__call__` | synthetic picture: a grid of linear colors (all LUT cells, black, overexposure, curve edges) goes into the shader directly, without RAW | mean ≤ 0.02/255, max ≤ 0.5/255 (float readback, actually ~0.001) | works |
| 2a | Neutral on frames | `render.Renderer.neutral(render.linear(...))`, PNG 8 bit | the whole page: RAW -> screen | mean ≤ 0.3, 99% ≤ 1, max ≤ 12 (NEF shadows, inherited from item 1) | works |
| 3 | Vignette estimation | `vignette.estimate` | a, b and the gain over the frame | |da|, |db| ≤ 0.02; gain ≤ 0.5% | for now we take a, b from Python |
| 4 | NP3 reading and writing | `np3.deserialize` / `serialize` | all project `.NP3`s and official samples: fields and bytes after writing; rejections on empty/garbage/truncations (a trim without a comment reads as a profile without a curve, as in Python; a trim inside the curve with a live comment header is an exception). Plus: spline points->table bit-exact on 6 official samples with curves; `strength.scaled` vs Python on 5 bases x 0/30/50/70/100/150%, a curve and its absence, the base Control is not modified | exact equality | works |
| 5 | The 33^3 profile LUT | `profile_model.Model(grid, c)` | NP3: finished R-, random combinations from `sweep`, extreme values of every slider, own curve | dE2000 mean ≤ 0.05, max ≤ 0.5 | works |

Level 5: the browser builds a 33^3 LUT through the `profile_model.Pixels` port (`web/lib/profile.js`, the model is `web/model/profile.*` from `web/export_model.py`) on the control read from the `.NP3` stored in golden, and is compared with the `Model(grid, c)` reference over the knots: 75 cases (8 finished profiles from `out/`, 12 random combinations seed 5, extreme values of Saturation/Blending/Balance, single blenders ±100, zone grading hue 0..359/chroma ±100, zone brightness ±100). The actual divergence is at the level of the float32 fixture rounding (mean/max ≈ 0.0000 dE), the tolerance was not relaxed.

| 6 | Clarity and sharpening | `detail.Detail` | full-size cutouts with edges and texture | mean ≤ 0.5 level | works |

Level 6: 512^2 cutouts (2 for each of the 5 set frames: center and a quarter of the frame) from the `render.py` neutral, the input is shared with the browser — a PNG that both sides decode. Controls (stored in golden as `.NP3`): all zero (identity), Sharpening 9/-3, Mid-range 5, Clarity 2/-2, mixed triples at scales 2 and 4 — 80 cases. The scale is the `Detail.__call__` parameter: the cutout pretends to be a frame of that scale, so full-frame sigmas (0.5-180 px) give noticeable kernels. Comparison in 8-bit levels: mean ≤ 0.5 (the main criterion from the fixture), max ≤ 8 is a safety net against gross errors. Actual: mean ≤ 0.32 (half ≈ 0.25 is the fixture PNG rounding), max ≤ 1.23.

The browser Gaussian is not the truncated discrete Gaussian: Python does FFT with reflect edges, and for subpixel sigma (sharpening) the FFT filter is substantially wider than the discrete kernel. `web/lib/detail.js` builds the kernel by a direct Fourier sum of the same frequency response `exp(-2(pi*sigma*k/N)^2)` with the numpy pad window N and convolves separably with reflect edges (one kernel for CPU and WebGL2). The GPU matches the CPU path bit-exactly; CPU vs FFT-Python — mean ≤ 0.02 level.

| 7 | The whole render | `render.py` (neutral + profile + detail) | frames with ADL Normal | dE2000 mean ≤ 0.3 over the sky/skin/green regions | works |
| 8 | End-to-end UI of the real application | `web/index.html` + behavior from `spec/ui-manual-mvp.md` | headless Firefox, programmatic File/Blob: panel layout, dropping a RAW, moving controls changes the canvas and the exported NP3, before/against the neutral, generation race, import/export round-trip, corrupt files without losing state, statics by GET only without bodies | boolean checks + exact byte/field equality | works |
| 9 | Fitting (if ported) | `match.py` | not bit-exact: the quality of the result vs the target by regions | no worse than Python by more than 0.1 dE in any region | not decided |

## The frame set

5 de-identified frames (no people, plates or signs) + 2 rejection files. They cover: Z f NEF (orientations 1, 6, 8), Z 8 DNG (6), overexposed sky/sun (sunset), deep shadows, saturated warm color, greenery. Orientation 3 and the Z 8 in orientation 1 are not represented in the de-identified set: there are no frames with them.

| Frame | Camera | Orient. | What it gives |
|---|---|---|---|
| `renders/lr_test/DSC_6550.NEF` | Z f NEF | 1 | greenery, texture, soft light |
| `renders/dev_sa/DSC_6474.NEF` | Z f NEF | 8 | harbour: saturated red/blue, metal |
| `test1/DSC_5584.NEF` | Z f NEF | 6 | splashes, bright highlights |
| `renders/check/DSC_6132.NEF` | Z f NEF | 1 | sunset: blown sun, warm saturated, shadows |
| `test2/SKL_3024.dng` | Z 8 DNG | 6 | deep shadows, foliage; the DNG path of the decoder |

Rejections: `test2/SKL_3024.NEF` (Z 8 HE*, `nef_high_efficiency`), `nekit_examples/DSC_9253.dng` (a linear DNG, `not_bayer`).

How the set is justified:
- **Z f DNG is not included:** the only Z f DNGs of the project (`fuji160/DSC_4837.dng`, `portra400/DSC_4837.dng`) were shot with a courtyard and a readable car plate. The DNG path of the decoder (white from the file, `AsShotNeutral`) is covered by the Z 8 DNG.
- The set used to include `fuji160/DSC_4837.NEF`+`.dng`, `fuji_x100v/DSC_9991.NEF` (chart shooting), `nekit_examples/DSC_9916.dng` (replaced by DSC_6132 for the overexposed sky) and `renders/check/DSC_6203.NEF` — see the anomaly below.

## Known anomaly: DSC_6203, x1.040 between LibRaw and rawler

`renders/check/DSC_6203.NEF` is decoded 4.0% darker by LibRaw (dcraw_emu, the reference) than by rawler (web/raw.wasm), purely multiplicatively on all channels, without a black shift. As if LibRaw's normalization denominator is 16004 instead of 15375 = 16383 - 1008. The other project NEFs (including the overexposed sunset DSC_6132) match within the item 1 tolerance, the DNGs almost exactly. The hypothesis about LibRaw's adaptive white reduction on a large overexposure **was not confirmed**: DSC_6203 has no clipped pixels in either output, and DSC_6132 has clipping yet matches well. The TIFF/Nikon tags of adjacent frames do not differ. The cause is not found; the frame was excluded from the reference set, the file stays in the project for analysis. The lib.rs note "rawler gives 15892" is about a different effect (the white level from the camera catalog) and is not relevant here.

## Rules

- A new browser module is not considered done without its row in the table and a green test.
- A tolerance is relaxed only with a recorded reason here (as for NEF in item 1).
- The Python model changed -> `python3 web/make_golden.py` -> `node web/test.mjs`; a red test means the browser copy must be brought up to date.
- The browser code changed -> just `node web/test.mjs`; the fixtures are not rebuilt.
- Frames for items 1 and 2a are added via `web/make_golden.py` (the FRAMES list), checking each frame by eye for people, plates and signs.
