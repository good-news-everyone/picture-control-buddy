// The mobile shell (spec/ui-mobile.md, plan stage M1): loaded by editor-app.js only for
// window.NP3_SHELL.kind === "mobile". Everything here works on the markup of
// web/picture-control-editor-mobile.html (the profile editor; spec/ui-pages.md):
// the tool bar and the active tool (one panel group at a time), Undo, the Reset confirmation,
// the info sheet with the attention dot, the status toasts, the version switch. The core
// (editor-core.js, panels.js, transfer.js) is not aware of this file except through the hooks
// window.__np3app.onStatus (statuses -> toasts) and window.__np3app.mobile.syncUndo (history).
// M2 added: blocked taps (name / clipboard link), keyboard visibility, the picker `accept` switch.
// M3 added: the curve chart over the photo (+ Done), the modified dots, the 20-point toast. The
// landscape layout is CSS only (mobile.css), the rotation keeps everything in this file.
import { t, applyI18n } from "./i18n.js";
import { ICONS } from "./icons.js";
import { newProfile, COLORS, ZONES } from "./np3.js";
import { horizontalDrag } from "./touch.js";

const app = window.__np3app;
const $ = (id) => document.getElementById(id);
const { state, hist } = app;
const curveChart = $("curve-chart");
const view = $("view");

// ---------- dialog helpers (showModal with a fallback for browsers without it) ----------
const hasModal = (d) => typeof d.showModal === "function";
function openDialog(d) {
  if (d.hasAttribute("open")) return;
  if (hasModal(d)) d.showModal();
  else { d.setAttribute("open", ""); d.classList.add("fb"); }
}
function closeDialog(d, value = "") {
  if (!d.hasAttribute("open")) return;
  if (hasModal(d) && !d.classList.contains("fb")) d.close(value);
  else {
    d.returnValue = value;
    d.removeAttribute("open");
    d.classList.remove("fb");
    d.dispatchEvent(new Event("close"));
  }
}
// Escape in the fallback mode (a real modal dialog handles Escape natively)
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const d of [$("confirm-reset"), $("sheet")])
    if (d.classList.contains("fb") && d.hasAttribute("open")) { closeDialog(d, "cancel"); break; }
});

// ---------- tool bar ----------
const TOOLS = [
  ["strength", "layers", "Profile"],
  ["basic", "sun", "Basic"],
  ["curve", "spline", "Curve"],
  ["details", "focus", "Details"],
  ["blender", "blend", "Blender"],
  ["grading", "palette", "Grading"],
];
const toolbar = $("toolbar");
const tools = document.createElement("div");
tools.id = "tools";
tools.setAttribute("role", "tablist");
const tabs = new Map();
const groups = new Map();
for (const g of document.querySelectorAll("#panel-scroll details.grp[data-group]")) groups.set(g.dataset.group, g);

for (const [key, icon, label] of TOOLS) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tool";
  b.id = `tab-${key}`;
  b.dataset.tool = key;
  b.setAttribute("role", "tab");
  b.setAttribute("aria-selected", "false");
  b.tabIndex = -1;
  b.setAttribute("aria-label", t(label));     // the label text is hidden in landscape (icon-only bar)
  b.innerHTML = `${ICONS[icon]}<span class="lbl" data-i18n="${label}">${t(label)}</span><span class="mdot" hidden></span>`;
  b.addEventListener("click", () => setTool(key));
  tools.append(b);
  tabs.set(key, b);
  const g = groups.get(key);
  if (g) {
    g.id = `tool-${key}`;
    g.setAttribute("role", "tabpanel");
    g.setAttribute("aria-labelledby", b.id);
    b.setAttribute("aria-controls", g.id);
  }
}
tools.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const keys = TOOLS.map((x) => x[0]);
  const i = keys.indexOf(tool);
  const next = keys[(i + (e.key === "ArrowRight" ? 1 : keys.length - 1)) % keys.length];
  setTool(next);
  tabs.get(next).focus();
  e.preventDefault();
});
const divider = document.createElement("div");
divider.className = "divider";
const resetBtn = document.createElement("button");
resetBtn.type = "button";
resetBtn.className = "tool";
resetBtn.id = "reset-btn";
resetBtn.setAttribute("aria-label", t("Reset"));
resetBtn.innerHTML = `${ICONS["rotate-ccw"]}<span class="lbl" data-i18n="Reset">${t("Reset")}</span>`;
toolbar.append(tools, divider, resetBtn);

