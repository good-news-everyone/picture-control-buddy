// Session state helpers for the full fitting flow (spec/ui-plan.md §3, stage 1): the pair
// shape, the pair-assembly rule, the profile-name rule. Pure functions — no DOM, no codec;
// the only state is the module-level pair id counter (per page load, like a fresh session).
//
// Pair shape (stage 1):
//   { id, rawFile, targetFile, raw, target, warnings, included, blocked }
//   raw:    null | "pending" | "error" | { name, info, image, warn }   (loader ready payload)
//   target: null | "pending" | decodeTarget() result
//   warnings: structured entries { code, ... } — localized in the UI via t()

let nextPairId = 1;

/** Lowercased base name of a file ("DSC_5584.NEF" -> "dsc_5584") — the pair-matching key. */
export function baseName(fileName) {
  return fileName.replace(/\.[^.]+$/, "").toLowerCase();
}

/** The np3.serialize name rule: 1 to 19 ASCII characters (panels.js uses the same regex). */
export function isValidProfileName(s) {
  return s.length >= 1 && s.length <= 19 && /^[\x00-\x7F]*$/.test(s);
}

/** Default profile name from the first RAW's base name, as in match.py (basename, lowercased),
 *  sanitized into the 1..19 printable-ASCII rule. */
export function defaultProfileName(rawFileName) {
  const s = baseName(rawFileName).replace(/[^\x21-\x7E]/g, "-");
  return s.slice(0, 19);
}

export function createPair() {
  return { id: nextPairId++, rawFile: null, targetFile: null, raw: null, target: null,
           warnings: [], included: true, blocked: false };
}

// The pairing rule (spec/ui.md step 1): a RAW and a JPEG with the same base name join one
// pair; the remaining files are matched in the order they arrived — a file joins the first
// pair that has the other kind of file and lacks its own; with no candidate a new pair is
// created (possibly a single-file pair, to be completed later). Re-dropping a file with the
// same base name as its own slot of an existing pair replaces that slot (the user fixes a
// wrong file); a same-name RAW retry of a not-yet-ready slot is the same rule.
export function assignFile(pairs, kind, file) {
  const mine = kind === "raw" ? "rawFile" : "targetFile";
  const other = kind === "raw" ? "targetFile" : "rawFile";
  const name = baseName(file.name);
  let p = pairs.find((q) => q[mine] && baseName(q[mine].name) === name);
  if (!p && kind === "raw")
    p = pairs.find((q) => q.rawFile && baseName(q.rawFile.name) === name && !isRawReady(q));
  if (!p) p = pairs.find((q) => !q[mine] && q[other] && baseName(q[other].name) === name);
  if (!p) p = pairs.find((q) => !q[mine] && q[other]);
  if (!p) { p = createPair(); pairs.push(p); }
  p[mine] = file;
  return p;
}

/** Drops pairs that hold neither a file nor any decoded data — the placeholder left behind
 *  by a rejected file. Existing (possibly valid) pairs are never removed by an error path. */
export function pruneEmpty(pairs) {
  for (let i = pairs.length - 1; i >= 0; i--) {
    const p = pairs[i];
    if (!p.rawFile && !p.targetFile && !isRawReady(p) && !isTargetReady(p)) pairs.splice(i, 1);
  }
}

export function isRawReady(p) {
  return !!p.raw && p.raw !== "pending" && p.raw !== "error";
}

export function isTargetReady(p) {
  return !!p.target && p.target !== "pending";
}

/** A pair can enter the fit: not blocked, the RAW decoded, the target decoded. */
export function isCompletePair(p) {
  return !p.blocked && isRawReady(p) && isTargetReady(p);
}

/**
 * The immutable draft version from a successful fit (spec/ui-plan.md §3, stage 3): the fit
 * result's control becomes the version control; the fit metadata stays attached for the
 * later stages (reports, refits). Versions are never mutated in place.
 */
export function draftVersion(result) {
  return {
    id: "draft",
    name: result.control.name,
    control: result.control,
    parentId: null,
    kind: "fit",
    pairIds: result.pairs,
    fitVector: Array.from(result.fitVector),
    cost: result.cost,
    iterations: result.iterations,
    seed: result.seed,
    scores: result.scores,
  };
}

// Stage-1 dimension guard until real pair preparation arrives (stage 2): the target must
// have roughly the same aspect ratio as the decoded RAW frame, in either orientation
// (±2%) — a cheap crop/rotation hint; alignment and NCC stay stage-2 checks.
export function dimsCompatible(rawImage, target) {
  const rel = (a, b) => Math.abs(a - b) / Math.max(a, b);
  const r = rawImage.w / rawImage.h, t = target.width / target.height;
  return rel(r, t) <= 0.02 || rel(r, 1 / t) <= 0.02;
}
