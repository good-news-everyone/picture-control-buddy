// NP3 import/export (part of the CD section 5 of the plan, spec/ui-manual-mvp.md "Import and export").
// Ownership: this file; wiring is in app.js.
// Import is atomic: deserialize() throws before any assignment, on failure the state does not change.
// Export: the final control = strength 100% ? the base control : scaled(...). At 100% scaled()
// would regenerate the curve points into 20 even samples and break the byte-exact round-trip
// of an unmodified profile (official samples store the real editor points), so the base control
// is the result at 100%. The naming rule is as in the panel: the "-<percent>" suffix is added
// only at strength != 100%.
// Share link: the serialized NP3 bytes (a few hundred) are base64url-encoded into the ?np3=
// query parameter, so a profile is shared by copying the URL. GitHub Pages serves the page
// regardless of the parameter; the decode happens here, on the client.
import { t } from "./i18n.js";
import { deserialize, serialize } from "./np3.js";
import { scaled } from "./strength.js";

// base64url without padding: URL-safe, and %3D escapes are avoided
export function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function b64urlToBytes(s) {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function setupTransfer({ state, panel, renderCurrent, setStatus, onReset = null }) {
  const importBtn = document.getElementById("import");
  const exportBtn = document.getElementById("export");
  const shareBtn = document.getElementById("share");
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".np3,.NP3";
  input.hidden = true;
  document.body.append(input);

  importBtn.disabled = false;
  importBtn.removeAttribute("title");
  exportBtn.removeAttribute("title");
  shareBtn.removeAttribute("title");
  importBtn.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const f = input.files[0];
    input.value = "";
    if (f) importFile(f);
  });

  function applyControl(control) {
    state.control = control;       // only after a successful parse
    state.strength = 100;
    state.nameValid = true;
    panel.refresh();
    renderCurrent();
    onReset?.();                   // an NP3 import resets the edit history (Ctrl+Z)
  }

  async function importFile(file) {
    try {
      const control = deserialize(await file.arrayBuffer());
      applyControl(control);
      setStatus(t("Imported: {name}", { name: control.name }));
    } catch (e) {
      setStatus(t("Import failed: {error}", { error: e.message }));
    }
  }

  /** Applies the ?np3= share parameter, if present. Called once at startup (app.js). */
  function importFromUrl() {
    const param = new URLSearchParams(location.search).get("np3");
    if (!param) return;
    try {
      const control = deserialize(b64urlToBytes(param));
      applyControl(control);
      setStatus(t("Imported from link: {name}", { name: control.name }));
    } catch (e) {
      setStatus(t("Link import failed: {error}", { error: e.message }));
    }
    // the parameter has been consumed — keep the address bar tidy
    const url = new URL(location.href);
    url.searchParams.delete("np3");
    history.replaceState(null, "", url);
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
    shareBtn.disabled = !ok;
    exportBtn.title = ok ? "" : t("Set a valid NP3 name (1–19 ASCII) to export");
    shareBtn.title = exportBtn.title;
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

  async function shareNow() {
    try {
      const link = new URL(location.href);
      link.search = "";
      link.hash = "";
      link.searchParams.set("np3", bytesToB64url(serialize(finalControl())));
      await navigator.clipboard.writeText(link.toString());
      setStatus(t("Link copied: {name}", { name: finalName() }));
    } catch (e) {
      setStatus(t("Share failed: {error}", { error: e.message }));
    }
  }
  shareBtn.addEventListener("click", shareNow);
  updateExport();

  return { importFile, exportNow, shareNow, importFromUrl, updateExport };
}
