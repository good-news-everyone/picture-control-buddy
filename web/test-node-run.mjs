// Child process entry of the parallel Node levels: `node web/test-node-run.mjs <level>`.
// Prints the level's lines to stdout (web/test.mjs buffers them and prints in the
// canonical level order) and a machine-readable summary as the last line; the exit
// code is non-zero on failure. One process per level: no shared mutable state.
import { LEVELS } from "./test-node.mjs";

const level = process.argv[2];
const t0 = Date.now();
let failed = 0, skipped = 0;
const report = (ok, text) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
  if (!ok) failed++;
};
const skip = (text) => {
  console.log(`skip ${text}`);
  skipped++;
};

try {
  const fn = LEVELS[level];
  if (!fn) { report(false, `level ${level}: unknown level`); }
  else await fn({ report, skip });
} catch (e) {
  report(false, `${level}: exception ${e.stack || e}`);
}
console.log(`__LEVEL_SUMMARY__${JSON.stringify({ level, failed, skipped, secs: (Date.now() - t0) / 1000 })}`);
process.exit(failed ? 1 : 0);
