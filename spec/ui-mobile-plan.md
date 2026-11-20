# Work plan: mobile version (`web/mobile.html`)

> **2026-11-20: ported** (see the last log entry). M0–M3 are done on branch `mobile` (`_local/_cloud_transfer/mobile.bundle`, based on `main` 6ac6189 + a 2026-11-19 snapshot of the fitting work). Before M4 the branch is ported onto the page split of [ui-pages.md](ui-pages.md) ([ui-plan.md](ui-plan.md) stage 11): `index.html` → `picture-control-editor.html`, `mobile.html` → `picture-control-editor-mobile.html`, the router only in those two pages, the canonical share URL → `picture-control-editor.html`, the mobile Start screen and its 9b checks dropped, the core hooks moved from `app.js` into `editor-core.js` / `editor-app.js`.

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

- [x] 1. **Reference screenshot.** Before any edit, add a helper to `test.mjs` that opens `index.html?view=desktop` at 1280 × 800, waits for `state.step === "start"`, and saves a PNG of the Start screen and of the editor without RAW (`enterEditor` is not possible without a pair — use `state.step = "edit"` + `syncStep` through `window.__np3app` only for the screenshot) to `_local/ui-ref/` (gitignored: font rendering differs between machines, so references are per machine). The comparison step in level 9a checks the current page against them with a 0-pixel-difference rule and skips when the references are absent. A difference is a bug, not a new reference; references are regenerated only by the operator.
- [x] 2. **Test harness.** In `test.mjs`: the static server maps a path ending in `/` to `index.html`; level 8 `page.goto` gets `?view=desktop` and `page.setViewport({ width: 1280, height: 800 })`. No assertion changes. Level 8 must stay green.
- [x] 3. **CSS split.** Move from the `<style>` in `index.html` to `web/css/common.css` everything that is not desktop layout: `:root` palette, `*`, base `html, body` font/colors (not the grid), `button/select/input`, `.row`, `.col`, `.hint`, `.bad/.ok`, `dl/dt/dd`, `.blk`, `.meta`, `.clip-warn`, `details.grp` inner styles, `.sub`, `.ctl*`, `#p-name*`, `.tgl*`, `.tabbtn*`, all `input[type="range"]` rules, `#nogl`, Start-screen cards (`.pair*`, `.zone*`, `.zones`, `#pairs`, `#fit*`, `.start-col` inner list styles). `index.html` links `css/common.css` and keeps the desktop layout rules (grid, `aside`, `#files`, `#panel*`, `main`, `#c` sizing, `#ba-slot`, `#caption`, `step-start` rules, the 980 px media query) inline. Screenshots must match (task 1).
- [x] 4. **Static Start texts.** Move the DISCLAIMER and "Pair recommendations" lists from `index.html` into `start.js` (rendered into a new `<div id="start-info">` at the same place in the markup, same `data-i18n` keys, same DOM shape: `h2` + `ul.dash > li`). Screenshots must match.
- [x] 5. **DOM contract in `app.js`.** The comment block from 2.1. Make optional ids null-safe: `drop` (its `onclick` and the document drag highlight), `hotkeys`, `known`. The `#nogl` branch hides `aside, main, #start` and any `[data-shell-hide]` element. Add the `NP3_REDIRECTING` early return at the top (before `applyI18n`). Read `window.NP3_SHELL`, expose `shell` in `__np3app`; pass the derived options of 2.2 (`softDisable`, `shareExport`, `hint`, `chartSlot` are accepted and ignored by the callees until M2/M3 implement them — add the parameters with defaults now so later stages only fill in behavior). `import("./mobile.js")` for `kind: "mobile"` is guarded so a missing file in M0 does not fail (M1 creates it).
- [x] 6. **`setStatus(text, kind)`** per 2.4 with `state.statusKind`, the `onStatus` hook and the kinds at the call sites (`app.js`, `start.js` via its `setStatus`, `transfer.js` — only the `kind` argument, nothing else in `transfer.js` yet).
- [x] 7. **Router.** `web/lib/view-route.js` per 2.3. `index.html`: `<script src="lib/view-route.js"></script>` as the first child of `<head>`, then `<script>window.NP3_SHELL = { kind: "desktop" };</script>`. Because `mobile.html` does not exist yet, `view-route.js` has a constant `const MOBILE_READY = false;`: while it is false, `choose()` always returns `want: "desktop"` (the unit tests cover both values by overriding it through `NP3_ROUTE_TEST`). M1 sets it to `true`. This avoids redirecting phones to a 404 between stages.
- [x] 8. **Canonical share URL** in `transfer.js` `shareNow()`: build on `NP3Route.canonical(location.href)` with the fallback of 2.6; add `shareLink()` to the returned API. The level-8 share test must still pass (adjust only if it asserts the exact path — then it is a harness change, note it in the log).
- [x] 9. **License.** `third_party/lucide/LICENSE` = the package `LICENSE` of `lucide-static@1.76.0` verbatim (ISC + the Feather MIT block); a row in `spec/external.md` "Used by the project": Lucide 1.76.0, ISC (+ MIT for Feather-derived icons), inline SVG icons in `web/`. The existing desktop icons (`upload`, `download`, `link`) are now covered too.
- [x] 10. **Level 9a** in `test.mjs` (no RAW needed): router unit tests in Node via `vm` (all rule branches; `?view=` stripping; `search`/hash preserved; no redirect when `want === page`; localStorage throwing); `setStatus` kinds through `__np3app` (`state.statusKind` after an NP3 import error); `shareLink()` ends with `/web/?np3=…` on the test server.

**Run:** `python3 test_np3.py`; `cd web && node test.mjs`.

**Done when:** levels 1–8 green with unchanged assertions; level 9a green; both screenshots identical to the references; `index.html` has no inline rules that are in `common.css`; the log entry lists every moved CSS block and every `setStatus` kind assignment.

**Pitfalls:** CSS order changes specificity — keep `common.css` linked before the inline `<style>`; `details.grp:first-of-type` and `#panel-scroll` rules depend on the panel container, keep them desktop-side if unsure. Do not rename any id or class.

**Hand-off to M1:** the list of required ids actually used, the shell options wiring point in `app.js`, the `onStatus` hook name, any harness change.

## 5. M1 — Mobile shell

**Goal:** `mobile.html` works end to end on a phone viewport with the existing (desktop-style) controls inside the panel: navigation, file actions, undo, reset with confirmation, info sheet, toasts, Start screen, and the redirect turned on.

**Inputs:** M0 done; spec sections "Portrait layout", "Info sheet", "Status toasts", "Start screen on mobile", "Icons and licensing", "Visual tokens".

**Tasks**

