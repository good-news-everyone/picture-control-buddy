// Curve editor (part CD of plan section 5, spec/ui-manual-mvp.md "Curve -> Editor").
// Ownership: this file. Replaces the contents of #curve-slot in the "Curve" group.
// Model: control.curve = {raw, points} | null. Points — up to 20, integers 0..255, ordered
// by x, the endpoints pinned at x=0 and x=255. Any edit of the points recomputes the table via
// curveTable() (257 x 0..32767). Imported points/raw are preserved byte-exactly until the points
// are touched: the SVG path is built from the stored table until the first edit, after — from the points.
// Dragging: interior points butt against their neighbors (x strictly between the neighboring x,
// jumping over a neighbor is impossible); the endpoints' x does not move, only y changes.
import { t } from "./i18n.js";
import { identityCurve } from "./np3.js";
import { curveTable } from "./curve.js";
import { neutralControl, sameField, resetKeys } from "./baseline.js";
import { markButton, setChanged } from "./mark.js";

const MAX_POINTS = 20;
const SVG_NS = "http://www.w3.org/2000/svg";
const PAD = 12;                        // chart padding: tones 0..255 -> PAD..PAD+255
const TONAL = ["contrast", "highlights", "shadows", "white", "black"];
const L = {
  toggle: "Custom curve",
  note: "When the curve is used, Contrast, Highlights, Shadows, White level and Black level are disabled — you can't use both. This is an NP3 format limitation.",
  del: "Delete point",
  limit: "A curve can have at most 20 points",
  x: "x",
  y: "y",
  pt: "Point {n}",
};