let tool = "basic";
function setTool(key) {
  if (!tabs.has(key)) return;
  tool = key;
  for (const [k, b] of tabs) {
    const on = k === key;
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
  }
  for (const [k, g] of groups) {
    g.open = true;                       // the summary is hidden: a group is never collapsed here
    g.classList.toggle("active", k === key);
  }
  $("panel-scroll").scrollTop = 0;
  tabs.get(key).scrollIntoView({ inline: "nearest", block: "nearest" });
  updateOverlay();
}

// ---------- curve chart over the photo ----------
// Shown only in the Curve tool with the custom curve on (re-checked on tool switches, the curve
// toggle and every panel refresh: undo, import, Reset). Its side is min(viewer w, viewer h) - 16 px.
function updateOverlay() {
  curveChart.hidden = !(tool === "curve" && state.control.curve !== null);
}
function sizeOverlay() {
  const side = Math.max(0, Math.min(view.clientWidth, view.clientHeight) - 16);
  curveChart.style.setProperty("--side", `${side}px`);
}
new ResizeObserver(sizeOverlay).observe(view);
sizeOverlay();
// a touch on the chart is the chart's own: it never starts the before/after long press of #c
curveChart.addEventListener("pointerdown", (e) => e.stopPropagation());
{
  const slot = $("curve-slot");
  const done = document.createElement("button");
  done.type = "button";
  done.className = "ce-done";
  done.innerHTML = `${ICONS.check}<span data-i18n="Done">${t("Done")}</span>`;
  done.addEventListener("click", () => setTool("basic"));
  slot.querySelector(".ce-toggle")?.after(done);
  slot.querySelector('input[type="checkbox"]')?.addEventListener("change", () => { updateOverlay(); updateDots(); });
  // the 20-point limit is shown as a toast (the editor's own note is hidden by CSS here)
  const limit = slot.querySelector(".ce-limit");
  if (limit) new MutationObserver(() => { if (!limit.hidden) showToast(limit.textContent); })
    .observe(limit, { attributes: true, attributeFilter: ["hidden"] });
}

// ---------- modified dots ----------
// A dot under the label of a tool whose fields differ from the neutral, built the way panels.js
// resetAll builds it (newProfile() with zeroed blender and grading). Profile: strength != 100,
// its name and comment do not count. Curve: control.curve !== null. Recomputed after every
// finished action (the history's onChange fires on every push, undo and clear) and on every refresh.
function modified() {
  const c = state.control, n = newProfile();
  for (const k of COLORS) n.blender[k] = [0, 0, 0];
  for (const z of ZONES) n.grade[z] = [0, 0, 0];
  const differs = (keys) => keys.some((k) => c[k] !== n[k]);
  const arrDiffers = (a, b) => a.some((v, i) => v !== b[i]);
  const out = new Set();
  if (state.strength !== 100) out.add("strength");
  if (differs(["saturation", "contrast", "highlights", "shadows", "white", "black"])) out.add("basic");
  if (c.curve !== null) out.add("curve");
  if (differs(["sharpening", "mid_sharpening", "clarity"])) out.add("details");
  if (COLORS.some((k) => arrDiffers(c.blender[k], n.blender[k]))) out.add("blender");
  if (ZONES.some((z) => arrDiffers(c.grade[z], n.grade[z])) || differs(["blending", "balance"])) out.add("grading");
  return out;
}
function updateDots() {
  const set = modified();
  for (const [k, b] of tabs) {
    const on = set.has(k);
    b.querySelector(".mdot").hidden = !on;
    b.toggleAttribute("data-modified", on);
  }
}
setTool("basic");

