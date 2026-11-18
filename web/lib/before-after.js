// Before/after (part of the EF section 5 of the plan, spec/ui-manual-mvp.md "Preview -> Before/after";
// UI-2 package: the button is gone, switching is space-hold only).
// While space is held (focus outside input fields) — state.showNeutral = true and renderCurrent()
// shows the ready Nikon neutral cache without LUT/strength; releasing returns the result.
// The canvas size, profile and strength do not change; RAW decoding is not started.
import { t } from "./i18n.js";

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
export function createBeforeAfter(slot, { state, renderCurrent }) {
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
    if (editableTarget(ev.target) || !state.raw) return;   // only after a successful RAW development
    ev.preventDefault();   // do not scroll the page with space
    show(true);
  });
  window.addEventListener("keyup", (ev) => {
    if (ev.key === " ") show(false);
  });

  return {
    label,
    hint,
    /** API compatibility: there is no button anymore, the state is by state.raw. */
    update() {},
  };
}
