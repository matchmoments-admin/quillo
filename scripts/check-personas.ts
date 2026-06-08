#!/usr/bin/env tsx
// Persona integration verification (Phase B / G2). Builds a real DB from migrations/*.sql via the
// built-in node:sqlite, wraps it in a minimal D1 shim, seeds the two validated case studies, and runs
// the ACTUAL buildReport with the attribution_engine flag ON — asserting the acceptance criteria the
// plan defined. This is the end-to-end check that lets us flip the flag with confidence (local runtime
// can't run workerd, so this is the closest we get to a live report without prod/a browser session).
//
// Run: npx tsx scripts/check-personas.ts
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/env";
import { buildReport } from "../src/lib/report";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// ── Minimal D1 shim over node:sqlite (async surface buildReport uses) ──
class D1Stmt {
  private params: unknown[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...args: unknown[]) { this.params = args.map((a) => (a === undefined ? null : a)); return this; }
  async all<T = unknown>() { return { results: this.db.prepare(this.sql).all(...(this.params as never[])) as T[], success: true, meta: {} }; }
  async first<T = unknown>() { return (this.db.prepare(this.sql).get(...(this.params as never[])) as T) ?? null; }
  async run() { this.db.prepare(this.sql).run(...(this.params as never[])); return { success: true, meta: {} }; }
}
class D1 {
  constructor(private db: DatabaseSync) {}
  prepare(sql: string) { return new D1Stmt(this.db, sql); }
  async batch(stmts: D1Stmt[]) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

const db = new DatabaseSync(":memory:");
// Apply every migration in lexical order (same chain the drift guard validates).
for (const f of fs.readdirSync(path.join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort()) {
  db.exec(fs.readFileSync(path.join(root, "migrations", f), "utf8"));
}

const env = { DB: new D1(db), FEATURES: "attribution_engine,position_excludes_nondeductible,loan_split,wfh_car_methods,refund_netting,income_dedupe" } as unknown as Env;

// tiny seed helper
const run = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...(p as never[]));
const FY_DATE = "2025-09-01"; // inside FY 2025-26
let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── Persona 1: PAYG renter (employer-owned laptop, reimbursed spend) ──
{
  const u = "p1";
  run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'P1')`, u);
  run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u}`, u);
  // a normal deductible work expense (counts) and an employer-REIMBURSED one (must be excluded)
  run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, direction, deductibility, reimbursed) VALUES ('p1t1', ?, 'upload', 'categorised', 'bank_line', 30000, 30000, ?, 'payg', 'debit', 'likely_deductible', 0)`, u, FY_DATE);
  run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, direction, deductibility, reimbursed) VALUES ('p1t2', ?, 'upload', 'categorised', 'bank_line', 20000, 20000, ?, 'payg', 'debit', 'likely_deductible', 1)`, u, FY_DATE);
  // a self-owned monitor (depreciates) and an EMPLOYER-owned laptop (must NOT depreciate for her)
  run(`INSERT INTO assets (id, user_id, label, asset_class, cost_cents, acquired_date, owned_by) VALUES ('p1aMon', ?, 'Monitor', 'div40_plant', 40000, ?, 'self')`, u, FY_DATE);
  run(`INSERT INTO assets (id, user_id, label, asset_class, cost_cents, acquired_date, owned_by) VALUES ('p1aLap', ?, 'Work laptop', 'div40_plant', 200000, ?, 'employer')`, u, FY_DATE);
  run(`INSERT INTO depreciation_schedule (id, user_id, asset_id, fy, opening_adjustable_value_cents, days_held, deduction_cents, closing_adjustable_value_cents, method_applied) VALUES ('p1sMon', ?, 'p1aMon', '2025-26', 40000, 365, 20000, 20000, 'diminishing_value')`, u);
  run(`INSERT INTO depreciation_schedule (id, user_id, asset_id, fy, opening_adjustable_value_cents, days_held, deduction_cents, closing_adjustable_value_cents, method_applied) VALUES ('p1sLap', ?, 'p1aLap', '2025-26', 200000, 365, 50000, 150000, 'diminishing_value')`, u);
}

