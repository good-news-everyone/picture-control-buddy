# Work plan: mobile version (`web/mobile.html`)

> **2026-11-20: rebase pending.** M0–M3 are done on branch `mobile` (`_local/_cloud_transfer/mobile.bundle`, based on `main` 6ac6189 + a 2026-11-19 snapshot of the fitting work). Before M4 the branch is ported onto the page split of [ui-pages.md](ui-pages.md) ([ui-plan.md](ui-plan.md) stage 11): `index.html` → `picture-control-editor.html`, `mobile.html` → `picture-control-editor-mobile.html`, the router only in those two pages, the canonical share URL → `picture-control-editor.html`, the mobile Start screen and its 9b checks dropped, the core hooks moved from `app.js` into `editor-core.js` / `editor-app.js`.

Requirements, layout and acceptance criteria: [ui-mobile.md](ui-mobile.md). This plan splits the work into stages for sequential agent development: every stage has a goal, fixed inputs, tasks by file, tests, a "done when" gate and a hand-off. The contracts in section 2 are fixed before M0 starts and are not changed by the stages (see "Changing a contract").

## 0. Rules for agents

1. **Read first:** [AGENTS.md](../AGENTS.md), [ui-mobile.md](ui-mobile.md), sections 0–3 of this plan and the section of your stage. Read the log (section 9) for what earlier stages left.
2. **English only** in code, comments, commit messages, specs and UI strings (AGENTS.md). New UI strings only through `t()` / `data-i18n` / `data-i18n-ph`; add every new key to the list in section 2.11.
3. **Own your files.** Edit only the files your stage owns (section 3). Small hooks in other files are allowed only where the stage section lists them explicitly.
4. **Do not touch** the pipeline: `renderer.js`, `profile.js`, `detail.js`, `neutral.js`, `color.js`, `np3.js`, `curve.js`, `strength.js`, `raw*.js`, `loader.js`, `*-worker.js`, `fit.js`, `pair-prepare.js`, `resample.js`, `target.js`, `session.js`, `web/raw/`, `web/model/`, `web/golden/`, the Python code.
5. **The desktop does not change.** `index.html` must look and behave as before (M0 records a reference screenshot). Assertions of levels 1–8 in `web/test.mjs` are not edited; the only allowed level-8 change is the URL `index.html?view=desktop` (M0).
6. **No new runtime dependencies**, no framework, no build step, no CDN. Icons are inlined Lucide SVG (section 2.12).
7. **Tests:** `python3 test_np3.py` and `cd web && node test.mjs` must be green at the end of every stage. RAW-dependent checks skip without the files in `_local/` (as level 8 does); layout checks never depend on RAW files. A skipped item is reported in the log.
8. **Finish a stage** with: green tests, the log entry (section 9 format), the stage checkboxes ticked in this file, one commit `web: mobile <stage> — <summary>` (unless the operator says otherwise). Do not start the next stage.
9. **Changing a contract:** if a stage cannot work within section 2, stop, describe the problem and the proposed change in the log, and wait for the operator. Do not change a contract silently.
10. **Stuck:** if the same failure survives three different fix attempts, stop and write what was tried into the log.

## 1. Baseline (state on 2026-11-19)

What the stages build on. Line counts are approximate.

| Area | Now | Matters for |
|---|---|---|
| `web/index.html` | ~300 lines; all CSS inline in one `<style>` (~200 lines): palette, buttons, sliders, `.ctl`, `.tgl`, `.tabbtn`, gradient tracks, Start screen, desktop grid, `@media (max-width: 980px)` stacking | M0 CSS split |
| `web/lib/app.js` | orchestrator; looks up 15 ids with `$()`, assumes all exist (`$("drop").onclick`, `$("to-start").addEventListener`); `setStatus(s)` writes `#status` and `#start-status`; exposes `window.__np3app` | M0 null-safety, shell options |
| `web/lib/start.js` | looks up 8 ids; static disclaimer/recommendation lists live in `index.html` markup | M0 static texts |
| `web/lib/transfer.js` | `getElementById("import"/"export"/"share")`; `updateExport()` uses `disabled` + `title`; `shareNow()` builds the link on `location.href`; `exportNow()` uses `<a download>` | M0 canonical URL, M2 soft-disable + share export |
| `web/lib/history.js` | `push/clear/undo`, `length`, `index`; Ctrl+Z listener | M1 `onChange`, `canUndo` |
| `web/lib/before-after.js` | Space hold, labels in `#ba-slot`, a hint line | M2 long-press, `hint` option |
| `web/lib/panels.js`, `blending.js`, `grading.js` | three separate `slider()` helpers, each with `dblclick` reset and an editable `.val` number | M2 double-tap |
| `web/lib/curve-editor.js` | SVG in `#curve-slot`; `dblclick` on the background adds a point; points dragged with pointer events | M3 overlay, tap-to-add |
| `web/test.mjs` | level 8 opens `/web/index.html` at the puppeteer default viewport **800 × 600** (below 980 px); RAWs `test1/DSC_5584.NEF`, `test2/SKL_3024.dng` from `_local/`, else skip; the static server has no directory → `index.html` mapping | M0 harness |

