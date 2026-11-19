// Fitting-set advice (spec/ui-plan.md §4 stage 7, spec/ui.md steps 1 and 3.2): the pure
// port of analyze.py `frame`, `coverage`, `level`, `value`, `suggest`, `lift_median`,
// `verdict`, `recommend` and the notes of `print_coverage`, plus the browser-only
// `exclusionCandidates`. No DOM, no Worker, no UI strings: every human-readable item is a
// structured code with parameters; the main thread localizes it via t(). Runs in Node.
//
// Frame record (analyze.frame dict, field for field):
//   { name, target, ncc, adl, groups: {group: share}, L, dark, light, clipped, lift,
//     warnings: [warning code objects] }
// buildFrame() builds it from what the browser already has for a prepared pair — see the
// mapping note there. Differences from Python, all deliberate and documented:
//   - warnings are the structured codes of target.js editWarningCodes() ({code, name, ...}),
//     not match.edit_warnings strings. verdict() classifies them by code: small_target is
//     "bad" (Python: "preview" in the string), vignette/grain are info only (INFO_ONLY),
//     no_lr_settings/masks are "caution". Python matches substrings of the whole string,
//     file name included (a target named "grain_1.jpg" is silently info-only there); the
//     code-based port is immune to that quirk. Browser-only pair warnings (camera,
//     gain_note, raw_error) are not edit warnings and do not enter the verdict (Python
//     frames never carry them); buildFrame() drops them.
//   - recommend() keys frames by identity instead of analyze.key() (target or nef path):
//     identical where the keys are unique, which Python assumes anyway.
//   - value() sums the present groups in GROUPS order; Python iterates a set (hash order),
//     so sums can differ in the last ulp — never observed to change a selection.
//   - adl is "?" unless the caller knows it: the browser RAW metadata does not expose
//     Active D-Lighting yet (analyze.adl reads it with exiv2), exactly as analyze.adl
//     answers without a NEF.

import { srgbToLab } from "./color.js";
import { GROUPS, labelsOf } from "./analyze.js";

export { GROUPS };
export const ENOUGH = 0.05;         // analyze.ENOUGH: enough for fitting (~2000 px over the set)
export const FEW = 0.01;            // analyze.FEW: below — the color is fitted blindly
export const MAX_FRAMES = 6;        // analyze.MAX_FRAMES
export const GAIN_STOP = 0.15;      // analyze.GAIN_STOP
export const LIFT_OUTLIER = 2.0;    // analyze.LIFT_OUTLIER (L)
export const LIFT_PENALTY = 0.7;    // analyze.LIFT_PENALTY (groups per 1 L)
export const CLIPPED_BAD = 0.3;     // analyze.CLIPPED_BAD
export const NCC_BAD = 0.6;         // analyze.NCC_BAD
export const INFO_ONLY = ["grain", "vignette"];   // analyze.INFO_ONLY (as warning codes)
export const CAUTION_PENALTY = 0.3; // the literal 0.3 in analyze.recommend
export const CLIP_T = 0.98;         // the literal .98 in analyze.frame (target white)
export const SET_LIFT_NOTE = 0.5;   // the literal 0.5 in analyze.print_coverage
// Warning codes that are edit warnings (match.edit_warnings); the only ones a frame carries.
export const EDIT_WARNINGS = ["small_target", "no_lr_settings", "masks", "vignette", "grain"];
const BAD_WARNINGS = ["small_target"];   // Python: "preview" in the warning string

// Python round(x, digits): the exact binary value rounded half-even at `digits` decimals.
export function pyRoundTo(x, digits) {
  return parseFloat(pyFixed(x, digits));
}

/** Python f"{x:.{d}f}": like toFixed, but exact ties go to the even digit (toFixed rounds
 *  them up). Exported for the UI/tests that want CLI-identical numbers. */
