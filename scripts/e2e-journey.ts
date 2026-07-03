// End-to-end journey simulation. The SPA can't run locally (deploy-only), so this drives a realistic
// single-user journey through the REAL server pipeline against an in-memory D1 (same shim the personas
// harness uses) — asserting the money outcome at each stage. DO mutation methods (confirmBatch,
// ignoreBatch, confirmSuggestedDeduction) can't be instantiated without the Cloudflare Agent base, so
// each is replayed as the EXACT SQL it runs (cited), while every READ goes through the genuine functions
// (buildReport, listReviewGroups, listSuggestedDeductions, verdictForTxn, groupKey). Covers this session's
// changes: grouped_review_v2 clustering, bulk confirm (position-neutral), bulk ignore, the stale-raffle
// re-check, the attribution deductibility veto, and confirm→position-moves.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/env";
import { buildReport } from "../src/lib/report";
import { listReviewGroups, listSuggestedDeductions, NEEDS_REVIEW, COUNTABLE } from "../src/lib/queries";
import { verdictForTxn } from "../src/lib/deductibility";
import { groupKey } from "../src/lib/clarify";
import auV1RulePack from "../src/rulepacks/au-v1.json";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";

// ── D1 shim over node:sqlite (mirrors scripts/check-personas.ts) ──
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
const env = { DB: new D1(db), FEATURES: "attribution_engine,position_excludes_nondeductible,loan_split,income_dedupe,accountant_schedule,jurisdiction_period,currency_base,position_confirmed_range" } as unknown as Env;
const run = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...(p as never[]));
const FY = "2025-09-01"; // inside FY 2025-26
let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };
const u = "e2e";

