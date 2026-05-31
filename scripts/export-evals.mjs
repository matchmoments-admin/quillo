#!/usr/bin/env node
// Export D1 eval_cases into committed promptfoo fixtures (evals/cases/<user>.json).
// "Golden cases in git": CI runs against these, not the prod DB.
// Usage: node scripts/export-evals.mjs [--local]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const local = process.argv.includes("--local");

const out = execFileSync(
  "npx",
  [
    "wrangler", "d1", "execute", "tax-agent-db", "--json",
    local ? "--local" : "--remote",
    "--command",
    "SELECT user_id, input_json, expected_bucket, expected_label FROM eval_cases",
  ],
  { encoding: "utf8", cwd: root },
);

// wrangler --json emits an array of { results: [...] }.
const rows = JSON.parse(out).flatMap((r) => r.results ?? []);
const byUser = {};
for (const row of rows) {
  const f = JSON.parse(row.input_json);
  (byUser[row.user_id] ??= []).push({
    description: `${f.merchant} -> ${row.expected_bucket}`,
    merchant: f.merchant,
    amount_cents: f.amount_cents ?? null,
    gst_cents: f.gst_cents ?? null,
    txn_date: f.txn_date ?? null,
    expected_bucket: row.expected_bucket,
    expected_label: row.expected_label,
  });
}

const dir = join(root, "evals", "cases");
mkdirSync(dir, { recursive: true });
for (const [user, cases] of Object.entries(byUser)) {
  writeFileSync(join(dir, `${user}.json`), JSON.stringify(cases, null, 2) + "\n");
  console.log(`wrote ${cases.length} cases -> evals/cases/${user}.json`);
}
if (!Object.keys(byUser).length) console.log("no eval_cases yet — promote some via corrections first");
console.log("Review the diff and commit the updated fixtures.");