export function pyFixed(x, d) {
  if (!Number.isFinite(x)) return String(x);
  const s = x.toFixed(d);
  const exact = Math.abs(x).toFixed(Math.min(100, d + 60));
  const dot = exact.indexOf(".");
  const tail = exact.slice(dot + 1 + d);
  if (!/^50*$/.test(tail)) return s;               // not an exact tie: toFixed is correct
  // an exact tie: toFixed rounded away from zero; Python keeps the even digit
  const kept = exact.slice(0, dot + 1 + d).replace(/\.$/, "");
  const last = Number(kept[kept.length - 1]);
  if (last % 2 === 0) return (x < 0 ? "-" : "") + kept;
  return s;
}

/**
 * analyze.frame from the browser's arrays.
 *   targetSrgb  — the aligned target, sRGB 0..1, (n, 3) at the working resolution: the
 *                 prepared pair's `y` (Python: raw["t"]).
 *   neutralSrgb — the developed Nikon neutral of the aligned RAW with the edit gain:
 *                 develop(dev, x * gain), the report worker's per-pair `fb` cache
 *                 (Python: m.dev(raw["x"] * g)).
 *   ncc         — the prepared pair's aligned NCC (Python: raw["ncc"]); rounded to 3 as there.
 *   warnings    — the pair's warning codes; only EDIT_WARNINGS are kept.
 *   adl         — "?" unless known (see the module note).
 * Every pixel counts, as in Python: no alignment/report mask is applied (analyze.frame has
 * none); `clipped` is the share of target pixels with a channel >= 0.98 and `groups`,
 * `lift` are over the remaining pixels. With all pixels clipped they are NaN, as in numpy.
 */
export function buildFrame({ name, target = null, ncc, warnings = [], adl = "?", targetSrgb, neutralSrgb }) {
  const n = targetSrgb.length / 3;
  const tl = srgbToLab(Float64Array.from(targetSrgb));
  const nl = srgbToLab(Float64Array.from(neutralSrgb));
  const ok = new Uint8Array(n);
  let nOk = 0, sumL = 0, dark = 0, light = 0, sumLift = 0;
  for (let i = 0; i < n; i++) {
    const r = targetSrgb[i * 3], g = targetSrgb[i * 3 + 1], b = targetSrgb[i * 3 + 2];
    const L = tl[i * 3];
    sumL += L;
    if (L < 15) dark++;
    if (L > 85) light++;
    if (Math.max(r, g, b) < CLIP_T) { ok[i] = 1; nOk++; sumLift += L - nl[i * 3]; }
  }
  const lab = labelsOf(tl, ok);
  const counts = new Array(GROUPS.length).fill(0);
  for (let i = 0; i < n; i++) if (lab[i] !== 255) counts[lab[i]]++;
  const groups = {};
  GROUPS.forEach((g, k) => { groups[g] = counts[k] / nOk; });
  return {
    name, target, ncc: pyRoundTo(ncc, 3), adl, groups,
    L: sumL / n, dark: dark / n, light: light / n, clipped: (n - nOk) / n,
    lift: sumLift / nOk,
    warnings: warnings.filter((w) => EDIT_WARNINGS.includes(w.code)),
  };
}

/**
 * analyze.verdict: { verdict: "good" | "caution" | "bad", reasons } — bad reasons first,
 * then caution reasons, in the Python order. Reason codes:
 *   { code: "ncc_low", severity: "bad", ncc }                       — alignment {ncc:.2f}
 *   { code: "clipped", severity: "bad", share }                     — in white {share:.0%}
 *   { code: "warning", severity: "bad" | "caution", warning }       — an edit warning (its
 *                                                                     own code inside)
 *   { code: "lift_outlier", severity: "caution", delta }            — target lightness vs
 *                                                                     neutral {delta:+.1f} L off the others
 */