// ── Persona 2: PAYG + Pty Ltd + co-owned rental + father's rent-free house ──
{
  const u = "p2";
  run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'P2')`, u);
  run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u}`, u);
  run(`INSERT INTO entities (id, user_id, kind, name, person_id, entity_type) VALUES ('p2eInd', ?, 'individual', 'Me', ?, 'individual')`, u, `person_self_${u}`);
  run(`INSERT INTO entities (id, user_id, kind, name, person_id, entity_type, base_rate_entity) VALUES ('p2eCo', ?, 'company', 'Startup Pty Ltd', ?, 'company', 1)`, u, `person_self_${u}`);
  // co-owned rental (he owns 50%) + the father-occupied rent-free house
  run(`INSERT INTO properties (id, user_id, label, status, use_status, ownership_pct) VALUES ('p2pRent', ?, 'Co-owned rental', 'rented', 'rented', 50)`, u);
  run(`INSERT INTO properties (id, user_id, label, status, use_status) VALUES ('p2pDad', ?, 'Father house', 'owner_occupied', 'private_use_rent_free')`, u);
  run(`INSERT INTO property_owners (id, user_id, property_id, person_id, ownership_pct) VALUES ('p2po', ?, 'p2pRent', ?, 50)`, u, `person_self_${u}`);
  // income-activity spine
  run(`INSERT INTO income_activities (id, user_id, entity_id, activity_type, label) VALUES ('p2iaCo', ?, 'p2eCo', 'business', 'Startup')`, u);
  run(`INSERT INTO income_activities (id, user_id, activity_type, property_id, label) VALUES ('p2iaRent', ?, 'rental_property', 'p2pRent', 'Co-owned rental')`, u);

  // (a) Cloudflare bill $90 paid personally → attributed 100% to the COMPANY (shareholder loan), $0 vs salary
  run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, direction, deductibility, payer_person_id) VALUES ('p2cf', ?, 'upload', 'categorised', 'bank_line', 9000, 9000, ?, 'company', 'debit', 'undetermined', ?)`, u, FY_DATE, `person_self_${u}`);
  run(`INSERT INTO transaction_attributions (id, user_id, transaction_id, entity_id, income_activity_id, attributed_amount_cents, deduction_provision, creates_shareholder_loan) VALUES ('p2aCf', ?, 'p2cf', 'p2eCo', 'p2iaCo', 9000, 's8-1_general', 1)`, u);
  // (b) co-owned property bill $1000 paid 100% by him → he claims his 50% = $500 (TR 93/32)
  run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, property_id, direction, deductibility) VALUES ('p2co', ?, 'upload', 'categorised', 'bank_line', 100000, 100000, ?, 'property_rented', 'p2pRent', 'debit', 'undetermined')`, u, FY_DATE);
  run(`INSERT INTO transaction_attributions (id, user_id, transaction_id, entity_id, income_activity_id, attributed_pct, attributed_amount_cents, deduction_provision) VALUES ('p2aCo', ?, 'p2co', 'p2eInd', 'p2iaRent', 50, 50000, 's8-1_general')`, u);
  // (c) father-house expense $300 (raw, no attribution) → rent-free => NOT deductible, but kept visible
  run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, property_id, direction, deductibility) VALUES ('p2dad', ?, 'upload', 'categorised', 'bank_line', 30000, 30000, ?, 'property_rented', 'p2pDad', 'debit', 'undetermined')`, u, FY_DATE);
}

async function main() {
  console.log("persona verification (attribution_engine ON)");

  // ── Persona 1 ──
  const r1 = await buildReport(env, "p1", 2025);
  check("P1: employer-owned laptop earns NO decline-in-value (monitor only) → $200 dep", r1.depreciation_cents === 20000);
  check("P1: a reimbursed work expense is excluded; only the $300 genuine one counts", r1.total_deductions_cents === 30000);

  // ── Persona 2 ──
  const r2 = await buildReport(env, "p2", 2025);
  const dad = r2.per_property.find((p) => p.property_id === "p2pDad");
  const rent = r2.per_property.find((p) => p.property_id === "p2pRent");
  check("P2: Cloudflare bill routes to the COMPANY (shareholder loan), not salary", r2.attribution?.company_cents === 9000 && r2.company_tracked_cents === 9000);
  check("P2: co-owned bill paid 100% is claimed at his 50% legal interest ($500)", r2.attribution?.property_cents === 50000 && rent?.deduction_cents === 50000);
  check("P2: personal deductions = co-owned $500 only (company + rent-free house excluded)", r2.total_deductions_cents === 50000);
  check("P2: father's rent-free house yields $0 deductions", !dad || dad.deduction_cents === 0);

  // ── Flag OFF: the attribution split must NOT apply — attributed txns fall back to their raw amount
  // (the legacy path). Proves the engine is genuinely gated by attribution_engine. ──
  const envOff = { ...env, FEATURES: "position_excludes_nondeductible,loan_split,wfh_car_methods" } as unknown as Env;
  const r2off = await buildReport(envOff, "p2", 2025);
  const rentOff = r2off.per_property.find((p) => p.property_id === "p2pRent");
  check("P2 (flag off): co-owned bill counts at its full raw $1000 (no 50% split)", rentOff?.deduction_cents === 100000);
  check("P2 (flag off): no attribution block on the report", r2off.attribution === undefined);

  console.log(`\n=== personas: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}
main();
