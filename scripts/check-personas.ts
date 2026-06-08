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

const env = { DB: new D1(db), FEATURES: "attribution_engine,position_excludes_nondeductible,loan_split,wfh_car_methods,refund_netting,income_dedupe,cgt_engine,ess_engine,gst_bas,car_logbook" } as unknown as Env;

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
  exp("p8tCoExp", u, 1000000, "company", "likely_deductible"); // company's own spend → company position loss
  inc("p8iDist", u, "other", 5000000); // GAP #139: trust distribution modelled as plain 'other' — character (franked/CGT) NOT retained
}

// ── Persona 9: Aisha, pre-revenue startup founder ──
{
  const u = "p9";
  seedTenant(u, "P9 Aisha founder");
  run(`INSERT INTO entities (id, user_id, kind, name, person_id, entity_type, base_rate_entity) VALUES ('p9eCo', ?, 'company', 'Startup Pty Ltd', ?, 'company', 1)`, u, `person_self_${u}`);
  run(`INSERT INTO blackhole_costs (id, user_id, entity_id, incurred_date, amount_cents, description, immediate_deduction) VALUES ('p9bh', ?, 'p9eCo', ?, 500000, 'ASIC + structure advice (s40-880)', 1)`, u, FY_DATE);
  run(`INSERT INTO rd_claims (id, user_id, entity_id, fy, eligible_expenditure_cents, aggregated_turnover_cents, offset_type, registered_with_ausindustry) VALUES ('p9rd', ?, 'p9eCo', '2025-26', 4000000, 0, 'refundable', 0)`, u); // NOT registered
  // #141: ESS — a staff startup-concession option (eligible, ≤10% → defers to CGT, $0 income now) and a
  // taxed-upfront grant (discount assessable now).
  run(`INSERT INTO ess_grants (id, user_id, person_id, employer_entity_id, scheme_type, grant_date, taxing_point_date, discount_cents, ownership_gt_10pct) VALUES ('p9essA', ?, ?, 'p9eCo', 'startup', '2025-09-01', '2025-09-01', 1000000, 0)`, u, `person_self_${u}`);
  run(`INSERT INTO ess_grants (id, user_id, person_id, employer_entity_id, scheme_type, grant_date, taxing_point_date, discount_cents, ownership_gt_10pct) VALUES ('p9essB', ?, ?, 'p9eCo', 'taxed_upfront', '2025-09-01', '2025-09-01', 500000, 0)`, u, `person_self_${u}`);
}

// ── Persona 10: Margaret, SMSF retiree + crypto ──
{
  const u = "p10";
  seedTenant(u, "P10 Margaret SMSF");
  run(`INSERT INTO entities (id, user_id, kind, name, person_id, entity_type) VALUES ('p10eSmsf', ?, 'individual', 'Family SMSF', ?, 'smsf')`, u, `person_self_${u}`); // GAP #140: smsf entity declarable, no pension/ECPI model
  inc("p10iDiv", u, "dividend", 700000, { franking_credit_cents: 300000 }); // franking captured
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

  // ── Persona 6: co-owned negatively-geared landlords (verifies neg-gearing NETS) ──
  const r6 = await buildReport(env, "p6", 2025);
  const r6prop = r6.per_property.find((p) => p.property_id === "p6prop");
  check("P6: negative gearing NETS — ($130k salary + $20k rent) − $30k expenses − $20k dep = $100k", r6.taxable_position_cents === 10000000);
  check("P6: per-property shows the $30k rental loss", r6prop?.net_cents === -3000000);

  // ── Persona 7: nurse, two employers ──
  const r7 = await buildReport(env, "p7", 2025);
  const r7sal = r7.income.by_type.find((t) => t.income_type === "salary_payg");
  check("P7: two employers' salaries aggregate into one income figure ($88k)", r7.income.gross_cents === 8800000 && r7sal?.n === 2);
  check("P7: self-education + uniform are deductible ($1,400)", r7.total_deductions_cents === 140000);

  // ── Persona 8: company + trust ──
  const r8 = await buildReport(env, "p8", 2025);
  const r8co = r8.company_positions?.find((c) => c.entity_id === "p8eCo");
  check("P8: the company is a separate taxpayer with a $10k current-year loss", r8co?.current_year_loss_cents === 1000000);
  check("P8 GAP #139: trust distribution lands as plain 'other' — franking character NOT retained", r8.income.franking_credit_cents === 0 && !!r8.income.by_type.find((t) => t.income_type === "other"));

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

  console.log(`\n=== personas: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}
main();
