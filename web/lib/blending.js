// Lightroom-style Color Blender (UI-2 package, spec/color-blending/: hsl.png, mixer.png).
// The "Adjust: HSL / Color" switch:
//  - HSL: tabs Hue | Saturation | Luminance | All — 8 rows by colors for the selected
//    attribute (All — all three sections in a row);
//  - Color: a row of 8 color dots (color selection), below them Hue/Saturation/Luminance
//    of the selected color.
// The NP3 key does not change: blender[color] = [hue, sat, lum]; Chroma/Brightness are shown
// as Saturation/Luminance. Refs: spec/color-blending/hsl.png, mixer.png.
import { t, i18nSet } from "./i18n.js";
import { COLORS } from "./np3.js";
import { neutralControl, colorKeys, changedKeys, resetKeys } from "./baseline.js";
import { markButton, resetButton, setChanged } from "./mark.js";
import { onDoubleTap } from "./touch.js";

const GSAT = 65;   // muted saturation of the gradients (as in LR)
const HUES = { red: 0, orange: 30, yellow: 60, green: 120, cyan: 180, blue: 240, purple: 280, magenta: 320 };
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const hsl = (h, s, l) => `hsl(${((h % 360) + 360) % 360},${s}%,${l}%)`;
// Hue: only the spectrum of the current color — ±55 degrees around it, not the whole circle
const hueTrack = (base) =>
  `linear-gradient(90deg, ${[-55, -27, 0, 27, 55].map((d, i) =>
    `${hsl(base + d, GSAT, 55)} ${i * 25}%`).join(", ")})`;
const satTrack = (base) => `linear-gradient(90deg, ${hsl(base, 0, 52)}, ${hsl(base, GSAT, 55)})`;
const lumTrack = (base) => `linear-gradient(90deg, #000, ${hsl(base, GSAT, 55)}, #fff)`;
const TRACKS = [hueTrack, satTrack, lumTrack];

const MODE_HSL = "HSL";
const MODE_COLOR = "Color";
const TABS = ["Hue", "Saturation", "Luminance", "All"];

const CSS = `
.bl-tabs { display: flex; gap: 2px; margin: 6px 0 2px; flex-wrap: wrap; justify-content: center; }
.bl-dots { display: flex; gap: 7px; justify-content: center; margin: 10px 0 6px; }
.bl-dot { width: 16px; height: 16px; border-radius: 50%; padding: 0; border: 1px solid #000;
  cursor: pointer; }
.bl-dot.sel { outline: 2px solid var(--accent); outline-offset: 1px; }
.bl-cname { text-align: center; color: var(--dim); font-size: 11px; margin-bottom: 2px;
  text-transform: capitalize; }
.bl-chead { display: flex; justify-content: center; align-items: center; gap: 6px; }
`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** A slider as in panels.js; returns {sync, box, input}. Double click — reset
 *  to opts.base() (the baseline value, stage 6); the changed mark shows while the value
 *  differs from it and resets it too; the numeric value is an editable input. */