- [x] 1. **`web/lib/icons.js`** — the map of 2.12 (all 18 icons now, later stages only use them).
- [x] 2. **`web/mobile.html`.** `<head>`: `view-route.js`, `NP3_SHELL = { kind: "mobile" }`, `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`, `css/common.css`, `css/mobile.css`, `<title data-i18n>`. `<body class="step-start">` with:
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
- [x] 3. **`web/css/mobile.css`:** the portrait layout of the spec — `100dvh` column (topbar / view / panel / toolbar), safe-area insets, no page scroll, `overscroll-behavior: none`; viewer `#000`, canvas fitted; panel `clamp(200px, 38dvh, 360px)` with inner scroll; `details.grp > summary { display: none }`, only `.grp.active` shown; toolbar items; sheet and confirm dialogs (scrim, 85dvh, rounded top); toasts; Start screen sizes (zones ≥ 88 px, 44 px targets, 16 px inputs); `step-start` / `step-edit` visibility. Landscape is M3 — portrait only now.
- [x] 4. **`web/lib/mobile.js`** (loaded by `app.js` for `kind: "mobile"`; gets `window.__np3app`):
  - tool bar from the spec table (icons + labels, divider, Reset), `setTool(key)` — sets `.active` on the matching `details.grp[data-group]`, forces `open`, `aria-selected`, scrolls the item into view; default `basic`;
  - `#add` and `#empty` → `$("file").click()`; `#empty` hidden when `state.raw` is set (check in the `onStatus` hook and after `enterEditor`; simplest: a `MutationObserver` on `#c[hidden]`);
  - Undo: `hist.undo()`, `disabled = !hist.canUndo`, updated from the history `onChange` (task 5);
  - Reset: `askReset()` opens `#confirm-reset`; Reset → `$("p-reset").click()`; Cancel / scrim / Escape → nothing;
  - info sheet: open/close (button, scrim click, Escape, close button), focus management, the attention dot (set on `kind: "error"` status or when `#warn` becomes visible; cleared on open);
  - toasts per the spec (`info` 3 s, `progress` until replaced, `error` 6 s or tap), wired through `__np3app.onStatus`;
  - `#to-desktop` → `NP3Route.switchTo("desktop", <b64url of the current profile>)` (use `transfer.shareLink()` and take its `np3` parameter);
  - the `__np3app.mobile` API of 2.10 (`modified()` may return an empty set until M3).
- [x] 5. **`history.js`:** `onChange`, `canUndo` (2.5). Hook in `app.js`: pass `onChange: () => app.mobile?.syncUndo?.()`.
- [x] 6. **`index.html`:** a "Mobile version" link at the bottom of `#files` (`data-shell-hide` not needed), shown when `NP3Route` auto rule would pick mobile or a preference is stored; click → `NP3Route.switchTo("mobile", …)`. Screenshot references: this link is hidden on the test machine (not coarse, no preference), so they stay identical.
- [x] 7. **Turn on the router:** set `MOBILE_READY = true` in `view-route.js`.
- [x] 8. **Level 9b** (`mobile.html?view=mobile`): spec level-9 items 1, 2, 3 (portrait parts), 5 (page-level redirect: open `index.html` with a stored `mobile` preference → lands on `mobile.html` with `?np3=` intact), 6, 7 (without the modified dot), 8 (requires a RAW or an NP3 import to create history — use an NP3 import from `third_party/samples/` + a slider change, so it runs without `_local/`), 9, 15, 16; plus: every interactive element in the top bar, tool bar and sheet ≥ 44 × 44 px; the Start screen at 390 × 844 has no horizontal overflow.

**Done when:** levels 1–8 and 9a–9b green; desktop screenshots identical; on a 390 × 844 viewport a user can open a sample NP3, switch all six tools, change a slider, undo, reset with confirmation, export, copy a link, open/close the sheet, go back to Start and to the desktop version — verified by level 9b, not by hand.

**Pitfalls:** `<dialog>` `showModal()` is supported in current Firefox/Safari/Chrome; still guard with `if (!dlg.showModal)` → toggle an `open` class. Do not move elements between pages at runtime — the mobile markup owns its elements. `panels.js` creates `#p-reset` inside `#panel-foot`; keep the footer in the DOM (hidden) so the button exists.

**Hand-off to M2:** the CSS class names of slider rows on mobile, where toasts and the sheet hook in, known gaps (dot, landscape, tool-specific sizes).

## 6. M2 — Touch interactions

**Goal:** every gesture of the spec works with a finger on `mobile.html` (and harmlessly on `index.html` with a touch screen); export and share behave as specified on phones.

**Inputs:** M1 done; spec sections "Viewer" (before/after), "Common slider row", "Files on mobile".

**Tasks**

- [x] 1. **`web/lib/touch.js`** per 2.7: `onLongPress`, `onDoubleTap` (and `horizontalDrag` only if task 6 needs it). Unit-test them in the browser part of level 9c with synthetic `PointerEvent`s.
- [x] 2. **Before/after long-press** in `before-after.js` per 2.8; `hint: false` hides the hint line; `contextmenu` prevented on `#c`. CSS on `#c` in `mobile.css`: `touch-action: none; -webkit-touch-callout: none; user-select: none`. Space path untouched.
- [x] 3. **Double-tap reset** in `panels.js`, `blending.js`, `grading.js`: in each `slider()` helper, `onDoubleTap(box, reset)` with the same reset body as the existing `dblclick` (extract it into a local `resetToDefault()` used by both); `exclude` the number field. Rows get `touch-action: manipulation` (in `common.css` — harmless on desktop; verify the screenshots).
- [x] 4. **Number fields:** in the three helpers set `enterkeyhint="done"` on `.val`; keep `type="number"`, **no** `inputmode`. `mobile.css`: `.val` and all text inputs `font-size: 16px`.
- [x] 5. **Keyboard visibility** in `mobile.js`: on `focusin` of an input inside `#panel` / `#start`, and on `visualViewport` `resize`, `scrollIntoView({ block: "nearest" })` for the focused element.
- [x] 6. **Slider vs vertical scroll.** `mobile.css`: rows 52 px min, range 32 px high, thumb 22 px, `input[type=range] { touch-action: pan-y }`. Then check on one iOS and one Android device (operator or remote device): (a) a vertical swipe over rows scrolls and changes nothing; (b) a tap on the track does not jump the value; (c) a horizontal drag works. If (a) or (b) fails on a target browser, implement `horizontalDrag()` (2.7: the input gets `pointer-events` handling — the value is computed from the pointer x only after the threshold with |dx| > |dy|, `input`/`change` events dispatched as a native drag would) and attach it to every range on `mobile.html`. Record the device results in the log.
- [x] 7. **Soft-disabled export/share** in `transfer.js` (`softDisable`, `onBlocked`); `mobile.js` handles `onBlocked("name")`: toast "Set a valid NP3 name (1–19 ASCII) to export", `setTool("strength")`, focus the name input. The input has no id today (the `#p-name` CSS rule matches nothing); `panels.js` gives it `id="p-name"` — check the desktop screenshots, since the rule starts to apply.
- [x] 8. **Share-sheet export** in `transfer.js` (`shareExport`) per 2.6.
- [x] 9. **Clipboard fallback:** `onBlocked("clipboard", link)` → `mobile.js` shows the link in the info sheet (a read-only `<input>` selected on open) with "Share…" (`navigator.share({ url })` when available).
- [x] 10. **File picker `accept`:** leave as is now; add a `data-accept-fallback` attribute on `#file` and the NP3 input so M4 can drop `accept` by one switch in `mobile.js` if devices grey files out.
- [x] 11. **Level 9c:** spec level-9 items 10 (needs a RAW — skip without `_local/`), 11, 12, 13 (stub `navigator.canShare` / `navigator.share` in the page: success, `AbortError`, other error, missing API); `touch.js` unit checks; on `index.html?view=desktop` a synthetic touch double-tap also resets (shared helper) and the screenshots are unchanged.

