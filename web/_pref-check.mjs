import puppeteer from "puppeteer-core";
import fs from "node:fs";
const browser = await puppeteer.launch({ browser: "firefox", executablePath: "/usr/bin/firefox",
  headless: true, userDataDir: "/tmp/ff-prof-check",
  extraPrefsFirefox: { "dom.min_background_timeout_value": 4, "dom.min_background_timeout_tracking_value": 4,
                       "dom.timeout.enable_budget_timer_throttling": false, "dom.disable_backgrounding": true } });
console.log(fs.readFileSync("/tmp/ff-prof-check/user.js", "utf8"));
await browser.close();