export function verdict(f, liftMedian) {
  const bad = [], care = [];
  if (f.ncc < NCC_BAD) bad.push({ code: "ncc_low", severity: "bad", ncc: f.ncc });
  if (f.clipped > CLIPPED_BAD) bad.push({ code: "clipped", severity: "bad", share: f.clipped });
  for (const w of f.warnings) {
    if (INFO_ONLY.includes(w.code)) continue;
    if (BAD_WARNINGS.includes(w.code)) bad.push({ code: "warning", severity: "bad", warning: w });
    else care.push({ code: "warning", severity: "caution", warning: w });
  }
  if (f.lift !== null && f.lift !== undefined && Math.abs(f.lift - liftMedian) > LIFT_OUTLIER)
    care.push({ code: "lift_outlier", severity: "caution", delta: f.lift - liftMedian });
  return { verdict: bad.length ? "bad" : care.length ? "caution" : "good", reasons: [...bad, ...care] };
}

/** The info-only warnings of a frame (print_frames shows them in parentheses). */
export function infoWarnings(f) {
  return f.warnings.filter((w) => INFO_ONLY.includes(w.code));
}

/** analyze.coverage: the sum of each group's shares over the frames (sequential, as sum()). */
export function coverage(frames) {
  const out = {};
  for (const g of GROUPS) {
    let s = 0;
    for (const f of frames) s += f.groups[g];
    out[g] = s;
  }
  return out;
}

/** analyze.level: "enough" | "little" | "none". */
export function level(v) {
  return v >= ENOUGH ? "enough" : v >= FEW ? "little" : "none";
}

/** analyze.value: covered groups, each up to ENOUGH; `present` is a Set of group names. */
export function value(cov, present) {
  let s = 0;
  for (const g of GROUPS) if (present.has(g)) s += Math.min(cov[g], ENOUGH) / ENOUGH;
  return s;
}

const mean = (a) => { let s = 0; for (const v of a) s += v; return s / a.length; };

/** analyze.lift_median: the median of the known lifts (numpy: mean of the middle two). */
export function liftMedian(frames) {
  const l = frames.map((f) => f.lift).filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
  if (!l.length) return 0;
  const m = l.length >> 1;
  return l.length % 2 ? l[m] : (l[m - 1] + l[m]) / 2;
}

/**
 * analyze.recommend: greedily picks frames while each next one closes a noticeable share of
 * groups (at most MAX_FRAMES; the first 3 are always taken if usable). Returns the chosen
 * frame objects in pick order. `adlOnly` keeps only frames with that ADL (case-insensitive).
 */
export function recommend(frames, liftMed, adlOnly = null) {
  const verdicts = new Map(frames.map((f) => [f, verdict(f, liftMed).verdict]));
  const usable = frames.filter((f) => verdicts.get(f) !== "bad"
    && (adlOnly === null || String(f.adl).toLowerCase() === adlOnly.toLowerCase()));
  const covU = coverage(usable);
  const present = new Set(GROUPS.filter((g) => covU[g] >= FEW));
  const score = (c) => {
    const lifts = c.map((x) => x.lift).filter((v) => v !== null && v !== undefined);
    return value(coverage(c), present) - (lifts.length ? LIFT_PENALTY * Math.abs(mean(lifts) - liftMed) : 0);
  };
  const chosen = [];
  while (usable.length && chosen.length < MAX_FRAMES) {
    const now = chosen.length ? score(chosen) : 0;
    let best = null, bestGain = -Infinity;
    for (const f of usable) {              // max(): the first maximal element wins
      const gain = score([...chosen, f]) - now - (verdicts.get(f) === "caution" ? CAUTION_PENALTY : 0);
      if (best === null || gain > bestGain) { best = f; bestGain = gain; }
    }
    if (chosen.length >= 3 && bestGain < GAIN_STOP) break;
    chosen.push(best);
    usable.splice(usable.indexOf(best), 1);
  }
  return chosen;
}