## 2. Fixed contracts

### 2.1 DOM id contract

The core (`app.js`, `start.js`, `transfer.js`, editors) talks to a page only through these ids. A comment block at the top of `app.js` repeats this table.

| Required on both pages | Optional (the core must tolerate absence) |
|---|---|
| `c`, `nogl`, `ba-slot`, `panel-scroll`, `panel-foot`, `curve-slot`, `blending-slot`, `grading-slot`, `file`, `info`, `warn`, `status`, `to-start`, `import`, `export`, `share`, `start`, `start-status`, `start-info`, `raw-drop`, `raw-file`, `target-drop`, `target-file`, `pairs`, `fit-name`, `fit-name-err`, `fit` | `drop`, `hotkeys`, `known`, `curve-chart` (mobile chart slot), `files`, `view`, `panel` |

`body` classes `step-start` / `step-edit` stay owned by `app.js` on both pages.

### 2.2 Shell options

Each page declares itself before loading the core:

```html
<script>window.NP3_SHELL = { kind: "mobile" };</script>   <!-- "desktop" on index.html -->
```

Missing `NP3_SHELL` means `{ kind: "desktop" }`. `app.js` derives everything else from `kind`:

| Option passed by `app.js` | desktop | mobile |
|---|---|---|
| `setupTransfer({ softDisable })` | `false` | `true` |
| `setupTransfer({ shareExport })` | `false` | `true` |
| `createBeforeAfter({ hint })` | `true` | `false` |
| `createBeforeAfter({ longPressTarget })` | `$("c")` | `$("c")` |
| `createCurveEditor({ chartSlot })` | `null` | `$("curve-chart")` |
| `import("./mobile.js")` | no | yes, after the core is built |

### 2.3 Router (`web/lib/view-route.js`)

A classic (non-module) synchronous script, the first element of `<head>` on both pages. It defines `window.NP3Route` and runs the redirect immediately.

```js
NP3Route.choose({ page, search, stored, coarse, screenMin })
  // page: "desktop" | "mobile" — the current page
  // search: location.search; stored: localStorage np3view or null
  // coarse: matchMedia("(pointer: coarse)").matches; screenMin: Math.min(screen.width, screen.height)
  // -> { want: "desktop" | "mobile", store: "desktop" | "mobile" | null, search: <search without view=> }
NP3Route.PAGES = { desktop: "index.html", mobile: "mobile.html" };
NP3Route.switchTo(kind, np3)   // stores the preference, navigates to the other page, ?np3=<np3> if given
NP3Route.canonical(href)       // new URL("./", href) with no search/hash — the share-link base
```

- Rule (from the spec): `?view=` override → stored preference → auto (`coarse && screenMin < 600` → mobile).
- When `want !== page`: set `window.NP3_REDIRECTING = true`, then `location.replace(PAGES[want] + search + hash)`. `app.js` returns at its first line if `NP3_REDIRECTING` is set (no model downloads on the page being left).
- When `?view=` is consumed and no redirect is needed: `history.replaceState` drops it.
- `localStorage` access is wrapped in `try`; failure means "no stored preference".
- The pure `choose()` is testable in Node by loading the file with `vm.runInNewContext` and a stub `window` (the script must not touch `location` when `window.NP3_ROUTE_TEST` is set).

### 2.4 Status

```js
setStatus(text, kind = "info")   // kind: "info" | "progress" | "error"
```

- Writes `#status` and `#start-status` as now, sets `state.status = text` and `state.statusKind = kind`.
- Calls `onStatus?.(text, kind)` — a hook `mobile.js` sets via `window.__np3app.onStatus`.
- `kind` at existing call sites: `"progress"` — "loading models…", "unpacking {name}…", pair preparation stages; `"error"` — decode errors, "Import failed", "Link import failed", "Export failed", "Share failed", "LUT worker failed", "Unsupported file", target rejections; everything else `"info"`. `transfer.js` receives `setStatus` and passes the kind itself.

### 2.5 History additions (`history.js`)

`createHistory({ snapshot, apply, limit, onChange })` — `onChange()` is called after `push`, `clear` and `undo`. New getter `canUndo` (`idx > 0`). Nothing else changes.

### 2.6 Transfer options (`transfer.js`)

```js
setupTransfer({ state, panel, renderCurrent, setStatus, onReset,
                softDisable = false, shareExport = false, onBlocked = null })
// returns { importFile, exportNow, shareNow, importFromUrl, updateExport, shareLink }
```