**Done when:** levels 1–8, 9a–9c green; desktop screenshots identical; device results of task 6 logged with the decision (native ranges kept or `horizontalDrag` added).

**Pitfalls:** a `pointerup` from a drag must not count as a tap — check the distance from `pointerdown`. iOS fires `dblclick` after two taps on some elements: the double-tap handler and the `dblclick` handler must not both reset — reset is idempotent, but they must not push two history snapshots (the reset dispatches `change` once per call; guard with a 350 ms timestamp). Long-press must release on `lostpointercapture` (iOS steals capture during system gestures).

**Hand-off to M3:** the final slider row structure on mobile, whether `horizontalDrag` is active, open device findings.

## 7. M3 — Tools and landscape

**Goal:** the curve, blender and grading are comfortable with a finger; modified dots; the landscape layout.

**Inputs:** M2 done; spec sections "Curve", "Color Blender", "Color Grading", "Tool bar" (modified dot), "Landscape phone layout".

**Tasks**

- [x] 1. **Curve editor** per 2.9: `chartSlot`, tap-to-add on touch, hit circles, CTM mapping, `api.chart`. Desktop behavior and level-8 curve checks unchanged.
- [x] 2. **Curve overlay** in `mobile.js` + `mobile.css`: `#curve-chart` is visible only when `tool === "curve"` and `state.control.curve !== null` (re-check on the toggle `change` and on `panel.refresh`); square `min(view w, view h) − 16px`, centered, `rgba(0,0,0,.35)` background, `touch-action: none`; a **Done** button (`check`) in the Curve panel → `setTool("basic")`. Long-press before/after must not start on the chart (stop propagation of `pointerdown` from `#curve-chart`).
- [x] 3. **Blender** (`blending.js` + `mobile.css`): toggle and tabs 40 px; color dots 28 px visible with a ≥ 40 px hit area, evenly spaced, selected dot ring 2 px accent. Desktop look unchanged (scope new rules to `mobile.css` or to a class only `mobile.html` sets).
- [x] 4. **Grading** (`grading.js` + `mobile.css`): wheel `min(200px, 55%)` of the panel width, `touch-action: none` on the disc; toggle/zone tabs 40 px.
- [x] 5. **Modified dots** in `mobile.js`: `modified()` per the spec (compare with a neutral built like `panels.resetAll`: `newProfile()` with zeroed blender/grading; Profile → `strength !== 100`; Curve → `curve !== null`; other groups by their fields); recomputed on every finished action (hook: wrap `scheduleRender(false)` path via `hist` `onChange`, which fires on every push) and after import/Reset/undo.
- [x] 6. **Landscape** in `mobile.css` (`@media (orientation: landscape)` inside the mobile page): two columns, right column `min(360px, 42vw)`, tool bar icon-only two rows, top bar 44 px, side safe-area insets. Rotation keeps state (no reload by design — verify `tool`, history, profile).
- [x] 7. **Level 9d:** spec level-9 items 3 (360 × 640 full), 4 (844 × 390, rotate back), 7 (modified dot), 14 (curve overlay: tap adds a point, drag changes `control.curve`, leaving hides; needs no RAW — the curve works without a frame); blender dots and grading wheel hit sizes; long-press does not start on the chart.

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

