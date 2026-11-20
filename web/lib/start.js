// The Start screen (spec/ui.md step 1, spec/ui-plan.md §4 stage 1): the pair list with
// pickers and drag-and-drop zones, the profile name field with immediate 1–19 ASCII
// validation and the Fit button. Stage 2: Fit runs the pair preparation; stage 3: the
// prepared pairs go to the fit Worker (app.js owns both flows) — here Fit only reflects
// the running state (disabled + "Fitting…" while a fit runs).
// The disclaimer and the pair recommendations are static markup in index.html; this module
// renders the dynamic part (pair cards) and forwards user intents to app.js via callbacks.
// Pair data lives in state.pairs (the session shape, web/lib/session.js).
// Stage 7: the same component renders the pair list of the More frames screen (step 3.2) —
// a second instance over its own element ids (`ids`), in mode "more": no name field or Fit
// button there, and `decorate(pair, box)` lets the More view add the per-pair advice
// (verdict, reasons, the high-error hint). One pair list implementation, one loading path
// (app.js addRawFile/addTargetFile) for both screens.
// Stage 9 (spec/ui.md decision #7): RAW first. The only zone takes RAW files; every card
// offers "Add JPEG" (a picker or a drop onto the card, one file) once its RAW is decoded,
// "Replace JPEG" afterwards, and "Remove from fit" always. No include checkbox, no Edit.
import { t } from "./i18n.js";
import { isValidProfileName, isRawReady, isTargetReady, isCompletePair, canAttachTarget,
         pickTargetFile } from "./session.js";

const $ = (id) => document.getElementById(id);

// Structured warning codes from app.js (target.js editWarningCodes, the camera flag, the
// edit-gain note, the RAW error) localized here — the codes are data, the strings are UI.
function warningText(w) {
  switch (w.code) {
    case "camera":
      return t("Camera is not Nikon Z f: development is approximate");
    case "raw_error":
      return t("RAW is unreadable: {error}", w);
    case "small_target":
      return t("{name}: the target is small ({w}×{h}), a full-size JPEG is better", w);
    case "no_lr_settings":
      return t("{name}: no Lightroom settings in XMP: WB, exposure and masks are invisible, they will land in the profile", w);
    case "masks":
      return t("{name}: has masks, local corrections are not carried into NP3", w);
    case "vignette":
      return t("{name}: vignette from the preset has no place in NP3", w);
    case "grain":
      return t("{name}: grain from the preset has no place in NP3", w);
    case "gain_note":
      return t("Custom WB or exposure in the target's XMP will be taken out of the profile: {note}", w);
    default:
      return w.code;
  }
}

// The pair's fit-blocking state (stage 2): a RAW error, a preparation failure, a low-NCC
// alignment or a too-small target. Data here, text below — returns null when the pair can fit.
function blockedReason(p) {
  if (p.raw === "error") return "raw_error";
  if (p.prepError) return "prep_error";
  if (p.prepared?.blocked?.code === "ncc_low") return "ncc_low";
  if (p.fitBlocked?.code === "target_too_small") return "target_too_small";
  return null;
}

function blockedText(p, reason) {
  switch (reason) {
    case "raw_error":
      return t("RAW is unreadable — this pair cannot be used");
    case "prep_error":
      return t("Preparation failed: {error} — this pair cannot be used", { error: p.prepError });
    case "ncc_low":
      return t("Alignment failed (NCC {ncc}) — this pair cannot be used in the fit",
               { ncc: p.prepared.ncc.toFixed(2) });
    case "target_too_small":
      return t("The target is too small ({detail}) — give a full-size JPEG", p.fitBlocked);
    default:
      return reason;
  }
}

// The card state (decision #7, the six states), as a code and as a short label.
function stateCode(p, blocked) {
  if (p.raw === "pending") return "decoding";
  if (p.raw === "error") return "raw_error";
  if (blocked || p.blocked) return "blocked";
  if (p.target === "pending") return "jpeg_decoding";
  if (!isTargetReady(p)) return "no_jpeg";
  if (p.preparing || !p.prepared) return "preparing";
  return "ready";
}

