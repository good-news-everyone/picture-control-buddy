import puppeteer from "puppeteer-core";
import fs from "node:fs";

const variants = {
  "min_bg=4": { "dom.min_background_timeout_value": 4 },
  "min_bg=4 + no_budget": { "dom.min_background_timeout_value": 4,
    "dom.timeout.enable_budget_timer_throttling": false,
    "dom.min_background_timeout_value_without_budget_throttling": 4 },
  "tracking+min": { "dom.min_background_timeout_value": 4,
    "dom.min_background_timeout_tracking_value": 4 },
  "throttling_delay=0": { "dom.timeout.throttling_delay": 0, "dom.timeout.budget_throttling_max_delay": 0,
    "dom.min_background_timeout_value": 4 },
};
for (const [name, prefs] of Object.entries(variants)) {
  fs.rmSync("/tmp/ff-prof-grid", { recursive: true, force: true });
  const browser = await puppeteer.launch({ browser: "firefox", executablePath: "/usr/bin/firefox",
    headless: true, userDataDir: "/tmp/ff-prof-grid", extraPrefsFirefox: prefs });
  const a = await browser.newPage(); await a.goto("about:blank");
  const b = await browser.newPage(); await b.goto("about:blank");
  const r = await a.evaluate(async () => {
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 60));
    return Math.round(performance.now() - t0);
  });
  console.log(name, "-> background 60ms sleep took", r, "ms");
  await browser.close();
}
