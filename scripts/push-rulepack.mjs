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

// ── Guard: never publish a structurally broken thresholds register to the KV shadow ──
// The KV pack fully shadows the bundled default, so a stale or malformed push silently serves
// wrong statutory rates while npm test (which reads the bundle) stays green. These rules mirror
// the "threshold register" block in scripts/check-units.ts — keep the two REQUIRED_KEYS in sync.
const REQUIRED_KEYS = [
  "instant_asset_write_off_cents",
  "car_limit_cents",
  "low_value_pool_threshold_cents",
  "immediate_non_business_cents",
  "gst_registration_threshold_cents",
  "super_concessional_cap_cents",
  "wfh_fixed_rate_cents_per_hour",
  "car_cents_per_km",
  "car_km_cap",
];
const byFy = pack.thresholds_by_fy ?? {};
const fyBlocks = Object.keys(byFy).filter((k) => !k.startsWith("_"));
const errors = [];
for (const fy of fyBlocks) {
  if (!/^\d{4}-\d{2}$/.test(fy)) errors.push(`threshold block key '${fy}' is not an FY label`);
  for (const k of REQUIRED_KEYS) {
    if (typeof byFy[fy]?.[k] !== "number" || !Number.isFinite(byFy[fy][k])) errors.push(`${fy}.${k} missing or non-numeric`);
  }
}
if (new Set(fyBlocks.map((fy) => Object.keys(byFy[fy]).sort().join(","))).size > 1) {
  errors.push("FY blocks do not share an identical key set");
}
// Current AU FY (rolls over 1 July): the live pack must cover the FY it will serve today.
const nowUtc = new Date();
const startYear = nowUtc.getUTCMonth() >= 6 ? nowUtc.getUTCFullYear() : nowUtc.getUTCFullYear() - 1;
const currentFy = `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
if (!byFy[currentFy]) errors.push(`no thresholds block for the current FY (${currentFy})`);
if (errors.length) {
  console.error(`refusing to push ${key} — thresholds register failed validation:`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}

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
