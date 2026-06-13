#!/usr/bin/env tsx
// AU report-snapshot regression guard.
//
// "AU byte-identical" is the product contract: the owner files a real AU 2024-25 return on this exact
// build, so any unintended change to an AU-path report output is a FAILURE. The persona harness
// (check-personas.ts) pins INDIVIDUAL figures with hand-written asserts; this guard complements it by
// freezing the ENTIRE buildReport JSON for one rich, representative AU persona and diffing it on every
// future slice. One explicit, whole-object guard means a stray change to any report field — even one no
// persona assert happens to read — fails loudly here instead of slipping into a real return.
//
// The persona mirrors P6 (Susan & Greg): a PAYG salary + co-owned negatively-geared rental (rent income,
// interest/rates/agent expenses, Div-40 plant depreciation) + a second family house held rent-free
// (its holding cost must stay OUT of deductions). That single tenant exercises income aggregation,
// deductions, depreciation, per-property negative gearing and the rent-free exclusion — the core AU
// money/tax-position pipeline.
//
// Determinism: buildReport is a pure function of the seeded DB + startYear (no wall-clock / generated_at /
// random fields), so the serialized report is stable across runs. We still normalize defensively
// (sort + strip any volatile-looking key) so a future field that DOES carry a timestamp can't make the
// fixture flap. Object keys are emitted in a stable sorted order so the committed JSON diffs cleanly.
//
// Run:    npx tsx scripts/check-au-snapshot.ts          (diff current vs committed fixture; FAIL on drift)
// Update: UPDATE_SNAPSHOT=1 npx tsx scripts/check-au-snapshot.ts   (re-capture the fixture from current main)
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/env";
import { buildReport } from "../src/lib/report";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const FIXTURE = path.join(__dirname, "fixtures", "au-report-snapshot.json");

// ── Minimal D1 shim over node:sqlite (async surface buildReport uses) — same shim as check-personas. ──
class D1Stmt {
  private params: unknown[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...args: unknown[]) { this.params = args.map((a) => (a === undefined ? null : a)); return this; }
  async all<T = unknown>() { return { results: this.db.prepare(this.sql).all(...(this.params as never[])) as T[], success: true, meta: {} }; }
  async first<T = unknown>() { return (this.db.prepare(this.sql).get(...(this.params as never[])) as T) ?? null; }
  async run() { const r = this.db.prepare(this.sql).run(...(this.params as never[])); return { success: true, meta: { changes: Number(r.changes ?? 0) } }; }
  async settle() { return /^\s*(select|with)/i.test(this.sql) ? this.all() : this.run(); }
}
class D1 {
  constructor(private db: DatabaseSync) {}
  prepare(sql: string) { return new D1Stmt(this.db, sql); }
  async batch(stmts: D1Stmt[]) { const out = []; for (const s of stmts) out.push(await s.settle()); return out; }
}

const db = new DatabaseSync(":memory:");
for (const f of fs.readdirSync(path.join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort()) {
  db.exec(fs.readFileSync(path.join(root, "migrations", f), "utf8"));
}

// Same feature set the persona harness builds under — this is the real shipped AU report shape.
const env = { DB: new D1(db), FEATURES: "attribution_engine,position_excludes_nondeductible,loan_split,wfh_car_methods,refund_netting,income_dedupe,cgt_engine,ess_engine,gst_bas,car_logbook,trust_distributions,partnership_distributions,smsf_engine,accountant_schedule,jurisdiction_period" } as unknown as Env;

const run = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...(p as never[]));
const FY_DATE = "2025-09-01"; // inside FY 2025-26

