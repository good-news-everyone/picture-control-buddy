// The report panel (stage 5B, spec/ui.md "Report"): renders the report DTO of the
// selected pair (state.pairs[].report, spec/web-schemas.md §4.3, computed by
// web/lib/report-worker.js) and the aggregate over the compared pairs
// (state.reportAggregate) — the summary, the sortable color-match table with the
// target/render swatches, the per-pixel error map with the sequential/diverging
// legends and the NP3 parameters (one value column: the value at the current strength,
// the one Download NP3 writes) with the square curve thumbnail over the neutral luma
// histogram (no JSON download — spec/ui.md decision #8). Every section is a collapsible
// details.grp, as the editor groups (decision #13). Pure presentation: every number comes from web/lib/analyze.js / the
// report worker; this module owns no color science. The same component shows on the
// Compare screen and beside the manual editor (spec/ui.md steps 2 and 3.1); a row
// click highlights the group's pixels on the compare image through the onHighlight
// callback (the stage-4 geometry: one report pixel = one 3×3 block of the working
// grid), the error map can be overlaid on the compare image through onMapOverlay.
import { t } from "./i18n.js";
import { labToSrgb } from "./color.js";
import { GROUPS } from "./analyze.js";
import { COLORS, ZONES } from "./np3.js";


// ---------- the error-map scales (spec/ui.md: dE sequential with 0/2/5/10+, dL/dC/dh diverging) ----------
// Sequential dE: dark blue -> light blue -> yellow -> red; above 10 stays at the last stop.
const SEQ_STOPS = [[0, [43, 62, 138]], [2, [71, 139, 204]], [5, [248, 214, 92]], [10, [214, 46, 38]]];
const DIV_NEG = [33, 102, 172], DIV_ZERO = [178, 178, 178], DIV_POS = [214, 46, 38];
// The separate neutral colors (spec/ui.md): overexposed and unaligned pixels.
const CLIP_RGB = [154, 154, 154], INVALID_RGB = [58, 58, 58];
const MAP_MODES = {
  dE: { diverging: false, max: 10 },
  dL: { diverging: true, max: 20 },
  dC: { diverging: true, max: 20 },
  dh: { diverging: true, max: 180 },
};

function seqColor(v) {
  if (v <= SEQ_STOPS[0][0]) return SEQ_STOPS[0][1];
  for (let i = 1; i < SEQ_STOPS.length; i++) {
    if (v <= SEQ_STOPS[i][0]) {
      const [v0, c0] = SEQ_STOPS[i - 1], [v1, c1] = SEQ_STOPS[i];
      const k = (v - v0) / (v1 - v0);
      return c0.map((c, j) => Math.round(c + (c1[j] - c) * k));
    }
  }
  return SEQ_STOPS[SEQ_STOPS.length - 1][1];
}

function divColor(v, max) {
  const k = Math.min(1, Math.max(-1, v / max));
  const [from, to] = k < 0 ? [DIV_ZERO, DIV_NEG] : [DIV_ZERO, DIV_POS];
  const a = Math.abs(k);
  return from.map((c, j) => Math.round(c + (to[j] - c) * a));
}

function mapColor(mode, v) {
  const cfg = MAP_MODES[mode];
  return cfg.diverging ? divColor(v, cfg.max) : seqColor(v);
}

function paintMapPixels(im, mode, data, clipMask, validMask) {
  const n = data.length;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    let rgb = null;
    if (validMask && validMask.length === n && !validMask[i]) rgb = INVALID_RGB;
    else if (clipMask && clipMask.length === n && clipMask[i]) rgb = CLIP_RGB;
    else {
      const v = data[i];
      if (Number.isNaN(v)) { im.data[o + 3] = 0; continue; }   // outside the reportMask: transparent
      rgb = mapColor(mode, v);
    }
    im.data[o] = rgb[0]; im.data[o + 1] = rgb[1]; im.data[o + 2] = rgb[2]; im.data[o + 3] = 255;
  }
}

// ---------- formatting ----------
const f2 = (v) => (typeof v === "number" && !Number.isNaN(v) ? v.toFixed(2) : "—");
const fsign = (v) => (v >= 0 ? "+" : "") + v.toFixed(2);
const meanFinite = (xs) => {
  const ok = xs.filter((v) => typeof v === "number" && !Number.isNaN(v));
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : NaN;
};

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("data-")) el.dataset[k.slice(5)] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids);
  return el;
}

