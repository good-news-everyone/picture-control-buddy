# Fitting interface: specification

Draft from 2026-11-10. Project goal: [stages.md](stages.md), note [memory/goal-ui-manual-tuning.md](memory/goal-ui-manual-tuning.md).

The user goes from a "RAW + JPEG" pair to a finished NP3 in the browser. NX Studio is not needed at any step. Base: a static application in `web/`, RAW decoding via WebAssembly and rendering on WebGL2; the server only serves the application files. The Python modules `match.py`, `render.py` and `analyze.py` remain the references for the browser implementations of fitting, rendering and reports.

## Language and localization

- The whole user interface is in English. No Russian appears in any UI string.
- i18n is built in from the start, the mechanism is `web/lib/i18n.js`: the English string is the key, other languages' dictionaries are registered via `register(code, dict)` and translate the keys; markup and code do not change when a language is added.
- Statics are translated with `data-i18n` attributes (text) and `data-i18n-ph` (placeholder), dynamics with the function `t("Processing {name}…", { name })`. New strings are added only this way, no hardcoded English in markup — otherwise the string is untranslatable.
- The language is stored in localStorage (`lang`), default en. A language switch is added to the interface with the first real translation; until then the dictionaries are empty.
- An example of the wiring is `web/bench.html`. Service pages without an interface (`web/test.html`, test logs) do not use i18n, their texts are developer-facing, not UI.

## Scenario

```
[1 Start] ──► [2 Comparison] ─┬─► "Looks good" ──► [3.1 Manual adjustment] ──► Save NP3
                  ▲           │
                  │           └──► "Continue fitting" ──► [3.2 More frames]
                  └───────────────────────────────────────────────┘
```

On steps 2 and 3.1 there is a **profile strength** slider (see the "Profile strength" section). After every fit (steps 1 and 3.2), after every change at step 3.1 and after a strength change the same **report** is shown: a color-match table, an error map, NP3 parameters. Its composition is described below, in the "Report" section.

## Step 1. Start

**Screen**

1. A disclaimer about what the application does. The text will be written later, for now it is a `DISCLAIMER` stub. It must say:
   - the render is approximate: it differs from the real NX Studio by dE ≈ 1.85 on average ([results.md](results.md));
   - the development is calibrated for the Nikon Z f, with other cameras the result is worse;
   - frames are processed locally and are not sent anywhere.
2. Recommendations for fitting pairs (draft, based on [decisions.md](decisions.md) and `analyze.py`):
   - the JPEG is made from the same RAW with one preset, without manual edits and local masks;
   - the frame is not cropped or rotated, without strong vignetting and grain;
   - there is little overexposure in the frame: the white share in the target is below 30% (`CLIPPED_BAD`);
   - Active D-Lighting is left "as shot" ([memory/adl-as-shot.md](memory/adl-as-shot.md));
   - the more different colors in the frame the better: greys, skin, greenery, sky, saturated warm colors;
   - more than 6 frames usually does not help the fit (`MAX_FRAMES`).
3. Pair loading: a RAW field (`.NEF`, `.DNG`) and a target field (`.JPG`). Drag-and-drop or file pickers, several files at once. **TIFF targets are not accepted in the browser interface** (decision 2026-11-19: nobody loads TIFFs into the browser; TIFF pairs remain fully supported by the Python CLI). Pairing rule (implemented in stage 1): a RAW and a JPEG with the same base name form one pair; the remaining files are matched in the order they arrived — a file joins the first pair that has the other kind of file and lacks its own; with no candidate a new pair is created (possibly a single-file pair, completed later). Re-dropping a RAW with the same name as a not-yet-ready slot retries that pair. Until real pair preparation arrives (stage 2), a target whose aspect ratio does not match the RAW frame (either orientation, ±2%) is rejected as a crop/rotation hint — a documented stage-1 guard, not the alignment check.
4. Profile name. This is the `name` field in NP3: 1 to 19 ASCII characters (`np3.serialize`). By default the name is taken from the RAW, as in `match.py`. Invalid characters are highlighted right away, before the run.
5. A "Fit" button.

**Pre-fit checks** (shown as warnings, they do not block the run unless stated):

