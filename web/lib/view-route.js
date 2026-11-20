// The page router (spec/ui-mobile.md "Two pages and the redirect", plan §2.3; page names of
// spec/ui-pages.md). A classic synchronous script — the first element of <head> on the two
// profile-editor pages only: picture-control-editor.html and picture-control-editor-mobile.html
// (not on the landing, not on the fitting wizard).
// It defines window.NP3Route and redirects at load when the current page is not the chosen one.
// The decision is the pure function choose(); the Node unit tests (test.mjs, level 9a) load this
// file in a vm context with a stub window and window.NP3_ROUTE_TEST set, which also keeps the
// script away from location.
(function () {
  "use strict";
  // Kept as a switch since stage M0 (when mobile.html did not exist yet: false made choose() answer
  // "desktop" always, so a phone was never redirected to a missing page). The tests override it through
  // window.NP3_ROUTE_TEST = { mobileReady: true|false, run: true|false } (run: also execute
  // the load-time redirect step against a stub window; otherwise only choose() etc. are defined).
  const MOBILE_READY = true;
  const PAGES = { desktop: "picture-control-editor.html", mobile: "picture-control-editor-mobile.html" };
  const KINDS = ["desktop", "mobile"];
  const STORE_KEY = "np3view";

  const testHook = () => window.NP3_ROUTE_TEST;
  const mobileReady = () => {
    const h = testHook();
    return h && typeof h === "object" && "mobileReady" in h ? !!h.mobileReady : MOBILE_READY;
  };

  // search: location.search; stored: localStorage np3view or null; coarse: (pointer: coarse);
  // screenMin: Math.min(screen.width, screen.height).
  // -> { want, store, search }: the page to show, the preference to store (or null), and the
  //    search string without the consumed view= parameter.
  function choose({ page, search = "", stored = null, coarse = false, screenMin = Infinity }) {
    const params = new URLSearchParams(search);
    const override = params.get("view");
    const hasOverride = KINDS.includes(override);
    let rest = search;
    if (params.has("view")) {                     // a consumed (or malformed) view= is dropped
      params.delete("view");
      const s = params.toString();
      rest = s ? "?" + s : "";
    }
    let want;
    if (hasOverride) want = override;
    else if (KINDS.includes(stored)) want = stored;
    else want = coarse && screenMin < 600 ? "mobile" : "desktop";
    const ready = mobileReady();
    if (!ready) want = "desktop";
    return { want, store: hasOverride && ready ? override : null, search: rest, page };
  }

  function readStored() {
    try { return window.localStorage.getItem(STORE_KEY); } catch (e) { return null; }
  }
  function writeStored(kind) {
    try { window.localStorage.setItem(STORE_KEY, kind); } catch (e) { /* no preference then */ }
  }

  // Stores the preference, navigates to the other page; np3 — a base64url profile for ?np3=.
  function switchTo(kind, np3) {
    writeStored(kind);
    window.location.assign(PAGES[kind] + (np3 ? "?np3=" + encodeURIComponent(np3) : ""));
  }

  // The share-link base: the desktop editor page beside the current page (the router moves a
  // phone on to the mobile page; spec/ui-pages.md "Share links").
  function canonical(href) {
    return new URL(PAGES.desktop, href);
  }

  window.NP3Route = { choose, switchTo, canonical, PAGES };

  // unit tests: no location access, unless the hook asks for the redirect step ({ run: true })
  if (testHook() && !(typeof testHook() === "object" && testHook().run)) return;
  const loc = window.location;
  const page = /(^|\/)picture-control-editor-mobile\.html$/.test(loc.pathname) ? "mobile" : "desktop";
  let r;
  try {
    r = choose({
      page, search: loc.search, stored: readStored(),
      coarse: !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches),
      screenMin: Math.min(window.screen.width, window.screen.height),
    });
  } catch (e) {
    return;                                       // never break the page because of the router
  }
  if (r.store) writeStored(r.store);
  if (r.want !== page) {
    window.NP3_REDIRECTING = true;                // editor-app.js stops at its first line
    loc.replace(PAGES[r.want] + r.search + loc.hash);
  } else if (r.search !== loc.search) {
    window.history.replaceState(null, "", loc.pathname + r.search + loc.hash);
  }
})();
