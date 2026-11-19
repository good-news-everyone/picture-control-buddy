// The manual-adjustment baseline (spec/ui.md "Decisions" #2, spec/ui-plan.md stage 6).
// Pure helpers — no DOM. The baseline is the control every reset returns to and every
// changed-field mark compares against:
//  - in the fitting flow (the editor entered with a selected fit version) — that immutable
//    version's control (a deep copy held by the session, never the version object itself);
//  - in standalone editing (no fitted version) — the neutral NP3 defaults (newProfile with
//    zeroed blender/grading), the manual-MVP reset behavior.
// Field keys are the report-view paths: "saturation", "blender.red.0", "grade.midtone.2",
// "blending", "curve". The name and the comment are not fields here: sliders do not edit
// them and resets never touch them.
import { newProfile, COLORS, ZONES } from "./np3.js";

/** The neutral NP3 defaults as a full control (newProfile leaves blender/grade empty). */
export function neutralControl() {
  const c = newProfile();
  for (const k of COLORS) c.blender[k] = [0, 0, 0];
  for (const z of ZONES) c.grade[z] = [0, 0, 0];
  return c;
}

export const BASIC_KEYS = ["saturation", "contrast", "highlights", "shadows", "white", "black"];
export const TONAL_KEYS = ["contrast", "highlights", "shadows", "white", "black"];
export const DETAIL_KEYS = ["sharpening", "mid_sharpening", "clarity"];
export const colorKeys = (color) => [0, 1, 2].map((i) => `blender.${color}.${i}`);
export const zoneKeys = (zone) => [0, 1, 2].map((i) => `grade.${zone}.${i}`);

/** The panel groups (panels.js data-group) and the field keys each one resets. */
export const GROUP_KEYS = {
  basic: BASIC_KEYS,
  curve: ["curve"],
  details: DETAIL_KEYS,
  blender: COLORS.flatMap(colorKeys),
  grading: [...ZONES.flatMap(zoneKeys), "blending", "balance"],
};
export const ALL_KEYS = Object.values(GROUP_KEYS).flat();

export function getField(ctl, key) {
  const parts = key.split(".");
  let v = ctl;
  for (const p of parts) {
    if (v == null) return undefined;
    v = Array.isArray(v) ? v[Number(p)] : v[p];
  }
  return v;
}

// A deep copy that keeps the source's key order (JSON comparisons stay stable).
function copyCurve(c) {
  if (c == null) return null;
  const o = {};
  for (const k of Object.keys(c)) {
    const v = c[k];
    o[k] = k === "points" ? v.map((p) => [p[0], p[1]])
         : (Array.isArray(v) || ArrayBuffer.isView(v)) ? Array.from(v) : v;
  }
  return o;
}

/** Writes one field from `value` (curves are deep-copied; arrays are mutated in place so
 *  the state.control identity and its nested arrays survive). */
export function setField(ctl, key, value) {
  if (key === "curve") { ctl.curve = copyCurve(value); return; }
  const parts = key.split(".");
  if (parts.length === 1) { ctl[key] = value; return; }
  const [top, sub, idx] = parts;
  if (!ctl[top][sub]) ctl[top][sub] = [0, 0, 0];
  ctl[top][sub][Number(idx)] = value;
}

function sameCurve(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (a.points.length !== b.points.length) return false;
  for (let i = 0; i < a.points.length; i++)
    if (a.points[i][0] !== b.points[i][0] || a.points[i][1] !== b.points[i][1]) return false;
  if (a.raw.length !== b.raw.length) return false;
  for (let i = 0; i < a.raw.length; i++) if (a.raw[i] !== b.raw[i]) return false;
  return true;
}

/** One field of `ctl` equals the same field of `base` (numbers to 1e-9, curves exactly). */
export function sameField(ctl, base, key) {
  if (key === "curve") return sameCurve(ctl.curve, base.curve);
  const a = getField(ctl, key), b = getField(base, key);
  if (typeof a !== "number" || typeof b !== "number") return a === b;
  return Math.abs(a - b) <= 1e-9;
}

/** The set of field keys where `ctl` differs from `base` (optionally within `keys`). */
export function changedKeys(ctl, base, keys = ALL_KEYS) {
  const out = new Set();
  for (const k of keys) if (!sameField(ctl, base, k)) out.add(k);
  return out;
}

/** Resets `keys` of `ctl` to `base` in place. The curve and the five tonal sliders are one
 *  NP3 unit (a curve locks them): resetting the curve to a baseline without one also
 *  restores the tonal fields of the baseline. Returns the keys actually changed. */
export function resetKeys(ctl, base, keys) {
  const list = [...keys];
  if (list.includes("curve") && base.curve == null)
    for (const k of TONAL_KEYS) if (!list.includes(k)) list.push(k);
  const changed = changedKeys(ctl, base, list);
  for (const k of changed) setField(ctl, k, k === "curve" ? base.curve : getField(base, k));
  return changed;
}

/** The manual control differs from the baseline — in any field or in the NP3 name (a rename
 *  is a manual edit too; the comment is never edited in the UI). */
export function isDirty(ctl, base) {
  return changedKeys(ctl, base).size > 0 || ctl.name !== base.name;
}

/** Per-field numeric deltas ctl − base for the report's parameter view (changed fields only). */
export function fieldDeltas(ctl, base) {
  const out = {};
  for (const k of changedKeys(ctl, base)) {
    if (k === "curve") continue;
    out[k] = Math.round((getField(ctl, k) - getField(base, k)) * 100) / 100;
  }
  return out;
}
