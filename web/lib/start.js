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
// button there, every card gets a Remove button, and `decorate(pair, box)` lets the More
// view add the per-pair advice (verdict, reasons, the high-error hint). One pair list
// implementation, one loading path (app.js addRawFile/addTargetFile) for both screens.
import { t } from "./i18n.js";
import { isValidProfileName, isRawReady, isTargetReady, isCompletePair } from "./session.js";

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

/**
 * state — the app state (session shape); callbacks:
 *   onAddRaws(files) / onAddTargets(files) — pair assembly (app.js decodes and validates);
 *   onEditPair(pair)  — enter the manual editor with the pair's RAW;
 *   onFit()           — the Fit button (preparation + the fit Worker live in app.js);
 *   setStatus(text)   — the shared status line (app.js owns it).
 * Returns { refresh, setNameDefault }.
 */
export const START_IDS = {
  pairs: "pairs", name: "fit-name", nameErr: "fit-name-err", fit: "fit", toCompare: "to-compare",
  rawZone: "raw-drop", targetZone: "target-drop", rawPicker: "raw-file", targetPicker: "target-file",
};

export function createStart({ state, onAddRaws, onAddTargets, onEditPair, onFit, setStatus,
                              ids = START_IDS, mode = "start", onRemovePair = null,
                              onIncludeChange = null, decorate = null }) {
  const more = mode === "more";
  const pairsEl = $(ids.pairs);
  const nameInput = ids.name ? $(ids.name) : null;      // absent on the More screen
  const nameErr = ids.nameErr ? $(ids.nameErr) : null;
  const fitBtn = ids.fit ? $(ids.fit) : null;
  const toCompareBtn = ids.toCompare ? $(ids.toCompare) : null;
  const rawZone = $(ids.rawZone);
  const targetZone = $(ids.targetZone);
  const rawPicker = $(ids.rawPicker);
  const targetPicker = $(ids.targetPicker);

  // ---------- pickers and drag-and-drop zones ----------
  rawZone.addEventListener("click", () => rawPicker.click());
  targetZone.addEventListener("click", () => targetPicker.click());
  rawPicker.addEventListener("change", () => { onAddRaws([...rawPicker.files]); rawPicker.value = ""; });
  targetPicker.addEventListener("change", () => { onAddTargets([...targetPicker.files]); targetPicker.value = ""; });

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
      for (const f of bad)
        setStatus(t("Skipped {name}: this zone accepts {kinds} only", { name: f.name, kinds }));
      if (good.length) cb(good);
    });
  }
  bindZone(rawZone, (n) => /\.(nef|dng)$/i.test(n), ".NEF/.DNG", onAddRaws);
  bindZone(targetZone, (n) => /\.(jpe?g)$/i.test(n), ".JPG", onAddTargets);

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
  // fit and its card reports the block; Fit needs at least one fittable included pair.
  // While a fit runs the status line shows the LM progress (iteration/cost) and the button
  // reads "Fitting…".
  function updateFit() {
    if (!fitBtn) return;
    const preparing = state.pairs.some((p) => p.preparing);
    const fittable = state.pairs.some((p) => p.included && isCompletePair(p) && !blockedReason(p));
    fitBtn.textContent = t(state.fitting ? "Fitting…" : "Fit");
    fitBtn.disabled = state.fitting || !isValidProfileName(state.profileName) || !fittable || preparing;
    // stage 4: the Comparison step needs a fitted version (from Fit or, later, a refit)
    if (toCompareBtn) toCompareBtn.disabled = state.versions.length === 0;
  }
  fitBtn?.addEventListener("click", () => onFit());

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

  function card(p) {
    const box = el("div", "pair");
    box.dataset.pairId = String(p.id);
    if (p.id === state.selectedPairId) box.classList.add("selected");
    if (p.blocked) box.classList.add("blocked");

    const blocked = blockedReason(p);

    const top = el("div", "pair-top");
    const inc = el("label", "pair-inc");
    const incBox = document.createElement("input");
    incBox.type = "checkbox";
    incBox.className = "pair-inc-box";
    incBox.checked = p.included && !p.blocked && !blocked;
    incBox.disabled = p.blocked || !!blocked;
    incBox.addEventListener("change", () => {
      p.included = incBox.checked;
      updateFit();
      onIncludeChange?.(p);
    });
    const incLabel = el("span", null, t("Include in the fit"));
    incLabel.dataset.i18n = "Include in the fit";
    inc.append(incBox, incLabel);

    const edit = el("button", "pair-edit", t("Edit"));
    edit.dataset.i18n = "Edit";
    edit.disabled = p.blocked || !isRawReady(p);
    edit.addEventListener("click", () => onEditPair(p));
    if (more) {
      // step 3.2: removal from the session (the other pairs, their preparation and the
      // versions are kept); the editor entry stays on the Start screen
      const rm = el("button", "pair-remove", t("Remove"));
      rm.dataset.i18n = "Remove";
      rm.type = "button";
      rm.addEventListener("click", () => onRemovePair?.(p));
      top.append(inc, rm);
    } else {
      top.append(inc, edit);
    }
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
    // Active D-Lighting is honestly unknown until the browser RAW metadata exposes it
    const [adlDt, adlDd] = metaRow("Active D-Lighting", "?");
    dl.append(adlDt, adlDd);
    // stage 2: preparation progress and the aligned NCC
    if (p.preparing) {
      dl.append(...metaRow("Preparing", t("{stage}…", { stage: p.prepStage ?? "queued" })));
    } else if (p.prepared && !blocked) {
      dl.append(...metaRow("Alignment", `NCC ${p.prepared.ncc.toFixed(3)}`));
    }
    box.append(dl);

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

  return { refresh, setNameDefault };
}
