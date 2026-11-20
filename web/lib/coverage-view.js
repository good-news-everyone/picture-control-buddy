// The color-coverage advice of the fitting wizard (spec/ui.md decision #11; the stage-7 advice
// of spec/ui-plan.md): computeAdvice() assembles the pure web/lib/advice.js port (analyze.py
// frame / verdict / coverage / recommend / suggest) over the session's frame records, and
// renderCoverage() draws the coverage block that sits above Versions on the Compare screen.
// pairHints() turns the per-pair advice (the high-error hint, "not recommended", a bad
// verdict) into the short texts of a thumbnail's warning badge. No computation beyond
// assembling the advice inputs; the frame records come from the report worker (fit-app.js
// requestFrames()).
import { t } from "./i18n.js";
import { isCompletePair, refitPairIds } from "./session.js";
import { GROUPS, coverage, level, liftMedian, verdict, infoWarnings, recommend, suggest,
         coverageNotes, exclusionCandidates } from "./advice.js";

/** A frame record is current when it was built from the pair's present preparation. */
export function frameOf(p) {
  return p.frame && p.frame.gen === (p.prepGen ?? 0) && p.prepared ? p.frame.rec : null;
}

/** A short display name of a pair: "#<id> <RAW base name>". */
export function pairLabel(p) {
  const n = p.rawFile?.name ?? p.targetFile?.name ?? "";
  return `#${p.id}${n ? " " + n.replace(/\.[^.]+$/, "") : ""}`;
}

/**
 * The advice over the session (pure; no DOM). Candidates: the complete pairs with a current
 * frame record. The fit set: refitPairIds(session) — exactly the pairs a refit would use.
 * Returns {
 *   candidates: [pairId], selected: [pairId] (refitPairIds), pending: n (complete pairs still
 *   preparing / analyzing), coverage: [{ group, value, level }] over the selected frames,
 *   verdicts: { pairId: { verdict, reasons, info } }, recommended: [pairId] (pick order),
 *   suggestions: advice.suggest codes, notes: advice.coverageNotes codes,
 *   exclusion: advice.exclusionCandidates codes (id = pairId), liftMedian }
 */
export function computeAdvice(state) {
  const cands = state.pairs.filter((p) => isCompletePair(p) && frameOf(p));
  const frames = cands.map(frameOf);
  const med = liftMedian(frames);
  const selected = refitPairIds(state);
  const sel = new Set(selected);
  const fitPairs = cands.filter((p) => sel.has(p.id));
  const fitFrames = fitPairs.map(frameOf);
  const cov = coverage(fitFrames);
  const verdicts = {};
  for (const p of cands) {
    const f = frameOf(p);
    verdicts[p.id] = { ...verdict(f, med), info: infoWarnings(f).map((w) => w.code) };
  }
  const recommended = recommend(frames, med).map((f) => cands[frames.indexOf(f)].id);
  const exclusion = exclusionCandidates(fitPairs
    .filter((p) => p.report && p.report.summary)
    .map((p) => ({ id: p.id, renderDE: p.report.summary.renderDE })));
  const pending = state.pairs.filter((p) => isCompletePair(p) && !p.blocked && !p.fitBlocked
    && !p.prepError && !p.prepared?.blocked && !frameOf(p)).length;
  return {
    candidates: cands.map((p) => p.id),
    selected,
    pending,
    coverage: fitFrames.length ? GROUPS.map((g) => ({ group: g, value: cov[g], level: level(cov[g]) })) : [],
    verdicts,
    recommended,
    suggestions: fitFrames.length ? suggest(fitFrames, frames) : [],
    notes: fitFrames.length ? coverageNotes(fitFrames, frames.length > fitFrames.length ? med : null) : [],
    exclusion,
    liftMedian: med,
  };
}

// ---------- codes -> UI strings (the advice module returns codes only) ----------
const signed = (v, d = 1) => (v >= 0 ? "+" : "") + v.toFixed(d);

function verdictText(v) {
  switch (v) {
    case "good": return t("good");
    case "caution": return t("caution");
    case "bad": return t("bad");
    default: return v;
  }
}

function warningShort(code) {
  switch (code) {
    case "small_target": return t("a small target (a preview)");
    case "no_lr_settings": return t("no Lightroom settings in XMP");
    case "masks": return t("local masks");
    case "grain": return t("grain");
    case "vignette": return t("vignette");
    default: return code;
  }
}

