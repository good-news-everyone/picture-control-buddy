# np3-fit: project specification

Fitting Nikon Flexible Color Picture Control (`.NP3`) profiles from examples: a NEF and a finished render with the preset go in, an NP3 comes out. Project camera: Nikon Z f.

State as of 2026-11-10. Goal and milestones: [stages.md](stages.md).

## Sections

| File | About |
|---|---|
| [np3-format.md](np3-format.md) | The NP3 format, SD card layout, NX Studio sidecars |
| [camera-response.md](camera-response.md) | What was measured about Nikon and NX Studio processing |
| [tools.md](tools.md) | Modules, commands, data, workflow |
| [tools/](tools/README.md) | Per-utility documentation: arguments and how each tool works |
| [results.md](results.md) | All measurements: ΔE tables across versions |
| [decisions.md](decisions.md) | Decisions, dead ends, found bugs, limitations |
| [web-tests.md](web-tests.md) | Browser version (`web/`): reference tests against Python |
| [test-plan.md](test-plan.md) | Test coverage gaps and the plan to close them |
| [stages.md](stages.md) | Project goal and milestones: what is done, what is in progress, what comes later |
| [roadmap.md](roadmap.md) | What is next and what we are waiting for |
| [charts.md](charts.md) | Fitting from printed chart sheets — moved to the local chart project (`../np3-fit-charts`) |
| [ui.md](ui.md) | Interface specification: from a RAW + JPEG pair to manual NP3 adjustment |
| [ui-manual-mvp.md](ui-manual-mvp.md) | First iteration: RAW upload, sliders, curve, strength, NP3 import and export in the browser |
| [ui-manual-mvp-plan.md](ui-manual-mvp-plan.md) | Implementation and verification plan for the manual-adjustment MVP |
| [ui-plan.md](ui-plan.md) | Work plan for the full RAW + target fitting interface (all steps) |
| [ui-pages.md](ui-pages.md) | Pages: landing `index.html`, fitting wizard `picture-control-jpg-fit.html` (desktop only), profile editor `picture-control-editor.html` + `picture-control-editor-mobile.html` with the redirect between them |
| [ui-mobile.md](ui-mobile.md) | Mobile version: separate `web/mobile.html` on the shared JS core, load-time redirect, single-tool panel, touch gestures, Lucide icons |
| [ui-mobile-plan.md](ui-mobile-plan.md) | Agent work plan for the mobile version: fixed contracts, file ownership, stages M0–M4 with tasks, tests and a log |
| [web-schemas.md](web-schemas.md) | Serializable contracts: prepared pair, fit result, report, golden fixture plan |
| [z8-calibration.md](z8-calibration.md) | Z8 calibration: shot list, procedure, known Z8-specific issues |
| [external.md](external.md) | Third-party projects and licenses |
| [memory/](memory/) | Copies of the Claude memory notes about the project |

## In short

- Final profile for the Astia preset: `out/fit4/NIKON/CUSTOMPC/PICCON01.NP3` (`NPF-FIT4`). The camera accepts it, the in-camera JPEG matches NX Studio (ΔE 0.97) and differs from the target by ΔE 3.69.
- Best result of the automatic process: `out/m3b` (`NPF-M3B`), 3 pairs and one render round, ΔE 2.84 on frames outside the fit. Downside: reds 6.34 vs 3.40 for FIT4.
- Working tool: `match.py`, accepts NEF and DNG. Calibrated only for the Z f.
- Portra and Fuji: `out/portra400_r2` and `out/fuji160_r2`, corrected over 5 frames. Prediction 3.39 and 2.46, not yet verified against real renders.
- `strength.py` changes the strength of a finished profile.
- Fitting frames with different manual processing does not work: ΔE 9.0 on `test2/` frames outside the fit.
- There is no open exact NEF + NP3 renderer. Exact renders come from NX Studio and the camera.
- Approximate renderer: `render.py`, viewer `ui.py`. It differs from a real NX render by ΔE 1.85 on frames outside the development-model training; development without a profile alone: 1.74.
- The step-based profile model (`profile_model.py`) is trained on NX exports that `sweep.py` produces in one action via sidecars. On 14 finished profiles outside the training set: 1.07 vs 2.32 for the on-screen chart model. `match.py` fits with it: a profile fitted from three pairs against the original in an NX render on 8 other frames: 1.22 (old fitting: 2.66).

## How to read the numbers

- Metric: mean ΔE2000 between render and target; lower means closer.
- "Real render" means an actual NX Studio or camera output.
- "Prediction" means model output. It currently differs from an NX render by about ΔE 1.5 (was around 3 for the on-screen chart model), so its numbers still cannot be compared directly with real ones.
- If a number was obtained without rendering, the documents say so.
