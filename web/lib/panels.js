// The profile panel (part AB of plan section 5, spec/ui-manual-mvp-plan.md; UI-2 packages).
// Group order is strict: Profile -> Basic -> Curve -> Details -> Blender -> Grading.
// The panel always shows the base control (at 100%); strength is applied only at render
// via scaled() — here it is needed only for the clipping highlight and does not affect the name.
// Ranges and steps are the "Profile fields" table in spec/ui-manual-mvp.md.
// For CD: refresh() re-reads all fields from state.control (after an import),
// the #curve-slot and #grading-slot slots are the places for the curve and grading editors.
// UI-2: LR-style gradient tracks (spec/sliders) via --track on input.grad;
// the blender is Hue/Saturation/Luminance sections x 8 colors; the Chroma/Brightness labels
// are replaced with Saturation/Luminance (the internal NP3 names do not change).
import { t } from "./i18n.js";
import { newProfile, COLORS, ZONES } from "./np3.js";

const BASIC = [
  ["saturation", "Saturation"],
  ["contrast", "Contrast"],
  ["highlights", "Highlights"],
  ["shadows", "Shadows"],
  ["white", "White level"],
  ["black", "Black level"],
];
const DETAIL = [
  ["sharpening", "Sharpening", -3, 9, 2],
  ["mid_sharpening", "Mid-range sharpening", -5, 5, 1],
  ["clarity", "Clarity", -5, 5, 0.5],
];
const ZONE_LABEL = { shadows: "Shadows", midtone: "Midtones", highlights: "Highlights" };
// CD: the five tonal sliders are locked by the curve editor when it is enabled
const TONAL = new Set(["contrast", "highlights", "shadows", "white", "black"]);

// The global Saturation (Basic) track gradient: grey for ~the first third of the track, then
// colors with growing saturation (ref sliders/saturation.png). The other LR tracks are in
// blending.js/grading.js.
const rainbowTrack = () =>
  `linear-gradient(90deg, ${[[0, 0, 0], [20, 0, 0], [33, 12, 8], [45, 30, 22], [55, 60, 34],
    [65, 120, 45], [75, 180, 55], [85, 240, 63], [95, 300, 72], [100, 360, 80]]
    .map(([p, hue2, sat2]) => `hsl(${hue2},${sat2}%,54%) ${p}%`).join(", ")})`;

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

/**
 * roots — {scroll, foot}: the group container (scrollable) and a separate footer for Reset
 * (always pinned to the bottom of the panel); state — the contract state (the panel writes state.control);
 * onChange(live): live=true — continuous movement (the render is throttled via rAF in app.js),
 * live=false — the action is finished, the final frame.
 */
