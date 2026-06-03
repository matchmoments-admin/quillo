#!/usr/bin/env node
// Generate a tenant + ingest key and print the SQL to seed them.
// Usage: node scripts/seed-tenant.mjs <userId> <emailLocalpart> [keyLabel]
//   node scripts/seed-tenant.mjs me me web
// Then run the printed statements via:
//   wrangler d1 execute tax-agent-db --command "<sql>"
import { randomUUID, randomBytes } from "node:crypto";

const [, , userId = "me", localpart = "me", label = "web"] = process.argv;
const keyId = `k_${randomBytes(6).toString("hex")}`;
const secret = randomBytes(32).toString("base64url");

const sql = [
  `INSERT INTO tenants (user_id, display_name, email_localpart) VALUES ('${userId}','${userId}','${localpart}');`,
  `INSERT INTO profiles (user_id, gst_registered, ledger_provider) VALUES ('${userId}', 1, 'qbo');`,
  // Self person (apportionment root). Deterministic id matches 0006_persons.sql's backfill +
  // the selfPersonId() default used by addProperty/addEntity, so those always resolve.
  `INSERT INTO persons (id, user_id, display_name, role) VALUES ('person_self_${userId}','${userId}','${userId}','self');`,
  `INSERT INTO tenant_keys (key_id, user_id, secret, label) VALUES ('${keyId}','${userId}','${secret}','${label}');`,
].join("\n");

console.log("# Run each statement with: wrangler d1 execute tax-agent-db --command \"...\"\n");
console.log(sql);
console.log(`\n# Save these for the client (scripts/upload.mjs):`);
console.log(`KEY_ID=${keyId}`);
console.log(`SECRET=${secret}`);
console.log(`\n# Receipts emailed to receipts+${localpart}@<yourdomain> will route to this tenant.`);
console.log(`# NOTE: consent for US (anthropic) inference is required before extraction runs:`);
console.log(`#   POST /consent {"text":"...","method":"web"}  (signed like /ingest)`);
console.log(`#   or set profiles.inference_provider='bedrock' to skip cross-border processing.`);