| Check | Source | Blocks |
|---|---|---|
| RAW is readable | `render.linear` | yes |
| Camera is not a Z f | `raw-identify`, `ui.TRAINED_ON` | no |
| Pair does not align (NCC < 0.6) | `pairs`, `analyze.NCC_BAD` | yes |
| Custom WB or exposure in the target's XMP, will be taken out of the profile | `match.edit_gain` | no |
| Manual edits, grain, vignetting | `match.edit_warnings` | no |
| A lot of overexposure in the target | `analyze.CLIPPED_BAD` | no |

**Fitting** runs in the background, with progress by stages on the screen: development, alignment, fitting, report. Result: a draft `out/<name>/`, then a transition to step 2.

## Step 2. Comparison

**Screen**

- The "RAW + NP3" render next to the original JPEG. Modes: side by side, a curtain, switching by a key. Zoom and pan are shared by both halves.
- If there are several pairs, a strip of thumbnails on top. The report is shown for the selected pair and aggregated over all.
- The report (see below).
- The profile strength slider. The render and the report are recomputed on a strength change.
- Profile version and version history: draft, then `_r1`, `_r2`... Any past version can be returned to.
- Two buttons:
  - **"Looks good, go to manual adjustment"** goes to step 3.1;
  - **"Continue fitting"** goes to step 3.2.

## Step 3.1. Manual adjustment

The starting values are taken from the selected profile version.

**Screen**: the image (as at step 2), a panel of NP3 tools, the report.

**Tools** (all `np3.Control` fields):

| Group | Fields | Range |
|---|---|---|
| Basic | Saturation, Contrast, Highlights, Shadows, White level, Black level | -100...100 |
| Color Blender | 8 colors x (Hue, Chroma, Brightness) | -100...100 |
| Color Grading | shadows, midtones, highlights x (Hue 0..359, Chroma, Brightness); Blending 0..100; Balance -100..100 | |
| Curve | points (x, y) 0..255, up to 20 points | |
| Details | Sharpening -3...9, Mid-range sharpening -5...5, Clarity -5...5 | step 0.25 |
| Profile strength | 0...150%, default 100% | see "Profile strength" |

**Behavior**

- After every change the render and the report are recomputed in the browser. While a slider is dragged, the render is reduced; full after release. Stale tasks do not apply to the current state.
- Tools the browser render does not understand yet (an analog of `Renderer.unrendered`) are visible and marked.
- Undo and redo. Reset of a field, a group or the whole profile to the fitted values. Changed fields get a mark.
- "Save NP3": the browser creates and downloads the file without contacting the server. Strength is already applied in the file.
- "Save a strength set": several NP3s at once, e.g. 30, 50, 70 and 100%. The computation matches `strength.py name 30 50 70` but runs in the browser; file names are derived from the base name and are unique (no field of the NP3 itself is renamed).
- One can return to step 2 and continue fitting. Manual edits are not carried over in that case, a warning is needed.

## Step 3.2. More frames

- Loading one or more new pairs with the same checks as at step 1.
- A hint on which colors are missing: coverage of groups over the already loaded pairs (`analyze.coverage`, `analyze.suggest`). Example: "little skin and sky".
- If more candidates are loaded than needed, a set is recommended (`analyze.recommend`), the user can change it.
- A pair that interferes can be removed from the fit: e.g. the one whose error is much higher than the others.
- "Refit": fitting over all selected pairs, the result into the next version (`next_name`: `_r1`, `_r2`...). Then back to step 2.

This is not `match.py --refine`: that one corrects a profile against an NX render, and here NX is not needed. Fitting in the interface is a new fit over the extended pair set. An open question: whether to start it from the previous version instead of zero.

## Decisions

Fixed 2026-11-19 at the start of the full-flow implementation ([ui-plan.md](ui-plan.md) section 2). Where an earlier section of this document disagrees, this section wins.

