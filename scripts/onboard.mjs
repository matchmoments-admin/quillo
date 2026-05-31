#!/usr/bin/env node
// Declarative tenant onboarding: write a tenant's full situation (entities, properties,
// per-user rules) from a JSON file. See situation.example.json for the shape.
// Usage: node scripts/onboard.mjs --file <situation.json> [--local] [--with-key]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";

const argFile = (() => {
  const i = process.argv.indexOf("--file");
  return i >= 0 ? process.argv[i + 1] : null;
})();
if (!argFile) {
  console.error("usage: node scripts/onboard.mjs --file <situation.json> [--local] [--with-key]");
  process.exit(1);
}
const local = process.argv.includes("--local");
const withKey = process.argv.includes("--with-key");

const s = JSON.parse(readFileSync(argFile, "utf8"));
const userId = s.tenant.user_id;
const q = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const num = (v, d = 0) => (v == null ? d : Number(v));

const stmts = [];
// Tenant + profile: upsert (idempotent re-onboarding).
stmts.push(
  `INSERT OR REPLACE INTO tenants (user_id, display_name, email_localpart) VALUES (${q(userId)}, ${q(s.tenant.display_name)}, ${q(s.tenant.email_localpart)});`,
);
const p = s.profile ?? {};
stmts.push(
  `INSERT OR REPLACE INTO profiles (user_id, gst_registered, ledger_provider, inference_provider, inference_region) ` +
    `VALUES (${q(userId)}, ${num(p.gst_registered)}, ${q(p.ledger_provider ?? "qbo")}, ${p.inference_provider ? q(p.inference_provider) : "NULL"}, ${p.inference_region ? q(p.inference_region) : "NULL"});`,
);

// Situation rows: clear-and-reinsert for this user so re-onboarding is clean.
stmts.push(`DELETE FROM entities WHERE user_id = ${q(userId)};`);
for (const e of s.entities ?? []) {
  stmts.push(
    `INSERT INTO entities (id, user_id, kind, name, detail_json) VALUES (${q(randomUUID())}, ${q(userId)}, ${q(e.kind)}, ${q(e.name)}, ${q(JSON.stringify(e.detail ?? {}))});`,
  );
}
stmts.push(`DELETE FROM properties WHERE user_id = ${q(userId)};`);
const propIdByLabel = {};
for (const pr of s.properties ?? []) {
  const id = randomUUID();
  propIdByLabel[pr.label] = id;
  stmts.push(
    `INSERT INTO properties (id, user_id, label, address, status, ownership_pct, acquired_date, notes) ` +
      `VALUES (${q(id)}, ${q(userId)}, ${q(pr.label)}, ${q(pr.address)}, ${q(pr.status ?? "rented")}, ${num(pr.ownership_pct, 100)}, ${q(pr.acquired_date)}, ${q(pr.notes)});`,
  );
}
stmts.push(`DELETE FROM user_rules WHERE user_id = ${q(userId)};`);
for (const r of s.rules ?? []) {
  const pid = r.property_label ? propIdByLabel[r.property_label] ?? null : r.property_id ?? null;
  stmts.push(
    `INSERT INTO user_rules (id, user_id, match_type, pattern, bucket, ato_label, property_id, priority) ` +
      `VALUES (${q(randomUUID())}, ${q(userId)}, ${q(r.match_type ?? "merchant_contains")}, ${q(r.pattern)}, ${q(r.bucket)}, ${q(r.ato_label)}, ${pid ? q(pid) : "NULL"}, ${num(r.priority, 100)});`,
  );
}

let key = null;
if (withKey) {
  const keyId = `k_${randomBytes(6).toString("hex")}`;
  const secret = randomBytes(32).toString("base64url");
  stmts.push(
    `INSERT INTO tenant_keys (key_id, user_id, secret, label) VALUES (${q(keyId)}, ${q(userId)}, ${q(secret)}, 'onboard');`,
  );
  key = { keyId, secret };
}

const tmp = `/tmp/onboard_${userId}_${randomBytes(3).toString("hex")}.sql`;
writeFileSync(tmp, stmts.join("\n") + "\n");
execFileSync("npx", ["wrangler", "d1", "execute", "tax-agent-db", local ? "--local" : "--remote", "-y", "--file", tmp], {
  stdio: "inherit",
});

console.log(
  `\nonboarded "${userId}": ${(s.entities ?? []).length} entities, ${(s.properties ?? []).length} properties, ${(s.rules ?? []).length} rules`,
);
if (key) {
  console.log(`\ningest key — save these for the Android app / scripts/upload.mjs:`);
  console.log(`KEY_ID=${key.keyId}`);
  console.log(`SECRET=${key.secret}`);
}
console.log(`\nReminder: record APP-8 consent before US inference, or set profile.inference_provider='bedrock'.`);
