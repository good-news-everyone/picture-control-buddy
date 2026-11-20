// NP3 import/export (part of the CD section 5 of the plan, spec/ui-manual-mvp.md "Import and export").
// Ownership: this file; wiring is in app.js.
// Import is atomic: deserialize() throws before any assignment, on failure the state does not change.
// Export: the final control = strength 100% ? the base control : scaled(...). At 100% scaled()
// would regenerate the curve points into 20 even samples and break the byte-exact round-trip
// of an unmodified profile (official samples store the real editor points), so the base control
// is the result at 100%. The naming rule is as in the panel: the "-<percent>" suffix is added
// only at strength != 100%.
// There is no strength-set export (spec/ui.md decision #10): one NP3 per Save, at the
// current strength.
// Share link: the serialized NP3 bytes (a few hundred) are base64url-encoded into the ?np3=
// query parameter, so a profile is shared by copying the URL. GitHub Pages serves the page
// regardless of the parameter; the decode happens here, on the client. The link always opens
// the profile editor (spec/ui-pages.md "Share links"): picture-control-editor.html next to the
// current page, from the editor pages and from the fitting wizard alike.
// Import is optional: the wizard has no NP3 import (no #import button, ui-pages.md).
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

export const SHARE_PAGE = "picture-control-editor.html";

/** The share link of a control: picture-control-editor.html?np3=… beside `base`. */
export function shareLinkOf(bytes, base = location.href) {
  const link = new URL(SHARE_PAGE, base);
  link.searchParams.set("np3", bytesToB64url(bytes));
  return link.toString();
}

// Options (spec/ui-mobile-plan.md §2.6, touch pages): softDisable — with an invalid name
// Export/Copy link are aria-disabled instead of disabled, so a tap is not swallowed and
// onBlocked("name") can explain it; shareExport — Export tries the system share sheet first and
// falls back to the download; onBlocked(kind, payload) — "name" (a blocked tap) or "clipboard"
// (copying failed, payload = the link). setStatus(text, kind): kind is "info" | "progress" | "error".
export function setupTransfer({ state, panel, renderCurrent, setStatus, onReset = null,
                                softDisable = false, shareExport = false, onBlocked = null }) {
  const importBtn = document.getElementById("import");
  const exportBtn = document.getElementById("export");
  const shareBtn = document.getElementById("share");
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".np3,.NP3";
  input.hidden = true;
  input.setAttribute("data-accept-fallback", "");   // mobile.js can drop `accept` for pickers that grey files out
  document.body.append(input);

  if (importBtn) {
    importBtn.disabled = false;
    importBtn.removeAttribute("title");
    importBtn.addEventListener("click", () => input.click());
  }
  exportBtn.removeAttribute("title");
  shareBtn.removeAttribute("title");
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
      setStatus(t("Import failed: {error}", { error: e.message }), "error");
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
      setStatus(t("Link import failed: {error}", { error: e.message }), "error");
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

  // soft-disabled: a tap is answered by onBlocked instead of being swallowed by a disabled button
  const blocked = () => softDisable && state.nameValid === false;

  function updateExport() {
    const ok = state.nameValid !== false;
    if (softDisable) {
      for (const b of [exportBtn, shareBtn]) {
        b.disabled = false;
        if (ok) b.removeAttribute("aria-disabled"); else b.setAttribute("aria-disabled", "true");
      }
      return;
    }
    exportBtn.disabled = !ok;
    shareBtn.disabled = !ok;
    exportBtn.title = ok ? "" : t("Set a valid NP3 name (1–19 ASCII) to export");
    shareBtn.title = exportBtn.title;
  }

  function download(bytes, name) {
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setStatus(t("Exported: {name}", { name }));
  }

  // The system share sheet (phones). Called synchronously from the tap, so the user activation
  // that navigator.share needs is still there. -> "shared" | "aborted" | "fallback"
  async function shareFile(bytes, name) {
    let file;
    try { file = new File([bytes], name, { type: "application/octet-stream" }); } catch { return "fallback"; }
    if (typeof navigator.share !== "function" || !navigator.canShare?.({ files: [file] })) return "fallback";
    try {
      await navigator.share({ files: [file], title: name });
      return "shared";
    } catch (e) {
      return e?.name === "AbortError" ? "aborted" : "fallback";   // the user closed the sheet: silent
    }
  }

  // Desktop: a synchronous download. shareExport: returns a promise.
  function exportNow() {
    let bytes, name;
    try {
      bytes = serialize(finalControl());
      name = `${finalName()}.NP3`;
      if (!shareExport) { download(bytes, name); return; }
    } catch (e) {
      setStatus(t("Export failed: {error}", { error: e.message }), "error");
      return;
    }
    return shareFile(bytes, name).then((how) => {
      if (how === "shared") setStatus(t("Shared: {name}", { name }));
      else if (how === "fallback") download(bytes, name);
    }).catch((e) => setStatus(t("Export failed: {error}", { error: e.message }), "error"));
  }
  exportBtn.addEventListener("click", () => { if (blocked()) onBlocked?.("name"); else exportNow(); });

  /** The share URL: picture-control-editor.html?np3=… (the editor page's router picks desktop
   *  or mobile on open). */
  function shareLink() {
    return shareLinkOf(serialize(finalControl()));
  }

  async function shareNow() {
    let link = null;
    try {
      link = shareLink();
      await navigator.clipboard.writeText(link);
      setStatus(t("Link copied: {name}", { name: finalName() }));
    } catch (e) {
      if (link && onBlocked) {
        // the page offers the link elsewhere (the info sheet on mobile)
        setStatus(t("Copy failed — the link is in Info"), "error");
        onBlocked("clipboard", link);
      } else {
        setStatus(t("Share failed: {error}", { error: e.message }), "error");
      }
    }
  }
  shareBtn.addEventListener("click", () => { if (blocked()) onBlocked?.("name"); else shareNow(); });
  updateExport();

  return { importFile, exportNow, shareNow, importFromUrl, updateExport, shareLink };
}