function stateText(p, blocked) {
  switch (stateCode(p, blocked)) {
    case "decoding": return t("Decoding the RAW…");
    case "raw_error": return t("RAW error");
    case "blocked": return t("Blocked — not fitted");
    case "jpeg_decoding": return t("Decoding the JPEG…");
    case "no_jpeg": return t("Waiting for the JPEG");
    case "preparing": return t("Preparing the pair…");
    default: return t("Ready to fit");
  }
}

/** The fit-set summary under Fit / Refit (decision #7): how many pairs will be fitted and how
 *  many are skipped — without a JPEG (a RAW-only card, or a RAW still decoding) and blocked. */
export function fitCount(state) {
  let n = 0, m = 0, k = 0;
  for (const p of state.pairs) {
    if (blockedReason(p) || p.blocked) k++;
    else if (isCompletePair(p)) n++;
    else if (!isTargetReady(p)) m++;
  }
  return { n, m, k };
}

export function fitCountText(state) {
  const { n, m, k } = fitCount(state);
  let s = n === 1 ? t("1 pair will be fitted") : t("{n} pairs will be fitted", { n });
  const skipped = [];
  if (m) skipped.push(t("{m} without a JPEG", { m }));
  if (k) skipped.push(t("{k} blocked", { k }));
  if (skipped.length) s += "; " + t("skipped: {list}", { list: skipped.join(", ") });
  const preparing = state.pairs.filter((p) => p.preparing).length;
  if (preparing) s += " — " + t("Fit unlocks when the preparation finishes");
  return s;
}

// The pair-preparation stages of pair-worker.js in user words (the codes are data).
const PREP_STAGES = {
  queued: "queued", decode: "reading the RAW", vignette: "lens corrections",
  crop: "geometry", orient: "geometry", radial: "lens corrections",
  align: "aligning with the JPEG", shrink: "finishing",
};
function prepStageText(stage) {
  return t(PREP_STAGES[stage] ?? "working");
}

/**
 * state — the app state (session shape); callbacks:
 *   onAddRaws(files)          — new RAW cards (app.js decodes and validates);
 *   onAddTarget(pair, file)   — the JPEG of one card (add or replace);
 *   onRemovePair(pair)        — "Remove from fit": the pair leaves the session;
 *   onFit()                   — the Fit button (preparation + the fit Worker live in app.js);
 *   onCancelFit()             — the same button while a fit runs ("Cancel fitting");
 *   setStatus(text)           — the shared status line (app.js owns it).
 * Returns { refresh, setNameDefault, setFitProgress }.
 */
export const START_IDS = {
  pairs: "pairs", name: "fit-name", nameErr: "fit-name-err", fit: "fit", fitCount: "fit-count",
  fitProgress: "fit-progress",
  rawZone: "raw-drop", rawPicker: "raw-file",
};