// The §3.3 parameter groups (the same fields as the manual tools): label + a control path.
const PARAM_SECTIONS = [
  { title: "Basic", rows: [
    ["Saturation", "saturation"], ["Contrast", "contrast"], ["Highlights", "highlights"],
    ["Shadows", "shadows"], ["White level", "white"], ["Black level", "black"]] },
  { title: "Details", rows: [
    ["Sharpening", "sharpening"], ["Mid-range sharpening", "mid_sharpening"], ["Clarity", "clarity"]] },
  { title: "Color Blender", rows: COLORS.flatMap((c) =>
    ["Hue", "Chroma", "Brightness"].map((a, i) =>
      [`${c[0].toUpperCase()}${c.slice(1)} ${a}`, `blender.${c}.${i}`])) },
  { title: "Color Grading", rows: ZONES.flatMap((z) =>
    ["Hue", "Chroma", "Brightness"].map((a, i) =>
      [`${z === "midtone" ? "Midtones" : z[0].toUpperCase() + z.slice(1)} ${a}`, `grade.${z}.${i}`]))
    .concat([["Blending", "blending"], ["Balance", "balance"]]) },
];

function valueAt(ctl, path) {
  const parts = path.split(".");
  let v = ctl;
  for (const p of parts) v = Array.isArray(v) ? v[Number(p)] : v[p];
  return v;
}

// Clipped fields at strength > 100% (web/lib/strength.js semantics, the panels.js rule):
// the scaled value would leave the NP3 range.
function clippedPaths(base, strength) {
  const k = strength / 100;
  const out = new Set();
  const lim = (key, v, lo, hi) => { if (v * k < lo - 0.5 || v * k > hi + 0.5) out.add(key); };
  for (const s of ["saturation", "contrast", "highlights", "shadows", "white", "black"])
    lim(s, base[s], -100, 100);
  for (const c of COLORS) {
    lim(`blender.${c}.1`, base.blender[c][1], -100, 100);
    lim(`blender.${c}.2`, base.blender[c][2], -100, 100);
  }
  for (const z of ZONES) {
    lim(`grade.${z}.1`, base.grade[z][1], 0, 100);
    lim(`grade.${z}.2`, base.grade[z][2], -100, 100);
  }
  return out;
}

/**
 * state — the session contract (pairs[].report, reportAggregate, selectedPairId,
 * selectedVersionId); onHighlight(labels, groupIndex | null) — the row-click region
 * highlight on the compare image; onMapOverlay(canvas | null) — the error-map overlay.
 */
