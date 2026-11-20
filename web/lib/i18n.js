// UI i18n. The source of truth is English: a key is the English string itself,
// other languages' dictionaries translate the keys. Markup and code do not change when a language is added.
//
//   import { t, applyI18n } from "./lib/i18n.js";
//   <button data-i18n="Browser">Browser</button>              // static text
//   <input data-i18n-ph="Drop NEF or DNG">                     // placeholder
//   <img data-i18n-alt="…"> / <button data-i18n-aria="…">          // alt / aria-label
//   <button data-i18n-title="…">                               // title (tooltip)
//   el.textContent = t("Processing {name}…", { name });        // dynamic, {var} are substituted
//   <b data-i18n="Reset {name}" data-i18n-vars='{"name":"Hue"}'>  // the same, kept live: applyI18n
//                                                              // re-translates it after a switch
//   n === 1 ? t("1 pair") : t("{n} pairs", { n })             // plural: English picks its key, a
//                                                              // translation may be { one, few, many, other }
//   t("Reset|toolbar")                                         // a context key: its own translation
//                                                              // (a shorter word), English "Reset";
//                                                              // without one, the plain key's translation
//
// New UI strings are added only via data-i18n* or t();
// do not hardcode English into markup (otherwise the string is untranslatable).
// Text that must follow a language switch made while the page is open carries data-i18n* (an
// element written once with t() keeps the language it was written in).
// Language: localStorage "lang", default en. A page registers its dictionaries and calls
// initLang(); pages that register none stay English whatever is stored.

const DICTS = {};                    // language code -> {"English string": "translation"}
let lang = "en";
try { lang = localStorage.getItem("lang") || "en"; } catch { /* no storage: English */ }

const recent = new Map();             // t() output -> [key, vars], see t()

export function t(key, vars) {
  // a context key ("Reset|toolbar", "skin|short") falls back to its plain key's translation
  const plain = key.replace(/\|\w+$/, "");
  let s = DICTS[lang]?.[key] ?? DICTS[lang]?.[plain] ?? plain;
  // plural forms: a translation may be { one, few, many, other } (Intl.PluralRules categories),
  // picked by vars.n — e.g. Russian 1 пара / 2 пары / 5 пар; English chooses its key in code
  if (typeof s === "object") s = s[plural().select(Number(vars?.n ?? 0))] ?? s.other;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  // the recent outputs remember their key and vars: reTranslate() re-renders a status line
  // with a file name or a number after a language switch (bounded, oldest dropped first)
  if (vars) {
    recent.delete(s);
    recent.set(s, [key, vars]);
    if (recent.size > 300) recent.delete(recent.keys().next().value);
  }
  return s;
}

let rules = null;
function plural() {
  if (rules?.lang !== lang) rules = { lang, pr: new Intl.PluralRules(lang) };
  return rules.pr;
}

/** Register a translation dictionary: register("de", {"Saturation": "Sättigung", …}).
 *  Registering the same language again merges (a page can combine several dictionaries). */
export function register(code, dict) {
  DICTS[code] = { ...DICTS[code], ...dict };
}

export function currentLang() {
  return lang;
}

/** The languages with a dictionary on this page, English first. */
export function languages() {
  return ["en", ...Object.keys(DICTS)];
}

export function setLang(code) {
  if (code !== "en" && !DICTS[code]) return;
  lang = code;
  try { localStorage.setItem("lang", code); } catch { /* not remembered */ }
  document.documentElement.lang = code;
  applyI18n();
}

/** Picks the language once the page's dictionaries are registered: the stored choice when this
 *  page has it, otherwise the browser's first known preference (navigator.languages; the same
 *  rule as the landing), otherwise English. Applies the statics. */
export function initLang() {
  const known = languages();
  let stored = null;
  try { stored = localStorage.getItem("lang"); } catch { /* no storage */ }
  let pick = known.includes(stored) ? stored : null;
  if (!stored) {
    pick = (navigator.languages ?? [navigator.language ?? ""])
      .map((l) => String(l).slice(0, 2).toLowerCase()).find((l) => known.includes(l)) ?? null;
  }
  lang = pick ?? "en";
  document.documentElement.lang = lang;
  applyI18n();
  document.documentElement.classList.remove("i18n-pending");
}

/** Translates statics: data-i18n — textContent, data-i18n-ph — placeholder,
 *  data-i18n-aria — aria-label, data-i18n-alt — alt, data-i18n-title — title.
 *  data-i18n-vars (JSON) substitutes {var} in all of them; string values are translated too
 *  (a value with no translation, like a file name, stays as is). */
export function applyI18n(root = document) {
  const tr = (el, key) => {
    if (!el.dataset.i18nVars) return t(key);
    let vars = {};
    try { vars = JSON.parse(el.dataset.i18nVars); } catch { /* malformed: no substitution */ }
    for (const [k, v] of Object.entries(vars)) if (typeof v === "string") vars[k] = t(v);
    return t(key, vars);
  };
  const all = (sel) => [...(root.matches?.(sel) ? [root] : []), ...root.querySelectorAll(sel)];
  for (const el of all("[data-i18n]")) el.textContent = tr(el, el.dataset.i18n);
  for (const el of all("[data-i18n-ph]")) el.placeholder = tr(el, el.dataset.i18nPh);
  for (const el of all("[data-i18n-aria]")) el.setAttribute("aria-label", tr(el, el.dataset.i18nAria));
  for (const el of all("[data-i18n-alt]")) el.alt = tr(el, el.dataset.i18nAlt);
  for (const el of all("[data-i18n-title]")) el.title = tr(el, el.dataset.i18nTitle);
}

/** Translates a string already written in language `from` into the current one: a recent t()
 *  output (with its vars) or a plain dictionary string; anything else (a string glued from
 *  several parts) comes back unchanged. */
export function reTranslate(s, from) {
  const hit = recent.get(s);
  if (hit) return t(hit[0], hit[1]);
  let key = s;
  if (from && from !== "en") {
    const hit = Object.entries(DICTS[from] ?? {}).find(([, v]) => v === s);   // plural objects never match
    if (!hit) return s;
    key = hit[0];
  }
  return t(key);
}

/** Sets a live translated attribute or text: i18nSet(el, "aria", "Reset {name}", { name: "Hue" })
 *  writes it now and marks it for applyI18n. what: "text" | "aria" | "title" | "ph" | "alt". */
export function i18nSet(el, what, key, vars) {
  const ds = { text: "i18n", aria: "i18nAria", title: "i18nTitle", ph: "i18nPh", alt: "i18nAlt" }[what];
  el.dataset[ds] = key;
  if (vars) el.dataset.i18nVars = JSON.stringify(vars);
  applyI18n(el);
}
