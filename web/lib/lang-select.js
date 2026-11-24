// The language menu of the app pages: a globe icon button that opens a menu of the page's
// languages by their endonyms (the current one checked) — the landing's pattern. A choice is
// stored (i18n.js setLang) and applied at once: every data-i18n* text re-translates; onChange lets
// the page refresh what it renders itself. Keyboard: the menu opens on the checked item,
// arrows move, Escape closes back to the button; a click outside closes it.
import { languages, currentLang, setLang } from "./i18n.js";

const NAMES = { en: "English", ru: "Русский", de: "Deutsch", fr: "Français" };

export function mountLangMenu(btn, menu, onChange = null) {
  const items = languages().map((code) => {
    const li = document.createElement("li");
    li.setAttribute("role", "none");
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitemradio");
    b.dataset.lang = code;
    b.lang = code;
    b.textContent = NAMES[code] ?? code;
    li.append(b);
    menu.append(li);
    return b;
  });
  const sync = () => items.forEach((b) => b.setAttribute("aria-checked", b.dataset.lang === currentLang()));
  sync();

  function open(on, focusItem = false) {
    if (on) sync();   // another menu of the page may have switched the language meanwhile
    menu.hidden = !on;
    btn.setAttribute("aria-expanded", on);
    if (on && focusItem) (items.find((b) => b.getAttribute("aria-checked") === "true") ?? items[0]).focus();
  }
  btn.addEventListener("click", () => open(menu.hidden, true));
  items.forEach((b) => b.addEventListener("click", () => {
    const changed = b.dataset.lang !== currentLang();
    setLang(b.dataset.lang);
    sync();
    open(false);
    btn.focus();
    if (changed) onChange?.(b.dataset.lang);
  }));
  menu.addEventListener("keydown", (e) => {
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
    } else if (e.key === "Escape") {
      // the menu only: inside the mobile Info sheet (a <dialog>) Escape would close the sheet too
      e.preventDefault();
      e.stopPropagation();
      open(false);
      btn.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !btn.contains(e.target) && !menu.contains(e.target)) open(false);
  });
}