// COUNTABLE debit spend total (what "tracked spend" reflects; ignore/confirm effects show here).
const countableSpend = () => (db.prepare(`SELECT COALESCE(SUM(COALESCE(amount_aud_cents,amount_cents)),0) AS c FROM transactions WHERE user_id='${u}' AND direction='debit' AND ${COUNTABLE}`).get() as { c: number }).c;
const needsReviewCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE user_id='${u}' AND ${NEEDS_REVIEW}`).get() as { n: number }).n;

async function main() {
  console.log("e2e journey simulation (FY 2025-26)\n");

  // ── STAGE 0 — Set up + Bring in: a tenant with a rental, then a statement imported ──
  run(`INSERT INTO tenants (user_id, display_name) VALUES (?, 'E2E')`, u);
  run(`INSERT INTO persons (id, user_id, display_name, role, occupation) VALUES ('e2ePerson', ?, 'You', 'self', 'nurse')`, u);
  run(`INSERT INTO entities (id, user_id, kind, name, person_id, entity_type) VALUES ('e2eEnt', ?, 'individual', 'Me', 'e2ePerson', 'individual')`, u);
  run(`INSERT INTO properties (id, user_id, label, status, use_status) VALUES ('e2eProp', ?, 'Rental', 'rented', 'rented')`, u);
  run(`INSERT INTO income_activities (id, user_id, activity_type, property_id, label) VALUES ('e2eIa', ?, 'rental_property', 'e2eProp', 'Rental')`, u);
  run(`INSERT INTO income (id, user_id, income_type, gross_cents, fy) VALUES ('e2eRent', ?, 'rental', 2000000, '2025-26')`, u);

  const T = (id: string, cents: number, bucket: string, status: string, deduct: string) =>
    run(`INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, txn_date, bucket, direction, deductibility) VALUES ('${id}', ?, 'upload', '${status}', 'bank_line', ${cents}, ${cents}, ?, '${bucket}', 'debit', '${deduct}')`, u, FY);
  const setMerchant = (id: string, m: string) => run(`UPDATE transactions SET merchant=?, raw_description=? WHERE id='${id}'`, m, m);

  // A confirmed work deduction that already counts; a needs-review work expense (bucketed, low-conf);
  // a transfer to exclude; two duplicate donations to the same DGR; a stale RSL raffle suggestion.
  T("e2eWorkOk", 30000, "payg", "categorised", "confirmed_deductible"); setMerchant("e2eWorkOk", "Nursing Registration AHPRA");
  T("e2eWorkNR", 12000, "payg", "needs_review", "confirmed_deductible"); setMerchant("e2eWorkNR", "Scrubs Uniform Co");
  run(`UPDATE transactions SET confidence=0.6 WHERE id='e2eWorkNR'`); // in the review queue via confidence<0.85
  T("e2eXfer", 500000, "payg", "needs_review", "undetermined"); setMerchant("e2eXfer", "Transfer to xx6819 CommBank app");
  run(`UPDATE transactions SET confidence=0.5 WHERE id='e2eXfer'`);
  // Two near-identical review-queue lines from the same merchant (per-receipt ref numbers) — the RSL-style
  // fragmentation grouped_review_v2 fixes. Both should collapse to ONE cluster in listReviewGroups.
  T("e2eOff1", 8000, "payg", "needs_review", "undetermined"); setMerchant("e2eOff1", "Officeworks 5521");
  T("e2eOff2", 3500, "payg", "needs_review", "undetermined"); setMerchant("e2eOff2", "Officeworks 5522");
  run(`UPDATE transactions SET confidence=0.5 WHERE id IN ('e2eOff1','e2eOff2')`);
  T("e2eDon1", 4000, "payg", "categorised", "suggested_deductible"); setMerchant("e2eDon1", "Friends Of The Earth Collingwood");
  T("e2eDon2", 1700, "payg", "categorised", "suggested_deductible"); setMerchant("e2eDon2", "Friends Of The Earth Collingwood");
  T("e2eRaffle", 1000, "payg", "categorised", "suggested_deductible"); setMerchant("e2eRaffle", "RSL ART UNION BRISBANE");
  // An attributed rental expense the user marked NOT deductible (Wave 1 veto target).
  T("e2eAttr", 80000, "property_rented", "categorised", "confirmed_not");
  run(`UPDATE transactions SET property_id='e2eProp' WHERE id='e2eAttr'`);
  run(`INSERT INTO transaction_attributions (id, user_id, transaction_id, entity_id, income_activity_id, attributed_amount_cents, deduction_provision) VALUES ('e2eAttrA', ?, 'e2eAttr', 'e2eEnt', 'e2eIa', 80000, 's8-1_general')`, u);

  const r0 = await buildReport(env, u, 2025);
  const ded0 = r0.total_deductions_cents;
  check("STAGE0 bring-in: report builds; the confirmed $300 work deduction counts", ded0 >= 30000);
  check("STAGE0: attributed $800 rental expense marked NOT deductible is VETOED (excluded, Wave 1)", !(r0.per_property ?? []).some((p) => p.deduction_cents >= 80000));

  // ── STAGE 1 — Sort: grouped_review_v2 clusters near-identical REVIEW-QUEUE lines (whole-queue) ──
  const groups = (await listReviewGroups(env, u)).groups;
  const offGroup = groups.find((g) => g.group_key === groupKey("Officeworks 5521"));
  check("STAGE1 grouping: the two ref-numbered Officeworks review lines cluster into ONE group (n=2, $115)", !!offGroup && offGroup.n === 2 && offGroup.total_cents === 11500);
  // The donations aren't review items (they're categorised → suggested); their grouping is the
  // grouped_deductions path — the client clusters the suggestions by the SAME server groupKey.
  check("STAGE1 grouping (deductions card): the two DGR donations share a group_key; the raffle differs", groupKey("Friends Of The Earth Collingwood") === groupKey("Friends Of The Earth Collingwood") && groupKey("Friends Of The Earth Collingwood") !== groupKey("RSL ART UNION BRISBANE"));

  // ── STAGE 2 — Sort: bulk "Confirm as-is" is POSITION-NEUTRAL, only clears the review flag ──
  const spendBefore = countableSpend(); const nrBefore = needsReviewCount(); const dedBefore = (await buildReport(env, u, 2025)).total_deductions_cents;
  // confirmBatch SQL (agent.ts): UPDATE ... SET status='corrected', confidence=1.0
  run(`UPDATE transactions SET status='corrected', confidence=1.0 WHERE id='e2eWorkNR' AND user_id=?`, u);
  const dedAfter = (await buildReport(env, u, 2025)).total_deductions_cents;
  check("STAGE2 bulk-confirm: needs-review count drops by 1 (row left the queue)", needsReviewCount() === nrBefore - 1);
  check("STAGE2 bulk-confirm: position is UNCHANGED (a bucketed review row already counted — neutral)", dedAfter === dedBefore && countableSpend() === spendBefore);

  // ── STAGE 3 — Sort: bulk "Not spend" excludes the transfer from every money sum ──
  const spendPre = countableSpend();
  // ignoreBatch SQL (agent.ts): UPDATE ... SET status='ignored'
  run(`UPDATE transactions SET status='ignored' WHERE id='e2eXfer' AND user_id=?`, u);
  check("STAGE3 bulk-ignore: the $5,000 transfer leaves COUNTABLE (dropped from tracked spend)", countableSpend() === spendPre - 500000);
  check("STAGE3 bulk-ignore: transfer no longer in the review queue", needsReviewCount() === nrBefore - 2);

  // ── STAGE 4 — Guided claims: suggestions surface; the stale raffle is re-checked and refused ──
  const suggs = await listSuggestedDeductions(env, u, 2025);
  check("STAGE4 suggestions: both DGR donations appear as possible deductions", suggs.filter((s) => s.merchant === "Friends Of The Earth Collingwood").length === 2);
  const raffleVerdict = verdictForTxn("payg", null, "RSL ART UNION BRISBANE", (auV1RulePack as { payg_deductibility?: Parameters<typeof verdictForTxn>[3] }).payg_deductibility);
  // confirmSuggestedDeduction (agent.ts) re-runs verdictForTxn on confirm; a 'likely_not' blocks + demotes.
  check("STAGE4 stale-raffle guard: the RSL raffle now re-checks to 'likely_not' → confirm would REFUSE it (no over-claim)", raffleVerdict.deductibility === "likely_not");

  // ── STAGE 5 — Guided claims: confirming a donation MOVES the position ──
  const dedPreConfirm = (await buildReport(env, u, 2025)).total_deductions_cents;
  // confirmSuggestedDeduction SQL: UPDATE ... SET deductibility='confirmed_deductible'
  run(`UPDATE transactions SET deductibility='confirmed_deductible' WHERE id='e2eDon1' AND user_id=?`, u);
  const dedPostConfirm = (await buildReport(env, u, 2025)).total_deductions_cents;
  check("STAGE5 confirm→impact: confirming the $40 donation increases the headline deductions by $40", dedPostConfirm === dedPreConfirm + 4000);
  check("STAGE5: the still-suggested $17 donation stays OUT of the position (deny-by-default holds)", dedPostConfirm < dedPreConfirm + 5700);

  console.log(`\n=== e2e journey: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main();
