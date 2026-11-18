# color.py

Color science library (no CLI). Pure numpy + PIL.

## Contents

- sRGB <-> linear RGB, linear RGB <-> Oklab, sRGB <-> CIELab conversions.
- dE2000 and its components (dL, dC, dh) — `de2000`, `de2000_weights` (the residual components
  with weights at the target color, used by the fit instead of a plain Lab difference).
- Helpers over Lab arrays used across the pipeline (means by groups, binning).

## Notes

- The whole repository is calibrated in encoded sRGB unless a function says "linear"; dE numbers
  everywhere are dE2000 mean over pixels.
- There are no tests for this module yet: the plan is in `spec/test-plan.md`.