export function createPanel(roots, { state, onChange, onNameValid }) {
  const scroll = roots.scroll;
  const syncs = [];        // re-reading each field from state.control (for refresh)
  const rowsByKey = new Map();

  // A slider bound to a getter/setter in state.control.
  // opts.def — the default value: a double click on the slider resets to it.
  // The numeric value on the right is an editable input: input applies on Enter/blur.
  function slider(parent, label, min, max, step, get, set, key, opts = {}) {
    const input = h("input", { type: "range", min, max, step });
    if (opts.track) {
      input.classList.add("grad");
      input.style.setProperty("--track", opts.track);
    }
    const val = h("input", { type: "number", class: "val", min, max, step });
    const box = h("div", { class: "ctl" },
      h("div", { class: "top" }, h("span", { class: "lbl", "data-i18n": label }, t(label)), val), input);
    // Track fill up to the value: --fill in percent (styles — index.html),
    // the color/gradient can be overridden per input via --fill-color.
    const paint = () => input.style.setProperty("--fill",
      `${(100 * (parseFloat(input.value) - min) / (max - min)).toFixed(1)}%`);
    const show = (v) => { val.value = String(v); };
    const apply = (v, live) => {
      set(v); show(get()); paint(); onChange(live);
    };
    const sync = () => { const v = get(); input.value = v; show(v); paint(); };
    sync();
    input.addEventListener("input", () => apply(parseFloat(input.value), true));
    input.addEventListener("change", () => onChange(false));
    // double click — reset to the default value
    input.addEventListener("dblclick", () => {
      if (opts.def == null) return;
      input.value = opts.def;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // manual number input: clamp to the range, apply as a finished action
    val.addEventListener("change", () => {
      let v = parseFloat(val.value);
      if (Number.isNaN(v)) { show(get()); return; }
      v = Math.min(max, Math.max(min, v));
      input.value = v;
      apply(v, false);
    });
    syncs.push(sync);
    if (key) { box.dataset.key = key; rowsByKey.set(key, box); }
    parent.append(box);
    return box;
  }

  // ---------- collapsible group ----------
  function group(label, key, open = true) {
    const body = h("div");
    const d = h("details", { class: "grp", "data-group": key }, h("summary", { "data-i18n": label }, t(label)), body);
    if (open) d.open = true;
    scroll.append(d);
    return body;
  }

  // ---------- 1. Profile (the very top): name, strength, clipping ----------
  // UI-2: the result name is gone, strength does not affect the name; the NP3 NAME is the first field of the group and the panel.
  const gStrength = group("Profile", "strength");

  // --- NP3 name (the first field) ---
  const nameInput = h("input", { type: "text", maxlength: 19, spellcheck: "false", value: state.control.name });
  const nameErr = h("div", { class: "bad", id: "p-name-err", hidden: "" },
    t("Name must be 1–19 ASCII characters"));
  function syncName() { nameInput.value = state.control.name; checkName(); }
  function checkName() {
    const n = state.control.name;
    const ok = n.length >= 1 && n.length <= 19 && /^[\x00-\x7F]*$/.test(n);
    state.nameValid = ok;                       // CD blocks export by this flag
    nameErr.hidden = ok;
    nameInput.classList.toggle("bad", !ok);
    onNameValid?.(ok);
  }
  nameInput.addEventListener("input", () => {
    state.control.name = nameInput.value;
    checkName();
    // no render needed: the name does not affect pixels (plan §5, P1 — no extra renders)
  });
  syncs.push(syncName);
  // UI-2: no separate "NP3 NAME" label at the field — the name is the first field of the group
  gStrength.append(h("div", { "data-group": "name" }, nameInput, nameErr));

  // --- strength ---
  const sClip = h("div", { class: "clip-warn", hidden: "" },
    t("Some values are clipped to the NP3 range at this strength"));
  const sBox = slider(gStrength, "Strength", 0, 150, 5,
    () => state.strength, (v) => { state.strength = v; syncStrength(); },
    null, { def: 100 });
  const sRange = sBox.querySelector("input[type=range]");
  const sVal = sBox.querySelector(".val");
  function syncStrength() {
    sRange.value = state.strength;
    sVal.value = String(state.strength);
    updateClip();
  }
  gStrength.append(sClip);

  // ---------- 2. Basic (open by default) ----------
  const gBasic = group("Basic", "basic");
  for (const [field, label] of BASIC)
    slider(gBasic, label, -100, 100, 1,
      () => state.control[field], (v) => { state.control[field] = v; }, field,
      { def: 0, ...(field === "saturation" ? { track: rainbowTrack() } : {}) });   // UI-2: grey -> rainbow as in LR
  // CD: when the curve is on, the tonal sliders are locked by the curve editor;
  // the explanation lives only at the curve editor (next to the checkbox)
  function setTonalLocked(locked) {
    for (const [key, el] of rowsByKey) {
      if (!TONAL.has(key)) continue;
      // a row has two inputs: the slider and the numeric value — lock both
      for (const inp of el.querySelectorAll("input")) inp.disabled = locked;
    }
  }

  // ---------- 3. Curve (the editor's place — CD) ----------
  const gCurve = group("Curve", "curve", false);
  gCurve.append(h("div", { class: "hint", id: "curve-slot" },
    t("Curve editor — coming in the next step")));

  // ---------- 4. Details ----------
  const gDetail = group("Details", "details", false);
  for (const [field, label, min, max, def] of DETAIL)
    slider(gDetail, label, min, max, 0.25,
      () => state.control[field], (v) => { state.control[field] = v; }, field, { def });

  // ---------- 5. Color Blender (LR style — blending.js, UI-2 package) ----------
  const gBlender = group("Color Blender", "blender", false);
  gBlender.append(h("div", { id: "blending-slot" },
    t("Color Blender editor — coming in the next step")));

  // ---------- 6. Color Grading (the last one; LR style — grading.js, UI-2 package) ----------
  const gGrade = group("Color Grading", "grading", false);
  gGrade.append(h("div", { id: "grading-slot" },
    t("Color Grading editor — coming in the next step")));

  // ---------- clipping highlight at strength > 100% ----------
  // Scalable fields and their NP3 ranges: sliders ±100, grading chroma ≥ 0.
  // Blender/grading Hue, Blending, Balance and detail are not touched by strength.
  function clippedKeys() {
    const k = state.strength / 100;
    const out = new Set();
    const lim = (key, v, lo, hi) => { if (v * k < lo - 0.5 || v * k > hi + 0.5) out.add(key); };
    for (const s of ["saturation", "contrast", "highlights", "shadows", "white", "black"])
      lim(s, state.control[s], -100, 100);
    for (const c of COLORS) {
      lim(`blender.${c}.1`, state.control.blender[c][1], -100, 100);
      lim(`blender.${c}.2`, state.control.blender[c][2], -100, 100);
    }
    for (const z of ZONES) {
      lim(`grade.${z}.1`, state.control.grade[z][1], 0, 100);
      lim(`grade.${z}.2`, state.control.grade[z][2], -100, 100);
    }
    return out;
  }
  function updateClip() {
    if (state.strength <= 100) {
      sClip.hidden = true;
      for (const el of rowsByKey.values()) el.classList.remove("clip");
      return;
    }
    const keys = clippedKeys();
    sClip.hidden = keys.size === 0;
    for (const [key, el] of rowsByKey) el.classList.toggle("clip", keys.has(key));
  }

  // ---------- Reset (the very bottom of the panel) ----------
  // Neutral — the np3.Control default values, as in a new profile.
  // The name and comment are not edited by sliders and are not subject to reset.
  function resetAll() {
    const fresh = newProfile();
    for (const c of COLORS) fresh.blender[c] = [0, 0, 0];
    for (const z of ZONES) fresh.grade[z] = [0, 0, 0];
    fresh.name = state.control.name;
    fresh.comment = state.control.comment;
    Object.assign(state.control, fresh);
    state.strength = 100;
  }
  const resetBtn = h("button", { type: "button", id: "p-reset", "data-i18n": "Reset" }, t("Reset"));
  resetBtn.addEventListener("click", () => {
    resetAll();
    api.refresh();          // in app.js refresh is wrapped: it also syncs the editors
    onChange(false);
  });
  roots.foot.append(resetBtn);

  syncStrength();

  const api = {
    /** Re-reads all fields from state.control (after an NP3 import or Reset). */
    refresh() { for (const s of syncs) s(); syncStrength(); },
    updateClip,
    syncStrength,
    setTonalLocked,          // CD: locking of the five tonal sliders by the curve editor
    reset: resetAll,         // only mutates state; widget sync happens via refresh()
    /** An external editor (blending/grading) registers a row for the clipping highlight. */
    clipRow(key, rowEl) { rowsByKey.set(key, rowEl); },
  };
  return api;
}
