// NP3 import/export (part of the CD section 5 of the plan, spec/ui-manual-mvp.md "Import and export").
// Ownership: this file; wiring is in app.js.
// Import is atomic: deserialize() throws before any assignment, on failure the state does not change.
// Export: the final control = strength 100% ? the base control : scaled(...). At 100% scaled()
// would regenerate the curve points into 20 even samples and break the byte-exact round-trip
// of an unmodified profile (official samples store the real editor points), so the base control
// is the result at 100%. The naming rule is as in the panel: the "-<percent>" suffix is added
// only at strength != 100%.
import { t } from "./i18n.js";
import { deserialize, serialize } from "./np3.js";
import { scaled } from "./strength.js";

export function setupTransfer({ state, panel, renderCurrent, setStatus, onReset = null }) {
  const importBtn = document.getElementById("import");
  const exportBtn = document.getElementById("export");
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".np3,.NP3";
  input.hidden = true;
  document.body.append(input);

  importBtn.disabled = false;
  importBtn.removeAttribute("title");
  exportBtn.removeAttribute("title");
  importBtn.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const f = input.files[0];
    input.value = "";
    if (f) importFile(f);
  });

  async function importFile(file) {
    try {
      const control = deserialize(await file.arrayBuffer());
      state.control = control;       // only after a successful parse
      state.strength = 100;
      state.nameValid = true;
      panel.refresh();
      renderCurrent();
      onReset?.();                   // an NP3 import resets the edit history (Ctrl+Z)
      setStatus(t("Imported: {name}", { name: control.name }));
    } catch (e) {
      setStatus(t("Import failed: {error}", { error: e.message }));
    }
  }

  function finalControl() {
    // Values — the result after strength; the name — the base one: strength does not affect the
    // profile name (UI-2), the "-<percent>" suffix is not written into the NP3.
    const c = state.strength === 100 ? state.control : scaled(state.control, state.strength);
    return state.strength === 100 ? c : { ...c, name: state.control.name };
  }
  function finalName() {
    // UI-2: strength does not affect the name, the "-<percent>" suffix is not added
    return state.control.name;
  }

  function updateExport() {
    const ok = state.nameValid !== false;
    exportBtn.disabled = !ok;
    exportBtn.title = ok ? "" : t("Set a valid NP3 name (1–19 ASCII) to export");
  }

  function exportNow() {
    try {
      const c = finalControl();
      const bytes = serialize(c);
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${finalName()}.NP3`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setStatus(t("Exported: {name}", { name: a.download }));
    } catch (e) {
      setStatus(t("Export failed: {error}", { error: e.message }));
    }
  }
  exportBtn.addEventListener("click", exportNow);
  updateExport();

  return { importFile, exportNow, updateExport };
}