function reasonText(r) {
  switch (r.code) {
    case "ncc_low": return t("alignment {ncc}", { ncc: r.ncc.toFixed(2) });
    case "clipped": return t("in white {share}%", { share: Math.round(r.share * 100) });
    case "warning": return warningShort(r.warning.code);
    case "lift_outlier":
      return t("target lightness vs neutral {delta} L off the others: exposure or a local correction, will not land in a shared profile",
               { delta: signed(r.delta) });
    default: return r.code;
  }
}

function levelText(l) {
  switch (l) {
    case "enough": return t("enough");
    case "little": return t("little");
    case "none": return t("none");
    default: return l;
  }
}

function noteText(n) {
  if (n.code === "set_lift") {
    let s = t("Set lightness vs the candidate median: {delta} L", { delta: signed(n.delta) });
    if (n.significant) s += " — " + (n.direction === "lighter"
      ? t("the profile will make the other frames lighter by about as much")
      : t("the profile will make the other frames darker by about as much"));
    return s;
  }
  if (n.code === "adl_mixed") return t("Mixed Active D-Lighting in the set: {adls}", { adls: n.adls.join(", ") });
  return n.code;
}

/** The coverage block (decision #11): the table of the pairs in the fit set, the
 *  "little or none" line, the suggestions and the notes. `el` is emptied and refilled. */
export function renderCoverage(el, state) {
  const a = state.advice;
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const out = [];
  const h = mk("h2", null, t("Color coverage"));
  h.dataset.i18n = "Color coverage";
  out.push(h);
  if (!a || !a.coverage.length) {
    out.push(mk("div", "hint", a?.pending ? t("Analyzing {n} pair(s)…", { n: a.pending })
                                          : t("Appears once a pair of the fit set is analyzed")));
    el.replaceChildren(...out);
    return;
  }
  const tbl = mk("table", "cov-table");
  for (const c of a.coverage) {
    const tr = mk("tr", `lv-${c.level}`);
    tr.dataset.group = c.group;
    tr.dataset.level = c.level;
    tr.append(mk("td", null, t(c.group)), mk("td", "num", `${(c.value * 100).toFixed(1)}%`),
              mk("td", null, levelText(c.level)));
    tbl.append(tr);
  }
  out.push(tbl);
  const missing = a.coverage.filter((c) => c.level !== "enough" && c.group !== "greys");
  if (missing.length) {
    out.push(mk("div", "cov-missing", t("Little or none: {groups}",
      { groups: missing.map((c) => t(c.group)).join(", ") })));
  }
  const label = (id) => { const p = state.pairs.find((q) => q.id === id); return p ? pairLabel(p) : `#${id}`; };
  for (const s of a.suggestions) {
    const names = s.candidates.map((c) => `${label(Number(c.name))} (${(c.share * 100).toFixed(0)}%)`).join(", ");
    const d = mk("div", "cov-suggest hint", t("{group}: {coverage}% ({level}) — add to the fit: {names}",
      { group: t(s.group), coverage: (s.coverage * 100).toFixed(1), level: levelText(s.level), names }));
    d.dataset.group = s.group;
    out.push(d);
  }
  for (const n of a.notes) out.push(mk("div", "hint cov-note", noteText(n)));
  if (a.pending) out.push(mk("div", "hint", t("Analyzing {n} pair(s)…", { n: a.pending })));
  el.replaceChildren(...out);
}

/** The texts of a pair's warning badge on the Compare strip (decision #11): the verdict
 *  "bad" with its reasons, "not recommended" (outside analyze.recommend) and the high-error
 *  hint. [] when there is nothing to say. */
export function pairHints(p, state) {
  const a = state.advice;
  if (!a) return [];
  const out = [];
  const v = a.verdicts[p.id];
  if (v && v.verdict !== "good") {
    let s = t("Verdict: {verdict}", { verdict: verdictText(v.verdict) });
    if (v.reasons.length) s += " — " + v.reasons.map(reasonText).join("; ");
    out.push(s);
  }
  if (a.recommended.length && a.candidates.includes(p.id) && !a.recommended.includes(p.id))
    out.push(t("Not recommended: the recommended set covers the colors without this pair"));
  const hi = a.exclusion.find((x) => x.id === p.id);
  if (hi) {
    out.push(t("Error {de} dE is {ratio}× the set median {median} — consider removing this pair from the fit",
      { de: hi.renderDE.toFixed(2), ratio: hi.ratio.toFixed(1), median: hi.median.toFixed(2) }));
  }
  return out;
}
