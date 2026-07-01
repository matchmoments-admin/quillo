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
import { buildReport, useStatusDeniedExpr, propertyUndeterminedGatedExpr } from "../src/lib/report";
import { runScan, type ScanTxn } from "../src/lib/scan";
import auV1RulePack from "../src/rulepacks/au-v1.json";
import { COUNTABLE } from "../src/lib/queries";
import { fyBounds } from "../src/lib/ledger-totals";
import { buildAccountantSchedule, tieBackChecks } from "../src/lib/accountant-schedule";
import { fetchAskDigestRows, listAccounts } from "../src/lib/queries";
import { deleteRow, archiveRow, DeleteBlockedError, syncPropertyDisposalToCgt, syncIncomeCgtFromComponents } from "../src/lib/situation-write";
import { ordinaryAssessableCents, type AmmaComponents } from "../src/lib/managed-fund";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// ── Minimal D1 shim over node:sqlite (async surface buildReport uses) ──
class D1Stmt {
  private params: unknown[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...args: unknown[]) { this.params = args.map((a) => (a === undefined ? null : a)); return this; }
  async all<T = unknown>() { return { results: this.db.prepare(this.sql).all(...(this.params as never[])) as T[], success: true, meta: {} }; }
  async first<T = unknown>() { return (this.db.prepare(this.sql).get(...(this.params as never[])) as T) ?? null; }
  async run() { const r = this.db.prepare(this.sql).run(...(this.params as never[])); return { success: true, meta: { changes: Number(r.changes ?? 0) } }; }
  // Real D1 .batch() returns each statement's full result (SELECTs carry `.results`); mirror that so
  // batched SELECTs (e.g. the delete-integrity guard) resolve correctly under the shim.
  async settle() { return /^\s*(select|with)/i.test(this.sql) ? this.all() : this.run(); }
}
class D1 {
  constructor(private db: DatabaseSync) {}
  prepare(sql: string) { return new D1Stmt(this.db, sql); }
  async batch(stmts: D1Stmt[]) { const out = []; for (const s of stmts) out.push(await s.settle()); return out; }
}

const db = new DatabaseSync(":memory:");
// Apply every migration in lexical order (same chain the drift guard validates).
for (const f of fs.readdirSync(path.join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort()) {
  db.exec(fs.readFileSync(path.join(root, "migrations", f), "utf8"));
}

const env = { DB: new D1(db), FEATURES: "attribution_engine,position_excludes_nondeductible,loan_split,wfh_car_methods,car_methods,refund_netting,income_dedupe,cgt_engine,ess_engine,gst_bas,car_logbook,trust_distributions,partnership_distributions,smsf_engine,accountant_schedule,jurisdiction_period,currency_base,position_confirmed_range" } as unknown as Env;

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
  // (d) a REIMBURSED company-bucket cost $50 (raw, not attributed) → the company never bore it, so it
  // must NOT inflate the company's loss (0030 invariant on the raw company-spend path).
  run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, direction, deductibility, reimbursed) VALUES ('p2crmb', ?, 'upload', 'categorised', 'bank_line', 5000, 5000, ?, 'company', 'debit', 'undetermined', 1)`, u, FY_DATE);
}

// Helpers for the report-persona fixtures (3–10). Income is first-class (income table); expenses are
// transactions. `// GAP #NNN` marks behaviour an EPIC-#134 child issue will change — the assertion pins
// TODAY's honest behaviour so we'd notice if a later feature silently moved it.
const seedTenant = (u: string, name: string) => {
  run(`INSERT INTO tenants (user_id, display_name) VALUES (?, ?)`, u, name);
  run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u}`, u);
};
const inc = (id: string, u: string, type: string, grossCents: number, extra: Record<string, number | string> = {}) => {
  const cols = ["id", "user_id", "income_type", "fy", "gross_cents", "amount_aud_cents", ...Object.keys(extra)];
  const vals = [id, u, type, "2025-26", grossCents, grossCents, ...Object.values(extra)];
  run(`INSERT INTO income (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, ...vals);
};
const exp = (id: string, u: string, cents: number, bucket: string, deductibility = "likely_deductible", propertyId: string | null = null) =>
  run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, property_id, direction, deductibility) VALUES (?, ?, 'upload', 'categorised', 'bank_line', ?, ?, ?, ?, ?, 'debit', ?)`, id, u, cents, cents, FY_DATE, bucket, propertyId, deductibility);
const asset = (id: string, u: string, costCents: number, depCents: number, propertyId: string | null = null) => {
  run(`INSERT INTO assets (id, user_id, property_id, label, asset_class, cost_cents, acquired_date, owned_by) VALUES (?, ?, ?, 'Asset', 'div40_plant', ?, ?, 'self')`, id, u, propertyId, costCents, FY_DATE);
  run(`INSERT INTO depreciation_schedule (id, user_id, asset_id, fy, opening_adjustable_value_cents, days_held, deduction_cents, closing_adjustable_value_cents, method_applied) VALUES (?, ?, ?, '2025-26', ?, 365, ?, ?, 'diminishing_value')`, `${id}_s`, u, id, costCents, depCents, costCents - depCents);
};

// ── #254 (Wave 1): property deny-by-default — undetermined rental status / no property_id ──
// The FY24-25 E2E proved the position over-states when property-bucketed spend counts even though it
// can't land in an income-producing property: a row with NO property_id, or a property whose granular
// rental status (use_status) was never set. Option B denies both until confirmed + attributed (mirrors
// the payg 'undetermined' deny). Flag-gated, so this is the ONLY persona that turns it on; every other
// persona runs flag-OFF (byte-identical legacy behaviour).
{
  const u = "p254";
  seedTenant(u, "P254 property deny-by-default");
  run(`INSERT INTO properties (id, user_id, label, status, use_status) VALUES ('p254let', ?, 'Let rental', 'rented', 'rented')`, u); // income-producing — always counts
  run(`INSERT INTO properties (id, user_id, label, status) VALUES ('p254undet', ?, 'New rental (rental status not yet set)', 'rented')`, u); // use_status left NULL ⇒ undetermined (the granular rental status is the determinant, and it's unset)
  exp("p254a", u, 100000, "property_rented", "likely_deductible", "p254let");   // $1,000 on the let rental — counts on/off
  exp("p254b", u, 80000, "property_rented", "likely_deductible", "p254undet");  // $800 on an undetermined-status property — denied when flag ON
  exp("p254c", u, 50000, "property_rented", "likely_deductible", null);          // $500 property-bucketed but UNATTRIBUTED — denied when flag ON
}

// ── #258 (Wave 1): matched refund-netting — personal reimbursements must NOT net deductions ──
// v1 nets ALL refund credits against the deduction pool, so the founder's flatmate cost-sharing +
// personal returns wrongly reduced work deductions (under-claim). v2 nets a refund ONLY against the
// specific deductible expense it reverses (refund_for_txn_id), capped at that expense; unlinked refunds
// and ones tied to non-deductible spend are position-neutral.
{
  const u = "p258";
  seedTenant(u, "P258 matched refund-netting");
  exp("p258e1", u, 50000, "payg", "likely_deductible");  // $500 deductible work expense
  exp("p258e2", u, 20000, "unknown", "likely_not");        // $200 personal/non-deductible expense
  // $200 refund reversing the DEDUCTIBLE expense → nets under v2
  run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, direction, refund_for_txn_id) VALUES ('p258r1', ?, 'upload', 'categorised', 'bank_line', 20000, 20000, ?, 'refund', 'credit', 'p258e1')`, u, FY_DATE);
  // $300 personal reimbursement, UNLINKED → position-neutral under v2 (but v1 wrongly nets it)
  run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, direction) VALUES ('p258r2', ?, 'upload', 'categorised', 'bank_line', 30000, 30000, ?, 'refund', 'credit')`, u, FY_DATE);
  // $50 refund linked to a NON-deductible expense → matched but not a deduction ⇒ neutral
  run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, direction, refund_for_txn_id) VALUES ('p258r3', ?, 'upload', 'categorised', 'bank_line', 5000, 5000, ?, 'refund', 'credit', 'p258e2')`, u, FY_DATE);
}

// #258 cumulative cap: several refunds pointing at the SAME expense must not net more than it contributed.
{
  const u = "p258b";
  seedTenant(u, "P258b refund cumulative cap");
  exp("p258be", u, 50000, "payg", "likely_deductible"); // $500 deductible expense
  run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, direction, refund_for_txn_id) VALUES ('p258br1', ?, 'upload', 'categorised', 'bank_line', 40000, 40000, ?, 'refund', 'credit', 'p258be')`, u, FY_DATE); // $400 → e
  run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, direction, refund_for_txn_id) VALUES ('p258br2', ?, 'upload', 'categorised', 'bank_line', 30000, 30000, ?, 'refund', 'credit', 'p258be')`, u, FY_DATE); // $300 → same e
}

// ── Persona 3: Lukas, tradie (PAYG + tools/ute + a CASH side job) ──
{
  const u = "p3";
  seedTenant(u, "P3 Lukas tradie");
  inc("p3iSal", u, "salary_payg", 9500000);
  inc("p3iCash", u, "other", 800000); // GAP #136: no 'business' income_type → cash job lands in 'other'
  exp("p3t1", u, 30000, "payg"); // tools $300
  exp("p3t2", u, 20000, "payg"); // PPE boots $200
  exp("p3t3", u, 5000, "payg");  // union $50
  asset("p3aDrill", u, 80000, 20000); // depreciating drill set >$300
  run(`INSERT INTO work_use_inputs (user_id, fy, car_work_km) VALUES (?, 2025, 5000)`, u); // GAP #142: cents-per-km only
}

// ── Persona 4: Priya, rideshare/ABN sole trader (#136 closes the headline gap) ──
{
  const u = "p4";
  seedTenant(u, "P4 Priya rideshare");
  // #136: a sole trader is an INDIVIDUAL entity with a 'business' income_activity. Her net business
  // income is assessable to HER, and her s8-1 expenses reach her personal headline via the activity
  // (the attribution engine routes an individual-owned business activity to 'individual', never 'company').
  // #137: rideshare must register for GST from the first dollar — entity flagged registered.
  run(`INSERT INTO entities (id, user_id, kind, name, person_id, entity_type, gst_registered) VALUES ('p4eInd', ?, 'individual', 'Priya (sole trader)', ?, 'individual', 1)`, u, `person_self_${u}`);
  run(`INSERT INTO income_activities (id, user_id, entity_id, activity_type, label) VALUES ('p4iaBiz', ?, 'p4eInd', 'business', 'Rideshare')`, u);
  inc("p4iFares", u, "business", 4500000);
  exp("p4tFuel", u, 500000, "company"); // raw bucket is moot once attributed below
  run(`UPDATE transactions SET gst_cents = 45454 WHERE id = 'p4tFuel'`); // GST credit on the fuel input
  run(`INSERT INTO transaction_attributions (id, user_id, transaction_id, entity_id, income_activity_id, attributed_amount_cents, deduction_provision) VALUES ('p4aFuel', ?, 'p4tFuel', 'p4eInd', 'p4iaBiz', 500000, 's8-1_general')`, u);
  run(`INSERT INTO work_use_inputs (user_id, fy, car_work_km) VALUES (?, 2025, 30000)`, u); // cents-per-km caps at 5k
  // #142: a 12-week logbook shows 90% business use; $10k running costs → logbook beats the capped cents-per-km.
  run(`INSERT INTO vehicle_logbooks (id, user_id, person_id, fy, business_km, total_km, running_costs_cents, business_use_pct) VALUES ('p4lb', ?, ?, '2025-26', 27000, 30000, 1000000, 90)`, u, `person_self_${u}`);
}

// ── Persona 5: Tom, sole-trader freelancer (home studio) ──
{
  const u = "p5";
  seedTenant(u, "P5 Tom sole trader");
  run(`INSERT INTO entities (id, user_id, kind, name, person_id, entity_type) VALUES ('p5eInd', ?, 'individual', 'Tom (sole trader)', ?, 'individual')`, u, `person_self_${u}`);
  run(`INSERT INTO income_activities (id, user_id, entity_id, activity_type, label) VALUES ('p5iaBiz', ?, 'p5eInd', 'business', 'Freelance design')`, u);
  inc("p5iFees", u, "business", 11000000);
  exp("p5tSaaS", u, 300000, "company");
  run(`INSERT INTO transaction_attributions (id, user_id, transaction_id, entity_id, income_activity_id, attributed_amount_cents, deduction_provision) VALUES ('p5aSaaS', ?, 'p5tSaaS', 'p5eInd', 'p5iaBiz', 300000, 's8-1_general')`, u);
  run(`INSERT INTO work_use_inputs (user_id, fy, wfh_hours) VALUES (?, 2025, 600)`, u); // WFH fixed-rate DOES work
}

// ── Persona TS (audit wave 4): Erin, e-commerce sole trader with trading stock ──
{
  const u = "pts";
  seedTenant(u, "PTS Erin e-commerce");
  run(`INSERT INTO entities (id, user_id, kind, name, person_id, entity_type) VALUES ('ptseInd', ?, 'individual', 'Erin (sole trader)', ?, 'individual')`, u, `person_self_${u}`);
  run(`INSERT INTO income_activities (id, user_id, entity_id, activity_type, label) VALUES ('ptsiaBiz', ?, 'ptseInd', 'business', 'Online store')`, u);
  inc("ptsiSales", u, "business", 9000000); // $90k of goods sales
  // Personal (entity_id NULL) stock: opening $8k → closing $12k ⇒ +$4k assessable (s 70-35).
  run(`INSERT INTO trading_stock (id, user_id, entity_id, fy, opening_cents, closing_cents, valuation_basis) VALUES ('ptsts', ?, NULL, '2025-26', 800000, 1200000, 'cost')`, u);
  // An ENTITY-scoped stock row (separate taxpayer) that must NEVER reach the personal headline.
  run(`INSERT INTO entities (id, user_id, kind, name, entity_type) VALUES ('ptseCo', ?, 'company', 'Erin Pty Ltd', 'company')`, u);
  run(`INSERT INTO trading_stock (id, user_id, entity_id, fy, opening_cents, closing_cents) VALUES ('ptsts2', ?, 'ptseCo', '2025-26', 0, 5000000)`, u);
}