> **M0 — done (agent-M0 (sonnet), 2026-11-19).** Core prepared for a second page; desktop pixel-identical.
> - `web/css/common.css` (new, linked before the inline `<style>` of `index.html`). CSS blocks moved out of `index.html`: `:root` palette; `*`; `html, body` font/colors/margin/height (the `body` grid stays inline); `h1`, `h2` (not named in task 3, but they are generic and the Start screen needs them on both pages); `button, select, input[type="text"]` + `button` hover/disabled; `.row`; `.col`, `.col button`, `.col button svg`; `.hint`; `.bad/.ok`; `dl/dt/dd`; `.blk`; `.meta`, `.meta b`; `.clip-warn`; `details.grp` (border/padding) and `details.grp summary`; `.sub`; `.ctl`, `.ctl .top`, `.ctl .val`, `.ctl .val:focus`, `.ctl.clip .val`; `#p-name`, `#p-name-err`; `.tgl*`; `.tabbtn*`; every `input[type="range"]` rule incl. `.grad`; `#nogl`, `#nogl[hidden]`; `.start-col > .hint`, `.start-col ul.dash`, `.start-col ul.dash li`; `.zones`, `.zone*`; `#pairs`; `.pair*`; `#fit-name`, `#fit-name-err`, `#fit`. New in common.css: `#start-info { display: contents }`. Kept inline (desktop layout): `body` grid, `aside`, `#files*`, `#hotkeys`, `#known*`, `#panel*`, `#panel-foot button`, `#drop*`, `#status`, `#warn`, `main`, `#c`, `#ba-slot`, `.ba-*`, `#caption`, `details.grp:first-of-type` (pitfall rule), `#start`, `body.step-start*`, `.start-col` (box), `#to-start`, the 980 px media query (incl. `.zones` override, which still wins by source order).
> - `web/lib/start.js`: the DISCLAIMER and "Pair recommendations" lists are rendered into `#start-info` (`h2` + `ul.dash > li`, same `data-i18n` keys); `index.html` has an empty `<div id="start-info">` at the same place. `setStatus` doc updated.
> - `web/lib/app.js`: DOM-id contract comment; `NP3_REDIRECTING` early exit (a top-level `throw` before `$`/`applyI18n`, since a module cannot `return`; it only fires on a page being left); `NP3_SHELL` read (`shell`, `isMobile`), exposed as `__np3app.shell`; `drop` null-safe (click handler and drag highlight); `hotkeys`/`known` are not referenced by any module, so nothing to guard; `#nogl` hides `aside, main, #start, [data-shell-hide]`; options of 2.2 passed (`createCurveEditor({chartSlot})`, `createBeforeAfter({hint, longPressTarget})`, `setupTransfer({softDisable, shareExport})`); `import("./mobile.js")` for mobile guarded with `.catch`; `__np3app.mobile = null` and a settable `__np3app.onStatus`.
> - `setStatus(text, kind = "info")` with `state.statusKind` and the `onStatus` hook. Kind assignments: `progress` — "loading models…", "unpacking {name}…"; `error` — "LUT worker failed: {error}", "LUT worker failed", decode error (`setStatus(full)` in the loader callback), "{name}: dimensions do not match the RAW frame — the target is skipped", "{name}: could not be read as a JPEG target — the file is skipped", "Unsupported file: …", and in `transfer.js` "Import failed", "Link import failed", "Export failed", "Share failed"; everything else `info` (default), including "Skipped {name}: this zone accepts …" (start.js, passes `"info"` explicitly), "Decoding of {name} was interrupted", "Preparation interrupted…", "Assemble at least one…", "Fitting is not part of this milestone…", "Ready", "Imported…", "Exported…", "Link copied…". Pair-preparation stages are shown on the pair cards, not through `setStatus`, so they have no kind.
> - `web/lib/view-route.js` (new) per 2.3: `choose`, `switchTo`, `canonical` (returns a `URL`), `PAGES`; `MOBILE_READY = false` (while false `choose()` answers `desktop` and `store: null`). Test hook: `window.NP3_ROUTE_TEST = { mobileReady, run }` — `mobileReady` overrides the constant, `run: true` also executes the load-time redirect step against a stub window (without `run` the script touches no `location`). `index.html`: the script is the first child of `<head>`, followed by `NP3_SHELL = { kind: "desktop" }`.
> - `transfer.js`: `shareLink()` (on `NP3Route.canonical(location.href)`, fallback `new URL("./", location.href)`) used by `shareNow()` and returned from `setupTransfer`; parameters `softDisable`, `shareExport`, `onBlocked` accepted and ignored. `before-after.js`: `hint`, `longPressTarget` accepted and ignored; `curve-editor.js`: `chartSlot` accepted and ignored.
> - `third_party/lucide/LICENSE` = `lucide-static@1.76.0` `package/LICENSE` verbatim; row added to `spec/external.md`.
> - Harness (`web/test.mjs`): the static server maps a path ending in `/` to `index.html` and now has a `.css` MIME type (`text/css`; without it Chromium refuses the stylesheet — this is a required harness change); level 8 uses `?view=desktop` (also in the three share/`?np3=` reloads, as `?view=desktop&np3=…`) and `page.setViewport(1280 x 800)`; no level 1-8 assertion changed (the share test needed no change: it only checks `includes("np3=…")`). New level 9a (after level 8, independent of RAW files): desktop screenshots, 19 router checks (pure `choose()` + load-time step in `vm`), shell/CSS/start-info checks, `setStatus` kinds, `shareLink()` ending `/web/?np3=…` and opening on a fresh page.
> - Screenshots: references `_local/ui-ref/start.png` and `edit.png` (1280 x 800, scale 1, Chromium, captured from the baseline code); written with `NP3_UI_REF=write node test.mjs` (operator only), compared with 0 differing pixels, skipped when absent. The procedure (`uiShot` in `test.mjs`) goes to the editor step by setting `state.step = "edit"` and toggling the two body classes itself (`syncStep` is not exposed by `__np3app`; adding it was not worth an `app.js` change).
> - Deviations: (1) `uiShot` forces a full repaint (`documentElement` display none/"" + 2 rAF) before each screenshot. Reason: once `start.js` inserts the static texts after the first paint, the layout is identical (verified by rects) but Chromium leaves 1-level antialiasing residue on the rounded corners of `#fit-name` (4 pixels); a forced repaint makes the pixels independent of paint history. The references were captured from the baseline code with this exact procedure, so the comparison is still against the pre-M0 desktop. (2) `h1`/`h2` moved to `common.css` (see above). (3) `#start-info { display: contents }`.
> - Skipped tests: none beyond the usual RAW-dependent levels (they ran here: `_local` has the test RAWs). Chromium run (`NP3_BROWSER=chrome`); Firefox is for the operator — the screenshot references are per machine and per browser, so the operator must write Firefox references (`NP3_UI_REF=write`) from the pre-M0 commit if they want that comparison in Firefox.
> - Hand-off to M1: required ids actually used by the core — all of 2.1 (`curve-chart` is read only when `kind: "mobile"`); shell options wiring point: the `createCurveEditor` / `createBeforeAfter` / `setupTransfer` calls in `app.js` (search `isMobile`); the status hook is `window.__np3app.onStatus` (a setter; `(text, kind)`), `state.statusKind` holds the latest kind; `__np3app.mobile` is `null` until `mobile.js` sets it; the history `onChange` hook (task 5 of M1) is not added yet. `NP3Route.switchTo(kind, np3)` takes a base64url string (use `transfer.shareLink()` and its `np3` parameter). M1 must set `MOBILE_READY = true` in `view-route.js` and update the router test "9a router: the shipped MOBILE_READY default…" and "while MOBILE_READY is false, mobile.html redirects…" (they assert the M0 state). The test server serves `.css`. `#start-info` has `display: contents`; M1 wraps it in `<details>` as planned — remember the h2/ul inside keep the common styles.

