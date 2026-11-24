// The (i) button of the app pages' icon row (the profile editor, the fitting wizard): it opens a
// small panel with the hotkeys above the button, inside the left column. A click on the button
// toggles it; Escape or a click outside closes it (Escape returns the focus to the button).
export function mountInfoPop(btn, pop) {
  function open(on) {
    pop.hidden = !on;
    btn.setAttribute("aria-expanded", on);
  }
  btn.addEventListener("click", () => open(pop.hidden));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || pop.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    open(false);
    btn.focus();
  }, true);
  document.addEventListener("click", (e) => {
    if (!pop.hidden && !btn.contains(e.target) && !pop.contains(e.target)) open(false);
  });
}