// ── Persona 6: Susan & Greg, co-owned negatively-geared landlords ──
{
  const u = "p6";
  seedTenant(u, "P6 landlords");
  run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'Spouse', 'spouse')`, `person_spouse_${u}`, u);
  run(`INSERT INTO properties (id, user_id, label, status, use_status, ownership_pct) VALUES ('p6prop', ?, 'Rental', 'rented', 'rented', 50)`, u);
  run(`INSERT INTO property_owners (id, user_id, property_id, person_id, ownership_pct) VALUES ('p6po1', ?, 'p6prop', ?, 50)`, u, `person_self_${u}`);
  run(`INSERT INTO property_owners (id, user_id, property_id, person_id, ownership_pct) VALUES ('p6po2', ?, 'p6prop', ?, 50)`, u, `person_spouse_${u}`);
  inc("p6iSal", u, "salary_payg", 13000000); // $130k salary
  run(`INSERT INTO income (id, user_id, income_type, property_id, fy, gross_cents, amount_aud_cents) VALUES ('p6iRent', ?, 'rent', 'p6prop', '2025-26', 2000000, 2000000)`, u);
  exp("p6tExp", u, 3000000, "property_rented", "likely_deductible", "p6prop"); // interest/rates/agent
  asset("p6aPlant", u, 8000000, 2000000, "p6prop"); // Div 40 plant on the rental
  // #181: a SECOND property held rent-free for family — its $1,500 holding cost must surface in the
  // accountant schedule's NOT-CLAIMED section (with the rent-free reason), never in deductions.
  run(`INSERT INTO properties (id, user_id, label, status, use_status) VALUES ('p6beach', ?, 'Beach house (family, rent-free)', 'owner_occupied', 'private_use_rent_free')`, u);
  exp("p6tBeach", u, 150000, "property_rented", "undetermined", "p6beach");
}

// ── Persona NC (audit wave 4): Ivy, influencer — non-cash business income at market value ──
// Assessability is TYPE-driven (NON_ASSESSABLE_INCOME_TYPES is a denylist): a `non_cash_business` row
// counts at market value; the same value as `non_cash_benefit` stays capture-only. The flag gates
// CREATION (recordIncome rejects the type when off) — these rows are seeded directly, proving the
// summation path needs no flag branch.
{
  const u = "pnc";
  seedTenant(u, "PNC Ivy influencer");
  run(`INSERT INTO entities (id, user_id, kind, name, person_id, entity_type) VALUES ('pnceInd', ?, 'individual', 'Ivy (sole trader)', ?, 'individual')`, u, `person_self_${u}`);
  run(`INSERT INTO income_activities (id, user_id, entity_id, activity_type, label) VALUES ('pnciaBiz', ?, 'pnceInd', 'business', 'Content creation')`, u);
  inc("pnciCash", u, "business", 4000000);            // $40k platform/brand cash income
  inc("pnciGift", u, "non_cash_business", 600000);     // $6k of gifted product at market value → ASSESSABLE
  inc("pnciHobby", u, "non_cash_benefit", 200000);     // $2k personal gift → capture-only, excluded
}

// ── Persona 7: Nadia, nurse with TWO employers (multi-income aggregation) ──
{
  const u = "p7";
  seedTenant(u, "P7 Nadia nurse");
  inc("p7iSal1", u, "salary_payg", 5000000); // hospital
  inc("p7iSal2", u, "salary_payg", 3800000); // agency shifts
  exp("p7tEdu", u, 120000, "payg"); // wound-care course (current role)
  exp("p7tUni", u, 20000, "payg");  // compulsory uniform
  // GAP #143: no occupation content layer to pre-suggest AHPRA/union/PPE or warn on conventional clothing
}

// ── Persona 8: James, company + discretionary trust ──
{
  const u = "p8";
  seedTenant(u, "P8 James co+trust");
  run(`INSERT INTO entities (id, user_id, kind, name, person_id, entity_type, base_rate_entity) VALUES ('p8eCo', ?, 'company', 'Trading Pty Ltd', ?, 'company', 1)`, u, `person_self_${u}`);
  run(`INSERT INTO entities (id, user_id, kind, name, person_id, entity_type) VALUES ('p8eTrust', ?, 'trust', 'Family Trust', ?, 'trust')`, u, `person_self_${u}`);
  run(`INSERT INTO income (id, user_id, entity_id, income_type, fy, gross_cents, amount_aud_cents) VALUES ('p8iCoRev', ?, 'p8eCo', 'business', '2025-26', 3000000, 3000000)`, u); // H1: company revenue — a SEPARATE taxpayer's income, must NOT touch his personal headline
  exp("p8tCoExp", u, 1000000, "company", "likely_deductible"); // company's own spend
  // #139: the trust distributes $50k to him as a FRANKED dividend ($15k franking) — character retained.
  run(`INSERT INTO trust_distributions (id, user_id, trust_entity_id, fy, beneficiary_person_id, amount_cents, character, franking_credit_cents) VALUES ('p8dist', ?, 'p8eTrust', '2025-26', ?, 5000000, 'franked_dividend', 1500000)`, u, `person_self_${u}`);
}

// ── Persona 9: Aisha, pre-revenue startup founder ──
{
  const u = "p9";
  seedTenant(u, "P9 Aisha founder");
  run(`INSERT INTO entities (id, user_id, kind, name, person_id, entity_type, base_rate_entity) VALUES ('p9eCo', ?, 'company', 'Startup Pty Ltd', ?, 'company', 1)`, u, `person_self_${u}`);
  run(`INSERT INTO rd_claims (id, user_id, entity_id, fy, eligible_expenditure_cents, aggregated_turnover_cents, offset_type, registered_with_ausindustry) VALUES ('p9rd', ?, 'p9eCo', '2025-26', 4000000, 0, 'refundable', 0)`, u); // NOT registered
  // #141: ESS — a staff startup-concession option (eligible, ≤10% → defers to CGT, $0 income now) and a
  // taxed-upfront grant (discount assessable now).
  run(`INSERT INTO ess_grants (id, user_id, person_id, employer_entity_id, scheme_type, grant_date, taxing_point_date, discount_cents, ownership_gt_10pct) VALUES ('p9essA', ?, ?, 'p9eCo', 'startup', '2025-09-01', '2025-09-01', 1000000, 0)`, u, `person_self_${u}`);
  run(`INSERT INTO ess_grants (id, user_id, person_id, employer_entity_id, scheme_type, grant_date, taxing_point_date, discount_cents, ownership_gt_10pct) VALUES ('p9essB', ?, ?, 'p9eCo', 'taxed_upfront', '2025-09-01', '2025-09-01', 500000, 0)`, u, `person_self_${u}`);
}

// ── p1maya (#179): Maya, PAYG + WFH — the accountant-schedule Golden A tenant ──
// Separate from p1 so p1's pinned totals stay byte-exact. One receipt-backed deduction, one
// bank-line-only deduction (the substantiation gap), and WFH hours (the work-method section).
{
  const u = "p1maya";
  seedTenant(u, "P1 Maya (schedule golden)");
  inc("p1mSal", u, "salary_payg", 8000000); // $80k salary
  exp("p1mt1", u, 15000, "payg"); // $150 keyboard — bank line ONLY (substantiation gap)
  run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, direction, deductibility, receipt_key) VALUES ('p1mt2', ?, 'upload', 'categorised', 'receipt', 8000, 8000, ?, 'payg', 'debit', 'likely_deductible', 'receipts/p1maya/keyboard.jpg')`, u, FY_DATE); // $80 cable — receipt on file
  run(`INSERT INTO work_use_inputs (user_id, fy, wfh_hours) VALUES (?, 2025, 400)`, u); // 400h × 70c = $280
}

// ── quillo_fee_deduction: a paid Quillo top-up auto-recorded as the customer's own D10 "cost of
// managing tax affairs" deduction (s25-5). The flag gates the WRITE (creditWallet → recordFeeDeduction);
// buildReport just reads rows, so the golden pins that the EXACT row recordFeeDeduction emits
// (source='quillo', status='extracted', kind='receipt', bucket='payg', ato_label='D10',
// deductibility='confirmed_deductible', debit) is COUNTED as a deduction, and that its absence is
// byte-identical. Two otherwise-identical PAYG tenants: pfeeoff (no fee) vs pfeeon (one $10 fee row). ──
{
  const u = "pfeeoff";
  seedTenant(u, "Quillo fee — control (no fee recorded)");
  inc("pfeeoffSal", u, "salary_payg", 5000000); // $50k salary, no expenses
}
{
  const u = "pfeeon";
  seedTenant(u, "Quillo fee — recorded D10 deduction");
  inc("pfeeonSal", u, "salary_payg", 5000000); // identical $50k salary
  // Mirror recordFeeDeduction's INSERT exactly (a paid $10 top-up):
  run(`INSERT INTO transactions (id, user_id, source, status, kind, merchant, amount_cents, currency, amount_aud_cents, gst_cents, txn_date, bucket, ato_label, deductibility, deductible_amount_cents, direction, confidence, reasoning, ledger_ref) VALUES ('pfeeonT', ?, 'quillo', 'extracted', 'receipt', 'Quillo', 1000, 'AUD', 1000, NULL, ?, 'payg', 'D10', 'confirmed_deductible', 1000, 'debit', 1.0, 'Quillo subscription fee — cost of managing tax affairs (s25-5, label D10)', 'cs_test_persona')`, u, FY_DATE); // $10 fee
}

// ── Persona 10: Margaret, SMSF retiree + crypto ──
{
  const u = "p10";
  seedTenant(u, "P10 Margaret SMSF");
  run(`INSERT INTO entities (id, user_id, kind, name, person_id, entity_type) VALUES ('p10eSmsf', ?, 'individual', 'Family SMSF', ?, 'smsf')`, u, `person_self_${u}`);
  // #140: she's 67, fully in retirement (pension) phase → ECPI 100% → fund earnings tax-exempt.
  run(`INSERT INTO smsf_members (id, user_id, smsf_entity_id, person_id, phase, pension_balance_cents, accumulation_balance_cents) VALUES ('p10mem', ?, 'p10eSmsf', ?, 'pension', 200000000, 0)`, u, `person_self_${u}`);
  run(`INSERT INTO income (id, user_id, entity_id, income_type, fy, gross_cents, amount_aud_cents) VALUES ('p10iFund', ?, 'p10eSmsf', 'dividend', '2025-26', 4000000, 4000000)`, u); // SMSF fund earnings $40k
  inc("p10iDiv", u, "dividend", 700000, { franking_credit_cents: 300000 }); // PERSONAL dividend (outside super) — franking captured
  // #138: a crypto parcel held >12 months (BTC) disposed at a $10k gain → 50% discount applies.
  run(`INSERT INTO cgt_assets (id, user_id, person_id, asset_kind, code, units, acquired_date, cost_base_cents) VALUES ('p10cBtc', ?, ?, 'crypto', 'BTC', 0.5, '2023-01-01', 2000000)`, u, `person_self_${u}`);
  run(`INSERT INTO cgt_events (id, user_id, cgt_asset_id, fy, event_date, proceeds_cents, cost_base_used_cents) VALUES ('p10eBtc', ?, 'p10cBtc', '2025-26', '2025-09-01', 3000000, 2000000)`, u); // $30k − $20k = $10k gain, held >12mo
}