export function createStart({ state, onAddRaws, onAddTarget, onRemovePair, onFit = () => {},
                              onCancelFit = () => {}, setStatus, ids = START_IDS, mode = "start", decorate = null }) {
  const pairsEl = $(ids.pairs);
  const nameInput = ids.name ? $(ids.name) : null;      // absent on the More screen
  const nameErr = ids.nameErr ? $(ids.nameErr) : null;
  const fitBtn = ids.fit ? $(ids.fit) : null;
  const fitCountEl = ids.fitCount ? $(ids.fitCount) : null;
  const fitProgress = ids.fitProgress ? $(ids.fitProgress) : null;
  const toCompareBtn = ids.toCompare ? $(ids.toCompare) : null;
  const rawZone = $(ids.rawZone);
  const rawPicker = $(ids.rawPicker);

  // ---------- the RAW picker and drop zone ----------
  rawZone.addEventListener("click", () => rawPicker.click());
  // the zone is a role=button with tabindex=0 in the markup: Enter / Space open the picker
  rawZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); rawPicker.click(); }
  });
  rawPicker.addEventListener("change", () => { onAddRaws([...rawPicker.files]); rawPicker.value = ""; });

  function bindZone(zone, accept, kinds, cb) {
    for (const ev of ["dragenter", "dragover"]) {
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.add("over");
      });
    }
    for (const ev of ["dragleave", "drop"]) {
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.remove("over");
      });
    }
    zone.addEventListener("drop", (e) => {
      e.stopPropagation();              // the page-level router must not process the same files
      const good = [], bad = [];
      for (const f of [...e.dataTransfer.files]) (accept(f.name) ? good : bad).push(f);
      for (const f of bad) {
        setStatus(/\.(jpe?g)$/i.test(f.name)
          ? t("{name}: add the JPEG on its RAW's card", { name: f.name })
          : t("Skipped {name}: this zone accepts {kinds} only", { name: f.name, kinds }));
      }
      if (good.length) cb(good);
    });
  }
  bindZone(rawZone, (n) => /\.(nef|dng)$/i.test(n), ".NEF/.DNG", onAddRaws);

  // ---------- profile name: immediate 1–19 ASCII validation (the np3.serialize rule) ----------
  function validateName() {
    const ok = isValidProfileName(state.profileName);
    if (!nameInput) return ok;
    nameErr.hidden = ok;
    nameInput.classList.toggle("bad", !ok);
    return ok;
  }
  nameInput?.addEventListener("input", () => {
    state.profileName = nameInput.value;
    validateName();
    updateFit();
  });

  // ---------- Fit ----------
  // Stage 2: disabled while anything prepares. Stage 3: a blocked pair (a failed alignment,
  // a too-small target, an unreadable file) no longer locks Fit — it is excluded from the
  // fit and its card reports the block; Fit needs at least one fittable pair.
  // While a fit runs the status line shows the LM progress (iteration/cost) and the button
  // reads "Fitting…".
  function updateFit() {
    if (!fitBtn) return;
    const preparing = state.pairs.some((p) => p.preparing);
    const fittable = fitCount(state).n > 0;
    if (fitCountEl) fitCountEl.textContent = state.pairs.length ? fitCountText(state) : "";
    // while a fit runs the button cancels it (UX review, decision #15); the progress bar under
    // it follows the LM iterations (setFitProgress from app.js)
    fitBtn.textContent = t(state.fitting ? "Cancel fitting" : "Fit");
    fitBtn.classList.toggle("cancel", !!state.fitting);
    fitBtn.disabled = state.fitting ? false
      : !isValidProfileName(state.profileName) || !fittable || preparing;
    if (fitProgress && !state.fitting) fitProgress.hidden = true;
    // stage 4: the Comparison step needs a fitted version (from Fit or, later, a refit)
    if (toCompareBtn) toCompareBtn.disabled = state.versions.length === 0;
  }
  fitBtn?.addEventListener("click", () => (state.fitting ? onCancelFit() : onFit()));

  /** The fit progress under the button: `frac` in 0..1, or null to hide it. */
  function setFitProgress(frac) {
    if (!fitProgress) return;
    fitProgress.hidden = frac == null;
    if (frac != null) fitProgress.value = Math.max(0, Math.min(1, frac));
  }

  // ---------- pair cards ----------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function metaRow(dt, dd) {
    const row = [el("dt", null, t(dt))];
    row[0].dataset.i18n = dt;
    row.push(el("dd", null, dd));
    return row;
  }

  // A card's JPEG input (picker or drop): exactly one JPEG, and only on a decoded RAW. A
  // rejection is shown on the card and changes nothing else.
  function takeTargets(p, files) {
    if (!files.length) return;
    if (!canAttachTarget(p) || p.target === "pending") {
      p.targetError = p.raw === "error" ? t("The RAW is unreadable — remove this card")
                                        : t("Wait until the RAW is decoded, then add its JPEG");
      refresh();
      return;
    }
    const pick = pickTargetFile(files);
    if (pick.error) {
      p.targetError = pick.error === "count" ? t("Drop one JPEG per card ({n} files dropped)", { n: files.length })
                                             : t("{name} is not a JPEG — the card takes one .JPG", { name: files[0].name });
      refresh();
      return;
    }
    p.targetError = null;
    onAddTarget?.(p, pick.file);
  }

  function card(p) {
    const box = el("div", "pair");
    box.dataset.pairId = String(p.id);
    if (p.id === state.selectedPairId) box.classList.add("selected");
    if (p.blocked) box.classList.add("blocked");

    const blocked = blockedReason(p);

    const top = el("div", "pair-top");
    const st = el("span", "pair-state", stateText(p, blocked));
    st.dataset.state = stateCode(p, blocked);
    // "Remove from fit" on every card, both screens: the pair leaves the session for good
    const rm = el("button", "pair-remove", t("Remove from fit"));
    rm.dataset.i18n = "Remove from fit";
    rm.type = "button";
    rm.addEventListener("click", () => onRemovePair?.(p));
    top.append(st, rm);
    box.append(top);

    const dl = el("dl", "pair-meta");
    const rawName = p.rawFile ? p.rawFile.name + (p.raw === "pending" ? ` (${t("decoding…")})` : "")
                              : "—";
    const targetName = p.targetFile ? p.targetFile.name
                                    : (p.target === "pending" ? `(${t("decoding…")})` : "—");
    dl.append(...metaRow("RAW", rawName), ...metaRow("Target", targetName));
    if (isRawReady(p)) {
      const i = p.raw.info;
      dl.append(...metaRow("Camera", `${i.make} ${i.model}${i.dng ? ", DNG" : ""}`));
      dl.append(...metaRow("Frames", `${p.raw.image.w}×${p.raw.image.h}`
        + (isTargetReady(p) ? ` / ${p.target.width}×${p.target.height}` : "")));
    }
    // Active D-Lighting is not shown: the browser RAW metadata does not expose it, and a
    // permanent "?" on every card was noise (UX review, decision #15)
    // stage 2: preparation progress and the aligned NCC
    if (p.preparing) {
      dl.append(...metaRow("Preparing", t("{stage}…", { stage: prepStageText(p.prepStage ?? "queued") })));
    } else if (p.prepared && !blocked) {
      dl.append(...metaRow("Alignment", `NCC ${p.prepared.ncc.toFixed(3)}`));
    }
    box.append(dl);

    // the JPEG slot: only once the RAW is decoded (decision #7) — "Add JPEG" / "Replace JPEG"
    if (canAttachTarget(p) && p.target !== "pending") {
      const slot = el("div", "pair-jpeg");
      const replace = isTargetReady(p);
      const btn = el("button", replace ? "pair-replace-jpeg" : "pair-add-jpeg",
                     replace ? t("Replace JPEG") : t("Add JPEG"));
      btn.dataset.i18n = replace ? "Replace JPEG" : "Add JPEG";
      btn.type = "button";
      const picker = document.createElement("input");
      picker.type = "file";
      picker.accept = ".jpg,.JPG,.jpeg,.JPEG";
      picker.hidden = true;
      picker.className = "pair-jpeg-file";
      btn.addEventListener("click", () => picker.click());
      picker.addEventListener("change", () => { takeTargets(p, [...picker.files]); picker.value = ""; });
      slot.append(btn, picker);
      if (!replace) slot.append(el("span", "hint", t("or drop the JPEG onto this card")));
      box.append(slot);
    }
    if (p.targetError) box.append(el("div", "bad pair-target-err", p.targetError));

    // a JPEG dropped anywhere on the card goes to this card (one file)
    for (const ev of ["dragenter", "dragover"]) {
      box.addEventListener(ev, (e) => { e.preventDefault(); box.classList.add("over"); });
    }
    box.addEventListener("dragleave", () => box.classList.remove("over"));
    box.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();                // the page-level router must not see these files
      box.classList.remove("over");
      takeTargets(p, [...(e.dataTransfer?.files || [])]);
    });

    if (p.warnings.length) {
      const ul = el("ul", "pair-warn");
      for (const w of p.warnings) ul.append(el("li", null, warningText(w)));
      box.append(ul);
    }
    if (blocked) {
      const b = el("div", "bad pair-blocked", blockedText(p, blocked));
      box.append(b);
    }
    decorate?.(p, box);
    return box;
  }

  function refresh() {
    pairsEl.replaceChildren(...state.pairs.map(card));
    validateName();
    updateFit();
  }

  /** Fills the default profile name from the first RAW (only while the field is untouched). */
  function setNameDefault(name) {
    if (state.profileName) return;
    state.profileName = name;
    nameInput.value = name;
    validateName();
    updateFit();
  }

  return { refresh, setNameDefault, setFitProgress };
}