- `shareLink()` — the share URL string, built on `NP3Route.canonical(location.href)` (falls back to `new URL("./", location.href)` if the router is absent). `shareNow()` uses it.
- `softDisable`: `updateExport()` sets `aria-disabled="true"` instead of `disabled`; a click while blocked does nothing except `onBlocked?.("name")`.
- `shareExport`: `exportNow()` tries `navigator.share({ files: [file] })` when `navigator.canShare?.({ files: [file] })` is true; `AbortError` → silent (status unchanged); any other error or no support → the existing download. Status: "Shared: {name}" / "Exported: {name}".
- Clipboard failure in `shareNow()`: status `"error"` "Copy failed — the link is in Info" and `onBlocked?.("clipboard", link)`.

### 2.7 Touch helpers (`web/lib/touch.js`)

```js
onLongPress(el, { start, end, delay = 250, slop = 10 })   // -> dispose()
  // pointerdown (any pointerType) arms a timer; move > slop or pointerup before delay cancels;
  // after start(): pointerup / pointercancel / lostpointercapture -> end(). Uses setPointerCapture.
onDoubleTap(el, fn, { interval = 300, slop = 12, exclude = "input[type=number]" })  // -> dispose()
  // only pointerType "touch" | "pen"; two pointerups within interval and slop; events whose
  // target matches `exclude` are ignored. Mouse keeps using the existing dblclick.
horizontalDrag(rangeInput, { threshold = 8 })  // -> dispose(); only if M2 needs it (see M2 task 6)
```

Pointer events only (no `touchstart` API). Each helper works with synthetic `PointerEvent`s (tests).

### 2.8 Before/after

`createBeforeAfter(slot, { state, renderCurrent, hint = true, longPressTarget = null })`. With `longPressTarget`, `onLongPress` drives the same `show(true/false)` as Space. `contextmenu` is prevented on the target.

### 2.9 Curve editor

`createCurveEditor(slot, { state, onChange, panel, histogram, chartSlot = null })`.

