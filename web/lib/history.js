// Edit history: undo/redo over finished actions (spec/ui-manual-mvp.md "Edit history",
// spec/ui.md step 3.1 "Undo and redo", spec/ui-plan.md §4 stage 6).
// Extracted from app.js in the session refactor (stage 1); redo added in stage 6.
// Up to `limit` last states (control + strength) in the tab's sessionStorage, a snapshot on
// every finished action. Undo/redo move a cursor over the stack; a new action cuts off the
// undone future (the redo chain), as in every editor. Changing the RAW or importing an NP3
// resets the history (the caller calls clear()).
// Keys: Ctrl/Cmd+Z — undo; Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y — redo. In text fields the keys are
// the native input undo/redo — the profile history is not touched.
// The sessionStorage format {stack, idx} is unchanged from the undo-only version: an old
// stored history loads as is (idx at the end = nothing to redo).

export const HIST_KEY = "np3hist";

/**
 * snapshot() — the current state as a plain JSON-able object;
 * apply(s)     — restores a stored snapshot (receives a deep copy);
 * onChange(h)  — optional, called after every push/clear/undo/redo with the history object
 *                (to enable/disable Undo/Redo buttons); can also be set later via h.onChange.
 */
export function createHistory({ snapshot, apply, limit = 20, onChange = null }) {
  let hist = { stack: [], idx: -1 };
  try {
    const raw0 = JSON.parse(sessionStorage.getItem(HIST_KEY));
    if (raw0 && Array.isArray(raw0.stack)) {
      const idx = Number.isInteger(raw0.idx) ? raw0.idx : raw0.stack.length - 1;
      hist = { stack: raw0.stack, idx: Math.min(Math.max(idx, -1), raw0.stack.length - 1) };
    }
  } catch { /* sessionStorage unavailable — the history is memory-only */ }

  let changed = onChange;
  const api = {};
  const save = () => {
    try { sessionStorage.setItem(HIST_KEY, JSON.stringify(hist)); } catch { }
    changed?.(api);
  };

  function push() {
    hist.stack = hist.stack.slice(0, hist.idx + 1);   // cut off the undone future (the redo chain)
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
    if (hist.idx <= 0) return false;
    hist.idx--;
    apply(JSON.parse(JSON.stringify(hist.stack[hist.idx])));
    save();
    return true;
  }

  function redo() {
    if (hist.idx >= hist.stack.length - 1) return false;
    hist.idx++;
    apply(JSON.parse(JSON.stringify(hist.stack[hist.idx])));
    save();
    return true;
  }

  window.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
    const key = ev.key.toLowerCase();
    const isUndo = key === "z" && !ev.shiftKey;
    const isRedo = (key === "z" && ev.shiftKey) || (key === "y" && !ev.shiftKey);
    if (!isUndo && !isRedo) return;
    // in text fields the keys are the native input undo/redo
    const el = ev.target.closest?.("input:not([type=range]), textarea, select, [contenteditable='true']");
    if (el) return;
    ev.preventDefault();
    if (isUndo) undo(); else redo();
  });

  Object.assign(api, { push, clear, undo, redo });
  Object.defineProperties(api, {
    length: { get: () => hist.stack.length },
    index: { get: () => hist.idx },
    canUndo: { get: () => hist.idx > 0 },
    canRedo: { get: () => hist.idx < hist.stack.length - 1 },
    onChange: { get: () => changed, set: (fn) => { changed = fn; } },
  });
  return api;
}
