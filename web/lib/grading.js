// Lightroom-style Color Grading (UI-2 package, spec/color-grading/ref.png).
// HSL / Color toggle group (first): HSL — Hue/Saturation/Luminance of the selected zone;
// Color — a single color wheel of the selected zone (dragging sets Hue and Saturation),
// below it a "Hue … Sat …" readout and a Luminance slider. Under the zone buttons — a window
// previewing the resulting color (Hue + Saturation at the zone's lightness). Blending and
// Balance are shared NP3 fields, visible in both modes below the mode bodies.
// The Saturation/Luminance gradients are tinted with the selected Hue: editing Hue repaints the tracks.
// The NP3 key does not change: grade[zone] = [hue, chroma, brightness]; Chroma is shown
// as Saturation (the wheel works with 0..100, negative values are available in HSL).
// The Point Color tab is not implemented and not offered.
import { t, i18nSet } from "./i18n.js";
import { ZONES } from "./np3.js";
import { neutralControl, zoneKeys, changedKeys, resetKeys } from "./baseline.js";
import { markButton, resetButton, setChanged } from "./mark.js";
import { onDoubleTap } from "./touch.js";

const ZLABEL = { shadows: "Shadows", midtone: "Midtones", highlights: "Highlights" };
// gradient and preview lightness by zone (shadows darker, highlights lighter)
const ZONE_L = { shadows: 35, midtone: 55, highlights: 72 };
const MODE_HSL = "HSL";
const MODE_COLOR = "Color";

const CSS = `
.gr-adjust { display: flex; gap: 2px; justify-content: center; margin: 4px 0 2px; }
.gr-preview { width: 100%; height: 42px; border-radius: 4px; border: 1px solid var(--line);
  margin: 4px 0 6px; box-sizing: border-box; }
.gr-wheel { width: 140px; margin: 4px auto 0; }
.gr-disc { position: relative; width: 140px; height: 140px; border-radius: 50%;
  cursor: crosshair; touch-action: none; border: 1px solid var(--line);
  background: conic-gradient(from 0deg, hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%),
    hsl(180,100%,50%), hsl(240,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%)); }
.gr-disc::after { content: ""; position: absolute; inset: 0; border-radius: 50%;
  background: radial-gradient(circle, rgba(150,150,150,.95) 0%, rgba(150,150,150,0) 70%); }
.gr-dot { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px;
  border-radius: 50%; background: #fff; border: 1px solid #000; pointer-events: none; z-index: 1; }
.gr-nums { display: flex; gap: 10px; justify-content: center; margin: 6px 0 2px; }
.gr-nums label { display: flex; gap: 4px; align-items: center; color: var(--dim); font-size: 12px; }
.gr-nums input.val { width: 52px; background: #2c2c2c; border: 1px solid var(--line);
  border-radius: 4px; color: var(--text); padding: 2px 4px; font: inherit;
  font-variant-numeric: tabular-nums; -moz-appearance: textfield; appearance: textfield; }
.gr-divider { border-top: 1px solid var(--line); margin: 12px 0 8px; }
.gr-zreset { display: flex; justify-content: flex-end; margin: 0 0 2px; }
`;

const hsl = (h, s, l) => `hsl(${((h % 360) + 360) % 360},${s}%,${l}%)`;
// Grading Hue — absolute hue 0..359: the full spectrum, muted
const hueTrack = (l) =>
  `linear-gradient(90deg, ${[0, 60, 120, 180, 240, 300, 360].map((d, i) =>
    `${hsl(d, 65, l)} ${i * 100 / 6}%`).join(", ")})`;
// Saturation/Luminance are tinted with the selected Hue (repainted when Hue is edited)
const satTrack = (l, hue) => `linear-gradient(90deg, ${hsl(0, 0, l)}, ${hsl(hue, 70, Math.min(l + 12, 72))})`;
const lumTrack = (hue) => `linear-gradient(90deg, #000, ${hsl(hue, 65, 55)}, #fff)`;

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
    opts.syncPeers?.();          // the same zone channel in the other mode
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
 * slot — #grading-slot in the "Color Grading" group; state/onChange — from app.js.
 * sync() re-reads the values from state.control (after an NP3 import / Reset).
 * getBaseline() — { control } (stage 6): resets and changed marks compare against it; a zone
 * button carries the mark while any of the zone's three fields differs, "Reset zone" resets
 * the selected zone (Blending/Balance have their own slider marks).
 */