> **M1 — done (agent-M1 (sonnet), 2026-11-19).** `mobile.html` works end to end in the portrait phone layout on the unchanged core; the router is on.
> - `web/lib/icons.js` (new): `ICONS` map of all 18 Lucide icons (lucide-static 1.76.0) plus `icon(name)`; one `// <name>, Lucide (ISC)` comment per entry. The SVG is the package markup with the license comment and `class` dropped and whitespace collapsed (attributes, paths and the 24 x 24 viewBox untouched). Nothing else from the package is in the repository.
> - `web/mobile.html` (new): head per task 2 (`view-route.js`, `NP3_SHELL = { kind: "mobile" }`, `viewport-fit=cover`, `common.css` + `mobile.css`); `body.step-start` with `#start` (own markup with the Start ids; `#start-info` inside a static `<details id="start-details">` "Before you start"; zones "Tap to choose RAW files / JPEG targets"), `header#topbar` (`#add`, `#info-btn` + `.dot` | `#undo`, `#import`, `#export`, `#share`; icon + visually hidden `data-i18n` label), `main#view` (`#c`, `#ba-slot`, `#curve-chart` hidden, `#empty`), `section#panel` (`#panel-scroll`, `#panel-foot`), `nav#toolbar`, `#toasts`, `dialog#sheet` (handle, close, `#to-start`, `#info`, `#warn`, `#status`, the render caption, Gestures, `#known` with the iOS hint, source link, `#to-desktop`), `dialog#confirm-reset`, `input#file`, `#nogl`. Static icons are inlined with `<!-- name, Lucide (ISC) -->` comments.
> - `web/css/mobile.css` (new): the portrait layout of the spec (`100dvh` column, safe-area insets, no page scroll, `overscroll-behavior: none`; viewer `#000` with the canvas fitted by `max-width/max-height: 100%`; panel `clamp(200px, 38dvh, 360px)` with inner scroll, summaries hidden, only `.grp.active` shown, `#panel-foot` hidden; tool bar; sheet and confirm dialogs; toasts; Start screen sizes). The empty state, the caption pill and the hint are pure CSS: `#c[hidden] ~ #empty/#ba-slot`, `.ba-hint { display: none }` (the real `hint: false` option is M2's). Class names for M2: `.ctl` rows are still the desktop rows (no 52 px rows, no 16 px number fields yet); `.ibtn` icon buttons, `.tool` tool-bar items, `.toast(.error)`, `.sr` visually hidden, `.wide` full-width sheet buttons.
> - `web/lib/mobile.js` (new, loaded by `app.js` for `kind: "mobile"`): tool bar built from the spec table (6 tabs in `#tools[role=tablist]`, divider, Reset), `setTool` (`.active` on the group, `open` forced, `aria-selected`, roving tabindex, arrow keys, scroll-into-view, panel scroll reset; groups get `role=tabpanel` + `aria-labelledby`), default `basic`; Add and `#empty` open `#file` (its value is cleared first so the same file can be chosen again); Undo bound to `hist.undo()` and `hist.canUndo` via `syncUndo`; Reset: `askReset()` (a Promise, in-page `<dialog>`; Cancel, scrim and Escape resolve false) and on confirm `#p-reset.click()`; the info sheet (open/close by button, scrim, Escape, close button, swipe down on the handle; focus returns to Info; the attention dot on an error status in the editor step or a new `#warn`); toasts through `__np3app.onStatus` (info 3 s, progress until replaced, error 6 s or tap); `#to-desktop` -> `NP3Route.switchTo("desktop", <np3 of shareLink()>)`; the "Before you start" disclosure is open on the first visit (`localStorage.np3seenStart`); the `__np3app.mobile` API of 2.10 plus `syncUndo`. `<dialog>` uses `showModal()` with a class/attribute fallback (`.fb`).
> - `web/lib/history.js`: `onChange` option (after push, clear, undo) and the `canUndo` getter. `web/lib/app.js`: one line, `onChange: () => window.__np3app?.mobile?.syncUndo?.()` passed to `createHistory`.
> - `web/index.html`: a "Mobile version" button inside `#known` (the last block of the left column; not a new direct child of `#files`, so the `#files > :last-child` rule is untouched), `hidden` unless the auto rule would pick mobile or `np3view` is stored; an inline module script (uses `t()` for the title, `NP3Route.switchTo("mobile", np3)`).
> - `web/lib/view-route.js`: `MOBILE_READY = true` (the constant stays as a switch; comment updated).
> - `web/test.mjs`: level 9a — the two M0 router tests updated (shipped default now answers `mobile` for a phone; with the shipped value `mobile.html` stays on a phone). New level 9b (60 checks; the RAW file is needed only by the last two, see below): DOM contract and clean console; Start screen 390 x 844 / 360 x 640 (no horizontal overflow, targets >= 44, disclosure open once); portrait geometry 390 x 844 and 360 x 640 (stacking without overlap, panel = 38dvh, no page scroll, tool bar scrolls at 360, active tool scrolled into view, every top-bar/tool-bar/sheet target >= 44 x 44, button order and names); tool bar (default Basic, each tool shows only its group, tab/tabpanel roles, Reset is not a tab); empty state and Add; undo (disabled at the base, restores a slider change); reset (dialog texts, Cancel/Escape/scrim change nothing, `askReset()` promise, confirm neutralizes, keeps the name, one history step, Undo restores); info sheet (open, focus, close button, scrim, Escape, swipe, short drag, Back to Start); toasts (error ~6 s between the bars and tap-dismiss, info ~3 s, progress until replaced, clamp, Info dot set/cleared); export and Copy link on the directory URL; the manual switch both ways carrying the profile; real page loads for the redirect in isolated browser contexts (stored preference + `?np3=` + hash, `?view=mobile`, `?view=desktop`, the auto rule with an emulated phone, the directory URL, a desktop stays, a stored desktop beats the phone rule) and the visibility of the "Mobile version" link; and RAW-dependent checks (canvas fitted and centered in the viewer, empty state gone, caption).
> - Deviations: (1) The editor step without a RAW is entered in tests by the same two body-class lines as the 9a screenshots (`enterEditor` needs a pair). (2) Tool-bar items are `min-width: 55px` instead of 56: 7 items + the 1 px divider must fit a 390 px phone without scrolling (7 x 56 + 1 = 393); they flex-grow, so on 390 px they are ~55.7 px, and the bar scrolls only below ~386 px. (3) Modified dots are not implemented (spec: M3); the `.mdot` span exists in every tab and `modified()` returns an empty set. (4) A new status replaces the previous info/progress toasts regardless of its own kind (so "unpacking…" cannot outlive the status that ends it); an error toast is replaced only by its timer or a tap. (5) The old Space hint is hidden by CSS, not by the `hint` option. (6) The `localStorage` key `np3seenStart` is written on the first load of `mobile.html`, not when the user dismisses the disclosure. (7) The sheet's status line (`#status`) is the only place the plain status text lives besides the toasts; on the Start screen toasts are hidden and `#start-status` shows it. (8) The "Mobile version" link on `index.html` is shown when the auto rule would pick mobile, or on a **touch** device (coarse pointer) with a stored preference — not on any device with a stored preference as the spec says. Reason: the router stores `np3view` on every `?view=` load, so the level-8/9a pages (`?view=desktop`) always have a stored preference; with the literal rule the link was visible in the desktop `edit` screenshot (13283 differing pixels). A mouse desktop never needs the link. (9) The plan's remark that the screenshots run with "no preference" is therefore not true; the coarse-pointer condition is what keeps them identical.
> - Skipped tests: none here (Chromium run, `_local` has the RAW files). Without `_local/test1/DSC_5584.NEF` only the 9b viewer-with-a-real-frame check is skipped. Full run `m1-final`: 573 ok lines (including test_np3.py), `all tests green`, exit 0; 9a screenshots 0 differing pixels.
> - Hand-off to M2: (a) slider rows are the desktop `.ctl` rows inside `#panel-scroll`; add the mobile sizes in `mobile.css` (`.ctl`, `.ctl .val` 16 px, range 32 px high, thumb 22 px). `#p-name` has no id yet (task 7), so the name field is not full width on mobile. (b) The `#export/#share` buttons still use `disabled` (the soft-disable is M2); the info sheet has no clipboard-link field yet (M2 task 9: put it into `#sheet`, e.g. above `#source-link`). (c) `hint: false` and the long-press are not wired; `#c` has no `touch-action` rule yet. (d) Toast/hook points: `showToast(text, kind)` and the `onStatus` hook are internal to `mobile.js`; for `onBlocked("name")` call `app.mobile.setTool("strength")`, focus the name input and show a toast (add an exported `toast()` on `app.mobile` if convenient — not in the 2.10 contract, so ask first or keep it internal to `mobile.js` by passing `onBlocked` from `app.js`, which has no mobile hook for it yet: `setupTransfer` is called in `app.js` without `onBlocked`). (e) Known gaps for M3: modified dots, curve overlay (`#curve-chart` is an empty hidden placeholder, the chart still lives in the Curve panel), landscape, tool-specific sizes (blender dots, wheel, tab heights 40 px). (f) After a reload the history keeps its sessionStorage stack and `app.js` pushes another base snapshot, so Undo can be enabled on a fresh page load (pre-existing desktop behavior, not changed).

> **M2 — done (agent-M2 (sonnet), 2026-11-19).** Every gesture of the spec works with a finger on `mobile.html`; export and share behave as specified on phones. Verified in Chromium only (no Firefox, no real devices here).
> - `web/lib/touch.js` (new): `onLongPress(el, { start, end, delay = 250, slop = 10, types })` (pointer capture, ends once on pointerup/pointercancel/lostpointercapture; `types` is an extra option beyond 2.7, default all), `onDoubleTap(el, fn, { interval = 300, slop = 12, exclude = "input[type=number]" })` (touch/pen only, a drag is not a tap), `horizontalDrag(range, { threshold = 8, area, exclude = ".top", thumb = 22 })` (see task 6). Unit-tested in 9c with synthetic `PointerEvent`s.
> - `before-after.js`: `hint: false` sets `hidden` on the hint line (the element stays, API unchanged); `longPressTarget` -> `onLongPress(..., types: ["touch", "pen"])` calling the same `show(true/false)` as Space (only with `state.raw`; no LUT/develop is built, checked by the stats counters); `contextmenu` is prevented unless the last pointer on the target was a mouse (so the desktop canvas keeps its right-click menu). A mouse hold does not trigger before/after (deviation from the literal "any pointerType" of 2.7 for this caller only: the desktop must not change).
> - `panels.js`, `blending.js`, `grading.js`: the `dblclick` body is a local `resetToDefault()` used by `dblclick` and by `onDoubleTap(box, ...)`; a second reset within 350 ms is ignored (the double tap and the dblclick that some browsers add must push one snapshot). `enterkeyhint="done"` on the `.val` fields (type=number, no inputmode). `panels.js`: the name input gets `id="p-name"`, `autocapitalize/autocomplete/autocorrect="off"`, `enterkeyhint="done"`.
> - `p-name` id and the desktop: giving the input the id would have made the existing desktop rule `#p-name { width: 100%; margin: 2px 0 }` (common.css, dead until now) apply. I did not measure whether that changes the desktop screenshot; I scoped it instead: the rule moved from `common.css` to `mobile.css` (a comment in `common.css` says why), `#p-name-err` stays in `common.css`. The desktop name field is therefore exactly as before (9a screenshots: 0 differing pixels).
> - `common.css`: `.ctl { touch-action: manipulation }` (no pixel effect). `mobile.css`: `#c` `touch-action: none; -webkit-touch-callout: none; user-select: none`; slider rows (`.ctl` min 52 px, `touch-action: pan-y`; label 14 px; `.val` 64 px wide, 32 px high, 16 px font; range 32 px high, thumb 22 px (`margin-top: -9px` for WebKit/Blink), track unchanged); `#clip-box`/`#clip-link` (16 px, 44 px); the old `.ba-hint { display: none }` is gone (the option does it).
> - Task 6, device check replaced by Chromium touch emulation (390 x 844, `isMobile` + `hasTouch`, real touch through CDP `Input.dispatchTouchEvent`), **native `input[type=range]` with `touch-action: pan-y`**, Basic > Contrast: (a) a vertical swipe starting on the track at 80%: value 0 -> 64, panel scrolled 76 px, +1 history step — VIOLATION; a swipe starting on the thumb: value unchanged, panel scrolled — ok; a slightly diagonal swipe (12 px x, 80 px y) from the track: 0 -> 64 + scroll, +1 history — VIOLATION. (b) A tap on the track at 80%: 0 -> 64, +1 history — VIOLATION (Blink's range handles `touchstart`: it jumps on touch-down; `preventDefault()` on `pointerdown` does not stop it, tried). A tap on the thumb: unchanged. (c) A horizontal drag from the thumb (+100 px) -> 58, from the track (+40 px) -> 66, one history step each — ok. Decision: **`horizontalDrag()` is implemented and attached to every range of `mobile.html`** (`mobile.js` attaches it to every range in `#panel-scroll`; the ranges are built at start-up). The ranges are drawn only: `pointer-events: none` on `input[type=range]` in `mobile.css`; the row (`.ctl`, `touch-action: pan-y` so horizontal moves stay with the page) receives the pointer events and drives the value: nothing changes until the pointer has moved 8 px with |dx| > |dy|; a mostly vertical move is left to the browser (it scrolls the panel); a tap never changes the value; a drag that starts within a thumb width of the thumb keeps the thumb under the finger, elsewhere the thumb follows the finger from the threshold on; `input` events while dragging, one `change` at the end (also after `pointercancel`), as a native drag; a mouse behaves like the native range (value from pointerdown, drag, focus). A drag that starts on the label/number line (`.top`) does not move the value. The desktop page keeps native ranges. With the handler the same Chromium runs give: vertical swipes (track/thumb/diagonal) scroll the panel (73-77 px) and change nothing, taps change nothing, horizontal drags from thumb (+100 px -> 58) and track work, one history step per drag (asserted in 9c). **Not verified on iOS Safari or on a real Android Chrome**: the behavior of Safari's native range was not observed at all; whether iOS needs the handler (it may not jump on a track tap) is left for M4 on real devices. The handler is deliberately active everywhere on `mobile.html` until then; M4 should check feel (live drag rate, thumb grab near the thumb, the 8 px threshold, the row hit area) and may remove it for a browser where the native range turns out to behave.
> - `transfer.js`: `softDisable` (invalid name -> `aria-disabled="true"` on `#export`/`#share`, buttons stay enabled, a tap calls `onBlocked("name")`; desktop keeps `disabled` + `title`); `shareExport` (`exportNow()` builds `File([bytes], "<name>.NP3", { type: "application/octet-stream" })`, `navigator.share({ files, title })` when `navigator.canShare({ files })` is true; `AbortError` silent; other errors/no support -> the download; status "Shared: {name}" / "Exported: {name}"; the desktop path stays synchronous, the share path returns a promise); clipboard failure with `onBlocked` set -> status error "Copy failed — the link is in Info" + `onBlocked("clipboard", link)` (without `onBlocked`, i.e. on the desktop, the old "Share failed: {error}" stays); the NP3 import input has `data-accept-fallback`. `app.js`: `onBlocked` passed only for the mobile shell, forwarding to `window.__np3app.mobile.onBlocked`.
> - `mobile.js`: `onBlocked("name")` -> toast "Set a valid NP3 name (1–19 ASCII) to export" (info), `setTool("strength")`, focus `#p-name`; `onBlocked("clipboard", link)` -> `#clip-box` in the info sheet (read-only `<input id="clip-link">` selected on open, a "Share…" button shown only when `navigator.share` exists, calling `navigator.share({ url })`); the link is recomputed on every open and the box is hidden when the sheet closes (never a stale link). Keyboard visibility: `focusin` of an input in `#panel`/`#start` (after 50 ms) and `visualViewport` `resize` call `scrollIntoView({ block: "nearest" })` on the focused field. `ACCEPT_FALLBACK = false` + `dropAccept()` (also on `__np3app.mobile`) remove `accept` from every `input[data-accept-fallback]` (`#file` in `mobile.html` and the NP3 input). `__np3app.mobile` gained `onBlocked` and `dropAccept` (not in 2.10; additive). `mobile.html`: `#clip-box` after `#status` in the sheet (not above the source link: it must be visible without scrolling), `data-accept-fallback` on `#file`. New strings: "Link", "Share…" (+ the already listed "Shared: {name}", "Copy failed — the link is in Info").
> - `web/test.mjs`: level 9c (after 9b), 57 `ok` lines (full run `m2-final2`: 630 ok lines in total incl. test_np3.py, `all tests green`, exit 0): touch.js unit checks (long press, double tap, horizontal drag, mouse), slider row CSS facts (row >= 52 px, range 32 px, thumb rule 22 px, 16 px number fields, no inputmode, `#p-name` full width and attributes, `#c` touch-action), real touch in Chromium (swipes, taps, drags, double tap on track/label: one history step; skipped with a message when `NP3_BROWSER` is not `chrome`), item 11 on Basic/Strength/Details/Blender/Grading (single tap, double tap, double tap + dblclick = one snapshot, number field excluded, mouse dblclick), item 12 (aria-disabled, toast, tool, focus, no file, no copy), keyboard visibility, the accept switch, item 13 with stubs (no API, success with the exact bytes, `AbortError`, other error, `canShare` false, serialize error), the clipboard fallback (toast, Info dot, pre-selected field, "Share…", fresh link, hidden after close), item 10 (RAW: before on a 300 ms touch with no LUT/develop, 5 px stays, 20 px cancels, 100 ms is not a long press, a mouse hold does nothing, Space untouched, a real emulated touch-and-hold; contextmenu without RAW), and the desktop page (touch double tap, dblclick, native ranges, hint shown, `disabled` + title, old clipboard status, synchronous download). The desktop screenshots are compared by level 9a on the same code (not repeated in 9c).
> - Deviations: (1) native ranges are not kept (task 6 decision above); the spec text "range inputs get `touch-action: pan-y`" is still true but the range is additionally `pointer-events: none` and the row gets `pan-y` instead of `manipulation` on mobile (pan-y also rules out double-tap zoom). (2) `onLongPress` has a `types` option and before/after uses touch+pen only (see above). (3) `contextmenu` suppression depends on the last pointer type instead of being unconditional, to keep the desktop right-click. (4) The clip-link box sits after `#status`. (5) One harness change in an M1 check: the 9b helper `small()` (targets >= 44 px) now ignores elements without a layout box; the hidden `#clip-share` button (inside the hidden `#clip-box` of the sheet) made "9b 360x640: the info sheet fits … targets >= 44" fail, and hidden elements are not tap targets. No assertion text or threshold changed. (6) The 350 ms reset guard means two resets of the same slider within 350 ms collapse into one (intended; tests wait 400 ms).
> - Skipped tests: none in the Chromium run here (the RAW file is present). Without `_local/test1/DSC_5584.NEF` the item-10 long-press checks skip (the contextmenu check runs); outside Chromium the real-touch checks skip.
> - Hand-off to M3: slider row = `.ctl > .top (span.lbl, input.val) + input[type=range]`, same in Basic, Details, Profile Strength, Blender, Grading; ranges are driven by `horizontalDrag` (attach it to any range you create later, and to rows created after start-up: `mobile.js` attaches only to ranges present at load); the area needs `touch-action: pan-y`. The Blender dots and the grading wheel are untouched (`touch-action: none` on the wheel is M3). Open: iOS/Android device checks of the slider handler, the keyboard-visibility behavior (only the call is tested, a real on-screen keyboard was not), `navigator.share` with files on real devices, the toast for blocked taps uses the info kind (3 s).

> **M3 — done (agent-M3 (sonnet), 2026-11-19).** The curve, Blender and Grading are finger-sized, the curve chart sits over the photo, the tool bar shows modified dots, and the landscape layout works. Verified in Chromium only (no Firefox, no real devices here).
> - `web/lib/curve-editor.js` (task 1): with `chartSlot` the SVG is appended there and the controls stay in `slot` (without it nothing changes); `api.chart` returns the SVG. Touch: a `pointerup` of a touch/pen pointer within 10 px of its `pointerdown` on anything that is not a point (the background, the histogram, the diagonal and the curve line all lie over the background) adds a point at the tone under the finger (`toTone()` already maps through `getScreenCTM()`, so it works in any parent; verified in the overlay and on the desktop page); a tap on a point selects it; a drag from an empty spot, a mouse click, and any tap at 20 points add nothing (the limit note is shown as a toast on mobile, see below). Each point has an invisible hit circle `.ce-hit` (class on the SVG) of `r = 22 / scale` SVG units (22 screen px; a `ResizeObserver` keeps it right when CSS rescales the chart), drawn in a group behind the visible points and routed to the same drag handler. The visible radius is unchanged. Deviation: the hit circles take pointer events only while the last pointer was a finger or a pen (class `touch` on the SVG, set from `matchMedia("(pointer: coarse)")` and a capture-phase `pointerdown` listener). Reason: always-on circles of 22 px would change the mouse (a dblclick within 22 px of a point would hit the circle, not the background, and could not add a point there); with the class the mouse path and the desktop pixels are exactly as before (`.ce-hit` is transparent, level 9a screenshots: 0 differing pixels). A tap has no maximum duration (a 450 ms rest on an empty spot adds a point too; the before/after long press lives on the photo outside the chart).
> - Curve overlay (task 2): `mobile.js` shows `#curve-chart` only when `tool === "curve"` and `state.control.curve !== null`, re-checked in `setTool`, on the curve toggle `change`, on every history `onChange` (`syncUndo`) and on every `panel.refresh()` (wrapped in `mobile.js`; undo, import and Reset all go through it). The side `--side = min(viewer w, h) - 16 px` is set by a `ResizeObserver` on `#view`, so rotation resizes it. `mobile.css`: the square is centered, `rgba(0,0,0,.35)` on the SVG, transparent `.ce-bg` (it still takes the pointer), lighter lines and a dark point fill for contrast over the photo, `touch-action: none`, `z-index: 2` (above the empty-state button). The photo stays visible and the histogram backdrop and identity diagonal are kept. A **Done** button (`check`, 44 px) sits in the same row as the "Custom curve" checkbox (`#curve-slot` is a flex row on mobile so Done never scrolls out of the 243 px panel at 360 x 640); it calls `setTool("basic")`. `pointerdown` from `#curve-chart` does not propagate (the chart is not inside `#c`, so the before/after long press on `#c` cannot start on it anyway; tested with a real RAW and real touch). The 20-point limit: a `MutationObserver` on the editor's `.ce-limit` note (new class) shows the text as a toast; the note itself is `display: none` on mobile.
> - Blender (task 3) and Grading (task 4): `blending.js` and `grading.js` are **unchanged**; everything is in `mobile.css` with id selectors (the editors inject their own `<style>` after `mobile.css`, so equal-specificity class rules would lose). Toggle and tab rows 40 px high (tabs also min 44 px wide: "All" was 35); Blender dots: the button is a 40 px hit area with a 6 px transparent border and `background-clip: content-box !important` (the inline `background` shorthand of `blending.js` resets the clip, hence `!important`), so the visible dot is 28 px; `justify-content: space-between` spreads the 8 dots over the panel width; the selected ring is a 2 px `::after` border around the dot (the original `outline` would have ringed the 40 px box). The hit area is the 40 px circle (the corners of its box are outside the `border-radius`). Grading: `.gr-wheel` is `min(200px, 55%)`, the disc is square by `aspect-ratio`, `touch-action: none`, the Hue/Saturation fields 16 px and 40 px high (they sit outside `.ctl`, so M2's 16 px rule did not reach them). All Blender/Grading ranges already exist at load, so M2's `horizontalDrag` covers them (real touch checks: a horizontal drag moves a Blender and a Grading slider, a vertical swipe on the track only scrolls the panel).
> - Modified dots (task 5): `mobile.js` `modified()` (also on `__np3app.mobile`) compares the live profile with a neutral built like `panels.resetAll` (`newProfile()` with zeroed blender/grading): Profile = `strength !== 100` (name/comment do not count), Basic = the six sliders, Curve = `curve !== null`, Details = sharpening/mid/clarity against the `newProfile()` defaults 2/1/0.5, Blender = any colour channel, Grading = any zone channel, Blending !== 50 or Balance !== 0. `updateDots()` toggles `.mdot` (and `data-modified`) from `syncUndo()` (the history `onChange`: every push, undo and clear), the `panel.refresh` wrapper and the curve toggle. Live drags do not update the dots until the action finishes. Every tab got an `aria-label` (the label text is hidden in landscape).
> - Landscape (task 6), `mobile.css` `@media (orientation: landscape)` (only outside `step-start`): the body is a grid, top bar 44 px over both columns (left group over the viewer, right group at the right edge, over the right column), viewer left, right column `min(360px, 42vw)` with the panel (flex, no fixed height) above the tool bar; the tool bar is a 4-column grid, icon only (`#tools { display: contents }`, labels `display: none`, divider hidden), 44 px items, 4 + 3 in two rows; the dot moves to the icon's top-right; toasts stay over the viewer (right edge at the column), the sheet is `min(600px, 100%)` wide; left/right safe-area insets go to the viewer, the panel and the tool bar only on their outer sides. Rotation is pure CSS plus the `ResizeObserver`: no reload, the profile, history, Undo state, active tool, open Reset dialog and curve overlay survive (tested by changing the viewport twice on one page).
> - `web/test.mjs` level 9d (after 9c, 78 `ok` lines; `python3 test_np3.py` + everything: 708 `ok` lines in `m3-final`, `all tests green`, exit 0, 0 skipped): A the curve over the photo (placement, size, background, hit circles at 22 px, Done, leaving/returning, tap adds, tap on the diagonal, tap in the hit zone selects, 40 px away is not a hit, drag and mouse click add nothing, mouse dblclick adds, the pointer-type switch of the hit circles, drag from the hit zone = one history step, the 20-point toast, Reset/Undo/import follow the overlay, real touch tap and drag); B modified dots (every tool, name excluded, Reset, Undo, NP3 imports, 4 px under the label, aria-labels); C Blender dots (40 px hit, 28 px visible, even spread, 2 px ring, taps), tabs/toggle heights, the grading wheel at 390 and 360 (size formula, centered, `touch-action`), real touch on the wheel (no panel scroll), on a Blender slider (horizontal drag moves, vertical swipe scrolls only) and a Grading slider; D 360 x 640 in all six tools and both Blender/Grading modes (every button/tab/dot >= 40 px, no horizontal overflow, the curve checkbox row 44 px, chart inside the viewer, bars >= 44 px, page does not scroll, tool bar scrolls); E landscape 844 x 390 (grid columns, no overlap, two icon-only rows, corners of the curve chart reachable, every tool >= 40 px without overflow, toast, info sheet, rotation back and forth, the Reset dialog through a rotation); F with the RAW (photo under the chart, histogram, long press on the photo strip still works, not on the chart, real touch); G the desktop page (chart stays in `#curve-slot`, hit circles inert for the mouse, `.ce-bg` unchanged, dblclick adds, a touch tap adds too). Level 8 assertions are unchanged; 9a screenshots 0 differing pixels; 9b/9c pass unchanged.
> - Deviations: (1) the hit-circle activation by pointer type (above). (2) `blending.js`/`grading.js` untouched (CSS only). (3) Done sits next to the checkbox, not at the end of the panel. (4) The size check covers buttons, tabs, toggles and dots (>= 40 px; icon buttons and Done >= 44); number fields stay 32-40 px high and sliders keep the 52 px row from M2 (the spec sets no 44 px rule for them). (5) The wheel corner check accepts the visible point (`ce-pt`) on top of its hit circle.
> - Skipped tests: none. Not verified: Firefox, iOS/Android devices (hit-circle feel with a real finger, the 22 px radius, the 8 px drag threshold vs. the chart's own 10 px tap slop, the wheel), real safe-area insets in landscape (notch side: CSS only, untested), the keyboard over the x/y fields of the curve.
> - Hand-off to M4: **how to test on a phone.** The pages need a secure context for Web Share and the clipboard: serve `web/` over HTTPS or reach it as `localhost`. Android Chrome: run a static server on the PC from the repository root (`python3 -m http.server 8000`), plug the phone in with USB debugging, open `chrome://inspect/#devices` on the PC, add the port forward `8000 -> localhost:8000`, open `http://localhost:8000/web/mobile.html?view=mobile` on the phone (`localhost` counts as secure; `?view=` stores the choice in `np3view`, so the desktop page can be reached with `?view=desktop`). The JS console and a device screenshot are available from that inspect window. iPhone: Safari does not treat a LAN IP as secure, so use an HTTPS tunnel or the real deployment (GitHub Pages) for Web Share/clipboard checks; for layout and touch only, `http://<pc-ip>:8000/web/mobile.html?view=mobile` works, and the Web Inspector is available from Safari on a Mac (Settings > Safari > Advanced > Web Inspector on the phone, then Develop > the phone on the Mac). Things M4 should look at first for this stage: dragging a curve point with a real finger (22 px hit circle, point hidden under the finger), tap-to-add near points and near the chart edge, the wheel under the thumb, the Blender dots at 360 px, landscape on a notched phone, and the tool bar dots at arm's length. The RAW test file `_local/test1/DSC_5584.NEF` is not needed for any 9d check except the photo-under-chart and long-press ones (the curve works without a frame).

> **Merge with the parallel ui-plan work — done (orchestrator, 2026-11-19).** The mobile commits M0–M3 were merged with a snapshot of the working folder taken at 14:12 UTC, which carries the parallel, uncommitted ui-plan stage 3–4 work (fit Worker, Comparison screen `compare-view.js`, More-frames stub). Conflicts resolved in `web/index.html` (the start-screen CSS stays in `css/common.css`; the new `#to-compare` rule stays inline), `web/lib/app.js` (`window.__np3app` carries both `shell`/`mobile` and `compare`/`enterCompare`), `web/lib/start.js` (comments only) and `web/test.mjs` (Chromium switch + the stage-3 `protocolTimeout`). `mobile.html` gets the Comparison / More-frames markup with the ids the core requires (`to-compare`, `compare`, `cmp-*`, `cc`, `more`, `more-back`) in a plain scrolling column — a designed mobile layout of these steps is an open question. The level-8 page is back at the puppeteer default 800 × 600 (`?view=desktop` keeps it on the desktop page): at 1280 × 800 the stage-4 check "compare modes share the same zoom/pan mapping" fails, while it passes at 800 × 600 on both the snapshot alone and the merge — a viewport-dependent issue for the stage-4 owner, not a merge defect. The desktop screenshot references were regenerated from the snapshot (pre-mobile code with the new Comparison button). Full suite in Chromium: 739 ok, exit 0.

> **Port onto the page split — done (stage 11 of ui-plan.md, 2026-11-20).** M0–M3 of branch `mobile` are on `feature/np3-fit`: the page is `picture-control-editor-mobile.html` (no Start/Compare/More, no `#to-start`), the router only on the two editor pages (`PAGES`, `canonical()` = the desktop editor page), the core hooks live in `editor-core.js`/`editor-app.js`, the levels 9a–9d run as one key "9m" in `web/test-mobile.mjs` (Start-screen checks dropped). Stage-6 marks/group resets got 40 px hit areas in `mobile.css`. Next: M4 (devices).