// ---------- slider drag ----------
// The ranges are drawn by CSS only (pointer-events: none): a native range jumps to the touch point
// on touchstart, which breaks "a vertical swipe never changes a value" (plan M2 task 6).
for (const r of document.querySelectorAll("#panel-scroll input[type=range]")) horizontalDrag(r);

// ---------- file buttons ----------
const fileInput = $("file");
const openPicker = () => { fileInput.value = ""; fileInput.click(); };   // the same file can be picked again
$("add").addEventListener("click", openPicker);
$("empty").addEventListener("click", openPicker);

// ---------- Undo ----------
const undoBtn = $("undo");
function syncUndo() { undoBtn.disabled = !hist.canUndo; updateDots(); updateOverlay(); }
undoBtn.addEventListener("click", () => { hist.undo(); syncUndo(); });

// ---------- Reset with confirmation ----------
const confirmDlg = $("confirm-reset");
let resetPromise = null;
function askReset() {
  if (resetPromise) return resetPromise;
  resetPromise = new Promise((resolve) => {
    confirmDlg.returnValue = "";
    const done = () => {
      confirmDlg.removeEventListener("close", done);
      resetPromise = null;
      resolve(confirmDlg.returnValue === "ok");
    };
    confirmDlg.addEventListener("close", done);
    openDialog(confirmDlg);
  });
  return resetPromise;
}
$("confirm-ok").addEventListener("click", () => closeDialog(confirmDlg, "ok"));
$("confirm-cancel").addEventListener("click", () => closeDialog(confirmDlg, "cancel"));
confirmDlg.addEventListener("click", (e) => { if (e.target === confirmDlg) closeDialog(confirmDlg, "cancel"); });
resetBtn.addEventListener("click", async () => {
  if (await askReset()) $("p-reset").click();     // the panel's own Reset: a finished action -> history
});

