// Before/after (part of the EF section 5 of the plan, spec/ui-manual-mvp.md "Preview -> Before/after";
// UI-2 package: the button is gone, switching is space-hold only).
// While space is held (focus outside input fields) — state.showNeutral = true and renderCurrent()
// shows the ready Nikon neutral cache without LUT/strength; releasing returns the result.
// The canvas size, profile and strength do not change; RAW decoding is not started.
import { t } from "./i18n.js";
import { onLongPress } from "./touch.js";

const BEFORE = "Before — neutral";
const AFTER = "After — NP3";
const HINT = "Hold Space to compare with neutral";

// Space acts as "before" only if the focus is not in a text field or an editable element.
// A slider (input[type=range]) is not a text field: after dragging, the focus stays on it,
// and space must still toggle "before/after".
function editableTarget(target) {
  const el = target.closest?.("input, textarea, select, [contenteditable='true']");
  return el && el.type !== "range" ? el : null;
}

/**
 * slot — #ba-slot in the viewer area; state/renderCurrent — from app.js.
 * Returns {label, hint, update()}: the state caption and the space hint.
 */
// hint: false hides the "Hold Space" line (touch pages). longPressTarget (plan §2.8): touching and
// holding that element (a finger or a pen, 250 ms, no more than 10 px of movement) shows "before"
// until the pointer is released — the touch counterpart of the Space hold. A mouse is not affected
// (so the desktop canvas keeps its right-click menu).
export function createBeforeAfter(slot, { state, renderCurrent, hint: showHint = true, longPressTarget = null }) {
  slot.replaceChildren();
  slot.classList.add("ba");
  const label = document.createElement("div");
  label.className = "ba-label";
  label.dataset.i18n = AFTER;
  label.textContent = t(AFTER);
  const hint = document.createElement("div");
  hint.className = "ba-hint";
  hint.dataset.i18n = HINT;
  hint.textContent = t(HINT);
  hint.hidden = !showHint;
  slot.append(label, hint);

  function show(before) {
    if (before === state.showNeutral) return;
    state.showNeutral = before;
    label.dataset.i18n = before ? BEFORE : AFTER;
    label.textContent = t(before ? BEFORE : AFTER);
    renderCurrent();      // with showNeutral it shows the neutral cache, no LUT is built
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.key !== " " || ev.repeat) return;
    // the editor ("edit": the profile editor and the wizard's quick editor) and the wizard's Compare
    // screen; never in a text field. The wizard has no state.raw: its pairs carry the frames
    const hasFrame = state.raw || state.pairs?.some?.((p) => p.prepared);
    if (editableTarget(ev.target) || !hasFrame || (state.step !== "edit" && state.step !== "compare")) return;
    // on Compare Space also presses a focused button or pair tile: leave those alone
    if (state.step === "compare" && ev.target.closest?.("button, [role='button']")) return;
    ev.preventDefault();   // do not scroll the page with space
    show(true);
  });
  window.addEventListener("keyup", (ev) => {
    if (ev.key === " ") show(false);
  });

  if (longPressTarget) {
    onLongPress(longPressTarget, {
      types: ["touch", "pen"],
      start: () => { if (state.raw) show(true); },
      end: () => show(false),
    });
    // the system "save image" / text-selection menu must not open on a long press; a mouse
    // right-click (last pointer was a mouse) keeps its menu
    let lastType = null;
    longPressTarget.addEventListener("pointerdown", (e) => { lastType = e.pointerType; }, true);
    longPressTarget.addEventListener("contextmenu", (e) => { if (lastType !== "mouse") e.preventDefault(); });
  }

  return {
    label,
    hint,
    /** API compatibility: there is no button anymore, the state is by state.raw. */
    update() {},
  };
}
