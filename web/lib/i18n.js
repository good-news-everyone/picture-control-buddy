// UI i18n. The source of truth is English: a key is the English string itself,
// other languages' dictionaries translate the keys. Markup and code do not change when a language is added.
//
//   import { t, applyI18n } from "./lib/i18n.js";
//   <button data-i18n="Browser">Browser</button>              // static text
//   <input data-i18n-ph="Drop NEF or DNG">                     // placeholder
//   <img data-i18n-alt="…"> / <button data-i18n-aria="…">          // alt / aria-label
//   el.textContent = t("Processing {name}…", { name });        // dynamic, {var} are substituted
//
// New UI strings are added only via data-i18n/data-i18n-ph or t();
// do not hardcode English into markup (otherwise the string is untranslatable).
// Language: localStorage "lang", default en; a switch appears with the first translation.

const DICTS = {};                    // language code -> {"English string": "translation"}
let lang = localStorage.getItem("lang") || "en";

export function t(key, vars) {
  let s = DICTS[lang]?.[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Register a translation dictionary: register("de", {"Saturation": "Sättigung", …}). */
export function register(code, dict) {
  DICTS[code] = dict;
}

export function currentLang() {
  return lang;
}

export function setLang(code) {
  if (code !== "en" && !DICTS[code]) return;
  lang = code;
  localStorage.setItem("lang", code);
  applyI18n();
}

/** Translates statics: data-i18n — textContent, data-i18n-ph — placeholder,
 *  data-i18n-aria — aria-label, data-i18n-alt — alt. */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-ph]")) el.placeholder = t(el.dataset.i18nPh);
  for (const el of root.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll("[data-i18n-alt]")) el.alt = t(el.dataset.i18nAlt);
}