// ── Rich AU persona (mirrors P6): PAYG + co-owned negatively-geared rental + rent-free family house. ──
const U = "ausnap";
run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'AU snapshot persona')`, U);
run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'You', 'self')`, `person_self_${U}`, U);
run(`INSERT INTO persons (id, user_id, display_name, role) VALUES (?, ?, 'Spouse', 'spouse')`, `person_spouse_${U}`, U);
run(`INSERT INTO properties (id, user_id, label, status, use_status, ownership_pct) VALUES ('ausRental', ?, 'Co-owned rental', 'rented', 'rented', 50)`, U);
run(`INSERT INTO property_owners (id, user_id, property_id, person_id, ownership_pct) VALUES ('ausPo1', ?, 'ausRental', ?, 50)`, U, `person_self_${U}`);
run(`INSERT INTO property_owners (id, user_id, property_id, person_id, ownership_pct) VALUES ('ausPo2', ?, 'ausRental', ?, 50)`, U, `person_spouse_${U}`);
// $130k salary + $20k rent.
run(`INSERT INTO income (id, user_id, income_type, fy, gross_cents, amount_aud_cents) VALUES ('ausSal', ?, 'salary_payg', '2025-26', 13000000, 13000000)`, U);
run(`INSERT INTO income (id, user_id, income_type, property_id, fy, gross_cents, amount_aud_cents) VALUES ('ausRent', ?, 'rent', 'ausRental', '2025-26', 2000000, 2000000)`, U);
// $30k deductible rental expenses (interest/rates/agent) on the rental.
run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, property_id, direction, deductibility) VALUES ('ausExp', ?, 'upload', 'categorised', 'bank_line', 3000000, 3000000, ?, 'property_rented', 'ausRental', 'debit', 'likely_deductible')`, U, FY_DATE);
// Div-40 plant on the rental: $80k cost, $20k decline-in-value.
run(`INSERT INTO assets (id, user_id, property_id, label, asset_class, cost_cents, acquired_date, owned_by) VALUES ('ausPlant', ?, 'ausRental', 'Plant', 'div40_plant', 8000000, ?, 'self')`, U, FY_DATE);
run(`INSERT INTO depreciation_schedule (id, user_id, asset_id, fy, opening_adjustable_value_cents, days_held, deduction_cents, closing_adjustable_value_cents, method_applied) VALUES ('ausPlantS', ?, 'ausPlant', '2025-26', 8000000, 365, 2000000, 6000000, 'diminishing_value')`, U);
// Second family house held rent-free — its $1,500 holding cost must NOT enter deductions.
run(`INSERT INTO properties (id, user_id, label, status, use_status) VALUES ('ausBeach', ?, 'Beach house (family, rent-free)', 'owner_occupied', 'private_use_rent_free')`, U);
run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, property_id, direction, deductibility) VALUES ('ausBeachExp', ?, 'upload', 'categorised', 'bank_line', 150000, 150000, ?, 'property_rented', 'ausBeach', 'debit', 'undetermined')`, U, FY_DATE);

// ── Determinism normaliser ──────────────────────────────────────────────────────────────────────────
// Recursively sort object keys (stable serialization) and strip any field whose name looks like a
// run-time/wall-clock artefact, so the fixture can never flap on a generated timestamp. buildReport has
// no such fields today; this is a guard for the future, not a current need.
const VOLATILE_KEY = /(^|_)(generated_at|generatedat|created_at|updated_at|now|timestamp|run_at|as_of|asof|requested_at|_ts)$/i;
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (VOLATILE_KEY.test(key)) continue;
      out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

async function main() {
  const report = await buildReport(env, U, 2025);
  const serialized = JSON.stringify(normalize(report), null, 2) + "\n";

  if (process.env.UPDATE_SNAPSHOT) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, serialized);
    console.log(`au-snapshot: wrote fixture (${serialized.length} bytes) → ${path.relative(root, FIXTURE)}`);
    return;
  }

  if (!fs.existsSync(FIXTURE)) {
    console.error(`au-snapshot: FIXTURE MISSING at ${path.relative(root, FIXTURE)}`);
    console.error("Run: UPDATE_SNAPSHOT=1 npx tsx scripts/check-au-snapshot.ts");
    process.exit(1);
  }

  const expected = fs.readFileSync(FIXTURE, "utf8");
  if (serialized === expected) {
    console.log("=== au-snapshot: PASS — AU report byte-identical to the committed fixture ===");
    return;
  }

  // Drift: show the first differing line so the failure is actionable, not just "they differ".
  const cur = serialized.split("\n");
  const exp = expected.split("\n");
  let i = 0;
  while (i < cur.length && i < exp.length && cur[i] === exp[i]) i++;
  console.error("=== au-snapshot: FAIL — AU report drifted from the committed fixture ===");
  console.error(`First difference at line ${i + 1}:`);
  console.error(`  expected: ${exp[i] ?? "(end of file)"}`);
  console.error(`  current:  ${cur[i] ?? "(end of file)"}`);
  console.error("\nIf this change is intended (a flag-gated AU-path change you've vetted), re-capture with:");
  console.error("  UPDATE_SNAPSHOT=1 npx tsx scripts/check-au-snapshot.ts");
  process.exit(1);
}
main();