- With `chartSlot`, the SVG is appended to `chartSlot`; the toggle, note, x/y and Delete stay in `slot`. Without it, the current behavior.
- On every page: a `pointerup` with `pointerType` `touch`/`pen` on the chart background (no drag, within 10 px of its `pointerdown`) adds a point; mouse keeps `dblclick`.
- Each point gets an invisible hit circle `r = 22` (in screen px: scale by the SVG's CTM) behind the visible one.
- `toTone()` maps through `svg.getScreenCTM()` so it works in any parent.
- New method `api.chart` → the SVG element (for `mobile.js` and tests).

### 2.10 `window.__np3app` additions

`statusKind` in `state`; `onStatus` (settable hook); `shell` (`NP3_SHELL`); `mobile` — set by `mobile.js`:

```js
{ tool,                 // active tool key: strength | basic | curve | details | blender | grading
  setTool(key), openInfo(), closeInfo(), isInfoOpen(),
  askReset(),           // opens the confirmation; returns a Promise<boolean>
  toasts: () => [{ text, kind }],   // currently visible
  modified: () => Set<toolKey> }
```

### 2.11 New UI strings (i18n keys)

"Open RAW", "Info", "Undo", "Open a RAW (.NEF / .DNG)", "Profile", "Basic", "Curve", "Details", "Blender", "Grading", "Reset", "Done", "Close", "Cancel", "Reset the whole profile?", "All settings return to neutral. The name is kept. You can undo it.", "Gestures", "Touch and hold the photo — view neutral (before/after)", "Double-tap a slider — reset to default", "Tap the value — type an exact number", "On iOS pick RAW files from Files: the Photos library may hand over a converted JPEG.", "Desktop version", "Mobile version", "Opens the other version with the current profile; the photo has to be opened again.", "Before you start", "Tap to choose RAW files", "Tap to choose JPEG targets", "Shared: {name}", "Copy failed — the link is in Info", "Share…", "Source code". Existing keys are reused where they exist ("Import NP3", "Export NP3", "Copy link", "Back to Start", "Set a valid NP3 name (1–19 ASCII) to export", …).

### 2.12 Icons

Lucide `lucide-static@1.76.0`, SVG copied verbatim, inline. One map `web/lib/icons.js`: `export const ICONS = { plus: '<svg …>', … }` with `// <name>, Lucide (ISC)` per entry; static markup inlines the same strings with `<!-- <name>, Lucide (ISC) -->`. Set: `plus`, `info`, `undo-2`, `upload`, `download`, `link`, `layers`, `sun`, `spline`, `focus`, `blend`, `palette`, `rotate-ccw`, `image-plus`, `x`, `check`, `chevron-left`, `external-link`. To get the files: `npm pack lucide-static@1.76.0` in a scratch directory outside the repo; nothing from the package is committed except the SVG strings and `LICENSE`.

## 3. File ownership

| File | M0 | M1 | M2 | M3 | M4 |
|---|---|---|---|---|---|
| `web/lib/view-route.js` (new) | own | | | | fix |
| `web/css/common.css` (new) | own | hook | hook | hook | fix |
| `web/index.html` | own | | | | fix |
| `web/lib/app.js` | own | hook | hook | hook | fix |
| `web/lib/start.js` | own | | | | fix |
| `web/lib/transfer.js` | canonical URL | | own | | fix |
| `web/lib/history.js` | | own | | | |
| `web/lib/icons.js` (new) | | own | hook | hook | |
| `web/mobile.html` (new) | | own | hook | hook | fix |
| `web/css/mobile.css` (new) | | own | own (slider rows) | own (tool sections, landscape) | fix |
| `web/lib/mobile.js` (new) | | own | hook | own (overlay, dots, landscape) | fix |
| `web/lib/touch.js` (new) | | | own | | fix |
| `web/lib/before-after.js` | | | own | | |
| `web/lib/panels.js` | | | own | | |
| `web/lib/blending.js`, `grading.js` | | | double-tap only | own | |
| `web/lib/curve-editor.js` | | | | own | |
| `web/test.mjs` | harness + level 9a | level 9b | level 9c | level 9d | |
| `third_party/lucide/LICENSE` (new), `spec/external.md` | own | | | | |
| `spec/ui-mobile-plan.md` (this file, log + checkboxes) | each stage | each stage | each stage | each stage | each stage |
| `spec/web-tests.md`, `spec/tools/web.md`, `spec/README.md`, `spec/stages.md` | | | | | own |

"hook" = small additions the stage section names; "fix" = M4 may fix defects found on devices anywhere in the mobile files.

## 4. M0 — Core preparation

**Goal:** the shared core can drive a second page; the desktop is pixel-identical; the router and the license are in place. No mobile UI yet.

**Inputs:** sections 1–2. No earlier stage.

**Tasks**

- [ ] 1. **Reference screenshot.** Before any edit, add a helper to `test.mjs` that opens `index.html?view=desktop` at 1280 × 800, waits for `state.step === "start"`, and saves a PNG of the Start screen and of the editor without RAW (`enterEditor` is not possible without a pair — use `state.step = "edit"` + `syncStep` through `window.__np3app` only for the screenshot) to `_local/ui-ref/` (gitignored: font rendering differs between machines, so references are per machine). The comparison step in level 9a checks the current page against them with a 0-pixel-difference rule and skips when the references are absent. A difference is a bug, not a new reference; references are regenerated only by the operator.
- [ ] 2. **Test harness.** In `test.mjs`: the static server maps a path ending in `/` to `index.html`; level 8 `page.goto` gets `?view=desktop` and `page.setViewport({ width: 1280, height: 800 })`. No assertion changes. Level 8 must stay green.
- [ ] 3. **CSS split.** Move from the `<style>` in `index.html` to `web/css/common.css` everything that is not desktop layout: `:root` palette, `*`, base `html, body` font/colors (not the grid), `button/select/input`, `.row`, `.col`, `.hint`, `.bad/.ok`, `dl/dt/dd`, `.blk`, `.meta`, `.clip-warn`, `details.grp` inner styles, `.sub`, `.ctl*`, `#p-name*`, `.tgl*`, `.tabbtn*`, all `input[type="range"]` rules, `#nogl`, Start-screen cards (`.pair*`, `.zone*`, `.zones`, `#pairs`, `#fit*`, `.start-col` inner list styles). `index.html` links `css/common.css` and keeps the desktop layout rules (grid, `aside`, `#files`, `#panel*`, `main`, `#c` sizing, `#ba-slot`, `#caption`, `step-start` rules, the 980 px media query) inline. Screenshots must match (task 1).
- [ ] 4. **Static Start texts.** Move the DISCLAIMER and "Pair recommendations" lists from `index.html` into `start.js` (rendered into a new `<div id="start-info">` at the same place in the markup, same `data-i18n` keys, same DOM shape: `h2` + `ul.dash > li`). Screenshots must match.
- [ ] 5. **DOM contract in `app.js`.** The comment block from 2.1. Make optional ids null-safe: `drop` (its `onclick` and the document drag highlight), `hotkeys`, `known`. The `#nogl` branch hides `aside, main, #start` and any `[data-shell-hide]` element. Add the `NP3_REDIRECTING` early return at the top (before `applyI18n`). Read `window.NP3_SHELL`, expose `shell` in `__np3app`; pass the derived options of 2.2 (`softDisable`, `shareExport`, `hint`, `chartSlot` are accepted and ignored by the callees until M2/M3 implement them — add the parameters with defaults now so later stages only fill in behavior). `import("./mobile.js")` for `kind: "mobile"` is guarded so a missing file in M0 does not fail (M1 creates it).
- [ ] 6. **`setStatus(text, kind)`** per 2.4 with `state.statusKind`, the `onStatus` hook and the kinds at the call sites (`app.js`, `start.js` via its `setStatus`, `transfer.js` — only the `kind` argument, nothing else in `transfer.js` yet).
- [ ] 7. **Router.** `web/lib/view-route.js` per 2.3. `index.html`: `<script src="lib/view-route.js"></script>` as the first child of `<head>`, then `<script>window.NP3_SHELL = { kind: "desktop" };</script>`. Because `mobile.html` does not exist yet, `view-route.js` has a constant `const MOBILE_READY = false;`: while it is false, `choose()` always returns `want: "desktop"` (the unit tests cover both values by overriding it through `NP3_ROUTE_TEST`). M1 sets it to `true`. This avoids redirecting phones to a 404 between stages.
- [ ] 8. **Canonical share URL** in `transfer.js` `shareNow()`: build on `NP3Route.canonical(location.href)` with the fallback of 2.6; add `shareLink()` to the returned API. The level-8 share test must still pass (adjust only if it asserts the exact path — then it is a harness change, note it in the log).
- [ ] 9. **License.** `third_party/lucide/LICENSE` = the package `LICENSE` of `lucide-static@1.76.0` verbatim (ISC + the Feather MIT block); a row in `spec/external.md` "Used by the project": Lucide 1.76.0, ISC (+ MIT for Feather-derived icons), inline SVG icons in `web/`. The existing desktop icons (`upload`, `download`, `link`) are now covered too.
- [ ] 10. **Level 9a** in `test.mjs` (no RAW needed): router unit tests in Node via `vm` (all rule branches; `?view=` stripping; `search`/hash preserved; no redirect when `want === page`; localStorage throwing); `setStatus` kinds through `__np3app` (`state.statusKind` after an NP3 import error); `shareLink()` ends with `/web/?np3=…` on the test server.

**Run:** `python3 test_np3.py`; `cd web && node test.mjs`.

**Done when:** levels 1–8 green with unchanged assertions; level 9a green; both screenshots identical to the references; `index.html` has no inline rules that are in `common.css`; the log entry lists every moved CSS block and every `setStatus` kind assignment.

**Pitfalls:** CSS order changes specificity — keep `common.css` linked before the inline `<style>`; `details.grp:first-of-type` and `#panel-scroll` rules depend on the panel container, keep them desktop-side if unsure. Do not rename any id or class.

**Hand-off to M1:** the list of required ids actually used, the shell options wiring point in `app.js`, the `onStatus` hook name, any harness change.

## 5. M1 — Mobile shell

**Goal:** `mobile.html` works end to end on a phone viewport with the existing (desktop-style) controls inside the panel: navigation, file actions, undo, reset with confirmation, info sheet, toasts, Start screen, and the redirect turned on.

**Inputs:** M0 done; spec sections "Portrait layout", "Info sheet", "Status toasts", "Start screen on mobile", "Icons and licensing", "Visual tokens".

**Tasks**

- [ ] 1. **`web/lib/icons.js`** — the map of 2.12 (all 18 icons now, later stages only use them).
- [ ] 2. **`web/mobile.html`.** `<head>`: `view-route.js`, `NP3_SHELL = { kind: "mobile" }`, `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`, `css/common.css`, `css/mobile.css`, `<title data-i18n>`. `<body class="step-start">` with:
  - `#start` (`.start-col`): title, `#start-info` (rendered by `start.js`, wrapped by `mobile.js` into a "Before you start" `<details>`, open when `localStorage.np3seenStart` is absent), `#raw-drop` / `#target-drop` zones with the "Tap to choose …" texts, `#raw-file`, `#target-file`, `#pairs`, `#start-status`, `#fit-name`, `#fit-name-err`, `#fit`.
  - `header#topbar`: left — `button#add` (`plus`), `button#info-btn` (`info`, with a `.dot` span); right — `button#undo` (`undo-2`), `button#import`, `button#export`, `button#share` (icons per spec, `aria-label` and `data-i18n` on a visually hidden label).
  - `main#view`: `canvas#c`, `#ba-slot`, `#curve-chart` (empty, hidden), `#empty` (the "Open a RAW" target with `image-plus`).
  - `section#panel`: `#panel-scroll`, `#panel-foot` (hidden by CSS).
  - `nav#toolbar` (`role="tablist"`), filled by `mobile.js`.
  - `#toasts` (`aria-live="polite"`).
  - `dialog#sheet` (info sheet) containing: close button, `#to-start`, `dl#info`, `#warn`, `#status`, the approximate-render caption, the Gestures legend, `#known`-equivalent limitations (same texts as desktop + the iOS hint), the source link (`external-link`), `button#to-desktop` "Desktop version".
  - `dialog#confirm-reset`.
  - `input#file` (hidden, `accept=".nef,.NEF,.dng,.DNG"`), `#nogl`.
  - `<script type="module" src="./lib/app.js">`.
- [ ] 3. **`web/css/mobile.css`:** the portrait layout of the spec — `100dvh` column (topbar / view / panel / toolbar), safe-area insets, no page scroll, `overscroll-behavior: none`; viewer `#000`, canvas fitted; panel `clamp(200px, 38dvh, 360px)` with inner scroll; `details.grp > summary { display: none }`, only `.grp.active` shown; toolbar items; sheet and confirm dialogs (scrim, 85dvh, rounded top); toasts; Start screen sizes (zones ≥ 88 px, 44 px targets, 16 px inputs); `step-start` / `step-edit` visibility. Landscape is M3 — portrait only now.
- [ ] 4. **`web/lib/mobile.js`** (loaded by `app.js` for `kind: "mobile"`; gets `window.__np3app`):
  - tool bar from the spec table (icons + labels, divider, Reset), `setTool(key)` — sets `.active` on the matching `details.grp[data-group]`, forces `open`, `aria-selected`, scrolls the item into view; default `basic`;
  - `#add` and `#empty` → `$("file").click()`; `#empty` hidden when `state.raw` is set (check in the `onStatus` hook and after `enterEditor`; simplest: a `MutationObserver` on `#c[hidden]`);
  - Undo: `hist.undo()`, `disabled = !hist.canUndo`, updated from the history `onChange` (task 5);
  - Reset: `askReset()` opens `#confirm-reset`; Reset → `$("p-reset").click()`; Cancel / scrim / Escape → nothing;
  - info sheet: open/close (button, scrim click, Escape, close button), focus management, the attention dot (set on `kind: "error"` status or when `#warn` becomes visible; cleared on open);
  - toasts per the spec (`info` 3 s, `progress` until replaced, `error` 6 s or tap), wired through `__np3app.onStatus`;
  - `#to-desktop` → `NP3Route.switchTo("desktop", <b64url of the current profile>)` (use `transfer.shareLink()` and take its `np3` parameter);
  - the `__np3app.mobile` API of 2.10 (`modified()` may return an empty set until M3).
- [ ] 5. **`history.js`:** `onChange`, `canUndo` (2.5). Hook in `app.js`: pass `onChange: () => app.mobile?.syncUndo?.()`.
- [ ] 6. **`index.html`:** a "Mobile version" link at the bottom of `#files` (`data-shell-hide` not needed), shown when `NP3Route` auto rule would pick mobile or a preference is stored; click → `NP3Route.switchTo("mobile", …)`. Screenshot references: this link is hidden on the test machine (not coarse, no preference), so they stay identical.
- [ ] 7. **Turn on the router:** set `MOBILE_READY = true` in `view-route.js`.
- [ ] 8. **Level 9b** (`mobile.html?view=mobile`): spec level-9 items 1, 2, 3 (portrait parts), 5 (page-level redirect: open `index.html` with a stored `mobile` preference → lands on `mobile.html` with `?np3=` intact), 6, 7 (without the modified dot), 8 (requires a RAW or an NP3 import to create history — use an NP3 import from `third_party/samples/` + a slider change, so it runs without `_local/`), 9, 15, 16; plus: every interactive element in the top bar, tool bar and sheet ≥ 44 × 44 px; the Start screen at 390 × 844 has no horizontal overflow.

**Done when:** levels 1–8 and 9a–9b green; desktop screenshots identical; on a 390 × 844 viewport a user can open a sample NP3, switch all six tools, change a slider, undo, reset with confirmation, export, copy a link, open/close the sheet, go back to Start and to the desktop version — verified by level 9b, not by hand.

**Pitfalls:** `<dialog>` `showModal()` is supported in current Firefox/Safari/Chrome; still guard with `if (!dlg.showModal)` → toggle an `open` class. Do not move elements between pages at runtime — the mobile markup owns its elements. `panels.js` creates `#p-reset` inside `#panel-foot`; keep the footer in the DOM (hidden) so the button exists.

**Hand-off to M2:** the CSS class names of slider rows on mobile, where toasts and the sheet hook in, known gaps (dot, landscape, tool-specific sizes).

## 6. M2 — Touch interactions

**Goal:** every gesture of the spec works with a finger on `mobile.html` (and harmlessly on `index.html` with a touch screen); export and share behave as specified on phones.

**Inputs:** M1 done; spec sections "Viewer" (before/after), "Common slider row", "Files on mobile".

**Tasks**

- [ ] 1. **`web/lib/touch.js`** per 2.7: `onLongPress`, `onDoubleTap` (and `horizontalDrag` only if task 6 needs it). Unit-test them in the browser part of level 9c with synthetic `PointerEvent`s.
- [ ] 2. **Before/after long-press** in `before-after.js` per 2.8; `hint: false` hides the hint line; `contextmenu` prevented on `#c`. CSS on `#c` in `mobile.css`: `touch-action: none; -webkit-touch-callout: none; user-select: none`. Space path untouched.
- [ ] 3. **Double-tap reset** in `panels.js`, `blending.js`, `grading.js`: in each `slider()` helper, `onDoubleTap(box, reset)` with the same reset body as the existing `dblclick` (extract it into a local `resetToDefault()` used by both); `exclude` the number field. Rows get `touch-action: manipulation` (in `common.css` — harmless on desktop; verify the screenshots).
- [ ] 4. **Number fields:** in the three helpers set `enterkeyhint="done"` on `.val`; keep `type="number"`, **no** `inputmode`. `mobile.css`: `.val` and all text inputs `font-size: 16px`.
- [ ] 5. **Keyboard visibility** in `mobile.js`: on `focusin` of an input inside `#panel` / `#start`, and on `visualViewport` `resize`, `scrollIntoView({ block: "nearest" })` for the focused element.
- [ ] 6. **Slider vs vertical scroll.** `mobile.css`: rows 52 px min, range 32 px high, thumb 22 px, `input[type=range] { touch-action: pan-y }`. Then check on one iOS and one Android device (operator or remote device): (a) a vertical swipe over rows scrolls and changes nothing; (b) a tap on the track does not jump the value; (c) a horizontal drag works. If (a) or (b) fails on a target browser, implement `horizontalDrag()` (2.7: the input gets `pointer-events` handling — the value is computed from the pointer x only after the threshold with |dx| > |dy|, `input`/`change` events dispatched as a native drag would) and attach it to every range on `mobile.html`. Record the device results in the log.
- [ ] 7. **Soft-disabled export/share** in `transfer.js` (`softDisable`, `onBlocked`); `mobile.js` handles `onBlocked("name")`: toast "Set a valid NP3 name (1–19 ASCII) to export", `setTool("strength")`, focus the name input. The input has no id today (the `#p-name` CSS rule matches nothing); `panels.js` gives it `id="p-name"` — check the desktop screenshots, since the rule starts to apply.
- [ ] 8. **Share-sheet export** in `transfer.js` (`shareExport`) per 2.6.
- [ ] 9. **Clipboard fallback:** `onBlocked("clipboard", link)` → `mobile.js` shows the link in the info sheet (a read-only `<input>` selected on open) with "Share…" (`navigator.share({ url })` when available).
- [ ] 10. **File picker `accept`:** leave as is now; add a `data-accept-fallback` attribute on `#file` and the NP3 input so M4 can drop `accept` by one switch in `mobile.js` if devices grey files out.
- [ ] 11. **Level 9c:** spec level-9 items 10 (needs a RAW — skip without `_local/`), 11, 12, 13 (stub `navigator.canShare` / `navigator.share` in the page: success, `AbortError`, other error, missing API); `touch.js` unit checks; on `index.html?view=desktop` a synthetic touch double-tap also resets (shared helper) and the screenshots are unchanged.

**Done when:** levels 1–8, 9a–9c green; desktop screenshots identical; device results of task 6 logged with the decision (native ranges kept or `horizontalDrag` added).

**Pitfalls:** a `pointerup` from a drag must not count as a tap — check the distance from `pointerdown`. iOS fires `dblclick` after two taps on some elements: the double-tap handler and the `dblclick` handler must not both reset — reset is idempotent, but they must not push two history snapshots (the reset dispatches `change` once per call; guard with a 350 ms timestamp). Long-press must release on `lostpointercapture` (iOS steals capture during system gestures).

**Hand-off to M3:** the final slider row structure on mobile, whether `horizontalDrag` is active, open device findings.

## 7. M3 — Tools and landscape

**Goal:** the curve, blender and grading are comfortable with a finger; modified dots; the landscape layout.

**Inputs:** M2 done; spec sections "Curve", "Color Blender", "Color Grading", "Tool bar" (modified dot), "Landscape phone layout".

**Tasks**

- [ ] 1. **Curve editor** per 2.9: `chartSlot`, tap-to-add on touch, hit circles, CTM mapping, `api.chart`. Desktop behavior and level-8 curve checks unchanged.
- [ ] 2. **Curve overlay** in `mobile.js` + `mobile.css`: `#curve-chart` is visible only when `tool === "curve"` and `state.control.curve !== null` (re-check on the toggle `change` and on `panel.refresh`); square `min(view w, view h) − 16px`, centered, `rgba(0,0,0,.35)` background, `touch-action: none`; a **Done** button (`check`) in the Curve panel → `setTool("basic")`. Long-press before/after must not start on the chart (stop propagation of `pointerdown` from `#curve-chart`).
- [ ] 3. **Blender** (`blending.js` + `mobile.css`): toggle and tabs 40 px; color dots 28 px visible with a ≥ 40 px hit area, evenly spaced, selected dot ring 2 px accent. Desktop look unchanged (scope new rules to `mobile.css` or to a class only `mobile.html` sets).
- [ ] 4. **Grading** (`grading.js` + `mobile.css`): wheel `min(200px, 55%)` of the panel width, `touch-action: none` on the disc; toggle/zone tabs 40 px.
- [ ] 5. **Modified dots** in `mobile.js`: `modified()` per the spec (compare with a neutral built like `panels.resetAll`: `newProfile()` with zeroed blender/grading; Profile → `strength !== 100`; Curve → `curve !== null`; other groups by their fields); recomputed on every finished action (hook: wrap `scheduleRender(false)` path via `hist` `onChange`, which fires on every push) and after import/Reset/undo.
- [ ] 6. **Landscape** in `mobile.css` (`@media (orientation: landscape)` inside the mobile page): two columns, right column `min(360px, 42vw)`, tool bar icon-only two rows, top bar 44 px, side safe-area insets. Rotation keeps state (no reload by design — verify `tool`, history, profile).
- [ ] 7. **Level 9d:** spec level-9 items 3 (360 × 640 full), 4 (844 × 390, rotate back), 7 (modified dot), 14 (curve overlay: tap adds a point, drag changes `control.curve`, leaving hides; needs no RAW — the curve works without a frame); blender dots and grading wheel hit sizes; long-press does not start on the chart.

**Done when:** levels 1–8, 9a–9d green; desktop screenshots identical; every mobile interactive element passes the size check at 360 × 640 and 844 × 390.

**Pitfalls:** the histogram backdrop scales with the SVG — keep `viewBox` and let CSS size the element. In landscape the curve square is bounded by the viewer height (~340 px) — check points at the corners are still reachable.

**Hand-off to M4:** a short "how to test on a phone" note (serve `web/` over HTTPS or `localhost` port-forwarding — Web Share and clipboard need a secure context; e.g. Android `chrome://inspect` port forwarding, iOS Safari Web Inspector from a Mac).

## 8. M4 — Devices, fixes and documentation

**Goal:** the manual checklist of the spec passes on real devices; decisions are recorded; documentation is updated.

This stage needs a human with devices; an agent prepares, collects results and fixes.

**Tasks**

- [ ] 1. **Checklist file:** copy the spec's "Manual checklist on devices" into a results table in the log (device, OS, browser, item, pass/fail, note).
- [ ] 2. **Run** on iPhone (iOS 17+, Safari), an Android mid-range phone (Chrome), an iPad (Safari) — operator; the agent assists through remote inspection when available.
- [ ] 3. **Decisions:**
  - picker `accept`: if `.NP3` / RAW files are greyed out, enable the `data-accept-fallback` switch for that input on `mobile.html`;
  - memory: if a 45 MP RAW crashes the tab, `mobile.html` opens RAW with `long: 1200` (an option through `NP3_SHELL` read in `app.js` `editorOpenRaw` / `addRawFile`; this is the only allowed `loader.open` option change);
  - performance: if slider drags drop below ~20 updates/s, record it with the profile and decide with the operator (no pipeline changes in this plan);
  - tablets (spec open question): record how the desktop page feels on iPad portrait.
- [ ] 4. **Fixes** for failed items in the mobile files (section 3 "fix"); each fix gets a level-9 regression where it is testable headlessly.
- [ ] 5. **Docs:** [web-tests.md](web-tests.md) — level 9 description and statuses; [tools/web.md](tools/web.md) — the two pages, the router, `?view=`, how to test on a phone; [ui-mobile.md](ui-mobile.md) — status line "implemented", resolved open questions moved to "Decisions"; [stages.md](stages.md) — the mobile milestone; [README.md](README.md) table already lists both docs.
- [ ] 6. **Cleanup:** no scratch files, no `node_modules` changes, no Lucide package files besides `third_party/lucide/LICENSE`.

**Done when:** all acceptance criteria of [ui-mobile.md](ui-mobile.md) are met or each miss has a logged decision accepted by the operator; all test levels green.

## 9. Log

Format of an entry (newest last):

```
> **<stage> — <done | blocked | partial> (<agent id>, <date>).** What was done, file by file.
> Deviations from the plan/contracts and why. Skipped tests and why.
> Hand-off: what the next stage must know. Open issues.
```

_No entries yet._
