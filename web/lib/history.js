// Edit history: Ctrl+Z over finished actions (spec/ui-manual-mvp.md "Edit history").
// Extracted from app.js in the session refactor (spec/ui-plan.md §4 stage 1) — the behavior
// is unchanged: up to `limit` last states (control + strength) in the tab's sessionStorage,
// a snapshot on every finished action, a new action cuts off the undone future (no redo),
// changing the RAW or importing an NP3 resets the history (the caller calls clear()).
// Ctrl+Z in a text field is the native input undo — the profile history is not touched.

export const HIST_KEY = "np3hist";

/**
 * snapshot() — the current state as a plain JSON-able object;
 * apply(s)     — restores a stored snapshot (receives a deep copy).
 */
export function createHistory({ snapshot, apply, limit = 20 }) {
  let hist = { stack: [], idx: -1 };
  try {
    const raw0 = JSON.parse(sessionStorage.getItem(HIST_KEY));
    if (raw0 && Array.isArray(raw0.stack)) hist = raw0;
  } catch { /* sessionStorage unavailable — the history is memory-only */ }

  const save = () => {
    try { sessionStorage.setItem(HIST_KEY, JSON.stringify(hist)); } catch { }
  };

  function push() {
    hist.stack = hist.stack.slice(0, hist.idx + 1);   // cut off the undone future
    hist.stack.push(snapshot());
    if (hist.stack.length > limit) hist.stack.shift();
    hist.idx = hist.stack.length - 1;
    save();
  }

  function clear() {
    hist = { stack: [], idx: -1 };
    save();
  }

  function undo() {
    if (hist.idx <= 0) return;
    hist.idx--;
    apply(JSON.parse(JSON.stringify(hist.stack[hist.idx])));
    save();
  }

  window.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== "z" || ev.shiftKey) return;
    // in text fields Ctrl+Z is the native input undo
    const el = ev.target.closest?.("input:not([type=range]), textarea, select, [contenteditable='true']");
    if (el) return;
    ev.preventDefault();
    undo();
  });

  return { push, clear, undo,
           get length() { return hist.stack.length; },
           get index() { return hist.idx; } };
}
