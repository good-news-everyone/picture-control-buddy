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

// ---------- refit versions (spec/ui-plan.md §4 stage 7, spec/ui.md step 3.2) ----------
// Version naming follows match.next_name: name -> name_r1, name_r1 -> name_r2, skipping the
// names already taken — in the browser "taken" means a version of this session (Python:
// an existing out/<name>/ folder). The NP3 name rule (1..19 ASCII) is kept by truncating
// the base, never the `_rN` suffix (Python names folders, not NP3 names, so it has no cap).

const VERSION_RE = /^(.+)_r(\d+)$/;

/** match.next_name over the session's versions: the next free `<base>_r<N>` after `prevName`. */
export function nextVersionName(versions, prevName) {
  const m = VERSION_RE.exec(prevName);
  const base = m ? m[1] : prevName;
  let n = m ? parseInt(m[2], 10) : 0;
  const taken = new Set(versions.map((v) => v.name));
  for (;;) {
    n += 1;
    const suffix = `_r${n}`;
    const name = base.slice(0, Math.max(1, 19 - suffix.length)) + suffix;
    if (!taken.has(name)) return name;
  }
}

/** A version id unique within the session: "r1", "r2", … (the draft keeps "draft"). */
export function nextVersionId(versions) {
  let n = 0;
  for (const v of versions) {
    const m = /^r(\d+)$/.exec(v.id);
    if (m) n = Math.max(n, parseInt(m[1], 10));
  }
  return `r${n + 1}`;
}

/** The pairs a refit runs over (spec/ui-plan.md stage 7 readiness: "exactly the displayed
 *  selected IDs"): included, both files decoded, not blocked — neither the stage-1 block,
 *  the target-size block nor a finished preparation's block (ncc_low) — in display
 *  (session) order. Pairs not prepared yet are included: the caller prepares them before
 *  the fit and calls this again, so a pair the preparation blocks drops out. The fit payload
 *  names a pair String(id), so FitResult.pairs (a version's pairIds) are these ids as strings. */
export function refitPairIds(session) {
  return session.pairs
    .filter((p) => p.included && isCompletePair(p) && !p.fitBlocked && !p.prepared?.blocked)
    .map((p) => p.id);
}

/**
 * The immutable refit version (spec/ui.md "Decisions" 3-4): the fit result over the
 * selected pairs, named by nextVersionName after its parent (the version selected when the
 * refit started). The control carries the version name, like the draft carries its own.
 * Nothing existing is mutated; the caller appends it and selects it.
 */
export function makeRefitVersion(versions, parent, result) {
  const name = nextVersionName(versions, parent.name);
  return {
    id: nextVersionId(versions),
    name,
    control: { ...result.control, name },
    parentId: parent.id,
    kind: "refit",
    pairIds: result.pairs,
    fitVector: Array.from(result.fitVector),
    cost: result.cost,
    iterations: result.iterations,
    seed: result.seed,
    scores: result.scores,
  };
}
