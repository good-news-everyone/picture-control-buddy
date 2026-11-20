// Hides the page until a translation is applied, so English text never flashes first. A classic
// synchronous script in <head>; data-langs lists the page's translations:
//   <script src="lib/i18n-boot.js" data-langs="ru de fr"></script>
// The language is picked by the rule of i18n.js initLang() (stored "lang", else the browser's
// first known preference); when it is not English, <html> gets the class i18n-pending
// (css: html.i18n-pending body { visibility: hidden; }) until initLang() removes it, or 1.5 s pass.
(function () {
  "use strict";
  var script = document.currentScript;
  var known = String(script && script.getAttribute("data-langs") || "").split(/\s+/).filter(Boolean);
  var stored = null;
  try { stored = window.localStorage.getItem("lang"); } catch (e) { /* no storage: English */ }
  var pick = stored;
  if (!stored) {
    var prefs = navigator.languages || [navigator.language || ""];
    for (var i = 0; i < prefs.length && !pick; i++) {
      var p = String(prefs[i]).slice(0, 2).toLowerCase();
      if (p === "en" || known.indexOf(p) >= 0) pick = p;
    }
  }
  if (known.indexOf(pick) >= 0) {
    document.documentElement.classList.add("i18n-pending");
    setTimeout(function () { document.documentElement.classList.remove("i18n-pending"); }, 1500);
  }
})();
