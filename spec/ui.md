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
3. Pair loading, **RAW first** (decision #7, 2026-11-20; replaces the earlier two-zone pairing rule):
   - One drop zone / picker for RAW files (`.NEF`, `.DNG`), several at once. There is no global JPEG zone.
   - Every RAW gets a card at once, with decode progress. Only after the RAW is decoded does the card offer an **"Add JPEG"** slot: a click opens a picker for one `.JPG`, or a JPEG is dropped onto the card. The user decides which JPEG belongs to which RAW; base names are not matched.
   - Every card has an explicit **"Remove from fit"** button. There is no include checkbox and no "Edit" button.
   - **TIFF targets are not accepted in the browser interface** (decision 2026-11-19: nobody loads TIFFs into the browser; TIFF pairs remain fully supported by the Python CLI).
   - Details and edge cases: "Decisions" #7.
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

- The "RAW + NP3" render next to the original JPEG. Modes: side by side and a curtain (the key-toggle mode is removed, decision #8). Zoom and pan are shared by both halves; a double click on the image returns to the fitted view (there is no "Reset view" button).
- If there are several pairs, a strip of thumbnails on top. The report is shown for the selected pair and aggregated over all.
- The report (see below).
- The profile strength slider. The render and the report are recomputed on a strength change.
- ~~Profile version and version history: draft, then `_r1`, `_r2`... Any past version can be returned to.~~ Removed by decision #12: one current profile.
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
- ~~"Save a strength set": several NP3s at once.~~ Removed by decision #10: the user saves NP3s at the strengths they need one by one.
- One can return to step 2 and continue fitting. Manual edits are not carried over in that case, a warning is needed.

## Step 3.2. More frames

> Since 2026-11-20 there is no separate More frames screen: adding/removing pairs, the coverage hint and the refit live on Compare (decision #11), and there is one current profile instead of versions (decision #12). The rules below (checks, coverage, recommended set, refit from zero) still apply there.

- Loading one or more new pairs with the same checks as at step 1.
- A hint on which colors are missing: coverage of groups over the already loaded pairs (`analyze.coverage`, `analyze.suggest`). Example: "little skin and sky".
- Loading follows the same RAW-first flow as step 1 (decision #7).
- If more candidates are loaded than needed, a set is recommended (`analyze.recommend`). Pairs outside it are marked "not recommended"; nothing is removed automatically, the user removes pairs with "Remove from fit".
- A pair that interferes can be removed from the fit: e.g. the one whose error is much higher than the others (only a hint, see decision #7).
- "Refit": fitting over all selected pairs, the result into the next version (`next_name`: `_r1`, `_r2`...). Then back to step 2.

This is not `match.py --refine`: that one corrects a profile against an NX render, and here NX is not needed. Fitting in the interface is a new fit over the extended pair set. An open question: whether to start it from the previous version instead of zero.

## Decisions

Fixed 2026-11-19 at the start of the full-flow implementation ([ui-plan.md](ui-plan.md) section 2). Where an earlier section of this document disagrees, this section wins.

1. **Strength UI.** No preset buttons (30/50/70/100%) — a slider only. The profile and file name do not change at any strength: no `-70`-style suffix, no truncation. ~~The strength-set export (several NP3s at once) stays; its files get valid unique names derived from the base name.~~ The strength-set export is removed (decision #10). This keeps the manual-MVP behavior; the older preset-button/suffix requirements above are superseded.
2. **Reset semantics.** In the fitting flow (steps 2, 3.1, 3.2) reset of a field, a group or the whole profile returns to the selected fitted version. ~~Standalone manual editing (the current single-RAW editor) keeps the neutral-default reset.~~ The standalone editor is removed by decision #7. Changed-field marks and undo/redo use the fitted baseline.
3. **Refit initialization.** A refit is a new deterministic fit from the same fixed starts as `match.py` (`match.STARTS`: zero, and — only when that run gets stuck — zero with zone brightness shadows −50 / midtone +30; the lower cost wins), over all selected pairs. The previous version is kept unchanged. Warm-start from the previous control or from manual edits is a separate quality experiment, not UI behavior.
4. **Versions and persistence.** Fit versions are immutable and live in tab memory only: `draft`, `_r1`, `_r2`, ... Versions store controls and fit metadata, not pixel buffers. Nothing is written to `out/`, there is no server storage. Session export/autosave is out of scope.
5. **Strength.** 0-150%, applied after every fit/refit (fitting always runs at 100%); no separate color/curve strengths. Single and batch exports always scale from the base control, never from an already scaled result.
6. **Open product items.** The disclaimer stays a `DISCLAIMER` stub until approved. Hold-out validation is not part of the first full-flow delivery. No version-retention limit until memory measurements justify one.

7. **Pair assembly: RAW first (2026-11-20).** Supersedes the stage-1 pairing rule (same base name, then arrival order), the global JPEG zone, the include checkbox, the per-card "Edit" button and the standalone editor entry. Applies to Start (step 1) and More frames (step 3.2) alike — one card component, one loading path.
   - **RAW zone.** The only drop zone / picker on the screen; accepts `.NEF` and `.DNG`, several files at once. A dropped JPEG or any other file is skipped with a status message (for a JPEG: "Add the JPEG on its RAW's card"). A RAW whose base name matches a card that is still decoding or failed retries that card (the old re-drop rule stays); a RAW whose name matches a ready card is skipped as a duplicate with a status message.
   - **Card states.**
     1. *Decoding* — file name and progress; only "Remove from fit".
     2. *RAW error* — the decode error; only "Remove from fit". Such a card never fits.
     3. *RAW ready, no JPEG* — camera, frame size, the camera warning; an **"Add JPEG"** slot (a button-styled drop target inside the card) and "Remove from fit".
     4. *JPEG decoding / preparing* — target name and progress (decode, then pair preparation: alignment, NCC, warnings).
     5. *Pair ready* — the current card content (RAW, Target, Camera, Frames, ADL, Alignment, warnings, More-screen advice) plus "Replace JPEG" and "Remove from fit".
     6. *Pair blocked* — as 5 with the blocking reason (low NCC, too small target, preparation failure).
   - **Adding a JPEG.** Allowed only in state 3 (and as "Replace JPEG" in 5/6). The slot accepts exactly one `.JPG`/`.JPEG`: by click (a file picker with `multiple` off) or by drop onto any part of the card. Several files dropped onto a card, or a non-JPEG, are rejected with a message on that card; the card state does not change. A JPEG dropped onto the page outside any card is skipped with the status message above. Names are not compared: a JPEG with another base name is accepted without a warning.
   - **Target checks** run on the card as before (decode, XMP/edit warnings, the aspect/orientation guard, then preparation and NCC). A rejected JPEG leaves the card in state 3 with the reason shown on the card until the next JPEG is added.
   - **Replacing a JPEG** cancels the pair's running preparation and drops its preparation, advice record and cached worker data; the pair is prepared again as new. Existing versions are not touched.
   - **"Remove from fit"** removes the pair from the session **permanently**: files, decoded data, preparation, advice and worker caches are released, its running decode/preparation is cancelled, and a running fit or refit that includes the pair is cancelled (as any selection change does now). No confirmation dialog; to get the pair back the user loads the RAW again. Versions are kept unchanged (they store controls and `pairIds`; an id that no longer exists is simply not shown in the Compare strip). If the removed pair was selected, the selection moves to the next pair, or to none.
   - **What is fitted.** No inclusion state remains in the UI (the session `included` flag is removed). Fit/refit uses every pair with both files decoded, prepared and not blocked, in card order. Under the Fit/Refit button: "{n} pairs will be fitted" and, when non-zero, "{m} without a JPEG, {k} blocked — skipped". Fit is disabled when n = 0.
   - **Recommended set (More frames).** "Use the recommended selection" is removed (it toggled inclusion). Pairs outside `analyze.recommend` get a "not recommended" mark with the reason; the high-error hint stays a flag. The user removes pairs by hand; nothing is removed automatically.
   - **No standalone editor in the wizard.** The "Edit" button and the editor entry from Start are gone: inside the wizard the manual editor is reached only from Compare ("Looks good — manual adjustment") on a fitted version, with the fitted baseline. The standalone editor (neutral reset, its own RAW drop, NP3 import, `?np3=` links) moves to its own pages — decision #9.
   - **Profile name default** comes from the first RAW card, as before.

8. **Compare screen and report panel (2026-11-20, user review of step 2).**
   - **Modes:** "Side by side" and "Curtain" only. The "Key toggle" mode, its Space-hold swap and its mention in the hint under the buttons are removed.
   - **No "Reset view" button.** A double click on the image (either half) returns zoom and pan to the fitted view; the hint under the buttons says so ("Wheel — zoom to the cursor, drag — pan, double click — fit to the screen; in the curtain mode drag the divider").
   - **Strength value follows the slider.** The number next to the Compare strength slider shows the current strength (`state.strength`) live while dragging, not a fixed "100%". Bug at the time of writing: `compare-view.js` repaints the label only in `refresh()`, not on the slider's `input` event. The same check for every strength label (Compare, editor): one value, updated on every change.
   - **No "Download report".** The button is removed from the report panel; the report stays on screen only ("This pair" / "All pairs" remain).
   - **Curve thumbnail** in "NP3 parameters":
     - square (1:1), full width of the report panel column, both axes 0..255 as in the curve editor; a thin identity diagonal as the reference;
     - the curve drawn is the result at the current strength (as now);
     - backdrop: the Y' luma histogram of the neutral development (without a profile), the same as the curve editor's backdrop (`renderer.lumaHistogram` semantics: detail.YW weights, 256 bins, peak = 1, filled, muted). "This pair" — the selected pair; "All pairs" — the sum of the fitted pairs' histograms, normalized to the peak;
     - the source is the report worker's cached neutral of each pair (the report grid), so no extra develop is needed; the histogram comes with the report DTO;
     - with the curve off: the same square with the histogram and the identity diagonal, and the "off" label.

9. **Separate pages (2026-11-20).** The fitting wizard (this document: steps 1, 2, 3.1, 3.2) lives on `web/picture-control-jpg-fit.html`, desktop only. The standalone NP3 editor lives on `web/picture-control-editor.html` with the mobile twin `web/picture-control-editor-mobile.html` (the redirect between the two is inside them). `web/index.html` becomes a landing (to be discussed) that also forwards legacy `?np3=` links to the editor. Step 3.1 stays in the wizard: manual adjustment of a fitted version and editing an NP3 on a RAW are different flows. The wizard has no NP3 import. Details: [ui-pages.md](ui-pages.md).

10. **No strength-set export (2026-11-20).** The "Save strength set (30/50/70/100%)" button is removed from every page (wizard step 3.1 and both editor pages). A user who wants several strengths moves the slider and saves each NP3 with "Save NP3". Decision #5 stays for the single export: it always scales from the base control. Code to remove: the button and its i18n key, `transfer.exportSet`, `web/lib/strength-set.js`, `make_strength_set_golden.py` and its golden fixture with the level-1/8/8b checks that use them; `strength.py` (CLI) is not affected.

11. **Compare is the hub after the first fit (2026-11-20, user review).** Supersedes step 3.2 "More frames" as a separate screen and the "Continue fitting" / "Back to Start" buttons. Start is only the beginning: once a fit exists the session lives on Compare (and its manual step 3.1); starting over is a page reload.
   - **Color coverage on Compare.** The coverage table of the pairs in the fit set (`analyze.coverage` / `level`: group, share, enough / little / none) sits at the top of the side panel (it was "above Versions"; the Versions list is gone, decision #12), with the "Little or none: …" line and the `suggest` lines under it. It follows every pair change without a fit (the advice records of stage 7).
   - **The thumbnail strip is the pair list.** The whole strip is a drop zone for RAW files; at its end a **drop button** tile (click = the RAW picker). A dropped RAW becomes a new tile at once, **inactive** (dimmed): decoding, then the RAW preview. An inactive tile takes its JPEG by a drop onto the tile or a click (the JPEG picker; one file — the decision #7 rules). The pair then prepares (progress on the tile); prepared, it shows the photo but stays dimmed with the caption **"Refit to include"** until a version that contains it is selected. A prepared new pair can be clicked: Compare shows the selected version on it and the report covers it (a preview of how the profile does on the new frame); RAW-only, decoding and preparing tiles are not selectable. A blocked pair keeps its reason on the tile (badge + title).
   - **× on every tile** = "Remove from fit" (decision #7: the pair leaves the session; a running refit is cancelled; versions are kept). The advice of stage 7 moves onto the tiles: the high-error hint and "not recommended" become a small warning badge with the text in the tooltip.
   - **Refit button** at the top, right of the strip — a square about the size of a thumbnail (layout change of 2026-11-20): the label is just "Refit" (no pair count) over `refitPairIds`, no caption under it (2026-11-20 review; why it is off and the skipped count of decision #7 are in its tooltip only); enabled when n ≥ 1 and the set differs from the selected version's pairs (otherwise the result would repeat it); while it runs it reads "Cancel the refit". The finished refit becomes the next `_rN` version, selected, and the screen stays on Compare.
   - **At the bottom of the side panel:** "Manual adjustments" (was "Looks good — manual adjustment", step 3.1) and **"Download NP3"** — the current profile at the current strength, the same file as Save NP3 in the editor.
   - **Removed:** "Continue fitting" and "Back to Start" on Compare, "Continue fitting" and "Back to Start" in the editor (step 3.1 keeps "Back to Comparison"), the More frames screen (`#more`, `more-view.js` UI; the pure advice stays), the Start-screen "Comparison" button. A RAW dropped on the page outside the strip while on Compare goes to the strip.

12. **No version history (2026-11-20, user review).** Supersedes decision #4 and the "Profile version and version history" item of step 2: the wizard always works with **one current profile**. There is no Versions list; a refit replaces the profile (the name stays, no `_rN` suffix; internally the id changes — `draft`, `r1`, `r2`, … — so the render/report caches never mix the two); a cancelled or failed refit leaves the current profile as it was. "Refit to include" on a tile means "not in the current profile". Step 3.1 edits the current profile; leaving it with edits still asks first (the edits are discarded, the profile stays). The report's "difference from the previous version after a refit" goes away with it.
13. **Report panel layout (2026-11-20, user review).** (a) Every report section — Summary, Color match, Error map, NP3 parameters — is a collapsible group like the editor's groups (`details.grp`, the title in the summary line), open by default; the error-map group hides as a whole in the "All pairs" scope. (b) NP3 parameters show **one value column**: the value at the report's strength, i.e. exactly what Download NP3 writes; the "Profile / Result · N%" header row and the second column are gone (at 100% they were identical; the strength is on the Compare slider). When the strength changes a value, the profile value at 100% is in the cell's tooltip; clipped values are highlighted as before; manual deltas follow the value. (c) The color-match table fits the panel width: the target and render swatches share one "Color" cell (target left, render right, each with its own tooltip), and the report panel never scrolls sideways.
14. **Coverage and summary readability (2026-11-20, user review).** (a) The coverage percents are padded with leading zeros to the widest value in the table (`000.4%` … `116.3%`), so the column keeps one width; shares can exceed 100% because they sum the group's share over the frames of the fit set. (b) The notice under the coverage table — "Little or none: …" with the "add to the fit" suggestions — sits in a tooltip-like box: a frame on a darkened background. (c) Every report summary line (Render vs target, Neutral vs target, Bin mean, Vs fitted) explains itself on hover (a tooltip on the term and the value; the term has a dotted underline).
15. **Wizard UX review fixes (2026-11-20, UI/UX review of the wizard; the manual step 3.1 and the editor are not touched).** (a) **Profile name:** the field is the NP3 name exactly as typed — the fit no longer rewrites it to `"NPF-" + upper()[-15:]`; the default is that final name built from the first RAW (`NPF-DSC_5584`), and a hint under the field says it is saved as typed. (b) **Leave guard:** with pairs in the session the page cancels `beforeunload`, so the browser asks before a reload or close. (c) **Export control after a fit:** the editor control follows the fitted profile at once (`setBaseline` on a finished fit), so Download NP3 on Compare before the manual step writes the fit, not the neutral `NPF-MANUAL`; after the download the status says where the file goes (`NIKON/CUSTOMPC`, Manage Picture Control → Load/save → Copy to camera). (d) **Fit progress:** no LM cost in the UI ("Fitting: iteration n of up to N", "Fit finished: name in s"); a thin progress bar under Fit; while a fit runs the button reads "Cancel fitting" and cancels it. The count under Fit reads "1 pair / n pairs will be fitted; skipped: m without a JPEG, k blocked" (only non-zero parts) and, while pairs prepare, "Fit unlocks when the preparation finishes". Preparation stages are shown in user words. (e) **Refit sub-line:** the square keeps one short label ("Refit", "Cancel" while running) and a one-line state under it drawn by CSS (`data-sub`): "Up to date", "Preparing…", "No pairs", "+n / −n pair(s)", "Refit i/N" while running — it never wraps; the tooltip stays. (f) **Compare canvas:** HiDPI (the bitmap is CSS size × `devicePixelRatio`, the mapping stays in CSS pixels); caption plates measured in their own font; the curtain shows "RAW + NP3" / "Target" captions at the divider, a round handle, `col-resize` near it. (g) **Report:** the error-map legend ticks sit under their values on a full-width bar; a pair outside the current profile gets a "Preview: this pair is not in the profile yet" note. (h) **Coverage:** "none" rows are muted, not red (a hint, not an error). (i) **Start:** no "Active D-Lighting ?" row on the cards; the decode status names the file instead of "Ready"; Fit and Download NP3 are primary buttons. (j) **Keyboard:** the RAW zone and the selectable / JPEG-waiting tiles are `role=button` with `tabindex=0` (Enter / Space), a focused tile keeps focus across strip rebuilds; the Start and Compare status lines are `aria-live`; a visible `:focus-visible` outline. Not in this round: the coverage share format (decision #14 stands), the Compare/editor layout density, the error-map height, the tile size, the manual step (target in the viewer, the strip in the editor).
16. **The quick editor on Compare; Start card progress (2026-11-20, user review).** Supersedes the separate step-3.1 screen (the "Manual adjustment" layout with its own viewer, the "Back to Comparison" leave warning, the manual "<version>+manual" report and "Copy link" in step 3.1). (a) **Manual adjustments** on Compare keeps the screen — the strip (pair switching, adding pairs), the viewer with the target (side by side / curtain), zoom and pan — and puts the NP3 parameter panel in the right column instead of the report. The rest of the layout does not change (the viewer does not move): the coverage column, Refit and the Compare strength bar stay visible, but Refit ("Editing"), the strength slider (the panel has its own), Manual adjustments, Download NP3 and Copy link are disabled until Done / Cancel, so the state is never ambiguous. Every edit re-renders the compare render side with the manual control (17-point LUT while a slider moves, 33 after the release). The report is hidden while editing and recomputes on the way out. Marks, resets, undo/redo and the curve backdrop work against the current profile as before (decision #2). (b) **Done** makes the edits the current profile: a new immutable version (`<parent>m<n>`, `kind: "manual"`, the same pairs and fit metadata), so Download NP3 writes it; **Cancel** returns the control to the profile it started from. No confirmation either way; Done without edits changes nothing. (c) A **refit** starts from zero (decision #3), so over a profile with manual adjustments it asks first in an in-page alertdialog ("Keep the profile" / "Refit anyway"). (d) **Copy link** (the editor link, spec/ui-pages.md "Share links") moves to the Compare actions under Download NP3. (e) **Start cards** show the pair preparation as a bar with the stage under it — "Step n of 7 · Reading the RAW / Lens correction: vignetting / Geometry: crop / Geometry: orientation / Lens correction: distortion / Aligning with the JPEG / Finishing" (or "Waiting for the previous pair") with a spinner; inside a stage the bar eases toward the stage end over its expected time (the spans follow the measured share: aligning ~60%); decoding states get a spinner before the state text.
17. **Wizard fixes (2026-11-24, user review).** (a) **No Strength line in the report summary:** the strength is the Compare slider right above the report; the report body keeps the strength it was computed at as `data-strength` (the tests' sync signal). (b) **Back to the fit after manual adjustments.** The session keeps the last fitted profile (`state.fitted`: the draft or the latest refit) when Done makes a manual version current. While the current profile is manual, Compare shows **Revert to fit** under Manual adjustments; it asks in the in-page alertdialog and makes the fitted profile current again at once (its renders and report come from the caches, the strength is kept). Refit is no longer "Up to date" over a manual profile: with the fit's own pairs it reads "Back to fit" and, since a refit is deterministic (decision #3), restores the fitted profile at once after the same confirmation instead of recomputing it; with changed pairs it refits as before (decision #16c). In the quick editor the marks and resets compare against the fitted profile (decision #2), also when the edits start from a manual profile, so a reset of the whole profile is a way back to the fit; Cancel returns to the profile the editor started from; Done with every field equal to the fit makes the fitted version itself current. (c) **Parallel pair preparation.** Up to two pairs prepare at once, each in its own pair Worker (`session.prepSlots`), but only on a desktop known to have at least 8 GB: `navigator.deviceMemory >= 8` (Chromium; the value is capped at 8, so 8 GB is the worst case) or a desktop Safari (every Mac it runs on has 8 GB or more; an iPad "desktop site" is told apart by its touch points), and at least 4 cores. Firefox (no deviceMemory) and mobile browsers prepare one pair at a time; `?prep=N` (1–4) overrides. A preparation already takes hundreds of MB and the session up to ~4 GB, hence the cap of two. RAW decoding stays serialized (the loader is single-generation).
18. **Render detail (2026-11-24, user review: "the render looks much softer than the target").** Measured against NX Studio's own exports of the same frames at the same size (the `tools` pack NEUTRAL, 1512 px): our render had the same amplitude below 0.2 cycles/px but only 0.68-0.94 of NX's at Nyquist, even with every detail tool at 0, and a full AHD demosaic + Lanczos is no crisper than our development — NX adds its own detail. (a) **The NX base detail:** a fixed Y' high-pass calibrated on those exports (`detail.py base`, spec/tools/detail.md) runs in every render — the web `Renderer`, `render.py` with `sharp=True` — near the 1512-1600 px scale it was measured at; not in fitting, not in the report's dE (its grid is too coarse to see it). It is not an NP3 field and changes nothing in the exported file. (b) **The Compare geometry gather is bicubic** (`applyRemap`, Catmull-Rom): the near-1:1 bilinear gather at random fractional offsets took about a quarter of the finest detail. On DSC_5584 the top-octave amplitude of the compare render rose from 0.47-0.48 to 0.67-0.73 of the target's (Lanczos-shrunk to the same size); the rest is the target's own look (its Lightroom Sharpening 40, Dehaze), which the profile's Sharpening / Mid-range fields can follow in the quick editor.

## Profile strength

Strength sets what part of the way from the Nikon neutral to the profile to go. The computation is as in `strength.scaled`:

- Saturation, Contrast, Highlights, Shadows, White, Black, the blender, grading Chroma and Brightness are multiplied by the fraction;
- the curve is blended with the identity;
- grading Hue, Blending, Balance, Sharpening, Mid-range sharpening and Clarity do not change.

**Behavior**

- Strength is a multiplier on top of the profile, not an edit of its fields. At step 3.1 the sliders show the profile values at 100%, strength is applied to them at render and at save. So strength can be changed back and forth without losses, and manual edits are not reset.
- Above 100% the profile is strengthened. Fields that hit ±100 and get clipped are highlighted, a warning next to them.
- Fitting (steps 1 and 3.2) always runs at 100%. The chosen strength is kept after it and applied to the new version.
- ~~The report states the strength it is computed at.~~ The summary has no Strength line (2026-11-24): the strength is on the Compare slider next to the report. ~~NP3 parameters are shown in two columns: profile and result with strength.~~ NP3 parameters show one column, the value at the strength (decision #13).
- The name in the NP3 and in the downloaded file is always the base profile name, at any strength (see "Decisions"). ~~Only the strength-set files differ: `<name>-<percent>.NP3`.~~ (strength sets removed, decision #10)

## Report

It is produced after every step: after a fit, after a refit and after every change in manual adjustment. It is computed on the aligned pair over the target pixels without overexposure, as `analyze.region_sums`.

Every section is a collapsible group, open by default (decision #13).

**1. Summary.** ~~The profile strength the report is computed at.~~ (removed 2026-11-24, see "Profile strength"). The mean dE2000 of the render vs the target, of the neutral (without a profile) vs the target, and the mean over color bins (`bin_mean`). At step 3.1 the difference from the fitted version is shown next to it.

**2. Color-match table.** One row per group from `analyze.GROUPS` with a share above 1% of the frame:

| Group | Share | Color | dE | dL | dC | dh |
|---|---|---|---|---|---|---|
| skin | 6% | ■■ | 2.1 | -0.8 | +1.2 | +3 deg |

"Color" holds two swatches of the group's mean color: the target (left) and the render (right) — one cell so the table fits the panel (decision #13). Rows can be sorted. Clicking a row highlights its region on the image.

**3. Error map.** dE2000 per pixel, overlaid on the image or next to it. A sequential scale with a legend (0, 2, 5, 10+). Overexposed and unaligned pixels are painted with a separate neutral color. There is a "dE / dL / dC / dh" switch, where dL, dC and dh have a diverging scale.

**4. NP3 parameters.** All fields of the current profile in the same groups as at step 3.1, one value column — the value at the report's strength (decision #13) — with a square curve thumbnail over a histogram backdrop (decision #8). Zero fields are muted. At step 2 after a refit the difference from the previous version is shown.

~~The report can be downloaded as a JSON file: summary, table, parameters, file names.~~ Removed by decision #8: there is no "Download report" button.

## What remains to be done in code

- A browser analog of `match.py`: fitting with progress in a Worker, without server-side computation. The Python code remains the quality reference.
- The static application `web/`: local file loading via the File API, background tasks, session state (pairs, versions), a report with an error map.
- A browser render with an arbitrary `np3.Control`, including the curve and detail. Strength is applied by a local analog of `strength.scaled`.
- Local download of a single NP3 via Blob, without writing to the server.
- A browser analog of `analyze.region_sums`: the table needs mean Lab of the target and the render by groups, not only sums.

## Planned, not implemented (fit-engine research 2026-11-24)

Agreed with the user, deferred. Numbers are from the research harness on the 34 SA pairs and NX checks
(project doc "fit-engine research, part 2", `spec/decisions.md`).

1. **Primary frame.** A pair can be marked as the primary one on Compare; it weighs ×2–3 in the fit
   (its residual rows multiplied by sqrt(w), the 1/sqrt(n_q · P) normalization unchanged). Measured with
   ×3 on the yellow-house frame (before the zone grid model): that frame 3.61 -> 3.21, the 28 frames
   outside the fit no worse (3.53 -> 3.46). Needs
   the same pair weight in `match.py` (the reference) and a `weight` per pair in the fit inputs.
2. **Effective tone curve.** The fit splits tone between the curve and the zone brightness (shadows
   about -100, midtones about +60 with Blending near 0), so the raw curve thumbnail looks crushed in the
   shadows while the result is not. Show, next to (or instead of) the raw curve, the tone the profile
   actually applies: a neutral grey ramp through the whole profile (grading with zone brightness,
   Blending/Balance, Saturation, curve), output Y' over input Y'. The editor keeps editing the raw curve.
3. **Flat-region error in the report.** Next to the overall dE, the dE of large flat regions (texture,
   the 5x5 Lab std of target and neutral, below 2; connected regions of at least 0.3 % of the frame) and
   the dE of their mean colors (area-weighted, with p90). Walls and sky are what the eye compares; on the
   yellow-house frame the flat-region error was 2.93 against 3.21 overall, p90 of region means 3.86.
4. **Flat-region weight in the fit (optional, the user decides).** Pixels outside large flat regions
   weigh 0.1–0.3 (weights renormalized to mean 1, otherwise the ridge grows relatively and the profile
   collapses). On the fit frames region-mean dE -0.26 (yellow house p90 3.64 -> 2.49), on other frames
   the overall dE +0.08. If added, it is a switch, off by default.
5. **Check frame instead of a "harmful frame" flag.** A frame-exclusion hint from one session's data is
   mostly a false alarm (research step 9): do not add automatic exclusion or a warning flag. Instead,
   open question 3 below: one pair held out of the fit as a judge, with its error shown separately, plus
   the advice "add more varied frames".

## Open questions

1. The disclaimer text.
2. ~~Refitting: from zero or from the previous version?~~ Resolved: from zero, deterministically (see "Decisions").
3. Is a check on frames outside the fit needed: hold out one pair and show the error on it separately? (Not part of the first full-flow delivery.)
4. ~~How many versions to keep and where~~ Resolved: immutable versions in tab memory, no retention limit for now (see "Decisions").
5. ~~The upper strength bound~~ Resolved: 150% (see "Decisions").
6. ~~A separate strength for color and curve~~ Resolved: no (see "Decisions").
7. ~~Where NP3 import and `?np3=` share links land without the standalone editor~~ Resolved: on the separate editor pages (decision #9, [ui-pages.md](ui-pages.md)).
