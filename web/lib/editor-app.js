// The profile editor (spec/ui-pages.md): the entry of picture-control-editor.html and
// picture-control-editor-mobile.html. One RAW at a time (picker, drop zone or a drop anywhere
// on the page), all NP3 tools on the editor core (lib/editor-core.js), NP3 import / export /
// share link, resets to the neutral defaults (spec/ui.md decision #2, the standalone
// semantics). No pairs, JPEG targets, fit, report or versions — those live in the fitting
// wizard (picture-control-jpg-fit.html). The page opens straight into the editor; an NP3 can
// be imported and edited before any RAW is opened; a ?np3= share link is applied at start.
import { t, register, initLang, reTranslate } from "./i18n.js";
import { mountLangMenu } from "./lang-select.js";
import DICT_RU from "./i18n-editor-ru.js";
import DICT_DE from "./i18n-editor-de.js";
import DICT_FR from "./i18n-editor-fr.js";
import { createEditorCore, $ } from "./editor-core.js";

// The editor pages are translated (EN / RU / DE / FR, the landing's languages): the language is
// picked before the core builds the panel, so every widget is created in it. A switch made later
// re-translates the data-i18n* texts in place; the status line follows below.
register("ru", DICT_RU);
register("de", DICT_DE);
register("fr", DICT_FR);
initLang();

const core = await createEditorCore({ extraState: { step: "edit" } });
const { state, setStatus, renderer, loader, panel, hist, curveEditor, blendingView, gradingView,
        beforeAfter, transfer, renderCurrent, getBaseline, setBaseline } = core;

// ---------- opening a RAW: the picker, the drop zone, a drop anywhere on the page ----------
// A new RAW replaces the frame; the profile and the strength are kept.
function openRaw(file) {
  return loader.open(file);
}

const drop = $("drop");
if (drop) drop.onclick = () => $("file").click();
$("file")?.addEventListener("change", (ev) => { const f = ev.target.files[0]; ev.target.value = ""; if (f) openRaw(f); });
for (const ev2 of ["dragenter", "dragover"]) document.addEventListener(ev2, (e) => {
  e.preventDefault();
  drop?.classList.add("over");
});
for (const ev2 of ["dragleave", "drop"]) document.addEventListener(ev2, (e) => {
  e.preventDefault();
  drop?.classList.remove("over");
});
// Routing by extension: an NP3 is imported, a RAW opened; a JPEG target belongs to the
// fitting wizard (spec/ui-pages.md) — a hint, no decode.
document.addEventListener("drop", (e) => {
  for (const f of [...(e.dataTransfer?.files || [])]) routeFile(f);
});

function routeFile(f) {
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  if (ext === "np3") transfer.importFile(f);
  else if (ext === "nef" || ext === "dng") openRaw(f);
  else if (ext === "jpg" || ext === "jpeg") {
    setStatus(t("{name}: JPEG targets are used by the fitting wizard (picture-control-jpg-fit.html)", { name: f.name }), "error");
  } else {
    setStatus(t("Unsupported file: {name} — drop a NEF, DNG or NP3", { name: f.name }), "error");
  }
}

setStatus(t("Open a RAW to see the profile"));

// ---------- language ----------
// A status written before the switch is re-translated when it is a plain string of the
// dictionaries ("Ready", "Open a RAW to see the profile"); one with a file name or an error
// stays as written until the next status. Written in place, not through setStatus: the mobile
// page would show the same status again as a toast.
let shownLang = document.documentElement.lang;
if ($("lang-btn")) mountLangMenu($("lang-btn"), $("lang-menu"), (lang) => {
  state.status = reTranslate(state.status, shownLang);
  shownLang = lang;
  if ($("status")) $("status").textContent = state.status;
});
transfer.importFromUrl(); // the ?np3= share parameter, if any

// For the end-to-end tests and lib/mobile.js: the state and the entry points. `mobile` and
// `onStatus` are the core's hooks (mobile.js registers its shell and its toast listener).
window.__np3app = { state, panel, renderer, loader, renderCurrent, curveEditor, blendingView,
                    gradingView, transfer, beforeAfter, hist, getBaseline, setBaseline, routeFile,
                    openRaw, shell: core.shell };
Object.defineProperties(window.__np3app, {
  mobile: { get: () => core.mobile, set: (m) => { core.mobile = m; }, enumerable: true },
  onStatus: { get: () => core.onStatus, set: (fn) => { core.onStatus = fn; }, enumerable: true },
});
if (core.isMobile) await import("./mobile.js");
