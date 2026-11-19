// The More frames screen (spec/ui.md step 3.2, spec/ui-plan.md §4 stage 7): more pairs
// through the same loading/check path as the Start screen, the color-coverage advice over
// the selected pairs, the recommended set, the high-error hints and the refit.
//
// The pair list is the Start-screen component (web/lib/start.js) instantiated over this
// screen's element ids in mode "more" — one list implementation, one loading path (app.js
// addRawFile/addTargetFile + the preparation Worker). This module owns only the DOM of the
// advice panel and the refit bar; the advice itself is computed by computeAdvice() from the
// pure web/lib/advice.js port (no computation here beyond assembling its inputs), and the
// refit lifecycle (prepare → fit Worker → the next _rN version) lives in app.js.
//
// Data in: state.pairs[].frame = { gen, rec } — the analyze.frame record of a prepared
// pair (built in the report worker, which already holds the developed neutral of the pair:
// app.js requestFrames()), pairs[].report — the stage-5 per-pair report at the selected
// version (summary.renderDE feeds the exclusion hints). Adding/removing/toggling pairs
// recomputes the advice from these cached records — never a fit.
import { t } from "./i18n.js";
import { createStart } from "./start.js";
import { isCompletePair, refitPairIds } from "./session.js";
import { GROUPS, coverage, level, liftMedian, verdict, infoWarnings, recommend, suggest,
         coverageNotes, exclusionCandidates } from "./advice.js";

const $ = (id) => document.getElementById(id);

export const MORE_IDS = {
  pairs: "more-pairs", name: null, nameErr: null, fit: null, toCompare: null,
  rawZone: "more-raw-drop", targetZone: "more-target-drop",
  rawPicker: "more-raw-file", targetPicker: "more-target-file",
};

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

/**
 * Callbacks (app.js owns every state change):
 *   onAddRaws(files) / onAddTargets(files) — the shared loading path;
 *   onRemovePair(pair), onIncludeChange(pair), onUseRecommended(), onRefit(), onCancel(), onBack().
 * Returns { refresh }.
 */