export function createGradingView(slot, { state, onChange, panel,
                                          getBaseline = () => ({ control: neutralControl() }) }) {
  const B = () => getBaseline().control;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  slot.replaceChildren();

  const syncs = [];
  const dotPlace = [];
  const satInputs = {};      // HSL Saturation sliders: repainted by Hue
  const lumInputs = {};      // HSL and Color Luminance sliders: repainted by Hue
  // Cross-sync: the same zone fields in the HSL and Color modes (Luminance, etc.)
  // always show one state; we also repaint the tracks and the preview.
  function syncAll() {
    for (const s of syncs) s();
    for (const zone of ZONES) {
      const hue = state.control.grade[zone][0];
      satInputs[zone]?.style.setProperty("--track", satTrack(ZONE_L[zone], hue));
      lumInputs[zone]?.style.setProperty("--track", lumTrack(hue));
      lumInputs["wheel_" + zone]?.style.setProperty("--track", lumTrack(hue));
    }
    for (const p of dotPlace) p();
    updatePreview();
    updateZoneMarks();
  }

  // --- HSL / Color toggle group (first, ref spec/toggle) ---
  let colorMode = false;
  const modeRow = el("div", "tgl");
  const btnHsl = el("button", "active", t(MODE_HSL));
  btnHsl.type = "button";
  btnHsl.dataset.i18n = MODE_HSL;
  const btnColor = el("button", null, t(MODE_COLOR));
  btnColor.type = "button";
  btnColor.dataset.i18n = MODE_COLOR;
  modeRow.append(btnHsl, btnColor);

  // --- zone selection: Shadows / Midtones / Highlights (LR-style text) ---
  const adjustRow = el("div", "gr-adjust");
  const zoneBtns = {};
  let selZone = "shadows";

  // --- resulting-color preview window: HSL mode only (only there are Hue/Sat) ---
  const preview = el("div", "gr-preview");
  i18nSet(preview, "aria", "Color preview");

  // --- HSL mode: preview + Hue/Saturation/Luminance of the selected zone ---
  const bodyHsl = el("div");
  bodyHsl.id = "grading-hsl";
  bodyHsl.append(preview);
  const hslZone = {};
  for (const zone of ZONES) {
    const box = el("div");
    const l = ZONE_L[zone];
    syncs.push(slider(box, "Hue", 0, 359, 1,
      () => state.control.grade[zone][0], (v) => { state.control.grade[zone][0] = v; },
      { track: hueTrack(l), base: () => B().grade[zone][0], syncPeers: syncAll,
        onLive: () => onChange(true), onDone: () => onChange(false) }).sync);
    const sat = slider(box, "Saturation", -100, 100, 1,
      () => state.control.grade[zone][1], (v) => { state.control.grade[zone][1] = v; },
      { track: satTrack(l, 0), base: () => B().grade[zone][1], syncPeers: syncAll,
        onLive: () => onChange(true), onDone: () => onChange(false) });
    syncs.push(sat.sync);
    satInputs[zone] = sat.input;
    const lum = slider(box, "Luminance", -100, 100, 1,
      () => state.control.grade[zone][2], (v) => { state.control.grade[zone][2] = v; },
      { track: lumTrack(0), base: () => B().grade[zone][2], syncPeers: syncAll,
        onLive: () => onChange(true), onDone: () => onChange(false) });
    syncs.push(lum.sync);
    lumInputs[zone] = lum.input;
    panel.clipRow?.(`grade.${zone}.1`, sat.box);   // chroma clipping highlight
    bodyHsl.append(box);
    hslZone[zone] = box;
  }

  // --- Color mode: wheel (center) + Hue/Saturation numbers + full-width Luminance ---
  const bodyColor = el("div");
  bodyColor.id = "grading-color";
  bodyColor.hidden = true;
  const wheelZone = {};
  for (const zone of ZONES) {
    const w = el("div");                    // zone wrapper: hidden as a whole
    const wheel = el("div", "gr-wheel");
    const disc = el("div", "gr-disc");
    disc.setAttribute("role", "slider");
    const dot = el("div", "gr-dot");
    disc.append(dot);
    wheel.append(disc);
    w.append(wheel);
    // Hue/Saturation — editable numbers (the wheel does not allow precise input)
    const nums = el("div", "gr-nums");
    const hueIn = el("input", "val");
    hueIn.type = "number"; hueIn.min = 0; hueIn.max = 359; hueIn.step = 1;
    const hueLbl = el("label");
    const hueTxt = el("span", null, t("Hue"));
    hueTxt.dataset.i18n = "Hue";
    hueLbl.append(hueTxt, hueIn);
    const satIn = el("input", "val");
    satIn.type = "number"; satIn.min = 0; satIn.max = 100; satIn.step = 1;
    const satLbl = el("label");
    const satTxt = el("span", null, t("Saturation"));
    satTxt.dataset.i18n = "Saturation";
    satLbl.append(satTxt, satIn);
    nums.append(hueLbl, satLbl);
    w.append(nums);
    const lum = slider(w, "Luminance", -100, 100, 1,
      () => state.control.grade[zone][2], (v) => { state.control.grade[zone][2] = v; },
      { track: lumTrack(0), base: () => B().grade[zone][2], syncPeers: syncAll,
        onLive: () => onChange(true), onDone: () => onChange(false) });
    syncs.push(lum.sync);
    lumInputs["wheel_" + zone] = lum.input;
    bodyColor.append(w);
    wheelZone[zone] = w;

    const place = () => {
      const z = state.control.grade[zone];
      const frac = Math.max(0, Math.min(100, z[1])) / 100;
      const a = z[0] * Math.PI / 180;
      dot.style.left = `${50 + 46 * frac * Math.sin(a)}%`;
      dot.style.top = `${50 - 46 * frac * Math.cos(a)}%`;
      hueIn.value = String(z[0]);
      satIn.value = String(Math.max(0, z[1]));
      disc.setAttribute("aria-valuetext", `Hue ${z[0]}, Saturation ${z[1]}`);
    };
    dotPlace.push(place);
    place();

    // Hue/Saturation input by numbers (the wheel is for a rough aim)
    hueIn.addEventListener("change", () => {
      let v = parseInt(hueIn.value, 10);
      if (Number.isNaN(v)) { place(); return; }
      state.control.grade[zone][0] = Math.min(359, Math.max(0, v));
      syncAll();
      onChange(false);
    });
    satIn.addEventListener("change", () => {
      let v = parseInt(satIn.value, 10);
      if (Number.isNaN(v)) { place(); return; }
      state.control.grade[zone][1] = Math.min(100, Math.max(0, v));
      syncAll();
      onChange(false);
    });

    disc.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      try { disc.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
      const move = (e2) => {
        const r = disc.getBoundingClientRect();
        const dx = e2.clientX - (r.left + r.width / 2);
        const dy = e2.clientY - (r.top + r.height / 2);
        const frac = Math.min(1, Math.hypot(dx, dy) / (r.width / 2));
        const hue = ((Math.atan2(dx, -dy) * 180 / Math.PI) + 360) % 360;
        const z = state.control.grade[zone];
        z[0] = Math.round(hue);
        z[1] = Math.round(frac * 100);
        syncAll();                     // readout, dot, tracks and preview — the same state
        onChange(true);
      };
      const up = () => {
        disc.removeEventListener("pointermove", move);
        disc.removeEventListener("pointerup", up);
        disc.removeEventListener("pointercancel", up);
        onChange(false);
      };
      move(ev);                          // apply the pressed point immediately
      disc.addEventListener("pointermove", move);
      disc.addEventListener("pointerup", up);
      disc.addEventListener("pointercancel", up);
    });
  }

  // --- Blending and Balance: global NP3 fields, in both modes; separated by a divider ---
  const bodyShared = el("div", "gr-shared");
  bodyShared.append(el("div", "gr-divider"));
  syncs.push(slider(bodyShared, "Blending", 0, 100, 1,
    () => state.control.blending, (v) => { state.control.blending = v; },
    { base: () => B().blending, syncPeers: syncAll, onLive: () => onChange(true), onDone: () => onChange(false) }).sync);
  syncs.push(slider(bodyShared, "Balance", -100, 100, 1,
    () => state.control.balance, (v) => { state.control.balance = v; },
    { base: () => B().balance, syncPeers: syncAll, onLive: () => onChange(true), onDone: () => onChange(false) }).sync);

  // the selected zone's reset (outside .gr-adjust: that row holds only the zone buttons)
  const zoneResetRow = el("div", "gr-zreset");
  const zoneReset = resetButton("Reset zone", () => resetZone(selZone));
  zoneResetRow.append(zoneReset);

  slot.append(modeRow, adjustRow, zoneResetRow, bodyHsl, bodyColor, bodyShared);

  // --- view state (does not land in NP3) ---
  for (const zone of ZONES) {
    const b = el("button", "tabbtn", t(ZLABEL[zone]));
    b.type = "button";
    b.dataset.i18n = ZLABEL[zone];
    b.addEventListener("click", () => selectZone(zone));
    adjustRow.append(b);
    zoneBtns[zone] = b;
  }

  function updatePreview() {
    const z = state.control.grade[selZone];
    const sat = Math.max(0, Math.min(100, z[1]));
    preview.style.background = hsl(z[0], sat, ZONE_L[selZone]);
    i18nSet(preview, "aria", "Color preview: hue {hue}, saturation {sat}", { hue: z[0], sat });
  }

  // ---------- changed marks / reset to the baseline (stage 6) ----------
  function updateZoneMarks() {
    if (!zoneBtns[selZone]) return;          // during construction
    const diff = changedKeys(state.control, B(), ZONES.flatMap(zoneKeys));
    for (const z of ZONES) {
      const on = zoneKeys(z).some((k) => diff.has(k));
      setChanged(zoneBtns[z], on);
      if (z === selZone) zoneReset.disabled = !on;
    }
  }
  function resetZone(zone) {
    if (!resetKeys(state.control, B(), zoneKeys(zone)).size) return;
    syncAll();
    onChange(false);
  }

  function selectZone(zone) {
    selZone = zone;
    for (const z of ZONES) {
      zoneBtns[z].classList.toggle("active", z === zone);
      hslZone[z].hidden = z !== zone;
      wheelZone[z].hidden = z !== zone;
    }
    updatePreview();
    updateZoneMarks();
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

  selectZone("shadows");

  function sync() { syncAll(); }

  sync();
  return { sync, setMode, selectZone, resetZone };
}
