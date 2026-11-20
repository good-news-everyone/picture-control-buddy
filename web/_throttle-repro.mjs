// Minimal repro: does headless Firefox throttle timers in non-active tabs?
// Page A is created first (background), page B second (likely active). We measure in A.
import puppeteer from "puppeteer-core";

const firefox = process.env.FIREFOX || "/usr/bin/firefox";
const extra = process.argv.includes("--prefs") ? {
  extraPrefsFirefox: {
    "dom.min_background_timeout_value": 4,
    "dom.timeout.enable_budget_timer_throttling": false,
    "dom.timeout.throttlemultiple": 1,
    "dom.timeout.tracking_throttling_delay": 300000,
    "dom.disable_backgrounding": true,
    "dom.disable_beforeunload": true,
  },
} : {};
const browser = await puppeteer.launch({ browser: "firefox", executablePath: firefox,
                                         headless: true, protocolTimeout: 900000, ...extra });

const measure = async (page, label) => {
  const r = await page.evaluate(async () => {
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 60));
    const sleepActual = performance.now() - t0;
    const ticks = [];
    let last = performance.now();
    await new Promise((done) => {
      const iv = setInterval(() => {
        const now = performance.now();
        ticks.push(Math.round(now - last));
        last = now;
        if (ticks.length >= 5) { clearInterval(iv); done(); }
      }, 10);
    });
    return { sleepActual: Math.round(sleepActual), ticks };
  });
  console.log(label, JSON.stringify(r));
};

const pageA = await browser.newPage();
await pageA.goto("about:blank");
const pageB = await browser.newPage();   // becomes the active tab; A goes to background
await pageB.goto("about:blank");

await measure(pageA, "pageA (background):");
await measure(pageB, "pageB (active):  ");
await measure(pageA, "pageA (background, 2nd):");

// and with A kept busy like a fitting page (synchronous spin between timers)
await pageA.evaluate(() => { window.__spin = true; (() => { const e = performance.now() + 400; while (performance.now() < e); })(); });
await measure(pageA, "pageA (background, after busy spin):");
await measure(pageB, "pageB (active, during A's spin):  ");

await browser.close();