export function createMore({ state, setStatus, onAddRaws, onAddTargets, onRemovePair, onIncludeChange,
                             onUseRecommended, onRefit, onCancel, onBack }) {
  const adviceEl = $("more-advice");
  const refitBtn = $("more-refit");
  const cancelBtn = $("more-cancel");
  const idsEl = $("more-refit-ids");
  const byId = (id) => state.pairs.find((p) => p.id === id);
  const label = (id) => { const p = byId(id); return p ? pairLabel(p) : `#${id}`; };

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // the per-pair advice on the card: the verdict, its reasons, the high-error hint
  function decorate(p, box) {
    const a = state.advice;
    if (!a) return;
    const v = a.verdicts[p.id];
    if (v) {
      const line = el("div", `pair-verdict v-${v.verdict}`);
      line.dataset.verdict = v.verdict;
      let s = t("Verdict: {verdict}", { verdict: verdictText(v.verdict) });
      if (v.reasons.length) s += " — " + v.reasons.map(reasonText).join("; ");
      if (v.info.length) s += ` (${v.info.map(warningShort).join(", ")})`;
      line.textContent = s;
      box.append(line);
    } else if (isCompletePair(p) && !p.blocked && !p.fitBlocked && !p.prepError && !p.prepared?.blocked) {
      box.append(el("div", "hint pair-verdict", t("Analyzing…")));
    }
    const hi = a.exclusion.find((x) => x.id === p.id);
    if (hi) {
      const w = el("div", "bad pair-high-error",
        t("Error {de} dE is {ratio}× the set median {median} — consider excluding this pair from the fit",
          { de: hi.renderDE.toFixed(2), ratio: hi.ratio.toFixed(1), median: hi.median.toFixed(2) }));
      box.append(w);
    }
  }

  const list = createStart({ state, setStatus, onAddRaws, onAddTargets,
    onEditPair: () => {}, onFit: () => {}, ids: MORE_IDS, mode: "more",
    onRemovePair, onIncludeChange, decorate });

  function renderAdvice() {
    const a = state.advice;
    const out = [];
    if (!a || (!a.candidates.length && !a.pending)) {
      out.push(el("div", "hint", t("Add RAW + JPEG pairs: the color-coverage advice appears once a pair is prepared")));
      adviceEl.replaceChildren(...out);
      return;
    }
    if (a.pending) out.push(el("div", "hint more-pending", t("Analyzing {n} pair(s)…", { n: a.pending })));

    // coverage of the selected pairs (analyze.coverage / level)
    const h = el("h2", null, t("Color coverage of the selected pairs"));
    h.dataset.i18n = "Color coverage of the selected pairs";
    out.push(h);
    if (a.coverage.length) {
      const tbl = el("table", "more-cov");
      for (const c of a.coverage) {
        const tr = el("tr", `lv-${c.level}`);
        tr.dataset.group = c.group;
        tr.dataset.level = c.level;
        tr.append(el("td", null, t(c.group)), el("td", "num", `${(c.value * 100).toFixed(1)}%`),
                  el("td", null, levelText(c.level)));
        tbl.append(tr);
      }
      out.push(tbl);
      const missing = a.coverage.filter((c) => c.level !== "enough" && c.group !== "greys");
      if (missing.length) {
        out.push(el("div", "more-missing", t("Little or none: {groups}",
          { groups: missing.map((c) => t(c.group)).join(", ") })));
      }
    } else {
      out.push(el("div", "hint", t("No analyzed pair is selected")));
    }

    // missing-color suggestions (analyze.suggest)
    for (const s of a.suggestions) {
      const names = s.candidates.map((c) => `${label(Number(c.name))} (${(c.share * 100).toFixed(0)}%)`).join(", ");
      const d = el("div", "more-suggest", t("{group}: {coverage}% ({level}) — add to the fit: {names}",
        { group: t(s.group), coverage: (s.coverage * 100).toFixed(1), level: levelText(s.level), names }));
      d.dataset.group = s.group;
      out.push(d);
    }
    for (const n of a.notes) out.push(el("div", "hint more-note", noteText(n)));

    // the recommended set (analyze.recommend); the user may override it
    if (a.recommended.length) {
      const same = a.recommended.length === a.selected.length
        && a.recommended.every((id) => a.selected.includes(id));
      const r = el("div", "more-rec", t("Recommended set ({n} of {m}): {names}",
        { n: a.recommended.length, m: a.candidates.length, names: a.recommended.map(label).join(", ") }));
      r.dataset.ids = a.recommended.join(",");
      out.push(r);
      const b = el("button", null, t("Use the recommended selection"));
      b.type = "button";
      b.id = "more-use-rec";
      b.dataset.i18n = "Use the recommended selection";
      b.disabled = same || state.fitting;
      b.addEventListener("click", () => onUseRecommended());
      out.push(b);
      if (same) out.push(el("div", "hint", t("The current selection is the recommended one")));
    }
    adviceEl.replaceChildren(...out);
  }

  function renderRefitBar() {
    const ids = refitPairIds(state);
    refitBtn.dataset.pairIds = ids.join(",");
    const preparing = state.pairs.some((p) => p.preparing);
    refitBtn.textContent = state.fitting ? t("Refitting…") : t("Refit ({n} pairs)", { n: ids.length });
    refitBtn.disabled = state.fitting || !ids.length || !state.versions.length || preparing;
    cancelBtn.hidden = !state.fitting;
    idsEl.textContent = ids.length ? t("Refit over: {names}", { names: ids.map(label).join(", ") })
                                   : t("Select at least one pair to refit");
  }

  refitBtn.addEventListener("click", () => onRefit());
  cancelBtn.addEventListener("click", () => onCancel());
  $("more-back").addEventListener("click", () => onBack());

  function refresh() {
    list.refresh();
    renderAdvice();
    renderRefitBar();
  }

  return { refresh };
}
