// Strength set: several NP3s at once from one base profile (spec/ui.md step 3.1 "Save a
// strength set", Decisions #1 and #5; spec/ui-plan.md §4 stage 6). Pure: no DOM, Node-safe;
// the download lives in transfer.js (exportSet).
//
// Rules:
// - every member is an INDEPENDENT strength.scaled(base, p) from the base control — never
//   from an already scaled result, so the set does not depend on the current strength slider;
// - at 100% the member is the base control itself (as the single export in transfer.js:
//   scaled(…, 100) would regenerate the curve points and break the byte-exact round-trip of an
//   unmodified profile);
// - the NP3 internal name is the base name at every strength (no "-70" suffix inside the NP3,
//   Decision #1); only the FILE names differ;
// - file name = "<base>-<percent>.NP3", where <base> is the profile name with characters that
//   are invalid in file names on common systems (control chars, < > : " / \ | ? *) replaced by
//   "_" and surrounding spaces/dots trimmed ("profile" if nothing remains). Percents are
//   deduplicated, so names are unique; a case-insensitive guard adds "_2", "_3"… anyway.
// Python mirror of the naming and the bytes: web/make_strength_set_golden.py (level 1h).
import { serialize } from "./np3.js";
import { scaled } from "./strength.js";

export const DEFAULT_PERCENTS = [30, 50, 70, 100];
export const MIN_PERCENT = 0;
export const MAX_PERCENT = 150;

/** Validates and normalizes a percent list: integers 0..150 (numbers or numeric strings),
 *  deduplicated, ascending. Throws on an empty list or an invalid entry. */
export function normalizePercents(list = DEFAULT_PERCENTS) {
  if (!Array.isArray(list) || list.length === 0) throw new Error("strength set: no percents");
  const out = new Set();
  for (const v of list) {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v.trim()) : v;
    if (typeof n !== "number" || !Number.isInteger(n) || n < MIN_PERCENT || n > MAX_PERCENT)
      throw new Error(`strength set: invalid percent ${JSON.stringify(v)} (whole numbers ${MIN_PERCENT}–${MAX_PERCENT})`);
    out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** The file-name stem derived from the profile name (see the header). */
export function fileStem(name) {
  // eslint-disable-next-line no-control-regex
  const s = String(name).replace(/[\x00-\x1f<>:"/\\|?*\x7f]/g, "_").replace(/^[\s.]+|[\s.]+$/g, "");
  return s || "profile";
}

/** "<stem>-<percent>.NP3" */
export function setFileName(name, percent) {
  return `${fileStem(name)}-${percent}.NP3`;
}

/** [{percent, control}] — the member controls; the base is not modified. */
export function strengthSetControls(base, percents = DEFAULT_PERCENTS) {
  return normalizePercents(percents).map((percent) => ({
    percent,
    control: percent === 100 ? base : { ...scaled(base, percent), name: base.name },
  }));
}

/** [{percent, fileName, bytes}] — serialized members with unique file names.
 *  Throws (before producing anything) on invalid percents or an unserializable base. */
export function buildStrengthSet(base, percents = DEFAULT_PERCENTS) {
  const seen = new Set();
  return strengthSetControls(base, percents).map(({ percent, control }) => {
    let fileName = setFileName(base.name, percent);
    for (let k = 2; seen.has(fileName.toLowerCase()); k++)
      fileName = setFileName(base.name, percent).replace(/\.NP3$/, `_${k}.NP3`);
    seen.add(fileName.toLowerCase());
    return { percent, fileName, bytes: serialize(control) };
  });
}