/**
 * analyze.suggest: for every weak group of the fit set (coverage < ENOUGH, greys excluded),
 * up to 3 non-bad candidates outside the fit (by name) with that group's share >= FEW, the
 * largest share first. Returns
 *   [{ code: "weak_group", group, coverage, level, candidates: [{ name, share }] }]
 * only for groups that have candidates (Python's `what` text — "add to the fit" — is the
 * UI's wording).
 */
export function suggest(fit, candidates) {
  const cov = coverage(fit);
  const weak = GROUPS.filter((g) => cov[g] < ENOUGH && g !== "greys");
  const med = liftMedian([...fit, ...candidates]);
  const names = new Set(fit.map((f) => f.name));
  const out = [];
  for (const g of weak) {
    const best = candidates
      .filter((f) => !names.has(f.name) && verdict(f, med).verdict !== "bad" && f.groups[g] >= FEW)
      .map((f, i) => ({ f, i }))
      .sort((a, b) => (b.f.groups[g] - a.f.groups[g]) || (a.i - b.i))   // sorted() is stable
      .slice(0, 3);
    if (best.length)
      out.push({ code: "weak_group", group: g, coverage: cov[g], level: level(cov[g]),
                 candidates: best.map(({ f }) => ({ name: f.name, share: f.groups[g] })) });
  }
  return out;
}

/**
 * The notes of analyze.print_coverage, as codes:
 *   { code: "set_lift", delta, significant, direction }  — with a candidate median and all
 *       lifts known: the set's mean lift vs the median; when |delta| >= 0.5 (significant)
 *       the profile will make the other frames `direction` ("lighter" | "darker") by about as much
 *   { code: "adl_mixed", adls }                          — more than one ADL in the set (sorted)
 */
export function coverageNotes(frames, median = null) {
  const out = [];
  if (median !== null && frames.length && frames.every((f) => f.lift !== null && f.lift !== undefined)) {
    const d = mean(frames.map((f) => f.lift)) - median;
    out.push({ code: "set_lift", delta: d, significant: Math.abs(d) >= SET_LIFT_NOTE,
               direction: d < 0 ? "lighter" : "darker" });
  }
  const adls = [...new Set(frames.map((f) => f.adl))].sort();
  if (adls.length > 1) out.push({ code: "adl_mixed", adls });
  return out;
}

// --------------------------------------------------------------------------- exclusion

export const EXCLUDE_MIN_PAIRS = 3;   // fewer pairs: no meaningful "others" to compare with
export const EXCLUDE_RATIO = 2.0;     // render dE above this multiple of the set median…
export const EXCLUDE_ABS = 1.0;       // …and at least this many dE2000 above it

/**
 * High-error pairs as candidates for exclusion (spec/ui-plan.md stage 7: surface, never
 * delete). Browser-only — Python has no such rule. Input: [{ id, renderDE }] for the pairs
 * in the fit (the stage-5 per-pair report `summary.renderDE` at the current version).
 * Rule: with at least EXCLUDE_MIN_PAIRS finite values, M = the median renderDE over them
 * (the pair itself included); a pair is flagged when renderDE > EXCLUDE_RATIO * M and
 * renderDE - M >= EXCLUDE_ABS (the absolute floor keeps near-perfect sets quiet).
 * Returns [{ code: "high_error", id, renderDE, median, ratio }], highest ratio first.
 */
export function exclusionCandidates(items) {
  const xs = items.filter((it) => Number.isFinite(it.renderDE));
  if (xs.length < EXCLUDE_MIN_PAIRS) return [];
  const s = xs.map((it) => it.renderDE).sort((a, b) => a - b);
  const m = s.length >> 1;
  const med = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  return xs
    .filter((it) => it.renderDE > EXCLUDE_RATIO * med && it.renderDE - med >= EXCLUDE_ABS)
    .map((it) => ({ code: "high_error", id: it.id, renderDE: it.renderDE, median: med,
                    ratio: med > 0 ? it.renderDE / med : Infinity }))
    .sort((a, b) => b.ratio - a.ratio);
}