// ---------- info sheet ----------
const sheet = $("sheet");
const infoBtn = $("info-btn");
const dot = infoBtn.querySelector(".dot");
const warn = $("warn");
let ackWarn = "";
function checkWarn() {
  if (warn.hidden) ackWarn = "";
  else if (warn.textContent && warn.textContent !== ackWarn && !isInfoOpen()) dot.hidden = false;
}
new MutationObserver(checkWarn).observe(warn, { attributes: true, attributeFilter: ["hidden"], childList: true });
function isInfoOpen() { return sheet.hasAttribute("open"); }
function openInfo() {
  dot.hidden = true;
  ackWarn = warn.hidden ? "" : warn.textContent;
  if (clipPending) {                      // the profile may have changed since the copy failed
    try { fillClipLink(app.transfer.shareLink()); } catch { /* invalid name: keep the old link */ }
  }
  openDialog(sheet);
  if (clipPending) { clipInput.focus(); clipInput.select(); }
}
function closeInfo() { closeDialog(sheet, "close"); }
infoBtn.addEventListener("click", openInfo);
$("sheet-close").addEventListener("click", closeInfo);
sheet.addEventListener("click", (e) => { if (e.target === sheet) closeInfo(); });
sheet.addEventListener("close", () => {
  sheet.style.transform = "";
  clipPending = false; clipBox.hidden = true;
  infoBtn.focus();
});
// a swipe down on the handle closes the sheet
{
  const handle = sheet.querySelector(".handle");
  let y0 = null;
  handle.addEventListener("pointerdown", (e) => { y0 = e.clientY; try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } });
  handle.addEventListener("pointermove", (e) => {
    if (y0 === null) return;
    sheet.style.transform = `translateY(${Math.max(0, e.clientY - y0)}px)`;
  });
  const end = (e) => {
    if (y0 === null) return;
    const dy = e.clientY - y0;
    y0 = null;
    sheet.style.transform = "";
    if (dy > 60) closeInfo();
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

// ---------- version switch ----------
const toDesktop = $("to-desktop");
toDesktop.title = t(toDesktop.title);
toDesktop.addEventListener("click", () => {
  let np3 = null;
  try { np3 = new URL(app.transfer.shareLink()).searchParams.get("np3"); } catch { /* invalid name: no profile */ }
  window.NP3Route.switchTo("desktop", np3);
});

// ---------- toasts ----------
// info 3 s, progress until replaced, error 6 s or until tapped (plan 2.4). Any new status replaces
// the previous info/progress toasts (so "unpacking…" never outlives the status that follows it);
// an error toast stays for its own time.
const toastBox = $("toasts");
const toastList = [];
function dropToast(x) {
  clearTimeout(x.timer);
  x.el.remove();
  const i = toastList.indexOf(x);
  if (i >= 0) toastList.splice(i, 1);
}
function showToast(text, kind = "info") {
  if (!text) return;
  for (const x of [...toastList]) if (x.kind !== "error") dropToast(x);
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.textContent = text;
  const x = { el, text, kind, timer: 0 };
  if (kind === "info") x.timer = setTimeout(() => dropToast(x), 3000);
  if (kind === "error") x.timer = setTimeout(() => dropToast(x), 6000);
  el.addEventListener("click", () => dropToast(x));
  toastBox.append(el);
  toastList.push(x);
}
app.onStatus = (text, kind) => {
  showToast(text, kind);
  if (kind === "error" && state.step === "edit" && !isInfoOpen()) dot.hidden = false;
  checkWarn();
};

// ---------- blocked taps from transfer.js: a bad name, a refused clipboard ----------
// "name": Export / Copy link on an invalid name -> a toast, the Profile tool, the name field.
// "clipboard": the link goes into the info sheet (read-only field, selected on open, "Share…").
const clipBox = $("clip-box");
const clipInput = $("clip-link");
const clipShare = $("clip-share");
let clipPending = false;
function fillClipLink(link) {
  clipInput.value = link;
  clipBox.hidden = false;
  clipShare.hidden = typeof navigator.share !== "function";
}
clipShare.addEventListener("click", async () => {
  try { await navigator.share({ url: clipInput.value }); } catch { /* cancelled or unsupported: nothing to do */ }
});
function onBlocked(kind, payload) {
  if (kind === "name") {
    showToast(t("Set a valid NP3 name (1–19 ASCII) to export"));
    setTool("strength");
    $("p-name")?.focus();
  } else if (kind === "clipboard") {
    clipPending = true;
    fillClipLink(payload);
  }
}

// ---------- keyboard visibility ----------
// An on-screen keyboard covers the lower part of the screen: keep the focused field in view,
// at focus and whenever the visual viewport changes (the keyboard opening / closing).
const isField = (el) => el && el.matches?.("input, textarea") && el.closest("#panel");
const keepVisible = () => { const el = document.activeElement; if (isField(el)) el.scrollIntoView({ block: "nearest" }); };
document.addEventListener("focusin", (e) => { if (isField(e.target)) setTimeout(keepVisible, 50); });
window.visualViewport?.addEventListener("resize", keepVisible);

// ---------- file pickers: one switch for the `accept` fallback (M4 decides on devices) ----------
// iOS can grey out files whose extension has no system type (.NP3); then the picker has to drop
// `accept` and the extension routing of app.js rejects wrong files. Flip the constant to try it.
const ACCEPT_FALLBACK = false;
function dropAccept() { for (const el of document.querySelectorAll("input[data-accept-fallback]")) el.removeAttribute("accept"); }
if (ACCEPT_FALLBACK) dropAccept();

// ---------- the API of plan 2.10 ----------
app.mobile = {
  get tool() { return tool; },
  setTool, openInfo, closeInfo, isInfoOpen, askReset, syncUndo, onBlocked, dropAccept,
  toasts: () => toastList.map((x) => ({ text: x.text, kind: x.kind })),
  modified,
};
// every refresh of the panel (undo, NP3 import, Reset, a new frame) re-reads the profile
{
  const base = app.panel.refresh;
  app.panel.refresh = () => { base(); updateOverlay(); updateDots(); };
}
syncUndo();
applyI18n(toolbar);
