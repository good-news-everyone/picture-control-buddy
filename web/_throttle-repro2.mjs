import puppeteer from "puppeteer-core";
const prefs = { "dom.min_background_timeout_value": 4,
                "dom.min_background_timeout_value_without_budget_throttling": 4,
                "dom.timeout.enable_budget_timer_throttling": false };
const browser = await puppeteer.launch({ browser: "firefox", executablePath: "/usr/bin/firefox",
                                         headless: true, protocolTimeout: 900000, extraPrefsFirefox: prefs });
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
// mimic the suite: 4 concurrent pages
const pages = [];
for (let i = 0; i < 4; i++) { const p = await browser.newPage(); await p.goto("about:blank"); pages.push(p); }
await Promise.all(pages.map(async (p, i) => measure(p, `page${i}:`)));
await browser.close();
