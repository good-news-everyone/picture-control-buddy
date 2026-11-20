// Changed-field marks and reset controls (spec/ui-plan.md stage 6, spec/ui.md step 3.1).
// Shared by panels.js, curve-editor.js, blending.js and grading.js. A mark is a small
// button that is visible only while its field differs from the baseline (web/lib/baseline.js):
// it keeps its box when hidden (visibility, no layout jump) and is a real button, so it is
// reachable from the keyboard — activating it resets that field to the baseline.
// Styles: index.html (.mark, .grp-reset, .chg).
import { t } from "./i18n.js";

/** The per-field mark; `label` is the English field label (translated here). */
export function markButton(label, onReset) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mark";
  b.title = t("Changed — click to reset");
  b.setAttribute("aria-label", t("Reset {name}", { name: t(label) }));
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onReset();
  });
  return b;
}

/** A small reset control for a group/section (`label` — its English accessible name). */
export function resetButton(label, onReset) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "grp-reset";
  b.title = t(label);
  b.setAttribute("aria-label", t(label));
  b.disabled = true;
  b.addEventListener("click", (e) => {
    e.preventDefault();          // inside a <summary>: do not toggle the group
    e.stopPropagation();
    onReset();
  });
  return b;
}

/** Shows/hides a mark (class `chg` on its owner) and enables a reset control. */
export function setChanged(owner, changed, resetBtn = null) {
  owner.classList.toggle("chg", changed);
  if (resetBtn) resetBtn.disabled = !changed;
}
