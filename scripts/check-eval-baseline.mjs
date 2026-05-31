#!/usr/bin/env node
// Regression gate: compare evals/results.json pass rate against evals/baseline.json.
// Exits 1 on regression (CI fails the PR). Tolerant of promptfoo output-shape variants.
import { readFileSync, existsSync } from "node:fs";

const RESULTS = "evals/results.json";
const BASELINE = "evals/baseline.json";
const TOLERANCE = 0.02;

if (!existsSync(RESULTS)) {
  console.error(`missing ${RESULTS} — run \`npm run eval\` first`);
  process.exit(1);
}

const out = JSON.parse(readFileSync(RESULTS, "utf8"));
const stats = out.results?.stats ?? out.stats ?? {};
const pass = stats.successes ?? stats.pass ?? 0;
const fail = stats.failures ?? stats.fail ?? 0;
const total = stats.total ?? pass + fail;
const rate = total ? pass / total : 0;
console.log(`pass rate: ${(rate * 100).toFixed(1)}%  (${pass}/${total})`);

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")).passRate ?? 0 : 0;
if (rate + TOLERANCE < baseline) {
  console.error(`REGRESSION: ${(rate * 100).toFixed(1)}% is below baseline ${(baseline * 100).toFixed(1)}% (tol ${TOLERANCE})`);
  process.exit(1);
}
console.log(`OK vs baseline ${(baseline * 100).toFixed(1)}%`);