const CSS = `
.ce-svg { display: block; width: 100%; height: auto; margin: 6px 0; touch-action: none; }
.ce-bg { fill: #161616; stroke: var(--line); }
.ce-hist { fill: rgba(255, 255, 255, .16); stroke: none; }
.ce-id { stroke: #4a4a4a; stroke-dasharray: 4 4; }
.ce-curve { fill: none; stroke: var(--accent); stroke-width: 1.5; }
.ce-pt { fill: #2c2c2c; stroke: var(--accent); stroke-width: 1.5; cursor: grab; }
.ce-pt.sel { fill: var(--accent); }
.ce-pt:focus { outline: none; stroke: var(--ok); }
/* touch hit circles (r = 22 screen px, set from the SVG scale): they take pointer events only
   while the last pointer was a finger or a pen, so the mouse keeps the exact desktop behavior */
.ce-hit { fill: transparent; stroke: none; pointer-events: none; }
.ce-svg.touch .ce-hit { pointer-events: all; }
.ce-ctl { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 4px 0; }
.ce-ctl label { display: flex; gap: 4px; align-items: center; color: var(--dim); }
/* x/y — the same value inputs as the sliders: transparent until focused */
.ce-ctl input[type="number"] { width: 56px; font: inherit; color: var(--dim); text-align: right;
  background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 1px 4px;
  font-variant-numeric: tabular-nums; -moz-appearance: textfield; appearance: textfield; }
.ce-ctl input[type="number"]:focus { border-color: var(--line); color: var(--text); outline: none; }
/* Delete point: no fill and no border, only an underline, pushed maximally right */
.ce-del { margin-left: auto; border: 0; background: transparent; color: var(--dim); padding: 2px 0;
  text-decoration: underline; text-underline-offset: 3px; }
.ce-del:hover { color: var(--text); border-color: transparent; }
.ce-del:disabled { opacity: .35; cursor: not-allowed; }
.ce-note { margin: 4px 0; }
.ce-toggle { display: flex; gap: 6px; align-items: center; margin: 2px 0; user-select: none; }
.ce-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
`;

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// getBaseline() — { control, fitted } (stage 6, web/lib/baseline.js): the curve tool has one
// changed mark for the whole curve; activating it resets the curve to the baseline.
// chartSlot (spec/ui-mobile-plan.md §2.9): when given (the mobile page), the SVG lives there
// and the controls stay in `slot`.
export function createCurveEditor(slot, { state, onChange, panel, histogram = null, chartSlot = null,
                                          getBaseline = () => ({ control: neutralControl() }) }) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  slot.replaceChildren();
  slot.classList.remove("hint");

  // ---------- DOM ----------
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  const note = document.createElement("div");
  note.className = "hint ce-note";
  note.dataset.i18n = L.note;
  note.textContent = t(L.note);   // always visible: a format limitation, not a state
  const label = document.createElement("label");
  label.className = "ce-toggle";
  const labelTxt = document.createElement("span");
  labelTxt.dataset.i18n = L.toggle;
  labelTxt.textContent = t(L.toggle);
  label.append(toggle, labelTxt);
  const head = document.createElement("div");
  head.className = "ce-head";
  const mark = markButton("Custom curve", () => resetCurve());
  head.append(label, mark);

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${PAD * 2 + 255} ${PAD * 2 + 255}`);
  svg.classList.add("ce-svg");
  const el = (name, attrs = {}) => {
    const e = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  const bg = el("rect", { class: "ce-bg", x: PAD, y: PAD, width: 255, height: 255 });
  const histPath = el("path", { class: "ce-hist" });   // backdrop: the neutral luma histogram
  const idLine = el("line", { class: "ce-id", x1: PAD, y1: PAD + 255, x2: PAD + 255, y2: PAD });
  const curvePath = el("path", { class: "ce-curve" });
  const gHit = el("g");   // invisible touch hit circles, behind the visible points
  const gPts = el("g");
  svg.append(bg, histPath, idLine, curvePath, gHit, gPts);

  const ctl = document.createElement("div");
  ctl.className = "ce-ctl";
  const xIn = document.createElement("input");
  xIn.type = "number"; xIn.min = 0; xIn.max = 255; xIn.step = 1; xIn.disabled = true;
  const yIn = document.createElement("input");
  yIn.type = "number"; yIn.min = 0; yIn.max = 255; yIn.step = 1; yIn.disabled = true;
  const xLbl = document.createElement("label");
  const xTxt = document.createElement("span"); xTxt.dataset.i18n = L.x; xTxt.textContent = t(L.x);
  xLbl.append(xTxt, xIn);
  const yLbl = document.createElement("label");
  const yTxt = document.createElement("span"); yTxt.dataset.i18n = L.y; yTxt.textContent = t(L.y);
  yLbl.append(yTxt, yIn);
  const delBtn = document.createElement("button");
  delBtn.type = "button"; delBtn.disabled = true;
  delBtn.className = "ce-del";
  delBtn.dataset.i18n = L.del; delBtn.textContent = t(L.del);
  ctl.append(xLbl, yLbl, delBtn);
  const limitNote = document.createElement("div");
  limitNote.className = "hint ce-note";
  limitNote.dataset.i18n = L.limit;
  limitNote.classList.add("ce-limit");
  limitNote.hidden = true;
  limitNote.textContent = t(L.limit);

  if (chartSlot) { slot.append(head, note, ctl, limitNote); chartSlot.append(svg); }
  else slot.append(head, note, svg, ctl, limitNote);

  // ---------- editor state ----------
  let points = [];       // working copy of control.curve.points
  let sel = -1;
  let circles = [];
  let hits = [];

  // ---------- drawing ----------
  // The path always follows control.curve.raw: until the first edit it is the imported table
  // as is, after — recomputed from the points (commit() assigns curveTable(points)).
  function drawPath() {
    const c = state.control.curve;
    if (!c) { curvePath.setAttribute("d", ""); return; }
    let d = "";
    for (let i = 0; i < c.raw.length; i++) {
      const x = PAD + i * 255 / 256;
      const y = PAD + 255 - c.raw[i] * 255 / 32767;
      d += `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    curvePath.setAttribute("d", d);
  }

  // the hit circle radius in SVG units: 22 screen px at the current scale of the chart
  function hitR() {
    const m = svg.getScreenCTM();
    const s = m ? Math.hypot(m.a, m.b) : 0;
    return s > 0.05 ? 22 / s : 22;
  }

  function place(circle, i) {
    const [x, y] = points[i];
    circle.setAttribute("cx", PAD + x);
    circle.setAttribute("cy", PAD + 255 - y);
    circle.setAttribute("aria-label", t(L.pt, { n: i + 1 }));
    hits[i]?.setAttribute("cx", PAD + x);
    hits[i]?.setAttribute("cy", PAD + 255 - y);
  }

  function drawPoints() {
    gPts.replaceChildren();
    gHit.replaceChildren();
    const r = hitR();
    hits = points.map((_, i) => {
      const h = el("circle", { class: "ce-hit", r });
      h.dataset.i = i;
      h.addEventListener("pointerdown", onPointDown);
      gHit.append(h);
      return h;
    });
    circles = points.map((_, i) => {
      const c = el("circle", { class: "ce-pt", r: 5, tabindex: 0 });
      c.dataset.i = i;
      place(c, i);
      c.addEventListener("pointerdown", onPointDown);
      c.addEventListener("keydown", onPointKey);
      c.addEventListener("keyup", onPointKeyUp);
      c.addEventListener("click", (ev) => { ev.stopPropagation(); select(i); });
      gPts.append(c);
      return c;
    });
    markSel();
  }
  // the chart is scaled by CSS (a square over the photo on mobile.html): keep the hit circles at 22 screen px
  if (typeof ResizeObserver === "function")
    new ResizeObserver(() => { const r = hitR(); for (const h of hits) h.setAttribute("r", r); }).observe(svg);
  // hit circles are active only for a finger or a pen; the last pointer type decides
  svg.classList.toggle("touch", !!window.matchMedia?.("(pointer: coarse)").matches);
  window.addEventListener("pointerdown", (ev) => svg.classList.toggle("touch", ev.pointerType !== "mouse"), true);

  function markSel() {
    circles.forEach((c, j) => c.classList.toggle("sel", j === sel));
    const on = state.control.curve !== null;
    const has = sel >= 0 && on;
    const endpoint = has && (sel === 0 || sel === points.length - 1);
    xIn.disabled = !has || endpoint;
    yIn.disabled = !has;
    delBtn.disabled = !has || endpoint;
    if (has) { xIn.value = points[sel][0]; yIn.value = points[sel][1]; }
    else { xIn.value = ""; yIn.value = ""; }
  }

  function redraw() { drawPath(); drawPoints(); }

  // The source frame's luma histogram (neutral without tools) under the curve —
  // drawn whenever a frame is present; the X axis matches the curve's input tone.
  function drawHist() {
    const h = histogram ? histogram() : null;
    if (!h) { histPath.setAttribute("d", ""); return; }
    let d = `M${PAD} ${PAD + 255}`;
    for (let i = 0; i < 256; i++) {
      const x = PAD + (i + 0.5) * 255 / 256;
      const y = PAD + 255 - h[i] * 235;      // peak = 1 -> height 235, 20 px margin
      d += ` L${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    d += ` L${PAD + 255} ${PAD + 255} Z`;
    histPath.setAttribute("d", d);
  }

  // ---------- geometry ----------
  function toTone(ev) {
    const m = svg.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
    return [p.x - PAD, 255 - (p.y - PAD)];
  }

  // Common movement clamp: endpoint move in y only; interior points — strictly between
  // neighbors (a jump is impossible). Neighboring x are at least 2 apart, so the
  // valid range is never empty.
  function applyMove(i, tx, ty) {
    const y = clamp(Math.round(ty), 0, 255);
    let x;
    if (i === 0) x = 0;
    else if (i === points.length - 1) x = 255;
    else x = clamp(Math.round(tx), points[i - 1][0] + 1, points[i + 1][0] - 1);
    if (points[i][0] === x && points[i][1] === y) return false;
    points[i] = [x, y];
    return true;
  }

  function commit(live) {
    state.control.curve = curveTable(points);
    drawPath();
    updateMark();
    onChange(live);
  }

  function select(i) {
    sel = i;
    markSel();
  }

  // ---------- interaction ----------
  function onPointDown(ev) {
    if (!state.control.curve) return;
    ev.preventDefault();
    ev.stopPropagation();
    const circle = ev.currentTarget;          // the visible point or its hit circle
    const i = Number(circle.dataset.i);
    select(i);
    // Synthetic events in tests do not provide an active pointer — fine:
    // the handlers below are bound to the circle itself, capture is not required.
    try { circle.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
    const move = (e2) => {
      const p = toTone(e2);
      if (!p) return;
      if (applyMove(i, p[0], p[1])) {
        commit(true);
        place(circles[i], i);
        markSel();
      }
    };
    const up = () => {
      circle.removeEventListener("pointermove", move);
      circle.removeEventListener("pointerup", up);
      circle.removeEventListener("pointercancel", up);
      onChange(false);
    };
    circle.addEventListener("pointermove", move);
    circle.addEventListener("pointerup", up);
    circle.addEventListener("pointercancel", up);
  }

  function onPointKey(ev) {
    if (!state.control.curve) return;
    const step = ev.shiftKey ? 10 : 1;
    let dx = 0, dy = 0;
    if (ev.key === "ArrowLeft") dx = -step;
    else if (ev.key === "ArrowRight") dx = step;
    else if (ev.key === "ArrowUp") dy = step;
    else if (ev.key === "ArrowDown") dy = -step;
    else return;
    ev.preventDefault();
    const circle = ev.currentTarget;
    const i = Number(circle.dataset.i);
    select(i);
    if (applyMove(i, points[i][0] + dx, points[i][1] + dy)) {
      commit(true);
      place(circle, i);
      markSel();
    }
  }

  function onPointKeyUp(ev) {
    if (ev.key.startsWith("Arrow")) onChange(false);
  }

  function addPoint(x, y) {
    if (points.length >= MAX_POINTS) {
      limitNote.hidden = false;
      clearTimeout(addPoint.timer);
      addPoint.timer = setTimeout(() => { limitNote.hidden = true; }, 2000);
      return;
    }
    if (points.some(p => p[0] === x)) {
      select(points.findIndex(p => p[0] === x));
      return;
    }
    points.push([x, y]);
    points.sort((a, b) => a[0] - b[0]);
    drawPoints();
    select(points.findIndex(p => p[0] === x));
    commit(false);
  }

  bg.addEventListener("dblclick", (ev) => {
    if (!state.control.curve) return;
    const p = toTone(ev);
    if (!p) return;
    addPoint(clamp(Math.round(p[0]), 0, 255), clamp(Math.round(p[1]), 0, 255));
  });
  // Touch: a tap on an empty spot adds a point (the mouse keeps dblclick above). A tap is a pointerup of
  // the same finger/pen within 10 px of its pointerdown; a pointerdown on a point never starts one.
  let tap = null;
  svg.addEventListener("pointerdown", (ev) => {
    // the histogram, the diagonal and the curve line lie over the background: for a finger they are
    // all "an empty spot" (only a point or its hit circle is not)
    const onPoint = ev.target.classList?.contains("ce-pt") || ev.target.classList?.contains("ce-hit");
    if (ev.target === svg || ev.target === bg) select(-1);
    tap = ev.pointerType !== "mouse" && !onPoint ? { id: ev.pointerId, x: ev.clientX, y: ev.clientY } : null;
  });
  svg.addEventListener("pointerup", (ev) => {
    const t0 = tap;
    tap = null;
    if (!t0 || ev.pointerId !== t0.id || !state.control.curve) return;
    if (Math.hypot(ev.clientX - t0.x, ev.clientY - t0.y) > 10) return;
    const p = toTone(ev);
    if (!p) return;
    addPoint(clamp(Math.round(p[0]), 0, 255), clamp(Math.round(p[1]), 0, 255));
  });
  svg.addEventListener("pointercancel", () => { tap = null; });

  xIn.addEventListener("change", () => {
    if (sel <= 0 || sel >= points.length - 1) return;
    const v = parseInt(xIn.value, 10);
    if (Number.isNaN(v)) { markSel(); return; }
    const lo = points[sel - 1][0] + 1, hi = points[sel + 1][0] - 1;
    if (lo > hi) { markSel(); return; }
    const p = [clamp(v, lo, hi), points[sel][1]];
    points.splice(sel, 1);
    points.push(p);
    points.sort((a, b) => a[0] - b[0]);
    drawPoints();
    select(points.findIndex(q => q[0] === p[0]));
    commit(false);
  });
  yIn.addEventListener("change", () => {
    if (sel < 0) return;
    const v = parseInt(yIn.value, 10);
    if (Number.isNaN(v)) { markSel(); return; }
    points[sel] = [points[sel][0], clamp(v, 0, 255)];
    place(circles[sel], sel);
    commit(false);
    markSel();
  });
  delBtn.addEventListener("click", () => {
    if (sel <= 0 || sel >= points.length - 1) return;
    points.splice(sel, 1);
    drawPoints();
    select(Math.min(sel, points.length - 2));
    commit(false);
  });

  // ---------- curve on/off ----------
  toggle.addEventListener("change", () => {
    if (toggle.checked) {
      if (!state.control.curve) state.control.curve = identityCurve();
    } else {
      state.control.curve = null;
      // Per spec, turning off unlocks the five tonal sliders with zero values.
      for (const f of TONAL) state.control[f] = 0;
    }
    panel.setTonalLocked(toggle.checked);
    panel.refresh();          // the sliders re-read control; sync() below updates the editor
    sync();
    onChange(false);
  });

  // ---------- the changed mark / reset to the baseline (stage 6) ----------
  function updateMark() {
    setChanged(head, !sameField(state.control, getBaseline().control, "curve"));
  }
  function resetCurve() {
    if (!resetKeys(state.control, getBaseline().control, ["curve"]).size) return;
    panel.refresh();          // the wrapped refresh also re-syncs this editor
    sync();
    onChange(false);
  }

  /** Re-reads the editor from state.control (after an NP3 import / Reset / a new RAW). */
  function sync() {
    const on = state.control.curve !== null;
    if (toggle.checked !== on) toggle.checked = on;
    panel.setTonalLocked(on);
    points = on ? state.control.curve.points.map(p => [...p]) : [];
    sel = -1;
    redraw();
    drawHist();
    updateMark();
  }

  sync();
  // addPoint — for tests; chart — the SVG (mobile.js, tests)
  return { sync, addPoint, updateMark, resetCurve, chart: svg };
}