1. **Strength UI.** No preset buttons (30/50/70/100%) — a slider only. The profile and file name do not change at any strength: no `-70`-style suffix, no truncation. The strength-set export (several NP3s at once) stays; its files get valid unique names derived from the base name. This keeps the manual-MVP behavior; the older preset-button/suffix requirements above are superseded.
2. **Reset semantics.** In the fitting flow (steps 2, 3.1, 3.2) reset of a field, a group or the whole profile returns to the selected fitted version. Standalone manual editing (the current single-RAW editor) keeps the neutral-default reset. Changed-field marks and undo/redo use the fitted baseline.
3. **Refit initialization.** A refit is a new deterministic fit from the same zero initialization as `match.py`, over all selected pairs. The previous version is kept unchanged. Warm-start from the previous control or from manual edits is a separate quality experiment, not UI behavior.
4. **Versions and persistence.** Fit versions are immutable and live in tab memory only: `draft`, `_r1`, `_r2`, ... Versions store controls and fit metadata, not pixel buffers. Nothing is written to `out/`, there is no server storage. Session export/autosave is out of scope.
5. **Strength.** 0-150%, applied after every fit/refit (fitting always runs at 100%); no separate color/curve strengths. Single and batch exports always scale from the base control, never from an already scaled result.
6. **Open product items.** The disclaimer stays a `DISCLAIMER` stub until approved. Hold-out validation is not part of the first full-flow delivery. No version-retention limit until memory measurements justify one.

## Profile strength

Strength sets what part of the way from the Nikon neutral to the profile to go. The computation is as in `strength.scaled`:

- Saturation, Contrast, Highlights, Shadows, White, Black, the blender, grading Chroma and Brightness are multiplied by the fraction;
- the curve is blended with the identity;
- grading Hue, Blending, Balance, Sharpening, Mid-range sharpening and Clarity do not change.

**Behavior**

- Strength is a multiplier on top of the profile, not an edit of its fields. At step 3.1 the sliders show the profile values at 100%, strength is applied to them at render and at save. So strength can be changed back and forth without losses, and manual edits are not reset.
- Above 100% the profile is strengthened. Fields that hit ±100 and get clipped are highlighted, a warning next to them.
- Fitting (steps 1 and 3.2) always runs at 100%. The chosen strength is kept after it and applied to the new version.
- The report states the strength it is computed at. NP3 parameters are shown in two columns: profile and result with strength.
- The name in the NP3 and in the downloaded file is always the base profile name, at any strength (see "Decisions"). Only the strength-set files differ: `<name>-<percent>.NP3` (the NP3 inside keeps the base name).

## Report

It is produced after every step: after a fit, after a refit and after every change in manual adjustment. It is computed on the aligned pair over the target pixels without overexposure, as `analyze.region_sums`.

**1. Summary.** The profile strength the report is computed at. The mean dE2000 of the render vs the target, of the neutral (without a profile) vs the target, and the mean over color bins (`bin_mean`). At step 3.1 the difference from the fitted version is shown next to it.

**2. Color-match table.** One row per group from `analyze.GROUPS` with a share above 1% of the frame:

| Group | Share | Target | Render | dE | dL | dC | dh |
|---|---|---|---|---|---|---|---|
| skin | 6% | ■ | ■ | 2.1 | -0.8 | +1.2 | +3 deg |

"Target" and "Render" are swatches of the group's mean color. Rows can be sorted. Clicking a row highlights its region on the image.

**3. Error map.** dE2000 per pixel, overlaid on the image or next to it. A sequential scale with a legend (0, 2, 5, 10+). Overexposed and unaligned pixels are painted with a separate neutral color. There is a "dE / dL / dC / dh" switch, where dL, dC and dh have a diverging scale.

**4. NP3 parameters.** All fields of the current version in the same groups as at step 3.1, with a curve thumbnail. Zero fields are muted. At step 2 after a refit the difference from the previous version is shown.

The report can be downloaded as a JSON file: summary, table, parameters, file names.

## What remains to be done in code

- A browser analog of `match.py`: fitting with progress in a Worker, without server-side computation. The Python code remains the quality reference.
- The static application `web/`: local file loading via the File API, background tasks, session state (pairs, versions), a report with an error map.
- A browser render with an arbitrary `np3.Control`, including the curve and detail. Strength is applied by a local analog of `strength.scaled`.
- Local download of a single NP3 or a strength set via Blob, without writing to the server.
- A browser analog of `analyze.region_sums`: the table needs mean Lab of the target and the render by groups, not only sums.

## Open questions

1. The disclaimer text.
2. ~~Refitting: from zero or from the previous version?~~ Resolved: from zero, deterministically (see "Decisions").
3. Is a check on frames outside the fit needed: hold out one pair and show the error on it separately? (Not part of the first full-flow delivery.)
4. ~~How many versions to keep and where~~ Resolved: immutable versions in tab memory, no retention limit for now (see "Decisions").
5. ~~The upper strength bound~~ Resolved: 150% (see "Decisions").
6. ~~A separate strength for color and curve~~ Resolved: no (see "Decisions").