export function createReport({ state, onHighlight = null, onMapOverlay = null }) {
  const root = document.getElementById("report");

  // ---------- the head: the scope switch and the updating badge ----------
  const scopeTgl = h("div", { class: "tgl", id: "rep-scope", hidden: "" },
    h("button", { type: "button", "data-scope": "pair" }, t("This pair")),
    h("button", { type: "button", "data-scope": "aggregate" }, t("All pairs")));
  const updating = h("span", { id: "rep-updating", hidden: "" }, t("Updating…"));
  const head = h("div", { id: "rep-head" }, scopeTgl, updating);

  // ---------- the body ----------
  const empty = h("div", { id: "rep-empty", hidden: "" },
    t("Fit a profile to see the report."));
  const summaryDl = h("dl", { class: "rep-kv" },
    h("dt", {}, t("Strength")), h("dd", { id: "rep-strength" }, "—"),
    h("dt", {}, t("Render vs target")), h("dd", { id: "rep-render-de" }, "—"),
    h("dt", {}, t("Neutral vs target")), h("dd", { id: "rep-neutral-de" }, "—"),
    h("dt", {}, t("Bin mean")), h("dd", { id: "rep-bin-mean" }, "—"),
    h("dt", { id: "rep-delta-dt", hidden: "" }, t("Vs fitted")),
    h("dd", { id: "rep-delta", hidden: "" }, "—"));
  const tableEl = h("table", { id: "rep-table" });
  const mapModes = h("div", { class: "tgl", id: "rep-map-modes" },
    ...Object.keys(MAP_MODES).map((m) => h("button", { type: "button", "data-mode": m }, m)));
  const mapCanvas = h("canvas", { id: "rep-map", width: 8, height: 8 });
  const legendBar = h("canvas", { id: "rep-legend-bar", width: 140, height: 8 });
  const legendTicks = h("div", { id: "rep-legend-ticks" });
  const overlayChk = h("input", { type: "checkbox", id: "rep-overlay" });
  const overlayBox = h("label", { id: "rep-overlay-box" }, overlayChk, t("Overlay on the image"));
  const clipChip = h("span", { class: "rep-chip" }, h("i", { style: `background:rgb(${CLIP_RGB.join(",")})` }),
    t("Overexposed"));
  const invalidChip = h("span", { class: "rep-chip" }, h("i", { style: `background:rgb(${INVALID_RGB.join(",")})` }),
    t("Unaligned"));
  const mapSection = h("div", { id: "rep-map-section" },
    mapModes, mapCanvas,
    h("div", { class: "rep-legend" }, legendBar, legendTicks),
    h("div", { class: "rep-legend" }, clipChip, invalidChip),
    overlayBox);
  const paramsEl = h("div", { id: "rep-params" });
  const curveEl = h("div", { id: "rep-curve" });
  // every section is a collapsible group, open by default (spec/ui.md decision #13)
  const grp = (key, label, ...kids) => {
    const d = h("details", { class: "grp rep-grp", "data-sec": key },
      h("summary", {}, h("span", { "data-i18n": label }, t(label))), ...kids);
    d.open = true;
    return d;
  };
  const mapGrp = grp("map", "Error map", mapSection);
  const body = h("div", { id: "rep-body" }, empty,
    grp("summary", "Summary", summaryDl),
    grp("table", "Color match", tableEl),
    mapGrp,
    grp("params", "NP3 parameters", paramsEl, curveEl));

  root.replaceChildren(head, body);

  // ---------- state ----------
  let scope = "pair";                  // "pair" | "aggregate"
  let sort = { key: "share", dir: -1 };
  let mapMode = "dE";
  let hlGroup = null;                  // the highlighted GROUPS index
  let lastLabels = null;               // the labels the highlight belongs to

  const pairReports = () => state.pairs.filter((p) => p.report);
  const currentPair = () => {
    const sel = state.pairs.find((p) => p.id === state.selectedPairId && p.report);
    return sel ?? pairReports()[0] ?? null;
  };

  // ---------- the color-match table ----------
  const COLS = [
    ["group", t("Group")], ["share", t("Share")], ["target", t("Color")], ["dE", "dE"], ["dL", "dL"], ["dC", "dC"], ["dh", "dh"],
  ];
  const colValue = {
    group: (r) => r.group,
    share: (r) => r.share,
    target: (r) => r.targetLab[0],
    dE: (r) => r.dE, dL: (r) => r.dL, dC: (r) => r.dC,
    dh: (r) => (r.dh == null ? -Infinity : r.dh),
  };

  // the target and render swatches share one cell (target left, render right) so the
  // table fits the panel width without a horizontal scroll
  function swatch(lab, what) {
    const d = h("div", { class: "rep-sw" });
    const out = labToSrgb(Float64Array.from(lab));
    const c = [0, 1, 2].map((k) => Math.round(255 * Math.min(1, Math.max(0, out[k]))));
    d.style.background = `rgb(${c.join(",")})`;
    d.title = `${t(what)}: L ${f2(lab[0])}, a ${f2(lab[1])}, b ${f2(lab[2])}`;
    return d;
  }

  function renderTable(rows) {
    const thead = h("thead", {});
    const tr = h("tr", {});
    for (const [key, label] of COLS) {
      const active = sort.key === key;
      tr.append(h("th", { "data-key": key, class: key === "group" || key === "share" ? "tg" : "" },
        label + (active ? (sort.dir > 0 ? " ↑" : " ↓") : "")));
    }
    thead.append(tr);
    const sorted = [...rows].sort((a, b) => {
      const va = colValue[sort.key](a), vb = colValue[sort.key](b);
      const d = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      return d * sort.dir;
    });
    const tbody = h("tbody", {});
    for (const r of sorted) {
      const gi = GROUPS.indexOf(r.group);
      const row = h("tr", { "data-group": r.group, class: gi === hlGroup ? "sel" : "" },
        h("td", { class: "tg" }, r.group),
        h("td", {}, `${(100 * r.share).toFixed(1)}%`),
        h("td", { class: "sw" }, swatch(r.targetLab, "Target"), swatch(r.renderLab, "Render")),
        h("td", {}, f2(r.dE)), h("td", {}, fsign(r.dL)), h("td", {}, fsign(r.dC)),
        h("td", {}, r.dh == null ? "—" : `${r.dh.toFixed(1)}°`));
      row.addEventListener("click", () => {
        hlGroup = hlGroup === gi ? null : gi;      // a second click clears
        onHighlight?.(hlGroup == null ? null : lastLabels, hlGroup);
        for (const tr2 of tbody.children)
          tr2.classList.toggle("sel", GROUPS.indexOf(tr2.dataset.group) === hlGroup);
      });
      tbody.append(row);
    }
    tableEl.replaceChildren(thead, tbody);
  }

  tableEl.addEventListener("click", (e) => {
    const th = e.target.closest("th");
    if (!th) return;
    const key = th.dataset.key;
    if (sort.key === key) sort.dir = -sort.dir;
    else sort = { key, dir: key === "group" || key === "share" ? 1 : -1 };
    refresh();
  });

  // ---------- the error map ----------
  function paintLegend() {
    const cfg = MAP_MODES[mapMode];
    const ctx = legendBar.getContext("2d");
    const im = ctx.createImageData(legendBar.width, legendBar.height);
    for (let x = 0; x < legendBar.width; x++) {
      const v = cfg.diverging ? (x / (legendBar.width - 1) * 2 - 1) * cfg.max
                              : x / (legendBar.width - 1) * cfg.max;
      const rgb = mapColor(mapMode, v);
      for (let y = 0; y < legendBar.height; y++) {
        const o = (y * legendBar.width + x) * 4;
        im.data[o] = rgb[0]; im.data[o + 1] = rgb[1]; im.data[o + 2] = rgb[2]; im.data[o + 3] = 255;
      }
    }
    ctx.putImageData(im, 0, 0);
    const ticks = cfg.diverging
      ? [`−${cfg.max}`, "0", `+${cfg.max}`]
      : ["0", "2", "5", "10+"];
    legendTicks.replaceChildren(...ticks.map((s) => h("span", {}, s)));
  }

  function paintMapSection(rep, agg) {
    // the map is per-pixel: only for a single pair (in the aggregate scope it is hidden)
    if (agg || !rep?.maps) {
      mapGrp.hidden = true;
      if (overlayChk.checked) { overlayChk.checked = false; onMapOverlay?.(null); }
      return;
    }
    mapGrp.hidden = false;
    const p = currentPair();
    const masks = p?.prepared?.masks ?? {};
    mapCanvas.width = rep.w3;
    mapCanvas.height = rep.h3;
    const ctx = mapCanvas.getContext("2d");
    const im = ctx.createImageData(rep.w3, rep.h3);
    paintMapPixels(im, mapMode, rep.maps[mapMode], masks.clipMask, masks.validMask);
    ctx.putImageData(im, 0, 0);
    paintLegend();
    if (overlayChk.checked) onMapOverlay?.(mapCanvas);
  }

  for (const btn of mapModes.querySelectorAll("button")) {
    btn.addEventListener("click", () => {
      mapMode = btn.dataset.mode;
      for (const b of mapModes.querySelectorAll("button"))
        b.classList.toggle("active", b === btn);
      paintMapSection(currentPair()?.report ?? null, scope === "aggregate" ? state.reportAggregate : null);
    });
  }
  mapModes.querySelector("button")?.classList.add("active");
  overlayChk.addEventListener("change", () =>
    onMapOverlay?.(overlayChk.checked ? mapCanvas : null));

  // ---------- the NP3 parameters ----------
  function renderParams(rep, agg) {
    paramsEl.replaceChildren();
    curveEl.replaceChildren();
    if (!rep?.parameters) return;
    const { base, result, deltas } = rep.parameters;
    const clipped = clippedPaths(base, rep.strength);
    // one value column: the value at the report's strength — what Download NP3 writes
    // (spec/ui.md decision #13); the profile value at 100% is in the tooltip when it differs
    for (const sec of PARAM_SECTIONS) {
      const secEl = h("div", { class: "rep-sec" }, h("div", { class: "sub" }, t(sec.title)));
      for (const [label, path] of sec.rows) {
        const bv = valueAt(base, path), rv = valueAt(result, path);
        const val = h("span", { class: "val" }, String(rv));
        if (bv !== rv) val.title = t("Profile at 100%: {value}", { value: bv });
        const row = h("div", { class: "rep-prow", "data-path": path },
          h("span", { class: "lbl" }, t(label)), val);
        if (rv === 0) row.classList.add("zero");                      // zero fields are muted
        if (clipped.has(path)) row.classList.add("clip");             // clipped at this strength
        if (deltas && typeof deltas === "object" && deltas[path] != null)
          val.append(h("span", { class: "rep-delta" }, fsign(deltas[path])));
        secEl.append(row);
      }
      paramsEl.append(secEl);
    }
    curveEl.append(h("div", { class: "sub" }, t("Curve")), curveThumb(rep, agg));
  }

  // The square curve thumbnail (spec/ui.md decision #8): 0..255 on both axes as in the curve
  // editor, the identity diagonal, the neutral's luma histogram underneath (the selected
  // pair, or the sum over the reported pairs in the "All pairs" scope; normalized to the
  // peak) and the curve result at this strength on top. With the curve off: the same square
  // with the histogram and the diagonal, and the "off" label.
  function curveThumb(rep, agg) {
    const NS = "http://www.w3.org/2000/svg";
    const PAD = 4, S = 255, W = S + 2 * PAD;
    const svgEl = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      return e;
    };
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${W}`, class: "rep-curve-svg" });
    const hist = agg?.neutralHist ?? rep?.neutralHist ?? null;
    let peak = 0;
    if (hist) for (const v of hist) if (v > peak) peak = v;
    if (peak > 0) {
      let d = `M${PAD} ${PAD + S}`;
      for (let i = 0; i < 256; i++) {
        const x = PAD + (i + 0.5) * S / 256;
        const y = PAD + S - (hist[i] / peak) * (S - 20);   // peak -> 20 px under the top
        d += ` L${x.toFixed(2)} ${y.toFixed(2)}`;
      }
      d += ` L${PAD + S} ${PAD + S} Z`;
      svg.append(svgEl("path", { d, class: "rep-hist" }));
    }
    svg.append(svgEl("line", { x1: PAD, y1: PAD + S, x2: PAD + S, y2: PAD, class: "rep-curve-diag" }));
    const { base, result } = rep.parameters;
    const curve = result?.curve ?? base?.curve;
    if (curve) {
      const n = curve.raw.length - 1;
      const pts = curve.raw.map((v, i) =>
        `${(PAD + i / n * S).toFixed(1)},${(PAD + S - (v / 32767) * S).toFixed(1)}`);
      svg.append(svgEl("polyline", { points: pts.join(" "), class: "rep-curve-line" }));
      return svg;
    }
    return h("div", { class: "rep-curve-off" }, svg, h("div", { class: "hint" }, t("off")));
  }

  // ---------- the summary ----------
  function renderSummary(rep, agg) {
    const blank = !rep && !agg;
    const reports = pairReports().map((p) => p.report);
    const s = blank ? null
      : agg
      ? { strength: rep?.strength ?? null, renderDE: agg.regionSums.all,
          neutralDE: meanFinite(reports.map((r) => r.summary.neutralDE)),
          binMean: agg.binMean,
          fittedDelta: meanFinite(reports.map((r) => r.summary.fittedDelta).filter((v) => v != null)) }
      : rep.summary;
    document.getElementById("rep-strength").textContent = s == null || s.strength == null ? "—" : `${s.strength}%`;
    document.getElementById("rep-render-de").textContent = f2(s?.renderDE);
    document.getElementById("rep-neutral-de").textContent = f2(s?.neutralDE);
    document.getElementById("rep-bin-mean").textContent = f2(s?.binMean);
    const deltaEl = document.getElementById("rep-delta");
    const deltaDt = document.getElementById("rep-delta-dt");
    const showDelta = s?.fittedDelta != null && !Number.isNaN(s.fittedDelta);
    deltaEl.hidden = !showDelta;
    deltaDt.hidden = !showDelta;
    if (showDelta) deltaEl.textContent = fsign(s.fittedDelta);
  }

  // ---------- the scope switch ----------
  for (const btn of scopeTgl.querySelectorAll("button")) {
    btn.addEventListener("click", () => { scope = btn.dataset.scope; refresh(); });
  }
  function syncScope() {
    for (const b of scopeTgl.querySelectorAll("button"))
      b.classList.toggle("active", b.dataset.scope === scope);
  }

  // ---------- refresh ----------
  function refresh() {
    const rep = currentPair()?.report ?? null;
    const reports = pairReports();
    const multi = reports.length >= 2;
    scopeTgl.hidden = !multi;
    if (!multi) scope = "pair";
    if (scope === "aggregate" && !state.reportAggregate) scope = "pair";
    syncScope();
    // the highlight belongs to the labels it was made from — a new report invalidates it
    const labels = rep?.labels ?? null;
    if (labels !== lastLabels) {
      hlGroup = null;
      lastLabels = labels;
      onHighlight?.(null);
    }
    const agg = scope === "aggregate" ? state.reportAggregate : null;
    empty.hidden = !!(rep || agg);
    renderSummary(rep, agg);
    renderTable(agg ? agg.table : (rep?.table ?? []));
    renderParams(rep, agg);
    paintMapSection(rep, agg);
  }

  function setUpdating(on) {
    updating.hidden = !on;
    body.classList.toggle("updating", on);
  }

  refresh();
  return { refresh, setUpdating,
           get scope() { return scope; } };
}
