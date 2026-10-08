#!/usr/bin/env tsx
// Publish the security pack's status tables to KV so the admin Security & compliance page (#636) can
// show them: docs/security/control-matrix.md → `security:source:control_matrix`, and
// docs/security/osp-register.md → `security:source:osp_register`. A missing doc (or one with no
// parseable table) is skipped, so this is safe to run before the security pack (#642) lands.
//
// Table format (GitHub markdown): control matrix needs columns named like `ID`, `Control`, `Status`
// (optionally `Evidence`); status cells use ✅ (met) / 🟡 (partial) / ⬜ (not started). The OSP
// register needs `Service` and `Country` columns (optionally `Role`).
//
// Usage: npx tsx scripts/push-security-docs.ts [--local] [--dry-run]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { controlMatrixRecord, ospRegisterRecord, SECURITY_KV, type SecuritySourceKey, type SecuritySourceRecord } from "../src/lib/security-dashboard";

const local = process.argv.includes("--local");
const dry = process.argv.includes("--dry-run");
const at = new Date().toISOString();

const docs: [SecuritySourceKey, string, (md: string, at: string) => SecuritySourceRecord | null][] = [
  ["control_matrix", "docs/security/control-matrix.md", controlMatrixRecord],
  ["osp_register", "docs/security/osp-register.md", ospRegisterRecord],
];

for (const [key, file, build] of docs) {
  if (!existsSync(file)) {
    console.log(`skip ${key}: ${file} not found`);
    continue;
  }
  const rec = build(readFileSync(file, "utf8"), at);
  if (!rec) {
    console.log(`skip ${key}: no status table parsed from ${file}`);
    continue;
  }
  const kvKey = SECURITY_KV.source(key);
  if (dry) {
    console.log(`${kvKey} ← ${rec.summary}`);
    continue;
  }
  execFileSync("npx", ["wrangler", "kv", "key", "put", kvKey, JSON.stringify(rec), "--binding", "RULES", local ? "--local" : "--remote"], { stdio: "inherit" });
  console.log(`pushed ${kvKey}: ${rec.summary}`);
}
