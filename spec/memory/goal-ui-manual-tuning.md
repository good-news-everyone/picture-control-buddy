---
name: goal-ui-manual-tuning
description: "End goal of np3-fit — UI where user sees our render vs their JPEG after match.py and hand-tunes every NP3 slider, NX Studio excluded"
metadata:
  node_type: memory
  type: project
  originSessionId: 6394d91c-9232-42d3-a575-39f6aff12e6c
  modified: 2026-11-09T23:18:18.269Z
---

End goal (stated 2026-11-10): after `match.py` fits an NP3, a UI shows our render next to the user's target JPEG, and the user can hand-tune any NP3 tool there. NX Studio must not be needed at any step, including refine.

**Why:** the renderer has to understand the whole Flexible Color toolset, not only what `match.py` fits: Saturation, Contrast, Highlights, Shadows, White/Black level, grade brightness, Blending, Balance, plus Clarity, Sharpening and Mid-range sharpening.

**How to apply:**
- Treat any NP3 field the renderer ignores as a gap to close, not as out of scope.
- Colour and tone tools are learned from the `sweep.py tools` probe pack.
- Clarity, Sharpening and Mid-range sharpening are a separate later stage. The user's idea is Gaussian blur / high-pass with fitted radii and their combinations; analyse those on full-resolution TIFFs, not the downsampled sweep npz.

Related: [[adl-as-shot]]
