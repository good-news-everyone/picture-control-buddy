# fit.py

The shared fitting core (library, no CLI): parameter packing and the Levenberg-Marquardt solver
used by `match.py` (and the legacy chart-fitting entry points).

## Contents

- `unpack(x) -> model.Params` / packing of the parameter vector: 24 blender values (8 colors x
  hue/chroma/brightness), 3 grading zones (hue, chroma, brightness), 20 curve anchors
  (`XS = round(i*255/19)/255`), Saturation, three zone brightnesses, Blending and Balance.
- `lm(...)` — the Levenberg-Marquardt solver with a numerical jacobian and a lower bound on the
  diagonal (a zero jacobian on a flat curve segment used to blow the step up).
- Photo-sampling helpers (`nearest`, pixel sampling with weights), used by `match.py` and
  `render.py`.
- Constants: `SMOOTH` (curve smoothness), `RIDGE`, `LIMIT = 60` (the sweeps measured the response
  only up to ±60), `WHITE` (the curve end is pinned to white where the shots have no data).

## Notes

No direct tests; it is exercised through `match.py` fits and the browser reference tests
(`strength.scaled` vs Python is checked at web test level 4). The plan is in `spec/test-plan.md`.