async function main() {
  console.log("persona verification (attribution_engine ON)");

  // ── Persona 1 ──
  const r1 = await buildReport(env, "p1", 2025);
  check("P1: employer-owned laptop earns NO decline-in-value (monitor only) → $200 dep", r1.depreciation_cents === 20000);
  check("P1: a reimbursed work expense is excluded; only the $300 genuine one counts", r1.total_deductions_cents === 30000);

  // ── PHI Extras Tracker (0062): extras tracking is engagement/display ONLY and must NOT touch the
  // tax position. Flipping phi_extras_tracker (and the held-OFF phi_tax_inputs) ON must leave
  // taxable_position_cents byte-identical — the feature never feeds report.ts. This is the persona
  // contract for the additive, flag-gated spine; later slices that wire detection/UI keep it green. ──
  const envPhi = { ...env, FEATURES: `${(env as { FEATURES: string }).FEATURES},phi_extras_tracker,phi_tax_inputs` } as unknown as Env;
  const r1phi = await buildReport(envPhi, "p1", 2025);
  check("PHI (flag ON): taxable position byte-identical (extras tracking is display-only)", r1phi.taxable_position_cents === r1.taxable_position_cents);
  check("PHI (flag ON): deductions byte-identical (no allied-health auto-claim)", r1phi.total_deductions_cents === r1.total_deductions_cents);

  // ── quillo_fee_deduction: the recorded $10 Quillo fee counts as a D10 deduction; absent ⇒ byte-identical ──
  const rFeeOff = await buildReport(env, "pfeeoff", 2025);
  const rFeeOn = await buildReport(env, "pfeeon", 2025);
  check("Fee D10: control PAYG tenant (no fee) has zero deductions", rFeeOff.total_deductions_cents === 0);
  check("Fee D10: the recorded $10 Quillo fee is counted as a deduction", rFeeOn.total_deductions_cents === 1000);
  check("Fee D10: the fee (and only the fee) lowers the taxable position by $10", rFeeOn.taxable_position_cents === rFeeOff.taxable_position_cents - 1000);

  // ── Persona 2 ──
  const r2 = await buildReport(env, "p2", 2025);
  const dad = r2.per_property.find((p) => p.property_id === "p2pDad");
  const rent = r2.per_property.find((p) => p.property_id === "p2pRent");
  check("P2: Cloudflare bill routes to the COMPANY track (not salary)", r2.attribution?.company_cents === 9000);
  check("P2: co-owned bill paid 100% is claimed at his 50% legal interest ($500)", r2.attribution?.property_cents === 50000 && rent?.deduction_cents === 50000);
  check("P2: personal deductions = co-owned $500 only (company + rent-free house excluded)", r2.total_deductions_cents === 50000);
  check("P2: father's rent-free house yields $0 deductions", !dad || dad.deduction_cents === 0);

  // ── Phase C: the company position (separate taxpayer) ──
  const co = r2.company_positions?.find((c) => c.entity_id === "p2eCo");
  check("P2: pre-revenue company shows a carried-forward loss = its $90 deductions", !!co && co.current_year_loss_cents === 9000 && co.total_carry_forward_cents === 9000 && co.assessable_income_cents === 0);
  check("P2: founder→company funding recorded as a shareholder loan ($90, not Div 7A)", co?.shareholder_loan_balance_cents === 9000);
  check("P2: R&D not auto-claimed without a registered AusIndustry rd_claims row", co?.rd_eligible === false);
  check("P2: company is a base-rate entity (25%)", co?.base_rate_entity === 1);

  // ── D.0: attributed amounts feed the secondary display figures too (no under-count) ──
  const rentDisplay = r2.by_property.find((p) => p.property_id === "p2pRent");
  check("D.0: co-owned property tracked-spend display reflects the attributed $500", rentDisplay?.total_cents === 50000);
  check("D.0: resolved-deductible includes the attributed personal deduction ($500)", r2.resolved_deductible_cents === 50000);

  // ── Flag OFF: the attribution split must NOT apply — attributed txns fall back to their raw amount
  // (the legacy path). Proves the engine is genuinely gated by attribution_engine. ──
  const envOff = { ...env, FEATURES: "position_excludes_nondeductible,loan_split,wfh_car_methods" } as unknown as Env;
  const r2off = await buildReport(envOff, "p2", 2025);
  const rentOff = r2off.per_property.find((p) => p.property_id === "p2pRent");
  check("P2 (flag off): co-owned bill counts at its full raw $1000 (no 50% split)", rentOff?.deduction_cents === 100000);
  check("P2 (flag off): no attribution block on the report", r2off.attribution === undefined);

  // ── #254 (Wave 1): property deny-by-default ──
  const env254 = { ...env, FEATURES: `${(env as { FEATURES: string }).FEATURES},position_excludes_property_undetermined` } as unknown as Env;
  const r254on = await buildReport(env254, "p254", 2025);
  const r254off = await buildReport(env, "p254", 2025); // default env: new flag OFF ⇒ legacy
  check("#254 (flag OFF): legacy — all property spend counts ($1,000 + $800 + $500 = $2,300)", r254off.total_deductions_cents === 230000);
  check("#254 (flag ON): only the let rental's $1,000 counts (undetermined + unattributed denied)", r254on.total_deductions_cents === 100000);
  const p254let = r254on.per_property.find((p) => p.property_id === "p254let");
  const p254undet = r254on.per_property.find((p) => p.property_id === "p254undet");
  check("#254 (flag ON): the let rental keeps its $1,000 per-property deduction", p254let?.deduction_cents === 100000);
  check("#254 (flag ON): the undetermined-status property yields $0 (deny until determined)", !p254undet || p254undet.deduction_cents === 0);

  // ── #258 (Wave 1): matched refund-netting ──
  const env258 = { ...env, FEATURES: `${(env as { FEATURES: string }).FEATURES},refund_netting_v2` } as unknown as Env;
  const r258on = await buildReport(env258, "p258", 2025);
  const r258off = await buildReport(env, "p258", 2025); // default env: refund_netting ON, v2 OFF ⇒ v1 global netting
  // v1: nets ALL $550 of refunds vs the $500 deductible expense → floored at $0 (the under-claim bug).
  check("#258 (v2 OFF): v1 nets all refunds globally — $500 deduction − $550 refunds → $0", r258off.total_deductions_cents === 0);
  // v2: only the $200 refund matched to the deductible expense nets → $500 − $200 = $300.
  check("#258 (v2 ON): only the matched-deductible refund nets ($500 − $200 = $300)", r258on.total_deductions_cents === 30000);
  check("#258 (v2 ON): refunds_cents reflects only the matched refund ($200)", r258on.refunds_cents === 20000);
  check("#258 (v2 ON): unlinked + non-deductible-matched refunds are flagged, not netted ($350, 2)", r258on.refunds_unmatched_cents === 35000 && r258on.refunds_unmatched_n === 2);
  // cumulative cap: $400 + $300 refunds on ONE $500 expense net $500 total (not $700) → deductions $0.
  const r258b = await buildReport(env258, "p258b", 2025);
  check("#258 (v2 ON): refunds on the same expense are capped at it ($500, not $700)", r258b.refunds_cents === 50000 && r258b.total_deductions_cents === 0);

  // ── Persona 3: tradie ──
  const r3 = await buildReport(env, "p3", 2025);
  check("P3: multi-income aggregates salary + a CASH side job ($95k + $8k 'other')", r3.income.gross_cents === 10300000);
  check("P3: depreciating tools earn decline-in-value ($200)", r3.depreciation_cents === 20000);
  check("P3: ute via cents-per-km @ 88c × 5,000km cap = $4,400", r3.work_method?.car_cents === 440000);
  check("P3 GAP #136: the cash job has no 'business' activity — it sits in 'other'", !!r3.income.by_type.find((t) => t.income_type === "other"));

  // ── Persona 4: rideshare/ABN sole trader (#136 closes the headline gap) ──
  const r4 = await buildReport(env, "p4", 2025);
  const r4biz = r4.income.by_type.find((t) => t.income_type === "business");
  check("P4 #136: business income is first-class ('business'), assessable to the individual ($45k)", r4biz?.gross_cents === 4500000);
  check("P4 #136: business fuel NETS into her individual position via the sole-trader activity (not company-orphaned)", r4.attribution?.individual_cents === 500000 && r4.company_tracked_cents === 0 && r4.taxable_position_cents === 4500000 - 500000 - 440000);
  check("P4 #142: cents-per-km still caps at 5,000km ($4,400)", r4.work_method?.car_cents === 440000);
  check("P4 #142: logbook (90% × $10k running costs = $9k) beats the capped cents-per-km, and is recommended", r4.car_logbook?.logbook_deduction_cents === 900000 && r4.car_logbook?.recommended_method === "logbook");
  check("P4 #137: GST-registered → output GST = 1/11 of $45k fares ($4,090.91)", r4.gst?.registered === true && r4.gst?.output_gst_cents === 409091);
  check("P4 #137: input GST credit on fuel → net BAS = output − input (GST is NOT income tax, not in the position)", r4.gst?.input_gst_cents === 45454 && r4.gst?.net_gst_cents === 409091 - 45454);

  // ── Persona 5: sole-trader freelancer ──
  const r5 = await buildReport(env, "p5", 2025);
  check("P5: WFH fixed-rate works (600h × 70c = $420)", r5.work_method?.wfh_cents === 42000);
  check("P5 #136: sole-trader business software ($3k) now nets into the individual position", r5.attribution?.individual_cents === 300000 && r5.company_tracked_cents === 0 && r5.taxable_position_cents === 11000000 - 300000 - 42000);

  // ── Persona TS (audit wave 4): trading stock — flag-gated s 70-35 adjustment ──
  // Local env override (P-car pattern): the base harness env never sets trading_stock, so the other
  // personas prove OFF ⇒ byte-identical by construction.
  const envTS = { DB: (env as unknown as { DB: unknown }).DB, FEATURES: `${(env as unknown as { FEATURES: string }).FEATURES},trading_stock` } as unknown as Env;
  const rTsOn = await buildReport(envTS, "pts", 2025);
  check("PTS: +$4k stock adjustment (closing $12k − opening $8k) lands in the position", rTsOn.taxable_position_cents === 9000000 + 400000);
  check("PTS: the report carries the itemised trading_stock block", rTsOn.trading_stock?.adjustment_cents === 400000 && rTsOn.trading_stock?.opening_cents === 800000 && rTsOn.trading_stock?.closing_cents === 1200000);
  check("PTS: the company's stock row (separate taxpayer) stays OUT of the personal headline", rTsOn.taxable_position_cents === 9400000); // $50k company closing stock would have shown here
  check("PTS: confirmed-range floor carries the adjustment too (no range inversion)", rTsOn.taxable_position_confirmed_cents === 9400000);
  const rTsOff = await buildReport(env, "pts", 2025);
  check("PTS: flag OFF ⇒ no field, no adjustment (byte-identical)", rTsOff.taxable_position_cents === 9000000 && rTsOff.trading_stock === undefined);

  // ── Persona 6: co-owned negatively-geared landlords (verifies neg-gearing NETS) ──
  const r6 = await buildReport(env, "p6", 2025);
  const r6prop = r6.per_property.find((p) => p.property_id === "p6prop");
  check("P6: negative gearing NETS — ($130k salary + $20k rent) − $30k expenses − $20k dep = $100k", r6.taxable_position_cents === 10000000);
  check("P6: per-property shows the $30k rental loss", r6prop?.net_cents === -3000000);

  // ── Persona NC (audit wave 4): non-cash business income ──
  const rNc = await buildReport(env, "pnc", 2025);
  check("PNC: non-cash BUSINESS income counts at market value ($40k cash + $6k gifted)", rNc.income.gross_cents === 4600000 && rNc.taxable_position_cents === 4600000);
  check("PNC: a personal non-cash benefit stays capture-only (excluded_by_type carries the $2k)", (rNc.income.excluded_by_type ?? []).some((e) => e.income_type === "non_cash_benefit" && e.gross_cents === 200000));


  // ── Persona 7: nurse, two employers ──
  const r7 = await buildReport(env, "p7", 2025);
  const r7sal = r7.income.by_type.find((t) => t.income_type === "salary_payg");
  check("P7: two employers' salaries aggregate into one income figure ($88k)", r7.income.gross_cents === 8800000 && r7sal?.n === 2);
  check("P7: self-education + uniform are deductible ($1,400)", r7.total_deductions_cents === 140000);

  // ── Persona 8: company + trust ──
  const r8 = await buildReport(env, "p8", 2025);
  const r8co = r8.company_positions?.find((c) => c.entity_id === "p8eCo");
  check("P8: the company is a separate taxpayer ($30k income − $10k deductions, no current-year loss)", r8co?.assessable_income_cents === 3000000 && r8co?.current_year_loss_cents === 0);
  check("P8 H1: the company's $30k income is NOT in the member's personal headline (separate taxpayer)", r8.income.gross_cents === 0 && r8.taxable_position_cents === 5000000);
  check("P8 #139: trust distribution retains FRANKED character — $50k assessable + $15k franking carried", r8.trust?.assessable_cents === 5000000 && r8.trust?.franking_credit_cents === 1500000 && r8.trust?.by_character.franked_dividend === 5000000);
  check("P8 #139: the franked trust distribution feeds his position ($50k)", r8.taxable_position_cents === 5000000);

  // ── Persona 9: pre-revenue founder ──
  const r9 = await buildReport(env, "p9", 2025);
  const r9co = r9.company_positions?.find((c) => c.entity_id === "p9eCo");
  check("P9 GAP #126: blackhole (s40-880) costs are capture-only — NOT auto-deducted into the company position", r9co?.deductions_cents === 0);
  check("P9: R&D not auto-claimed without AusIndustry registration", r9co?.rd_eligible === false);
  check("P9 #141: startup-concession ESS option defers to CGT ($10k), taxed-upfront discount is assessable ($5k)", r9.ess?.startup_deferred_to_cgt_cents === 1000000 && r9.ess?.assessable_discount_cents === 500000);
  check("P9 #141: only the taxed-upfront ESS discount feeds the position ($5k)", r9.taxable_position_cents === 500000);

  // ── Persona 10: SMSF retiree + crypto ──
  const r10 = await buildReport(env, "p10", 2025);
  check("P10: franking credits on dividends are captured ($3k)", r10.income.franking_credit_cents === 300000);
  check("P10 #138: crypto held >12mo, $10k gain → 50% discount → $5k net capital gain", r10.capital_gains?.net_capital_gain_cents === 500000);
  check("P10 #138: net capital gain feeds the position; dividend stays gross (no franking gross-up) → $7k + $5k = $12k", r10.taxable_position_cents === 1200000);
  check("P10 #140: SMSF fully in pension phase → ECPI 100% → fund earnings tax-exempt ($0 fund taxable income)", r10.smsf_funds?.[0]?.assessable_income_cents === 4000000 && r10.smsf_funds?.[0]?.fund_taxable_income_cents === 0 && r10.smsf_funds?.[0]?.ecpi_exempt_fraction === 1);
  check("P10 #140: the SMSF's $40k fund income does NOT pollute the member's personal position (still $12k)", r10.taxable_position_cents === 1200000);

  // ── Persona 11 (#157 S5): negatively-geared investor — evidence-first loan interest ──
  // A rented property funded by an investment loan. The lender's ACTUAL FY interest ($12k) is the
  // source of truth; a stale legacy per-line split row for the SAME loan must NOT also count (one
  // source per loan per FY); and the v2 figure must equal what the legacy split produced for the same $.
  {
    const u = "p11";
    run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'P11')`, u);
    run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u}`, u);
    run(`INSERT INTO properties (id, user_id, label, status, use_status) VALUES ('p11rent', ?, 'Investment unit', 'rented', 'rented')`, u);
    run(`INSERT INTO accounts (id, user_id, name, type, source) VALUES ('p11loan', ?, 'Investment Loan', 'loan', 'statement')`, u);
    run(`INSERT INTO loans_properties (id, user_id, loan_account_id, property_id, deductible_interest_pct) VALUES ('p11lp', ?, 'p11loan', 'p11rent', 100)`, u);
    run(`INSERT INTO loan_interest_summaries (id, user_id, loan_account_id, fy, interest_cents, source) VALUES ('p11lis', ?, 'p11loan', '2025', 1200000, 'lender_summary')`, u);
    // a STALE legacy per-line split row on the same loan ($12k interest of a $20k repayment) — must be
    // superseded by the summary under v2, never double-counted.
    run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, ato_label, property_id, account_id, direction, deductibility, deductible_amount_cents) VALUES ('p11int', ?, 'upload', 'categorised', 'bank_line', 2000000, 2000000, ?, 'property_rented', 'rental:interest', 'p11rent', 'p11loan', 'debit', 'confirmed_deductible', 1200000)`, u, FY_DATE);
    run(`INSERT INTO income (id, user_id, income_type, fy, gross_cents, amount_aud_cents, property_id) VALUES ('p11rinc', ?, 'rent', '2025-26', 1000000, 1000000, 'p11rent')`, u);
    // Regression guard A (NULL-safe exclusion): a NULL-ato_label rental expense on a DIFFERENT property
    // must NOT be dropped under v2 — `NOT (NULL='rental:interest')` is NULL, so a naive clause would
    // wrongly exclude every NULL-ato_label row. $500 deductible, must survive.
    run(`INSERT INTO properties (id, user_id, label, status, use_status) VALUES ('p11rent2', ?, 'Unit 2', 'rented', 'rented')`, u);
    run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, property_id, direction, deductibility) VALUES ('p11r2exp', ?, 'upload', 'categorised', 'bank_line', 50000, 50000, ?, 'property_rented', 'p11rent2', 'debit', 'likely_deductible')`, u, FY_DATE);
    // Regression guard B (scoped exclusion): a loan with a legacy split but NO v2 figure (no summary,
    // no rate/balance) is NOT superseded — its per-line split ($3k) must KEEP counting under v2.
    run(`INSERT INTO properties (id, user_id, label, status, use_status) VALUES ('p11rent3', ?, 'Unit 3', 'rented', 'rented')`, u);
    run(`INSERT INTO accounts (id, user_id, name, type, source) VALUES ('p11loan2', ?, 'Loan 2', 'loan', 'statement')`, u);
    run(`INSERT INTO loans_properties (id, user_id, loan_account_id, property_id, deductible_interest_pct) VALUES ('p11lp2', ?, 'p11loan2', 'p11rent3', 100)`, u);
    run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, ato_label, property_id, account_id, direction, deductibility, deductible_amount_cents) VALUES ('p11int2', ?, 'upload', 'categorised', 'bank_line', 500000, 500000, ?, 'property_rented', 'rental:interest', 'p11rent3', 'p11loan2', 'debit', 'confirmed_deductible', 300000)`, u, FY_DATE);

    const envV2 = { ...env, FEATURES: `${(env as { FEATURES: string }).FEATURES},loan_interest_v2` } as unknown as Env;
    const r11 = await buildReport(envV2, u, 2025);
    const p11prop = r11.per_property?.find((p) => p.property_id === "p11rent");
    check("P11 #157: evidence-first interest ($12k) is the property's deduction — NOT the legacy split row", p11prop?.deduction_cents === 1200000);
    check("P11 #157: NO double count — summary supersedes the stale split (deduction is $12k, not $24k)", p11prop?.deduction_cents === 1200000);
    check("P11 #157: per-property net = rent $10k − interest $12k = −$2k (negatively geared)", p11prop?.net_cents === -200000);
    check("P11 #157 (NULL-safe): a NULL-ato_label rental expense is NOT dropped under v2 ($500 kept)", r11.per_property?.find((p) => p.property_id === "p11rent2")?.deduction_cents === 50000);
    check("P11 #157 (scoped): a legacy split on a loan with NO v2 figure still counts ($3k kept)", r11.per_property?.find((p) => p.property_id === "p11rent3")?.deduction_cents === 300000);
    check("P11 #157: headline deductions = v2 interest $12k + $500 expense + kept split $3k = $15.5k", r11.total_deductions_cents === 1550000);
    // BUG FIX: resolved_deductible_cents must apply the SAME loan_interest_v2 supersession as the headline.
    // The superseded $12k legacy split (p11int, on a loan with a v2 summary) must NOT be summed here, or
    // resolved over-states. Expect $3k confirmed (p11int2) + $0.5k likely (p11r2exp) = $3.5k; never $15.5k.
    check("P11 #157: resolved-deductible excludes the superseded split (no double-count) — $3.5k", r11.resolved_deductible_cents === 350000);

    // Cross-check: the legacy split (loan_split ON, loan_interest_v2 OFF) yields the SAME $ — proving the
    // two engines agree, so flipping to v2 doesn't move the position for honest data.
    const r11legacy = await buildReport(env, u, 2025);
    const p11legacy = r11legacy.per_property?.find((p) => p.property_id === "p11rent");
    check("P11 #157: legacy split and evidence-first agree on the deductible interest ($12k each)", p11legacy?.deduction_cents === 1200000 && p11legacy.deduction_cents === p11prop?.deduction_cents);
    check("P11 #157: headline deductions match across both engines ($15.5k)", r11legacy.total_deductions_cents === r11.total_deductions_cents && r11.total_deductions_cents === 1550000);
  }

  // ── Attribution regression (#240 follow-up): a property_rented debit attributes to a property ONLY
  // when it carries a property_id. The harness is engine-only (buildReport), so this pins the behaviour
  // the import/clarify paths feed: a learned property-scoped rule MUST stamp property_id (M1), or the
  // expense deducts at the headline but never appears in the property's schedule. ──
  {
    const u = "pattr";
    seedTenant(u, "Attribution");
    run(`INSERT INTO properties (id, user_id, label, status, use_status) VALUES ('paUnit', ?, 'Attr Unit', 'rented', 'rented')`, u);
    exp("paWith", u, 60000, "property_rented", "likely_deductible", "paUnit"); // $600 attributed to paUnit
    exp("paNull", u, 40000, "property_rented", "likely_deductible", null);      // $400 with NO property
    const ra = await buildReport(env, u, 2025);
    const prop = ra.per_property?.find((p) => p.property_id === "paUnit");
    check("#240: a property_rented debit WITH property_id lands in that property's deductions ($600)", prop?.deduction_cents === 60000);
    check("#240: a NULL-property rental expense does NOT inflate the property ($600, not $1000)", prop?.deduction_cents === 60000);
    check("#240: both rental expenses still deduct at the headline ($1000) — attribution ≠ deductibility", ra.total_deductions_cents === 100000);
    // Slice A (#189): the NULL-property rental expense ($400 paNull) is surfaced as an unattributed count.
    check("#189: NULL-property rental spend is counted as unattributed (1 txn / $400)", ra.property_unattributed_n === 1 && ra.property_unattributed_cents === 40000);
  }

  // ── Persona 12 (S3/S4): content creator — the generalised self-employed spine ──
  // Brand-deal business income, foreign-sourced platform (AdSense) income WITH foreign tax (→ FITO), a
  // gifted product captured at market value but EXCLUDED from the position, a part-time salary + bank
  // interest (multi-income aggregation), and a camera that depreciates. One taxpayer exercising S3
  // (foreign_business assessable), S4 (non_cash excluded) and multi-income aggregation on the SAME engines.
  {
    const u = "p12";
    seedTenant(u, "P12 content creator");
    run(`INSERT INTO income_activities (id, user_id, activity_type, label, psi_status) VALUES ('p12iaBiz', ?, 'business', 'Content creation', 'not_psi')`, u);
    inc("p12iSal", u, "salary_payg", 3000000);       // part-time day job ($30k)
    inc("p12iBrand", u, "business", 6000000);         // brand / sponsor deals ($60k)
    inc("p12iAds", u, "foreign_business", 2500000, { foreign_tax_paid_cents: 300000 }); // AdSense ($25k, $3k foreign tax)
    inc("p12iInt", u, "interest", 200000);            // bank interest ($2k)
    inc("p12iGift", u, "non_cash_benefit", 500000);   // gifted products at market value ($5k) — EXCLUDED
    asset("p12cam", u, 400000, 100000);               // camera: $4k cost, $1k decline-in-value

    const r12 = await buildReport(env, u, 2025);
    const fb = r12.income.by_type.find((t) => t.income_type === "foreign_business");
    check("P12 S3: foreign business income is assessable + kept as its own type ($25k)", fb?.gross_cents === 2500000);
    check("P12 S3: foreign tax paid is carried for FITO ($3k)", r12.income.foreign_tax_paid_cents === 300000);
    check("P12: income aggregates salary+business+foreign_business+interest ($30k+$60k+$25k+$2k=$117k); non-cash EXCLUDED", r12.income.gross_cents === 11700000);
    check("P12 S4: the gifted product is captured but EXCLUDED from assessable income ($5k → non_cash_cents)", r12.income.non_cash_cents === 500000 && !r12.income.by_type.some((t) => t.income_type === "non_cash_benefit"));
    check("P12: camera decline-in-value is captured ($1k)", r12.depreciation_cents === 100000);
    check("P12: taxable position = $117k income − $1k depreciation = $116k (non-cash NEVER added)", r12.taxable_position_cents === 11600000);
    // Regression guard: the accountant schedule re-derives income straight from the DB — it must exclude
    // the same non-cash benefit, or its income section won't tie back to the report's total_income_cents.
    const sched12 = await buildAccountantSchedule(env, u, 2025, { report: r12 });
    const inc12 = sched12.sections.find((s) => s.key === "income");
    check("P12 S4: accountant schedule income section ties back (non-cash excluded, no double-count)", inc12?.tie_back?.ok === true && inc12?.subtotal_cents === 11700000);
  }

  // ── Persona 13: Margaret, retiree (account-based pension + bank interest) — Slice D ──
  // Proves super_pension is captured but EXCLUDED from the assessable headline (an over-60 ABP from a taxed
  // fund is tax-free; we never compute the SAPTO offset), surfaced per-type so it isn't mislabelled.
  {
    const u = "p13";
    seedTenant(u, "P13 Margaret retiree");
    inc("p13iPen", u, "super_pension", 4000000);  // account-based pension ($40k) — EXCLUDED
    inc("p13iInt", u, "interest", 200000);         // bank interest ($2k) — assessable
    const r13 = await buildReport(env, u, 2025);
    check("P13 D: super pension is captured but EXCLUDED from assessable income ($40k → excluded_by_type)",
      r13.income.excluded_by_type?.some((t) => t.income_type === "super_pension" && t.gross_cents === 4000000) === true
      && !r13.income.by_type.some((t) => t.income_type === "super_pension"));
    check("P13 D: only the $2k interest is assessable (pension never added to gross)", r13.income.gross_cents === 200000);
    check("P13 D: taxable position = $2k interest only", r13.taxable_position_cents === 200000);
    // The pension must NOT be lumped into the non-cash convenience field (it isn't a gift).
    check("P13 D: super pension is not counted as a non-cash benefit", (r13.income.non_cash_cents ?? 0) === 0);
    // Accountant schedule re-derives income from the DB — it must exclude the pension too or the tie-back breaks.
    const sched13 = await buildAccountantSchedule(env, u, 2025, { report: r13 });
    const inc13 = sched13.sections.find((s) => s.key === "income");
    check("P13 D: accountant schedule income section ties back (pension excluded, no double-count)", inc13?.tie_back?.ok === true && inc13?.subtotal_cents === 200000);
  }

  // ── Persona 14: property disposal → CGT engine (Slice F) ──
  // A disposed investment property's orphaned cost_base/disposal fields now materialise into a cgt_event
  // (via syncPropertyDisposalToCgt) and flow through the portfolio engine into the position. A second,
  // main-residence-flagged disposal must NOT create an event (no auto-exemption / no auto-tax).
  {
    const u = "p14";
    seedTenant(u, "P14 property disposer");
    // Investment property: bought $500k (2020), sold $700k (in FY 2025-26), 100% owned, held > 12 months.
    run(`INSERT INTO properties (id, user_id, label, status, ownership_pct, acquired_date, cost_base_cents, disposal_date, disposal_proceeds_cents, main_residence_flag) VALUES ('p14inv', ?, 'Investment unit', 'sold', 100, '2020-01-01', 50000000, '2025-09-01', 70000000, 0)`, u);
    // Main residence sold the same FY — captured but EXCLUDED from the computed gain (defer to agent).
    run(`INSERT INTO properties (id, user_id, label, status, ownership_pct, acquired_date, cost_base_cents, disposal_date, disposal_proceeds_cents, main_residence_flag) VALUES ('p14home', ?, 'Family home', 'sold', 100, '2015-01-01', 60000000, '2025-10-01', 90000000, 1)`, u);
    await syncPropertyDisposalToCgt(env, u, "p14inv");
    await syncPropertyDisposalToCgt(env, u, "p14home");

    const r14 = await buildReport(env, u, 2025);
    check("P14 F: investment-property gain reaches the position (gross $200k)", r14.capital_gains?.gross_capital_gains_cents === 20000000);
    check("P14 F: 50% discount applied on a 12-month+ hold ($100k)", r14.capital_gains?.discount_applied_cents === 10000000);
    check("P14 F: net capital gain ($100k) is in the taxable position", r14.capital_gains?.net_capital_gain_cents === 10000000 && r14.taxable_position_cents === 10000000);
    // Main residence: NO event materialised → it never inflates the gain.
    const homeEvents = db.prepare(`SELECT COUNT(*) AS n FROM cgt_assets WHERE user_id = ? AND property_id = 'p14home'`).get(u) as { n: number };
    check("P14 F: main-residence disposal creates NO cgt_asset (no auto-exemption / no auto-tax)", homeEvents.n === 0);
    // Idempotency: re-running the sync rebuilds exactly one asset + one event for the investment property.
    await syncPropertyDisposalToCgt(env, u, "p14inv");
    const invAssets = db.prepare(`SELECT COUNT(*) AS n FROM cgt_assets WHERE user_id = ? AND property_id = 'p14inv'`).get(u) as { n: number };
    const invEvents = db.prepare(`SELECT COUNT(*) AS n FROM cgt_events WHERE user_id = ? AND cgt_asset_id IN (SELECT id FROM cgt_assets WHERE property_id = 'p14inv')`).get(u) as { n: number };
    check("P14 F: sync is idempotent (exactly one asset + one event after re-run)", invAssets.n === 1 && invEvents.n === 1);
    const r14b = await buildReport(env, u, 2025);
    check("P14 F: position unchanged after a second sync (no double-count)", r14b.taxable_position_cents === 10000000);
  }

  // ── Persona 15: ETF / managed-fund investor — AMMA component split (Slice B) ──
  // A managed-fund distribution's ordinary income lands in gross_cents; its discounted capital gain flows
  // through the CGT engine (50% discount), NOT taxed as ordinary; the AMIT cost-base amount stays out.
  {
    const u = "p15";
    seedTenant(u, "P15 ETF investor");
    const comps: AmmaComponents = {
      franked_cents: 0, unfranked_cents: 1000000, interest_cents: 200000, other_income_cents: 0, foreign_income_cents: 300000,
      franking_credit_cents: 0, foreign_tax_paid_cents: 30000, capital_gain_discounted_cents: 2000000, capital_gain_other_cents: 0,
      amit_cost_base_net_amount_cents: 400000,
    };
    const ordinary = ordinaryAssessableCents(comps); // $15k = unfranked $10k + interest $2k + foreign $3k
    // Mirror recordIncome's write-time split: ordinary in gross, foreign tax in its column, components in detail_json.
    inc("p15mf", u, "managed_fund_distribution", ordinary, { foreign_tax_paid_cents: 30000, detail_json: JSON.stringify({ components: comps }) });
    await syncIncomeCgtFromComponents(env, u, "p15mf", comps, "2025-26", `person_self_${u}`, "Vanguard ETF", "2025-09-01");

    const r15 = await buildReport(env, u, 2025);
    const mfRow = r15.income.by_type.find((t) => t.income_type === "managed_fund_distribution");
    check("P15 B: only ORDINARY income lands in gross ($15k — CG + cost-base excluded)", mfRow?.gross_cents === 1500000 && r15.income.gross_cents === 1500000);
    check("P15 B: foreign tax paid is carried for FITO ($300)", r15.income.foreign_tax_paid_cents === 30000);
    check("P15 B: discounted capital gain flows through the CGT engine, halved ($20k → $10k net)", r15.capital_gains?.net_capital_gain_cents === 1000000);
    check("P15 B: taxable position = $15k ordinary + $10k net CG = $25k (CG NOT double-counted as income)", r15.taxable_position_cents === 2500000);
    // Accountant schedule CGT section ties back to the engine's gross gains.
    const sched15 = await buildAccountantSchedule(env, u, 2025, { report: r15 });
    const cgtSec = sched15.sections.find((s) => s.key === "cgt");
    check("P15 B: accountant schedule CGT section ties back", cgtSec?.tie_back?.ok === true);

    // Byte-identical: a managed-fund row WITHOUT components records as a single gross, no CGT (legacy path).
    const u2 = "p15b";
    seedTenant(u2, "P15b legacy managed fund");
    inc("p15bmf", u2, "managed_fund_distribution", 1800000); // single $18k gross, no components
    const r15b = await buildReport(env, u2, 2025);
    check("P15 B: a no-components managed-fund row is byte-identical (full gross, no CGT)", r15b.income.gross_cents === 1800000 && r15b.taxable_position_cents === 1800000 && r15b.capital_gains === undefined);
  }

  // ── Persona 16: partnership partner — distribution share (Slice E) ──
  // A partner's share of partnership net income (character retained) feeds the personal position exactly
  // like a trust distribution. A trust distribution in the SAME tenant must NOT cross-contaminate.
  {
    const u = "p16";
    seedTenant(u, "P16 partnership partner");
    run(`INSERT INTO entities (id, user_id, kind, name, person_id, entity_type) VALUES ('p16ePart', ?, 'partnership', 'Smith & Co Partnership', ?, 'partnership')`, u, `person_self_${u}`);
    run(`INSERT INTO entities (id, user_id, kind, name, person_id, entity_type) VALUES ('p16eTrust', ?, 'trust', 'Family Trust', ?, 'trust')`, u, `person_self_${u}`);
    // Partnership distributes $50k as a FRANKED dividend ($15k franking) — source_kind='partnership'.
    run(`INSERT INTO trust_distributions (id, user_id, trust_entity_id, fy, beneficiary_person_id, amount_cents, character, franking_credit_cents, source_kind) VALUES ('p16pdist', ?, 'p16ePart', '2025-26', ?, 5000000, 'franked_dividend', 1500000, 'partnership')`, u, `person_self_${u}`);
    // Trust distributes $20k ordinary — source_kind defaults to 'trust'.
    run(`INSERT INTO trust_distributions (id, user_id, trust_entity_id, fy, beneficiary_person_id, amount_cents, character) VALUES ('p16tdist', ?, 'p16eTrust', '2025-26', ?, 2000000, 'ordinary')`, u, `person_self_${u}`);

    const r16 = await buildReport(env, u, 2025);
    check("P16 E: partnership share is assessable to the partner ($50k)", r16.partnership?.assessable_cents === 5000000 && r16.partnership?.franking_credit_cents === 1500000);
    check("P16 E: trust + partnership don't cross-contaminate (trust $20k stays in trust)", r16.trust?.assessable_cents === 2000000);
    check("P16 E: taxable position = $50k partnership + $20k trust = $70k", r16.taxable_position_cents === 7000000);
  }

  // ── Mission-audit #10 (partnership_losses): a partnership LOSS flows to the partner; a trust loss is trapped ──
  {
    const u = "p16loss";
    seedTenant(u, "P16-loss partnership");
    run(`INSERT INTO entities (id, user_id, kind, name, person_id, entity_type) VALUES ('plossPart', ?, 'partnership', 'Loss Partners', ?, 'partnership')`, u, `person_self_${u}`);
    run(`INSERT INTO entities (id, user_id, kind, name, person_id, entity_type) VALUES ('plossTrust', ?, 'trust', 'Loss Trust', ?, 'trust')`, u, `person_self_${u}`);
    run(`INSERT INTO trust_distributions (id, user_id, trust_entity_id, fy, beneficiary_person_id, amount_cents, character, source_kind) VALUES ('plossPd', ?, 'plossPart', '2025-26', ?, -1000000, 'ordinary', 'partnership')`, u, `person_self_${u}`); // $10k partnership LOSS
    run(`INSERT INTO trust_distributions (id, user_id, trust_entity_id, fy, beneficiary_person_id, amount_cents, character) VALUES ('plossTd', ?, 'plossTrust', '2025-26', ?, -500000, 'ordinary')`, u, `person_self_${u}`); // $5k trust "loss" — trapped
    const envPL = { ...env, FEATURES: `${(env as { FEATURES: string }).FEATURES},partnership_losses` } as unknown as Env;
    const rOff = await buildReport(env, u, 2025);
    const rOn = await buildReport(envPL, u, 2025);
    check("partnership_losses OFF: partnership loss floored to 0 ⇒ position $0 (byte-identical)", (rOff.partnership?.assessable_cents ?? 0) === 0 && rOff.taxable_position_cents === 0);
    check("partnership_losses ON: the $10k partnership loss flows through (position −$10k)", rOn.partnership?.assessable_cents === -1000000 && rOn.taxable_position_cents === -1000000);
    check("partnership_losses ON: a TRUST loss stays trapped (not applied)", (rOn.trust?.assessable_cents ?? 0) === 0);
  }

  // ── Accountant schedule (#179/#181): goldens + the tie-back-by-construction loop ──

  // Golden A (#179) — Maya: the schedule's claiming sections sum EXACTLY to her report deductions,
  // and the bank-line-only claim surfaces as a substantiation gap.
  {
    const rM = await buildReport(env, "p1maya", 2025);
    const sM = await buildAccountantSchedule(env, "p1maya", 2025, { report: rM });
    const sec = (k: string) => sM.sections.find((s) => s.key === k);
    const workRelated = sec("work_related");
    const workMethods = sec("work_methods");
    check("Schedule A (#179): work-related + work-method sections sum to Maya's report deductions",
      (workRelated?.subtotal_cents ?? 0) + (workMethods?.subtotal_cents ?? 0) === rM.total_deductions_cents && rM.total_deductions_cents === 15000 + 8000 + 28000);
    const gapRows = sec("substantiation_gaps")?.rows ?? [];
    check("Schedule A (#181): the bank-line-only $150 claim is a substantiation gap; the receipt-backed one is not",
      gapRows.some((r) => r[0] === "work_related" && r[1] === 1 && r[2] === "150.00"));
    check("Schedule A: itemised rows label substantiation (receipt vs bank line)",
      (workRelated?.rows ?? []).some((r) => r.includes("Receipt on file")) && (workRelated?.rows ?? []).some((r) => r.includes("Bank line only")));
    // Phase 2c: the "Deductions mapped to return labels" routing section. The itemised work-related
    // rows (grouped by D-label) sum EXACTLY to the work_related section subtotal — routing preserves
    // the money, it just tags each group with where it lands on the return.
    const byLabel = sec("deductions_by_label");
    const itemisedRouted = (byLabel?.rows ?? []).filter((r) => r[1] === "Work-related deductions (itemised)");
    check("Schedule A (Phase 2c): work-related deductions route to return labels and sum to the work-related subtotal",
      !!byLabel && itemisedRouted.length > 0 && itemisedRouted.reduce((s, r) => s + Math.round(parseFloat(String(r[3])) * 100), 0) === (workRelated?.subtotal_cents ?? 0));
  }

  // Golden B (#181) — Susan & Greg: the rent-free beach-house holding cost lands in NOT-CLAIMED with
  // the rent-free reason, in no deduction/property subtotal, and P6's pinned position is unmoved.
  {
    const rB = await buildReport(env, "p6", 2025);
    const sB = await buildAccountantSchedule(env, "p6", 2025, { report: rB });
    const nc = sB.sections.find((s) => s.key === "not_claimed");
    const beachRow = (nc?.rows ?? []).find((r) => r[3] === "1500.00");
    check("Schedule B (#181): the rent-free property's $1,500 holding cost is EXPLICITLY NOT CLAIMED, with the rent-free reason",
      !!beachRow && String(beachRow[4]).includes("rent-free"));
    const beachSec = sB.sections.find((s) => s.key === "property:p6beach");
    check("Schedule B (#181): the rent-free property claims $0 deductions (and ties back)",
      (!beachSec || beachSec.subtotal_cents === 0) && rB.per_property.find((p) => p.property_id === "p6beach")?.deduction_cents === 0);
    check("Schedule B: P6's pinned position is unmoved by the schedule tenant data ($100k)", rB.taxable_position_cents === 10000000);
    // Phase 2: the grouped NOT-CLAIMED summary collapses the per-txn detail to count+total groups and
    // ties EXACTLY to the detail total — the rent-free holding cost is "Not claimable" (excluded).
    const ncSum = sB.sections.find((s) => s.key === "not_claimed_summary");
    check("Schedule B (Phase 2): grouped not-claimed summary subtotal == detail subtotal",
      !!ncSum && ncSum.subtotal_cents === nc?.subtotal_cents);
    check("Schedule B (Phase 2): grouped summary has fewer rows than the detail (it aggregates)",
      !!ncSum && (ncSum.rows.length) <= (nc?.rows.length ?? 0));
    check("Schedule B (Phase 2): the rent-free holding cost is segmented 'Not claimable'",
      (ncSum?.rows ?? []).some((r) => String(r[4]).includes("rent-free") && r[0] === "Not claimable"));
  }
  // Phase 2 — P2 has 'undetermined' rows (fixable): they must surface as "Worth a second look" in the
  // grouped not-claimed summary (the agent may still be able to claim them — nothing is hidden).
  {
    const r2 = await buildReport(env, "p2", 2025);
    const s2 = await buildAccountantSchedule(env, "p2", 2025, { report: r2 });
    const sum2 = s2.sections.find((s) => s.key === "not_claimed_summary");
    const det2 = s2.sections.find((s) => s.key === "not_claimed");
    check("Schedule (Phase 2) P2: grouped summary ties to the detail total",
      !!sum2 && !!det2 && sum2.subtotal_cents === det2.subtotal_cents);
    // Every grouped-summary row carries a valid confidence segment label (the "worth a second look"
    // path itself is unit-tested on notClaimedSegment — no persona seed currently leaves an
    // undetermined/suggested item UNCLAIMED, so it can't be exercised end-to-end here).
    check("Schedule (Phase 2) P2: every grouped row has a valid confidence label",
      (sum2?.rows ?? []).every((r) => r[0] === "Worth a second look" || r[0] === "Not claimable"));
  }

  // Tie-back loop — for EVERY tenant, every section that declares a tie-back must equal its
  // buildReport figure exactly (engine totals stay the single source of truth).
  for (const u of ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10", "p1maya"]) {
    const r = await buildReport(env, u, 2025);
    const s = await buildAccountantSchedule(env, u, 2025, { report: r });
    const checks = tieBackChecks(s);
    const bad = checks.filter((c) => !c.ok);
    check(`Schedule tie-back ${u}: ${checks.length} section(s) tie to the report exactly`,
      checks.length > 0 && bad.length === 0);
    if (bad.length) for (const b of bad) console.log(`      ✗ ${u} ${b.label}: section ${b.actual_cents} vs report ${b.report_cents}`);
  }
  // ── Ask Quillo C3 (ask_actions): the FY transaction digest against a REAL migrated DB ──
  // P2 mixes deductibility states: p2dad/p2crmb are 'undetermined' (fixable — must sort FIRST),
  // p2co/p2cf are attributed but still countable rows. Cap + total + COUNTABLE (no credits/dupes).
  {
    const all = await fetchAskDigestRows(env, "p2", 2025);
    check("Digest (C3): every countable P2 row is present with a real id", all.total === all.rows.length && all.rows.every((r) => r.id && r.amount_aud_cents > 0));
    const states = all.rows.map((r) => r.deductibility ?? "undetermined");
    const firstNonUndetermined = states.findIndex((s) => s !== "undetermined");
    check("Digest (C3): undetermined (fixable) rows sort before resolved ones", firstNonUndetermined === -1 || states.slice(firstNonUndetermined).every((s) => s !== "undetermined"));
    const capped = await fetchAskDigestRows(env, "p2", 2025, 2);
    check("Digest (C3): cap honoured while total still reports the full count", capped.rows.length === 2 && capped.total === all.total && all.total > 2);
  }

  // p11 runs under the loan_interest_v2 flag set — its schedule must tie under that engine too.
  {
    const envV2 = { ...env, FEATURES: `${(env as { FEATURES: string }).FEATURES},loan_interest_v2` } as unknown as Env;
    const r = await buildReport(envV2, "p11", 2025);
    const s = await buildAccountantSchedule(envV2, "p11", 2025, { report: r });
    const checks = tieBackChecks(s);
    const bad = checks.filter((c) => !c.ok);
    check("Schedule tie-back p11 (loan_interest_v2): evidence-first interest ties per property", checks.length > 0 && bad.length === 0);
    if (bad.length) for (const b of bad) console.log(`      ✗ p11 ${b.label}: section ${b.actual_cents} vs report ${b.report_cents}`);
  }

  // ── Mission-audit handoff (#5/#3b, accountant_schedule_v2): a loan register + an FX-excluded list ──
  {
    const envSch = { ...env, FEATURES: `${(env as { FEATURES: string }).FEATURES},accountant_schedule_v2` } as unknown as Env;
    const u = "pschv2";
    seedTenant(u, "P-schedule-v2");
    run(`INSERT INTO properties (id, user_id, label, status, use_status) VALUES ('psv2prop', ?, 'Rental', 'rented', 'rented')`, u);
    run(`INSERT INTO accounts (id, user_id, name, type, source, balance_cents, interest_rate_pct) VALUES ('psv2loan', ?, 'Over-split loan', 'loan', 'statement', 40000000, 6.0)`, u);
    run(`INSERT INTO loans_properties (id, user_id, loan_account_id, property_id, deductible_interest_pct) VALUES ('psv2lp', ?, 'psv2loan', 'psv2prop', 120)`, u); // 120% ⇒ over-100% warning
    run(`INSERT INTO income (id, user_id, income_type, fy, gross_cents, currency) VALUES ('psv2fx', ?, 'dividend', '2025-26', 100000, 'USD')`, u); // amount_aud_cents NULL ⇒ FX-excluded
    const sOn = await buildAccountantSchedule(envSch, u, 2025, { report: await buildReport(envSch, u, 2025) });
    const loanSec = sOn.sections.find((s) => s.key === "loan_register");
    const fxSec = sOn.sections.find((s) => s.key === "fx_excluded");
    check("schedule_v2: loan register lists the loan", !!loanSec && loanSec.rows.length === 1);
    check("schedule_v2: apportionment >100% is flagged in the loan register", !!loanSec && (loanSec.notes ?? []).some((n) => n.includes("over 100%")));
    check("schedule_v2: FX-excluded section lists the unconverted USD dividend", !!fxSec && fxSec.rows.length === 1);
    const sOff = await buildAccountantSchedule(env, u, 2025, { report: await buildReport(env, u, 2025) });
    check("schedule_v2 OFF: no loan_register / fx_excluded sections (schedule byte-identical)", !sOff.sections.some((s) => s.key === "loan_register") && !sOff.sections.some((s) => s.key === "fx_excluded"));
  }

  // ── Delete integrity (H1): RESTRICT + archive — no FK cascade, so a parent delete must not
  //    silently orphan rows that the tax position still sums. ──
  {
    const u = "pdel";
    run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'PDEL')`, u);
    run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u}`, u);
    run(`INSERT INTO accounts (id, user_id, name, type, source, active) VALUES ('pdAcc', ?, 'Everyday', 'transaction', 'statement', 1)`, u);
    run(`INSERT INTO properties (id, user_id, label, status, use_status) VALUES ('pdProp', ?, 'Rental', 'rented', 'rented')`, u);
    run(`INSERT INTO entities (id, user_id, kind, name, entity_type, active) VALUES ('pdEnt', ?, 'company', 'Co', 'company', 1)`, u);
    // A countable bank-line tied to BOTH the account and the property (negative-gearing deduction).
    run(`INSERT INTO transactions (id, user_id, source, status, kind, account_id, property_id, amount_cents, amount_aud_cents, txn_date, bucket, ato_label, direction, deductibility) VALUES ('pdTxn', ?, 'statement', 'categorised', 'bank_line', 'pdAcc', 'pdProp', 50000, 50000, ?, 'property_rented', 'rental:interest', 'debit', 'likely_deductible')`, u, FY_DATE);
    // Income on the entity so deleting it would orphan a money row too.
    run(`INSERT INTO income (id, user_id, entity_id, income_type, fy, gross_cents, amount_aud_cents) VALUES ('pdInc', ?, 'pdEnt', 'rent', '2025-26', 120000, 120000)`, u);

    const before = await buildReport(env, u, 2025);

    const blocks = async (table: "accounts" | "properties" | "entities", id: string) => {
      try { await deleteRow(env, u, table, id); return false; } catch (e) { return e instanceof DeleteBlockedError; }
    };
    check("H1: deleting an account with transactions is blocked (409)", await blocks("accounts", "pdAcc"));
    check("H1: deleting a property with transactions is blocked (409)", await blocks("properties", "pdProp"));
    check("H1: deleting an entity with income is blocked (409)", await blocks("entities", "pdEnt"));

    const after = await buildReport(env, u, 2025);
    check("H1: blocked deletes leave the tax position byte-identical",
      JSON.stringify(after.by_bucket) === JSON.stringify(before.by_bucket) &&
      after.taxable_position_cents === before.taxable_position_cents);

    // Archive is the non-destructive path: the account leaves the picker but its line stays counted.
    const archived = await archiveRow(env, u, "accounts", "pdAcc");
    const accts = await listAccounts(env, u);
    const afterArchive = await buildReport(env, u, 2025);
    check("H1: archiveRow(account) succeeds and drops it from listAccounts", archived === true && !accts.some((a) => a.id === "pdAcc"));
    check("H1: archiving keeps the account's transactions in the position",
      afterArchive.taxable_position_cents === before.taxable_position_cents);

    // A leaf parent with no children deletes cleanly (guard is a no-op).
    run(`INSERT INTO accounts (id, user_id, name, type, source, active) VALUES ('pdAcc2', ?, 'Spare', 'transaction', 'statement', 1)`, u);
    let leafDeleted = false;
    try { await deleteRow(env, u, "accounts", "pdAcc2"); leafDeleted = true; } catch { leafDeleted = false; }
    check("H1: deleting a parent with no children still works", leafDeleted);
  }

  // ── FX un-conversion (H2): a foreign row we couldn't convert (amount_aud_cents NULL) must be
  //    EXCLUDED from the position, never summed 1:1 as AUD. A converted foreign row still counts. ──
  {
    const u = "pfx";
    run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'PFX')`, u);
    run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u}`, u);
    // Converted GBP income: £1,000 @ 1.9 = $1,900 (counts). Unconverted USD income: amount_aud_cents NULL (excluded).
    run(`INSERT INTO income (id, user_id, income_type, fy, gross_cents, currency, amount_aud_cents, fx_rate) VALUES ('pfxIncOk', ?, 'foreign_pension', '2025-26', 100000, 'GBP', 190000, 1.9)`, u);
    run(`INSERT INTO income (id, user_id, income_type, fy, gross_cents, currency, amount_aud_cents, fx_rate, needs_review) VALUES ('pfxIncBad', ?, 'foreign_pension', '2025-26', 500000, 'USD', NULL, NULL, 1)`, u);
    // Converted USD deduction $300 (counts) + an unconverted EUR deduction (excluded).
    run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, currency, amount_aud_cents, fx_rate, txn_date, bucket, direction, deductibility) VALUES ('pfxTxnOk', ?, 'upload', 'categorised', 'bank_line', 20000, 'USD', 30000, 1.5, ?, 'payg', 'debit', 'likely_deductible')`, u, FY_DATE);
    run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, currency, amount_aud_cents, fx_rate, txn_date, bucket, direction, deductibility) VALUES ('pfxTxnBad', ?, 'upload', 'needs_review', 'bank_line', 90000, 'EUR', NULL, NULL, ?, 'payg', 'debit', 'likely_deductible')`, u, FY_DATE);

    const r = await buildReport(env, u, 2025);
    check("H2: income excludes the un-converted foreign row (only the $1,900 converted one counts)", r.income.gross_cents === 190000);
    const payg = r.by_bucket.find((b) => b.bucket === "payg");
    check("H2: deductions exclude the un-converted foreign txn (only the $300 converted one counts)", (payg?.total_cents ?? 0) === 30000);
    check("H2: the un-converted rows are NOT silently counted at their raw foreign value",
      r.income.gross_cents !== 690000 && (payg?.total_cents ?? 0) !== 120000);
  }

  // ── Multi-company spend (H3): raw bucket='company' spend with 2+ companies can't be auto-assigned —
  //    it must be SURFACED (unattributed), never silently dropped or pinned to companies[0]. ──
  {
    // Two-company tenant: an unattributed company expense must surface, not vanish.
    const u = "pco2";
    run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'PCO2')`, u);
    run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u}`, u);
    run(`INSERT INTO entities (id, user_id, kind, name, entity_type, active) VALUES ('pco2a', ?, 'company', 'Co A', 'company', 1)`, u);
    run(`INSERT INTO entities (id, user_id, kind, name, entity_type, active) VALUES ('pco2b', ?, 'company', 'Co B', 'company', 1)`, u);
    run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, direction, deductibility) VALUES ('pco2t', ?, 'upload', 'categorised', 'bank_line', 80000, 80000, ?, 'company', 'debit', 'likely_deductible')`, u, FY_DATE);
    const r2 = await buildReport(env, u, 2025);
    check("H3: 2-company unattributed company spend is surfaced ($800, 1 txn)", r2.company_unattributed_cents === 80000 && r2.company_unattributed_n === 1);
    check("H3: 2-company unattributed spend is NOT pinned to companies[0]", (r2.company_positions ?? []).every((p) => p.deductions_cents === 0));

    // One-company tenant: the SAME raw spend is consumed into that company's deductions (byte-identical legacy).
    const u1 = "pco1";
    run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'PCO1')`, u1);
    run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u1}`, u1);
    run(`INSERT INTO entities (id, user_id, kind, name, entity_type, active) VALUES ('pco1a', ?, 'company', 'Solo Co', 'company', 1)`, u1);
    run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, direction, deductibility) VALUES ('pco1t', ?, 'upload', 'categorised', 'bank_line', 50000, 50000, ?, 'company', 'debit', 'likely_deductible')`, u1, FY_DATE);
    const r1 = await buildReport(env, u1, 2025);
    check("H3: 1-company raw spend still counts in that company's deductions ($500), nothing unattributed",
      (r1.company_positions ?? [])[0]?.deductions_cents === 50000 && !r1.company_unattributed_cents);
  }

  // ── Canonical source: INCOME (income table wins; a matched credit folds in once) ──
  // The `income` table is the single source of truth for income. A bank credit the user confirmed
  // duplicates a documented income row (matched_income_id set) must NOT be counted a second time.
  {
    const u = "pdup";
    run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'PDUP')`, u);
    run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u}`, u);
    run(`INSERT INTO income (id, user_id, income_type, fy, gross_cents, currency, amount_aud_cents) VALUES ('pdupInc', ?, 'salary_payg', '2025-26', 100000, 'AUD', 100000)`, u);
    // The same salary as a bank credit, CONFIRMED to match the income row → excluded from income-by-bucket.
    run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, ato_label, direction, matched_income_id) VALUES ('pdupCr', ?, 'statement', 'categorised', 'bank_line', 100000, 100000, ?, 'income_personal', 'income:salary', 'credit', 'pdupInc')`, u, FY_DATE);
    // An UNMATCHED credit still shows as income-by-bucket (proves the dedupe is targeted, not blanket).
    run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, ato_label, direction) VALUES ('pdupCr2', ?, 'statement', 'categorised', 'bank_line', 20000, 20000, ?, 'income_personal', 'income:other', 'credit')`, u, FY_DATE);
    const r = await buildReport(env, u, 2025);
    const ibb = (r.income_by_bucket ?? []).reduce((s, b) => s + b.total_cents, 0);
    check("Canonical income: the documented row counts once ($1,000 headline)", r.income.gross_cents === 100000);
    check("Canonical income: a matched credit is NOT double-counted (only the $200 unmatched credit shows)", ibb === 20000);
  }

  // ── Phase 2: the report engines now HONOUR rule_pack_ver / the KV pack (was statically bypassed —
  //    a KV/jurisdiction pack's thresholds were silently ignored by cgtTotals/companyPositions/work-use). ──
  {
    const u = "pcgtpack";
    run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'PCGTPACK')`, u);
    run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u}`, u);
    run(`INSERT INTO profiles (user_id, rule_pack_ver) VALUES (?, 'test-cgt')`, u);
    run(`INSERT INTO cgt_assets (id, user_id, person_id, asset_kind, code, units, acquired_date, cost_base_cents) VALUES ('pcgtA', ?, ?, 'crypto', 'BTC', 0.5, '2023-01-01', 2000000)`, u, `person_self_${u}`);
    run(`INSERT INTO cgt_events (id, user_id, cgt_asset_id, fy, event_date, proceeds_cents, cost_base_used_cents) VALUES ('pcgtE', ?, 'pcgtA', '2025-26', '2025-09-01', 3000000, 2000000)`, u); // $10k gain, held >12mo
    // Control: no KV binding → bundled au-v1 (keep 0.5 = 50% discount) → $5k net.
    const rDefault = await buildReport(env, u, 2025);
    check("Phase 2 control: default pack applies the 50% CGT discount ($5k net)", rDefault.capital_gains?.net_capital_gain_cents === 500000);
    // Override: a KV pack 'rulepack:test-cgt' with cgt_discount_keep_fraction=1.0 (NO discount) MUST now be honoured.
    const customPack = { thresholds_by_fy: { "2025-26": { cgt_discount_keep_fraction: 1.0 } } };
    const envKv = { ...env, RULES: { get: async (k: string) => (k === "rulepack:test-cgt" ? customPack : null) } } as unknown as Env;
    const rOverride = await buildReport(envKv, u, 2025);
    check("Phase 2: a KV rule-pack override flows into the report (no discount → $10k net)", rOverride.capital_gains?.net_capital_gain_cents === 1000000);
  }

  // ── Rule-pack/jurisdiction SPLIT-BRAIN fix: the report pack id now comes from the resolved descriptor
  //    (jurisdiction default), not an independent profiles.rule_pack_ver read. A UK tenant whose
  //    rule_pack_ver column is still the legacy 'au-v1' default MUST resolve the UK pack (uk-2025), so a
  //    KV 'rulepack:uk-2025' is honoured — previously it silently loaded au-v1 (UK period under AU pack). ──
  {
    const u = "puksplit";
    run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'PUKSPLIT')`, u);
    run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u}`, u);
    run(`INSERT INTO profiles (user_id, jurisdiction) VALUES (?, 'UK')`, u); // rule_pack_ver stays the 'au-v1' default
    run(`INSERT INTO cgt_assets (id, user_id, person_id, asset_kind, code, units, acquired_date, cost_base_cents) VALUES ('puksA', ?, ?, 'crypto', 'BTC', 0.5, '2023-01-01', 2000000)`, u, `person_self_${u}`);
    run(`INSERT INTO cgt_events (id, user_id, cgt_asset_id, fy, event_date, proceeds_cents, cost_base_used_cents) VALUES ('puksE', ?, 'puksA', '2025-26', '2025-09-01', 3000000, 2000000)`, u);
    const ukPack = { thresholds_by_fy: { "2025-26": { cgt_discount_keep_fraction: 1.0 } } };
    const envUk = { ...env, RULES: { get: async (k: string) => (k === "rulepack:uk-2025" ? ukPack : null) } } as unknown as Env;
    const rUk = await buildReport(envUk, u, 2025);
    check("Split-brain fix: a UK tenant resolves the uk-2025 pack (not au-v1) → uk pack's no-discount applies ($10k)", rUk.capital_gains?.net_capital_gain_cents === 1000000);
    // AU control on the SAME shape: an AU tenant with the same KV mock must NOT pick up uk-2025 → keeps 50%.
    const au = "pausplit";
    run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'PAUSPLIT')`, au);
    run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${au}`, au);
    run(`INSERT INTO profiles (user_id, jurisdiction) VALUES (?, 'AU')`, au);
    run(`INSERT INTO cgt_assets (id, user_id, person_id, asset_kind, code, units, acquired_date, cost_base_cents) VALUES ('pausA', ?, ?, 'crypto', 'BTC', 0.5, '2023-01-01', 2000000)`, au, `person_self_${au}`);
    run(`INSERT INTO cgt_events (id, user_id, cgt_asset_id, fy, event_date, proceeds_cents, cost_base_used_cents) VALUES ('pausE', ?, 'pausA', '2025-26', '2025-09-01', 3000000, 2000000)`, au);
    const rAu = await buildReport(envUk, au, 2025);
    check("Split-brain fix: an AU tenant ignores the uk-2025 KV pack → bundled au-v1 50% discount ($5k)", rAu.capital_gains?.net_capital_gain_cents === 500000);
  }

  // ── Phase 3a: franking gross-up (s207-20) + personal-deductible super (s290-150). Flag-gated:
  //    OFF ⇒ byte-identical; ON ⇒ franking ADDS to assessable income, personal-deductible super SUBTRACTS
  //    (capped), and employer SG is NEVER deducted. ──
  {
    const u = "p3a";
    run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'P3A')`, u);
    run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u}`, u);
    run(`INSERT INTO income (id, user_id, person_id, income_type, fy, gross_cents, amount_aud_cents) VALUES ('p3aSal', ?, 'person_self_p3a', 'salary_payg', '2025-26', 10000000, 10000000)`, u); // $100k salary
    run(`INSERT INTO income (id, user_id, person_id, income_type, fy, gross_cents, amount_aud_cents, franking_credit_cents) VALUES ('p3aDiv', ?, 'person_self_p3a', 'dividend', '2025-26', 70000, 70000, 30000)`, u); // $700 fully-franked, $300 credit
    run(`INSERT INTO super_contributions (id, user_id, person_id, fy, type, amount_cents) VALUES ('p3aSP', ?, 'person_self_p3a', '2025-26', 'personal_deductible', 3500000)`, u); // $35k personal deductible (OVER the $30k cap)
    run(`INSERT INTO super_contributions (id, user_id, person_id, fy, type, amount_cents) VALUES ('p3aSE', ?, 'person_self_p3a', '2025-26', 'concessional', 1150000)`, u); // $11.5k employer SG — must NOT be deducted

    const incomeGross = 10000000 + 70000; // salary + dividend cash (franking is separate)
    const rOff = await buildReport(env, u, 2025);
    check("3a OFF: byte-identical — franking not in position, super not deducted", rOff.franking_gross_up_cents === undefined && rOff.super_deduction === undefined && rOff.taxable_position_cents === incomeGross);

    const env3a = { ...env, FEATURES: `${(env as { FEATURES: string }).FEATURES},franking_gross_up,super_deduction` } as unknown as Env;
    const rOn = await buildReport(env3a, u, 2025);
    check("3a ON: $300 franking credit grossed up into assessable income", rOn.franking_gross_up_cents === 30000);
    check("3a ON: only personal-deductible super counts (employer SG $11.5k excluded)", rOn.super_deduction?.contributed_cents === 3500000);
    check("3a ON: super deduction capped at the $30k concessional cap (over_cap flagged)", rOn.super_deduction?.claimed_cents === 3000000 && rOn.super_deduction?.over_cap === true);
    check("3a ON: position = income + franking − capped super", rOn.taxable_position_cents === incomeGross + 30000 - 3000000);
  }

  // ── Phase 3b: WFH/car rates only exist for FY2024-25+. A prior FY (active-FY switcher allows it) must
  //    NOT silently apply the current rate (over-claim) — skip the deduction + flag it instead. ──
  {
    const u = "p3bwu";
    run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'P3BWU')`, u);
    run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u}`, u);
    run(`INSERT INTO work_use_inputs (user_id, fy, wfh_hours, car_work_km) VALUES (?, 2021, 1000, 5000)`, u); // prior FY — no rate block in au-v1
    run(`INSERT INTO work_use_inputs (user_id, fy, wfh_hours, car_work_km) VALUES (?, 2025, 1000, 5000)`, u); // current FY — has rates
    const rPrior = await buildReport(env, u, 2021);
    const rCurrent = await buildReport(env, u, 2025);
    check("3b: prior FY with no configured rate → NO work-method deduction (avoids over-claim) + flagged", rPrior.work_method === undefined && rPrior.work_method_rates_unavailable === true);
    check("3b: current FY with configured rates → work-method still computed (byte-identical)", rCurrent.work_method !== undefined && !rCurrent.work_method_rates_unavailable);
  }

  // ── UK epic stop 1: the tax-period seam. A tenant with profiles.jurisdiction='UK' buckets by the UK
  //    tax year (6 Apr – 5 Apr), not AU's Jul–Jun. Three deductible payg expenses straddle the Apr-6
  //    boundary; the report's date-range deduction total must follow the UK period — and revert to AU
  //    (byte-identical) when the jurisdiction_period flag is OFF. Proves the seam + the gate end-to-end. ──
  {
    const u = "puk";
    run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'PUK')`, u);
    run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u}`, u);
    run(`INSERT INTO profiles (user_id, jurisdiction) VALUES (?, 'UK')`, u);
    const ukExp = (id: string, cents: number, date: string) =>
      run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, direction, deductibility) VALUES (?, ?, 'upload', 'categorised', 'bank_line', ?, ?, ?, 'payg', 'debit', 'likely_deductible')`, id, u, cents, cents, date);
    ukExp("pukApr5", 10000, "2025-04-05"); // UK FY2024 (prior; 5 Apr is the LAST day) — NOT in FY2025
    ukExp("pukApr6", 20000, "2025-04-06"); // UK FY2025 (boundary day; 6 Apr is the FIRST day)
    ukExp("pukMay", 30000, "2025-05-01");  // UK FY2025 — and AU FY2024 (the AU/UK discriminator)

    const rUk25 = await buildReport(env, u, 2025);
    check("UK seam: FY2025 buckets by Apr 6 — only the 6 Apr + 1 May expenses count ($500), 5 Apr excluded", rUk25.total_deductions_cents === 50000);
    const rUk24 = await buildReport(env, u, 2024);
    check("UK seam: the 5 Apr 2025 expense lands in UK FY2024 (Apr 6 2024 – Apr 5 2025) = $100", rUk24.total_deductions_cents === 10000);

    // Flag OFF ⇒ AU descriptor regardless of the stored 'UK' code ⇒ byte-identical AU bucketing.
    const envOff = { ...env, FEATURES: "attribution_engine,position_excludes_nondeductible" } as unknown as Env;
    const rAu25 = await buildReport(envOff, u, 2025);
    const rAu24 = await buildReport(envOff, u, 2024);
    check("UK seam GATE: flag OFF ⇒ AU Jul–Jun — none of the Apr/May 2025 rows fall in AU FY2025 ($0)", rAu25.total_deductions_cents === 0);
    check("UK seam GATE: flag OFF ⇒ all three rows lump into AU FY2024 (Jul 2024 – Jun 2025) = $600", rAu24.total_deductions_cents === 60000);
  }

  // ── UK epic stop 2: currency de-anchoring. A UK tenant's money model is in GBP, not AUD. amount_aud_cents
  //    now holds BASE-currency (GBP) cents; the report sums them currency-agnostically. A GBP row and a
  //    converted USD→GBP row both count; a USD row whose conversion FAILED (amount_aud_cents NULL) is
  //    excluded by FX_CONVERTED (never summed un-converted). buildReport reports base_currency='GBP'.
  //    Reuses the stop-1 puk tenant (UK jurisdiction). With currency_base ON + jurisdiction='UK' ⇒ base GBP;
  //    flag OFF ⇒ base reverts to 'AUD' (the byte-identical gate). ──
  {
    const u = "pukbase";
    run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'PUKBASE')`, u);
    run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u}`, u);
    run(`INSERT INTO profiles (user_id, jurisdiction) VALUES (?, 'UK')`, u);
    // All rows in UK FY2025 (6 Apr 2025 – 5 Apr 2026), deductible payg spend. amount_aud_cents = GBP cents.
    const ukRow = (id: string, currency: string, amountCents: number, baseCents: number | null) =>
      run(
        `INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, currency, amount_aud_cents, txn_date, bucket, direction, deductibility) VALUES (?, ?, 'upload', 'categorised', 'bank_line', ?, ?, ?, '2025-05-01', 'payg', 'debit', 'likely_deductible')`,
        id, u, amountCents, currency, baseCents,
      );
    ukRow("pukbGbp", "GBP", 10000, 10000);   // £100 base-currency spend (passthrough) — counts
    ukRow("pukbUsdOk", "USD", 12000, 9000);  // a USD receipt converted to £90 (amount_aud_cents set) — counts
    ukRow("pukbUsdBad", "USD", 5000, null);  // a USD receipt whose conversion FAILED (NULL) — EXCLUDED

    const rUk = await buildReport(env, u, 2025);
    check("UK base: report.base_currency === 'GBP'", rUk.base_currency === "GBP");
    check("UK base: GBP passthrough (£100) + converted USD (£90) count, failed USD excluded ⇒ £190", rUk.total_deductions_cents === 19000);

    // Flag OFF ⇒ base reverts to 'AUD' regardless of the stored 'UK' code (the byte-identical gate). The
    // GBP/USD rows are then treated as foreign-vs-AUD: GBP & USD <> 'AUD', so only the two with a non-NULL
    // amount_aud_cents count (same £/$ cents values), the NULL one still excludes ⇒ 19000. base_currency is
    // OMITTED for the 'AUD' default ⇒ the payload is byte-identical (no new key) — the AU-snapshot guard.
    const envBaseOff = { ...env, FEATURES: `${(env as { FEATURES: string }).FEATURES.replace(",currency_base", "")}` } as unknown as Env;
    const rOff = await buildReport(envBaseOff, u, 2025);
    check("UK base GATE: currency_base OFF ⇒ base reverts to 'AUD' ⇒ base_currency OMITTED (byte-identical payload)", rOff.base_currency === undefined);
    check("UK base GATE: the FX_CONVERTED guard is base-agnostic ⇒ same countable total (19000)", rOff.total_deductions_cents === 19000);
  }

  // ── #255 (Wave 3): confirmed-vs-tracked position range (position_confirmed_range) ──
  // A rental owner with $1,000 salary and two rental expenses: one CONFIRMED-deductible ($300) and one
  // captured-but-UNDETERMINED ($400, pending review). A property-bucket expense left 'undetermined'
  // still counts as TRACKED spend (deny-by-default applies to payg, not to a let property — see
  // deductionGroupForRow), but it is NOT resolved-deductible until a review confirms it. So the confirmed
  // position must sit ABOVE the tracked one by exactly that unresolved $400 — the founder's real gap
  // (mostly un-reviewed rental spend), and the range the Reports headline renders.
  {
    const u = "pcrange";
    run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'P-range')`, u);
    run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u}`, u);
    run(`INSERT INTO properties (id, user_id, label, status, use_status, ownership_pct) VALUES ('pcrProp', ?, 'Rental', 'rented', 'rented', 100)`, u);
    run(`INSERT INTO income (id, user_id, income_type, fy, gross_cents, amount_aud_cents) VALUES ('pcrSal', ?, 'salary_payg', '2025-26', 100000, 100000)`, u);
    run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, property_id, direction, deductibility, reimbursed) VALUES ('pcrConf', ?, 'upload', 'categorised', 'bank_line', 30000, 30000, ?, 'property_rented', 'pcrProp', 'debit', 'likely_deductible', 0)`, u, FY_DATE);
    run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, property_id, direction, deductibility, reimbursed) VALUES ('pcrUnd', ?, 'upload', 'categorised', 'bank_line', 40000, 40000, ?, 'property_rented', 'pcrProp', 'debit', 'undetermined', 0)`, u, FY_DATE);

    const r = await buildReport(env, u, 2025);
    check("range: confirmed position is present when the flag is on", r.taxable_position_confirmed_cents != null);
    // Identity against the report's OWN figures (no work_method/dep/super here), so the assert can't drift
    // with the gating: confirmed − tracked === tracked-discretionary spend − resolved-deductible spend.
    const gap = (r.taxable_position_confirmed_cents ?? 0) - r.taxable_position_cents;
    check("range: confirmed ≥ tracked (confirmed is the conservative endpoint)", (r.taxable_position_confirmed_cents ?? 0) >= r.taxable_position_cents);
    check("range: gap === tracked discretionary − resolved deductible", gap === r.total_deductions_cents - r.resolved_deductible_cents);
    check("range: the $400 undetermined spend is exactly the unresolved gap", gap === 40000);
    check("range: confirmed = income − resolved ($300) ⇒ 100000 − 30000 = 70000", r.taxable_position_confirmed_cents === 70000);
    check("range: tracked = income − tracked ($700) ⇒ 100000 − 70000 = 30000", r.taxable_position_cents === 30000);

    // Gate: flag OFF ⇒ the field is omitted entirely ⇒ byte-identical payload (the AU-snapshot contract).
    const envOff = { ...env, FEATURES: (env as { FEATURES: string }).FEATURES.replace(",position_confirmed_range", "") } as unknown as Env;
    const rOff = await buildReport(envOff, u, 2025);
    check("range GATE: flag OFF ⇒ taxable_position_confirmed_cents omitted (byte-identical)", rOff.taxable_position_confirmed_cents === undefined);
    check("range GATE: flag OFF ⇒ taxable_position_cents unchanged", rOff.taxable_position_cents === r.taxable_position_cents);
  }

  // ── #255 refund clamp: refunds net the TRACKED total but not resolved_deductible_cents, so a refund on
  // a CONFIRMED-deductible expense could push confirmed deductions above tracked ⇒ the range inverts
  // (confirmed below tracked). The confirmed discretionary deduction is capped at the refund-netted
  // tracked spend, so confirmed ≥ tracked always holds. (refund_netting is ON in the harness env.)
  {
    const u = "pcrefund";
    run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'P-refund')`, u);
    run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u}`, u);
    run(`INSERT INTO income (id, user_id, income_type, fy, gross_cents, amount_aud_cents) VALUES ('pcrfSal', ?, 'salary_payg', '2025-26', 100000, 100000)`, u);
    // A confirmed-deductible $500 work expense (counts in BOTH tracked and resolved) ...
    run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, direction, deductibility, reimbursed) VALUES ('pcrfE', ?, 'upload', 'categorised', 'bank_line', 50000, 50000, ?, 'payg', 'debit', 'confirmed_deductible', 0)`, u, FY_DATE);
    // ... with a $200 refund that nets the tracked total down to $300 (but leaves resolved at $500).
    run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, direction, refund_for_txn_id) VALUES ('pcrfR', ?, 'upload', 'categorised', 'bank_line', 20000, 20000, ?, 'refund', 'credit', 'pcrfE')`, u, FY_DATE);

    const r = await buildReport(env, u, 2025);
    // income $1,000 = 100000c; gross deductions $500 = 50000c; refund $200 = 20000c nets tracked to 30000c.
    // Without the clamp: confirmed would subtract resolved 50000c vs tracked's netted 30000c ⇒ confirmed
    // (50000c) BELOW tracked (70000c), inverting the range. The clamp caps confirmed deductions at the
    // 30000c netted tracked spend ⇒ confirmed == tracked == 70000c, invariant intact.
    check("refund clamp: tracked nets the refund ⇒ taxable_position_cents = 100000 − 30000 = 70000", r.taxable_position_cents === 70000);
    check("refund clamp: confirmed ≥ tracked (range never inverts under refund netting)", (r.taxable_position_confirmed_cents ?? 0) >= r.taxable_position_cents);
    check("refund clamp: confirmed capped at netted tracked spend ⇒ 70000 (not the un-netted 50000)", r.taxable_position_confirmed_cents === 70000);
  }

  // ── #245 Slice 1: car cents-per-km decouple (car_methods → car_inputs, byte-identical off) ──
  // Seed BOTH the legacy work_use_inputs.car_work_km AND a DIFFERENT car_inputs.work_km so we can prove
  // (a) flag-ON reads car_inputs (the decouple works), (b) flag-OFF reads the legacy column (byte-identical),
  // and (c) the report has a single car figure regardless of source. P3/P4 above already prove flag-ON
  // falls back to the legacy column when there's no car_inputs row.
  {
    const u = "pcardecouple";
    run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'P-car')`, u);
    run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u}`, u);
    run(`INSERT INTO work_use_inputs (user_id, fy, car_work_km) VALUES (?, 2025, 1000)`, u); // legacy column: 1,000 km
    run(`INSERT INTO car_inputs (user_id, fy, work_km) VALUES (?, 2025, 2000)`, u);          // new table: 2,000 km
    const rOn = await buildReport(env, u, 2025);
    const envCarOff = { ...env, FEATURES: (env as { FEATURES: string }).FEATURES.replace(",car_methods", "") } as unknown as Env;
    const rOff = await buildReport(envCarOff, u, 2025);
    // 88c/km: car_inputs 2,000 km → $1,760 ; legacy 1,000 km → $880.
    check("P-car: car_methods ON reads car_inputs (2,000km × 88c = $1,760)", rOn.work_method?.car_cents === 176000);
    check("P-car: car_methods OFF reads the legacy work_use_inputs.car_work_km (1,000km × 88c = $880)", rOff.work_method?.car_cents === 88000);
    check("P-car: the two sources actually differ (the decouple is load-bearing)", rOn.work_method?.car_cents !== rOff.work_method?.car_cents);
    // Identity: a persona using ONLY the legacy column must be byte-identical on/off (P3 mirror).
    const u2 = "pcarfallback";
    run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'P-car2')`, u2);
    run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u2}`, u2);
    run(`INSERT INTO work_use_inputs (user_id, fy, car_work_km) VALUES (?, 2025, 3000)`, u2); // legacy only, no car_inputs row
    const fOn = await buildReport(env, u2, 2025);
    const fOff = await buildReport(envCarOff, u2, 2025);
    check("P-car fallback: legacy-only persona is byte-identical car_cents on==off (3,000km × 88c = $2,640)", fOn.work_method?.car_cents === 264000 && fOn.work_method?.car_cents === fOff.work_method?.car_cents);
  }

  // ── #256 double-check scan: SQL + engine integration over a realistic persona ──
  // Plants an OVER-CLAIM (groceries counting in property_rented — the founder's $15k pattern) and a
  // MISSED deduction (union fees sitting undetermined in payg), then runs the SAME query + runScan the DO
  // uses. Proves the scan surfaces both AND that the report position is untouched (read-only/additive).
  {
    const u = "pscan";
    run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'P-scan')`, u);
    run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${u}`, u);
    run(`INSERT INTO properties (id, user_id, label, status, use_status, ownership_pct) VALUES ('pscanProp', ?, 'Rental', 'rented', 'rented', 100)`, u);
    run(`INSERT INTO income (id, user_id, income_type, fy, gross_cents, amount_aud_cents) VALUES ('pscanSal', ?, 'salary_payg', '2025-26', 10000000, 10000000)`, u);
    run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, property_id, direction, deductibility) VALUES ('pscanGroc', ?, 'upload', 'categorised', 'bank_line', 25000, 25000, ?, 'property_rented', 'pscanProp', 'debit', 'likely_deductible')`, u, FY_DATE);
    run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, direction, deductibility, merchant) VALUES ('pscanGrocM', ?, 'upload', 'categorised', 'bank_line', 25000, 25000, ?, 'property_rented', 'debit', 'likely_deductible', 'WOOLWORTHS')`, u, FY_DATE);
    run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, direction, deductibility, merchant) VALUES ('pscanUnion', ?, 'upload', 'categorised', 'bank_line', 40000, 40000, ?, 'payg', 'debit', 'undetermined', 'ASU UNION FEES')`, u, FY_DATE);
    const reportScan = await buildReport(env, u, 2025);
    const { start, end } = fyBounds(2025);
    const scanRows = (await env.DB.prepare(
      `SELECT id, txn_date, merchant, ato_label, bucket, deductibility,
              COALESCE(amount_aud_cents, amount_cents) AS amount_cents,
              COALESCE(reimbursed,0) AS reimbursed,
              ${useStatusDeniedExpr("property_id")} AS use_status_denied,
              ${propertyUndeterminedGatedExpr(env, "bucket", "property_id")} AS property_undetermined
         FROM transactions WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND ${COUNTABLE}
        ORDER BY COALESCE(amount_aud_cents, amount_cents) DESC LIMIT 500`,
    ).bind(u, start, end).all<ScanTxn>()).results ?? [];
    const section = (auV1RulePack as { payg_deductibility?: import("../src/lib/deductibility").DeductibilitySection }).payg_deductibility;
    const scan = runScan(scanRows, reportScan, section, { excludeNonDeductible: true });
    check("scan: surfaces the WOOLWORTHS-in-property over-claim (counting)", scan.findings.some((f) => f.affected_txn_ids.includes("pscanGrocM") && f.category === "over_claim"));
    check("scan: surfaces the union-fee missed deduction (payg undetermined)", scan.findings.some((f) => f.affected_txn_ids.includes("pscanUnion") && f.category === "missed"));
    check("scan: carries the confirmed→tracked range from the report", scan.summary.position_tracked_cents === reportScan.taxable_position_cents && scan.summary.position_confirmed_cents === (reportScan.taxable_position_confirmed_cents ?? reportScan.taxable_position_cents));
    check("scan: read-only — the report position is byte-identical after scanning", (await buildReport(env, u, 2025)).taxable_position_cents === reportScan.taxable_position_cents);
  }

  // ── Feature B2 (#71, carryforward_position): prior-year ORDINARY tax losses from a CONFIRMED NOA
  //    reduce the indicative taxable position (capped at income; flag OFF ⇒ byte-identical). ──
  {
    seedTenant("pB2", "P-B2 carried tax loss");
    inc("pB2Inc", "pB2", "salary_payg", 5000000); // $50k salary, no deductions ⇒ pre-loss position $50k
    // A confirmed NOA for FY 2024-25 (source_fy 2024 → target_fy 2025) carrying $8,000 of ordinary tax loss.
    run(`INSERT INTO fy_carryovers (id, user_id, source_fy, target_fy, status, prior_year_tax_losses_cf_cents) VALUES (?, ?, 2024, 2025, 'confirmed', 800000)`, "pB2co", "pB2");
    const envB2 = { ...env, FEATURES: `${(env as { FEATURES: string }).FEATURES},carryforward_position` } as unknown as Env;
    check("B2 (flag ON): $50k income − $8k carried tax loss = $42k position", (await buildReport(envB2, "pB2", 2025)).taxable_position_cents === 4200000);
    check("B2 (flag OFF): carried loss NOT applied — position stays $50k (byte-identical)", (await buildReport(env, "pB2", 2025)).taxable_position_cents === 5000000);
    // The env has position_confirmed_range ON, so the CONFIRMED floor must ALSO drop by the loss (it's an
    // ATO-confirmed reduction) — locks the confirmed-range fix (was $50k when the loss was tracked-only).
    check("B2: the carried loss reduces the CONFIRMED-range position too, not just tracked", (await buildReport(envB2, "pB2", 2025)).taxable_position_confirmed_cents === 4200000);
    // The applied amount is surfaced for the display layer; omitted (no key) when off/zero.
    check("B2: applied loss surfaced (tax_losses_applied_cents) when ON", (await buildReport(envB2, "pB2", 2025)).tax_losses_applied_cents === 800000);
    check("B2 (flag OFF): tax_losses_applied_cents omitted — no new key", (await buildReport(env, "pB2", 2025)).tax_losses_applied_cents === undefined);
    run(`UPDATE fy_carryovers SET status='draft' WHERE id='pB2co'`);
    check("B2: a DRAFT (unconfirmed) NOA carryover does NOT offset the position", (await buildReport(envB2, "pB2", 2025)).taxable_position_cents === 5000000);
    run(`UPDATE fy_carryovers SET status='confirmed' WHERE id='pB2co'`);
    // Only the NOA carrying INTO this FY (target_fy === startYear) applies: an OLDER NOA (target_fy 2024,
    // a huge loss) must NOT apply to FY 2025-26 and must NOT be summed — locks target_fy = startYear.
    run(`INSERT INTO fy_carryovers (id, user_id, source_fy, target_fy, status, prior_year_tax_losses_cf_cents) VALUES (?, ?, 2023, 2024, 'confirmed', 9900000)`, "pB2co2", "pB2");
    check("B2: only the NOA whose target_fy = this FY applies — older/other NOAs are neither applied nor summed", (await buildReport(envB2, "pB2", 2025)).taxable_position_cents === 4200000);
    // The loss offsets only positive income — it floors the position at 0, never negative.
    seedTenant("pB2z", "P-B2 loss exceeds income");
    inc("pB2zInc", "pB2z", "salary_payg", 300000); // $3k income
    run(`INSERT INTO fy_carryovers (id, user_id, source_fy, target_fy, status, prior_year_tax_losses_cf_cents) VALUES (?, ?, 2024, 2025, 'confirmed', 5000000)`, "pB2zco", "pB2z"); // $50k loss
    check("B2: loss capped at income — position floors at $0, never negative", (await buildReport(envB2, "pB2z", 2025)).taxable_position_cents === 0);
    // A negative pre-loss position (deductions > income) must apply 0 loss — never deepen it below zero.
    seedTenant("pB2n", "P-B2 negative pre-loss year");
    inc("pB2nInc", "pB2n", "salary_payg", 1000000); // $10k income
    exp("pB2nExp", "pB2n", 3000000, "payg", "confirmed_deductible"); // $30k deductible ⇒ pre-loss position negative
    run(`INSERT INTO fy_carryovers (id, user_id, source_fy, target_fy, status, prior_year_tax_losses_cf_cents) VALUES (?, ?, 2024, 2025, 'confirmed', 500000)`, "pB2nco", "pB2n");
    check("B2: negative pre-loss year — carried loss applies 0, position unchanged (not deepened)", (await buildReport(envB2, "pB2n", 2025)).taxable_position_cents === (await buildReport(env, "pB2n", 2025)).taxable_position_cents);
  }

  console.log(`\n=== personas: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}
main();