function slider(parent, label, min, max, step, get, set, opts = {}) {
  const input = document.createElement("input");
  input.type = "range";
  input.min = min; input.max = max; input.step = step;
  if (opts.track) {
    input.classList.add("grad");
    input.style.setProperty("--track", opts.track);
  }
  const val = el("input", "val");
  val.type = "number";
  val.setAttribute("enterkeyhint", "done");
  val.min = min; val.max = max; val.step = step;
  const top = el("div", "top");
  const lbl = el("span", "lbl", t(label));
  lbl.dataset.i18n = label;
  let lastReset = -1e9;     // a double tap may be followed by a browser dblclick: one reset only
  const resetTo = () => {
    if (!opts.base || performance.now() - lastReset < 350) return;
    lastReset = performance.now();
    input.value = opts.base();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  top.append(lbl);
  if (opts.base) top.append(markButton(label, resetTo));
  top.append(val);
  const box = el("div", "ctl");
  box.append(top, input);
  const mark = () => { if (opts.base) setChanged(box, Math.abs(get() - opts.base()) > 1e-9); };
  const paint = () => input.style.setProperty("--fill",
    `${(100 * (parseFloat(input.value) - min) / (max - min)).toFixed(1)}%`);
  const show = (v) => { val.value = String(v); };
  const sync = () => { const v = get(); input.value = v; show(v); paint(); mark(); };
  sync();
  input.addEventListener("input", () => {
    set(parseFloat(input.value));
    opts.syncPeers?.();          // the same color channel in the other mode/tab
    show(get());
    paint();
    mark();
    opts.onLive?.();
  });
  input.addEventListener("change", () => opts.onDone?.());
  // double click (mouse) and double tap (touch): one reset, one history snapshot (see panels.js)
  input.addEventListener("dblclick", resetTo);
  onDoubleTap(box, resetTo);
  val.addEventListener("change", () => {
    let v = parseFloat(val.value);
    if (Number.isNaN(v)) { show(get()); return; }
    v = Math.min(max, Math.max(min, v));
    input.value = v;
    set(v);
    opts.syncPeers?.();
    show(get());
    paint();
    mark();
    opts.onDone?.();
  });
  parent.append(box);
  return { sync, box, input };
}

/**
 * slot — #blending-slot in the "Color Blender" group; state/onChange — from app.js.
 * sync() re-reads the values from state.control (after an NP3 import / Reset).
 * getBaseline() — { control } (stage 6): resets and changed marks compare against it; a
 * color dot carries the mark while any of its three channels differs, "Reset color" resets
 * the selected color.
 */
export function createBlendingView(slot, { state, onChange, panel,
                                           getBaseline = () => ({ control: neutralControl() }) }) {
  const B = () => getBaseline().control;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  slot.replaceChildren();

  const syncs = [];
  function syncAll() { for (const s of syncs) s(); updateColorMarks(); }

  // --- Adjust: HSL / Color toggle group (first, ref spec/toggle) ---
  let colorMode = false;
  const modeRow = el("div", "tgl");
  const btnHsl = el("button", "active", t(MODE_HSL));
  btnHsl.type = "button";
  btnHsl.dataset.i18n = MODE_HSL;
  const btnColor = el("button", null, t(MODE_COLOR));
  btnColor.type = "button";
  btnColor.dataset.i18n = MODE_COLOR;
  modeRow.append(btnHsl, btnColor);

  // --- HSL mode: Hue/Saturation/Luminance/All tabs (LR-style text) ---
  const bodyHsl = el("div");
  const tabRow = el("div", "bl-tabs");
  const tabBtns = TABS.map((tab) => {
    const b = el("button", "tabbtn", t(tab));
    b.type = "button";
    b.dataset.i18n = tab;
    tabRow.append(b);
    return b;
  });
  bodyHsl.append(tabRow);
  const sections = TRACKS.map((trackFn, i) => {
    const sec = el("div");
    const sub = el("div", "sub", t(TABS[i]));
    sub.dataset.i18n = TABS[i];
    sec.append(sub);
    const rowSyncs = [];
    for (const color of COLORS) {
      const { sync, box } = slider(sec, cap(color), -100, 100, 1,
        () => state.control.blender[color][i], (v) => { state.control.blender[color][i] = v; },
        { track: trackFn(HUES[color]), base: () => B().blender[color][i], syncPeers: syncAll,
          onLive: () => onChange(true), onDone: () => onChange(false) });
      syncs.push(sync);
      rowSyncs.push(sync);
      panel.clipRow?.(`blender.${color}.${i}`, box);   // clipping highlight at strength >100%
    }
    bodyHsl.append(sec);
    return sec;
  });

  // --- Color mode: color dots + sliders of the selected color ---
  const bodyColor = el("div");
  bodyColor.hidden = true;
  const dots = el("div", "bl-dots");
  const dotBtns = {};
  let selColor = "red";
  const cname = el("div", "bl-cname");
  i18nSet(cname, "text", cap(selColor));
  const colorSyncs = [];
  const colorInputs = [];
  for (const color of COLORS) {
    const b = el("button", "bl-dot");
    b.type = "button";
    b.style.background = hsl(HUES[color], GSAT, 55);
    i18nSet(b, "title", cap(color));
    i18nSet(b, "aria", cap(color));
    b.addEventListener("click", () => selectColor(color));
    dots.append(b);
    dotBtns[color] = b;
  }
  const colorReset = resetButton("Reset color", () => resetColor(selColor));
  const chead = el("div", "bl-chead");
  chead.append(cname, colorReset);
  bodyColor.append(dots, chead);
  for (let i = 0; i < 3; i++) {
    const { sync, input } = slider(bodyColor, TABS[i], -100, 100, 1,
      () => state.control.blender[selColor][i], (v) => { state.control.blender[selColor][i] = v; },
      { track: TRACKS[i](HUES[selColor]), base: () => B().blender[selColor][i], syncPeers: syncAll,
        onLive: () => onChange(true), onDone: () => onChange(false) });
    syncs.push(sync);
    colorSyncs.push(sync);
    colorInputs.push(input);
  }

  slot.append(modeRow, bodyHsl, bodyColor);

  // --- view state (does not land in NP3) ---
  let tab = "All";                 // the active attribute tab
  function setTab(next) {
    tab = next;
    tabBtns.forEach((b, i) => b.classList.toggle("active", TABS[i] === tab));
    sections.forEach((sec, i) => { sec.hidden = tab !== "All" && TABS[i] !== tab; });
  }
  tabBtns.forEach((b, i) => b.addEventListener("click", () => setTab(TABS[i])));

  // ---------- changed marks / reset to the baseline (stage 6) ----------
  function updateColorMarks() {
    const diff = changedKeys(state.control, B(), COLORS.flatMap(colorKeys));
    for (const c of COLORS) {
      const on = colorKeys(c).some((k) => diff.has(k));
      setChanged(dotBtns[c], on);
      if (c === selColor) colorReset.disabled = !on;
    }
  }
  function resetColor(color) {
    if (!resetKeys(state.control, B(), colorKeys(color)).size) return;
    syncAll();
    onChange(false);
  }

  function selectColor(color) {
    selColor = color;
    i18nSet(cname, "text", cap(color));
    for (const c of COLORS) dotBtns[c].classList.toggle("sel", c === color);
    // the sliders rebind through the selColor closure; the track is the gradient of the selected color
    for (let i = 0; i < 3; i++) colorInputs[i].style.setProperty("--track", TRACKS[i](HUES[color]));
    for (const s of colorSyncs) s();
    updateColorMarks();
  }

  function setMode(next) {
    colorMode = next;
    btnHsl.classList.toggle("active", !next);
    btnColor.classList.toggle("active", next);
    bodyHsl.hidden = next;
    bodyColor.hidden = !next;
  }
  btnHsl.addEventListener("click", () => setMode(false));
  btnColor.addEventListener("click", () => setMode(true));

  selectColor("red");
  setTab("All");
  setMode(true);          // UI-2: Color mode by default (color dots)

  function sync() { syncAll(); }

  sync();
  return { sync, setMode, selectColor, setTab, resetColor };
}
