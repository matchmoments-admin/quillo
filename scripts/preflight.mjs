#!/usr/bin/env node
// Read-only config readiness check. Never prints secret VALUES (only names).
// Usage: node scripts/preflight.mjs [--local]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const local = process.argv.includes("--local");
const ok = (l) => console.log(`  ✅ ${l}`);
const bad = (l) => console.log(`  ❌ ${l}`);
const warn = (l) => console.log(`  ⚠️  ${l}`);
const wr = (args) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

console.log("tax-agent preflight\n");

console.log("Resources (wrangler.toml):");
const toml = readFileSync("wrangler.toml", "utf8");
const d1 = toml.match(/database_id\s*=\s*"([^"]*)"/)?.[1];
d1 && d1 !== "PASTE_AFTER_CREATE" ? ok("D1 database_id set") : bad("D1 database_id is a placeholder — wrangler d1 create tax-agent-db");
const kv = toml.match(/binding = "RULES"[\s\S]*?id = "([^"]*)"/)?.[1];
kv && kv !== "PASTE_AFTER_CREATE" ? ok("KV (RULES) id set") : bad("KV id is a placeholder — wrangler kv namespace create RULES");

console.log("\nSecrets (names only):");
try {
  const names = JSON.parse(wr(["secret", "list"])).map((x) => x.name);
  names.includes("ANTHROPIC_API_KEY")
    ? ok("ANTHROPIC_API_KEY set")
    : bad("ANTHROPIC_API_KEY missing — wrangler secret put ANTHROPIC_API_KEY");
  for (const n of ["QBO_CLIENT_ID", "QBO_CLIENT_SECRET"]) {
    names.includes(n) ? ok(`${n} set (QBO track)`) : warn(`${n} not set (only needed for the QuickBooks track)`);
  }
} catch {
  warn("couldn't list secrets (worker not deployed / not logged in) — skipping");
}

console.log("\nDatabase:");
try {
  const tables = JSON.parse(
    wr(["d1", "execute", "tax-agent-db", local ? "--local" : "--remote", "--json", "--command", "SELECT name FROM sqlite_master WHERE type='table'"]),
  )
    .flatMap((r) => r.results ?? [])
    .map((t) => t.name);
  const need = ["tenants", "profiles", "transactions", "properties", "entities", "user_rules", "audit_log"];
  const missing = need.filter((t) => !tables.includes(t));
  missing.length === 0
    ? ok(`schema applied (${tables.length} tables)`)
    : bad(`missing tables: ${missing.join(", ")} — npm run schema${local ? ":local" : ""}`);

  const count = (sql) =>
    JSON.parse(wr(["d1", "execute", "tax-agent-db", local ? "--local" : "--remote", "--json", "--command", sql]))
      .flatMap((r) => r.results ?? [])[0]?.n ?? 0;
  count("SELECT COUNT(*) n FROM tenants") > 0
    ? ok(`${count("SELECT COUNT(*) n FROM tenants")} tenant(s) onboarded`)
    : warn("no tenants — node scripts/onboard.mjs --file situation.json");
  count("SELECT COUNT(*) n FROM profiles WHERE consent_xborder=1") > 0
    ? ok("APP-8 consent recorded for at least one profile")
    : warn("no cross-border consent recorded (fine if using Bedrock ap-southeast-2)");
} catch {
  warn("couldn't query D1 (not created / not logged in) — skipping");
}

console.log("\nSee SETUP.md for the full checklist.");
