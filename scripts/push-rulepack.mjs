#!/usr/bin/env node
// Push a rule-pack JSON to KV so the Worker uses it (key `rulepack:<version>`),
// keeping the deployed agent in sync with the version the eval harness graded.
// Usage: node scripts/push-rulepack.mjs src/rulepacks/au-v1.json [--local]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/push-rulepack.mjs <rulepack.json> [--local]");
  process.exit(1);
}
const local = process.argv.includes("--local");
const pack = JSON.parse(readFileSync(file, "utf8"));
const key = `rulepack:${pack.version}`;

// NOTE: wrangler KV CLI syntax is `kv key put` on v3.60+ (older: `kv:key put`).
execFileSync(
  "npx",
  [
    "wrangler", "kv", "key", "put", key, JSON.stringify(pack),
    "--binding", "RULES",
    local ? "--local" : "--remote",
  ],
  { stdio: "inherit" },
);
console.log(`pushed ${key}`);
