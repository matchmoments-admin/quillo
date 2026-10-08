#!/usr/bin/env tsx
// End-to-end FIRST-TIMER journey (ticket #595, spec docs/first-timer/spec.md §0 + A14). Drives one fresh
// tenant through the four steps — Get set up → Connect → Review → Lodge in myTax — over an in-memory D1 (the
// same node:sqlite shim as scripts/e2e-journey.ts) with EVERY journey flag ON, asserting GET /api/journey's
// step statuses at each stage. Then replays the same inputs with every journey flag OFF and diffs the outputs
// against a committed baseline (the check-au-snapshot approach): OFF ⇒ byte-identical.
//
// What is REAL here (the exact functions the Worker / Durable Object call):
//   ensureTenant · fillSituationPeriod (+ the SPA's aboutYouWrites model) · parseCsv/applyColumnMap/
//   lineFingerprint/isTransferLike · assertCanonicalSource · runRelevanceScan · noticeSignals/listNoticed/
//   confirmNoticed · relevanceView/confirmWorthALook · recordsView · reconcileProposals/receiptLinkTargets/
//   applyReceiptLink · computeFilingReadiness · readJourney (the DO's journey()) · buildMytaxWorksheet ·
//   markFyLodged/lodgedOnError/lodgingFy · purgeTenant (a returning user starts over, #623) · buildReport.
// What is REPLAYED (cited; the SQL each runs, narrowed to the columns this fixture exercises), because a Durable Object method can't be instantiated
// without the Cloudflare Agent base: confirmImport's line INSERT, the categoriser's bucket write (an LLM call —
// replaced by a fixed, plausible outcome), stampDeductibility, setDeductibility ("Not work-related"),
// saveWorkUse (WFH hours) and addIncome (the income statement). Each replay cites its source.
//
// The statement is the committed fixture evals/statements/westpac-sample.csv (what eval:statements parses).
// It is imported twice — the fixture, then the next fortnight's statement (the same fixture shifted 14 days) —
// because pay is only recognisable as pay once it recurs (credit_signals.payroll.min_count = 2).
//
// Run:    npx tsx scripts/e2e-first-timer.ts
// Update: UPDATE_SNAPSHOT=1 npx tsx scripts/e2e-first-timer.ts   (re-capture the OFF baseline — only for a
//         vetted, intended change to the flag-OFF outputs)
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/env";
import { buildReport } from "../src/lib/report";
import { parseCsv, applyColumnMap, lineFingerprint, isTransferLike, type ColumnMap, type StatementLine } from "../src/lib/statements";
import { cleanMerchant } from "../src/lib/bank-parsers";
import { verdictForTxn } from "../src/lib/deductibility";
import { assertCanonicalSource, reconcileProposals } from "../src/lib/queries";
import { reconcileConfigFromPack } from "../src/lib/reconcile-proposer";
import { receiptLinkTargets, applyReceiptLink } from "../src/lib/receipt-link";
import { ensureTenant, addAccount, fillSituationPeriod } from "../src/lib/situation-write";
import { purgeTenant } from "../src/lib/retention";
import { aboutYouWrites, emptyAnswers, fyBoundsFor, type AboutAnswers } from "../web/src/lib/aboutYou";
import { runRelevanceScan, relevanceView, confirmWorthALook } from "../src/lib/relevance-scan-run";
import { noticeSignals, listNoticed, confirmNoticed, INCOME_STATEMENT_PROMPT } from "../src/lib/noticed-signals";
import { recordsView } from "../src/lib/records";
import { computeFilingReadiness } from "../src/lib/filing-readiness";
import { readJourney } from "../src/lib/journey-read";
import type { Journey } from "../src/lib/journey";
import { buildMytaxWorksheet, mytaxWorksheetResponse } from "../src/lib/mytax-worksheet";
import { markFyLodged } from "../src/lib/fy-signoff";
import { lodgedOnError, lodgingFy } from "../src/lib/lodging-year";
import { AU_DESCRIPTOR } from "../src/lib/jurisdiction";
import auV1RulePack from "../src/rulepacks/au-v1.json";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(root, "scripts", "fixtures", "first-timer-off-baseline.json");
const STATEMENT_CSV = path.join(root, "evals", "statements", "westpac-sample.csv");
const COLUMN_MAP = JSON.parse(fs.readFileSync(path.join(root, "evals", "statements", "westpac-sample.expected.json"), "utf8")).columnMap as ColumnMap;

// ── D1 shim over node:sqlite (mirrors scripts/e2e-journey.ts) + a tiny KV (ensureTenant's init marker). ──
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
class KV {
  private m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; } // no rule-pack override ⇒ the bundled au-v1 pack
  async put(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
  async list() { return { keys: [], list_complete: true }; }
}
class R2 { // purgeTenant lists + deletes the tenant's objects; this tenant never stored bytes
  async list() { return { objects: [], truncated: false }; }
  async delete() {}
}

const db = new DatabaseSync(":memory:");
for (const f of fs.readdirSync(path.join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort()) {
  db.exec(fs.readFileSync(path.join(root, "migrations", f), "utf8"));
}

// Production's flag set (wrangler.toml) is the base, so "OFF" means exactly what prod runs today.
const PROD_FEATURES = (/^FEATURES\s*=\s*"([^"]*)"/m.exec(fs.readFileSync(path.join(root, "wrangler.toml"), "utf8"))?.[1] ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const JOURNEY_FLAGS = ["ft_journey", "situation_profile", "relevance_scan", "wages_payer", "reconcile_proposals", "mytax_worksheet", "residency_assessability"];
const kv = new KV();
const mkEnv = (flags: string[]) => ({ DB: new D1(db), RULES: kv, RECEIPTS: new R2(), FEATURES: flags.join(",") }) as unknown as Env;
const OFF = mkEnv(PROD_FEATURES.filter((f) => !JOURNEY_FLAGS.includes(f)));
const ON = mkEnv([...PROD_FEATURES.filter((f) => !JOURNEY_FLAGS.includes(f)), ...JOURNEY_FLAGS]);

const FY = 2025; // FY 2025-26 — the fixture's May 2026 lines
const NOW = new Date("2026-09-01T00:00:00Z"); // after "Tax ready", before 31 October: the year being lodged is FY 2025-26
const deps = { loadRulePack: async () => auV1RulePack as unknown, now: NOW }; // the DO's loader with no KV override
const run = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...(p as never[]));
const one = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...(p as never[])) as T;
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail === undefined ? "" : `\n      ${JSON.stringify(detail)}`}`); }
};
const steps = (j: Journey) => Object.fromEntries(j.steps.map((s) => [s.key, s.status])) as Record<string, string>;
const stepLine = (j: Journey) => j.steps.map((s) => `${s.key}=${s.status}${s.count ? `(${s.count})` : ""}`).join(" ");
const denylist = /refund|tax payable|marginal rate/i;

// ── Fixture statements: westpac-sample.csv, then the same statement two weeks later. ──
const shiftDays = (iso: string | null, n: number) => {
  if (!iso) return iso;
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const fixtureLines = applyColumnMap(parseCsv(fs.readFileSync(STATEMENT_CSV, "utf8")), COLUMN_MAP);
const STATEMENTS: { key: string; lines: StatementLine[] }[] = [
  { key: "s1", lines: fixtureLines },
  { key: "s2", lines: fixtureLines.map((l) => ({ ...l, date: shiftDays(l.date, 14) })) },
];

/**
 * Connect: the statement-import path for one tenant. Replays TaxAgent.confirmImport's line INSERT (same
 * columns, same fingerprint + transfer rule; ids are deterministic so the OFF baseline is stable), then the
 * categoriser's outcome (an LLM call in production — fixed here: spend → 'payg', credits → 'income_personal'),
 * then stampDeductibility's deny-by-default verdict, then afterIngestStamped's two REAL hooks.
 */
async function importStatements(env: Env, u: string): Promise<string> {
  const accountId = await addAccount(env, u, { institution: "Westpac", name: "Everyday", type: "transaction", source: "statement" });
  await assertCanonicalSource(env, u, accountId, "statement");
  for (const s of STATEMENTS) {
    const sid = `${u}-${s.key}`;
    run(`INSERT INTO statements (id, user_id, account_id, filename, format, status) VALUES (?, ?, ?, 'westpac-sample.csv', 'csv', 'parsed')`, sid, u, accountId);
    const occ = new Map<string, number>();
    let i = 0;
    for (const line of s.lines) {
      const base = `${line.date}|${line.amount_cents}|${line.direction ?? "debit"}|${cleanMerchant(line.raw_description).toLowerCase()}`;
      const occurrence = occ.get(base) ?? 0;
      occ.set(base, occurrence + 1);
      const fp = await lineFingerprint(accountId, line, occurrence);
      const status = isTransferLike(line.raw_description) ? "ignored" : "needs_review"; // a fresh tenant has no rules; no pack merchant hint matches the fixture (deterministicCategorise ⇒ null)
      run(
        `INSERT INTO transactions (id, user_id, source, status, kind, account_id, statement_id, line_fingerprint, raw_description,
           merchant, amount_cents, currency, amount_aud_cents, txn_date, direction, bucket, ato_label, confidence, property_id)
         VALUES (?, ?, 'statement', ?, 'bank_line', ?, ?, ?, ?, ?, ?, 'AUD', ?, ?, ?, NULL, NULL, NULL, NULL)
         ON CONFLICT(user_id, account_id, line_fingerprint) DO NOTHING`,
        `${sid}-L${i++}`, u, status, accountId, sid, fp, line.raw_description, line.description, line.amount_cents, line.amount_cents, line.date, line.direction,
      );
    }
    run(`UPDATE statements SET status = 'imported', imported_count = (SELECT COUNT(*) FROM transactions WHERE statement_id = ?) WHERE id = ?`, sid, sid);
  }
  // categoriseStatement (LLM) outcome, fixed: spend → payg (no label yet), money in → income_personal.
  run(`UPDATE transactions SET status = 'categorised', confidence = 0.9, bucket = CASE direction WHEN 'credit' THEN 'income_personal' ELSE 'payg' END
        WHERE user_id = ? AND status = 'needs_review'`, u);
  // stampDeductibility (agent.ts): verdictForTxn over payg rows that are undetermined; likely_not ⇒ $0 claimable.
  const section = (auV1RulePack as unknown as { payg_deductibility: Parameters<typeof verdictForTxn>[3] }).payg_deductibility;
  for (const r of db.prepare(`SELECT id, bucket, ato_label, merchant FROM transactions WHERE user_id = ? AND bucket = 'payg' AND (deductibility IS NULL OR deductibility = 'undetermined' OR (deductibility = 'suggested_deductible' AND deductible_amount_cents IS NULL))`).all(u) as { id: string; bucket: string; ato_label: string | null; merchant: string | null }[]) {
    const v = verdictForTxn(r.bucket, r.ato_label, r.merchant, section);
    if (v.deductibility !== "undetermined") run(`UPDATE transactions SET deductibility = ?, deductible_amount_cents = ? WHERE id = ? AND user_id = ?`, v.deductibility, v.deductibility === "likely_not" ? 0 : null, r.id, u);
  }
  // afterIngestStamped (agent.ts): the relevance scan, then (wages_payer) the credit triage. Both no-ops OFF.
  await runRelevanceScan(env, u, { descriptor: AU_DESCRIPTOR });
  await noticeSignals(env, u, AU_DESCRIPTOR);
  return accountId;
}

const ANSWERS: AboutAnswers = { ...emptyAnswers(), residency: "all_year", spouse: "no", state: "NSW", occupation: "tradesperson", ticks: ["job", "wfh"] };
const W = { fy: FY, now: NOW };
const bunnings = (u: string, stmt: "s1" | "s2") => one<{ id: string }>(`SELECT id FROM transactions WHERE user_id = ? AND statement_id = ? AND merchant LIKE '%BUNNINGS%'`, u, `${u}-${stmt}`).id;
const receiptRow = (u: string) => run(
  // A snapped receipt OCR'd a day after the purchase with no readable merchant: the import-time auto-matcher
  // (merchant-aware, ≥ 0.8) leaves it, so it waits in Review as a proposal.
  `INSERT INTO transactions (id, user_id, source, status, kind, amount_cents, amount_aud_cents, currency, txn_date, bucket, direction, receipt_key)
   VALUES (?, ?, 'upload', 'extracted', 'receipt', 12050, 12050, 'AUD', '2026-05-06', 'payg', 'debit', ?)`, `${u}-rcpt`, u, `${u}/receipts/bunnings.jpg`);
// saveWorkUse (agent.ts): the Records step's WFH-hours fact.
const wfhHours = (u: string, hours: number) => run(`INSERT INTO work_use_inputs (user_id, fy, wfh_hours, updated_at) VALUES (?, ?, ?, datetime('now'))`, u, FY, hours);
// addIncome (agent.ts): the income statement, once it's "Tax ready" — gross + tax withheld, employer named.
const incomeStatement = (u: string) => run(
  `INSERT INTO income (id, user_id, person_id, income_type, fy, gross_cents, withholding_cents, currency, amount_aud_cents, fx_rate, detail_json, needs_review)
   VALUES (?, ?, ?, 'salary_payg', '2025-26', 5200000, 780000, 'AUD', 5200000, 1, ?, 0)`, `${u}-sal`, u, `person_self_${u}`, JSON.stringify({ employer: "Acme Pty Ltd" }));

// ════════════════════════════════════════════════════════════════════════════════════════════════════
async function journeyOn() {
  console.log("first-timer e2e — all journey flags ON (FY 2025-26)\n");
  const u = "ftE2E";
  const me = `person_self_${u}`;
  const j = () => readJourney(ON, u, FY, deps);
  const pos = async () => (await buildReport(ON, u, FY)).taxable_position_cents;

  const reviewOf = (x: Journey) => x.steps.find((s) => s.key === "review")!;
  const seen: Journey[] = [];
  const snap = async () => { const x = await j(); seen.push(x); return x; };

  // ── Signup ──
  await ensureTenant(ON, u);
  const j0 = await snap();
  check("signup: ensureTenant seats a profile + the self person", !!one(`SELECT 1 AS x FROM profiles WHERE user_id = ?`, u) && !!one(`SELECT 1 AS x FROM persons WHERE id = ?`, me));
  // Connect reads "needs attention" from the start: readiness's nothing_captured BLOCKER points into Connect.
  check(`signup: no step done; Connect is the thing to do (nothing captured); Review + Lodge not started [${stepLine(j0)}]`,
    j0.steps.every((s) => s.status !== "done") && steps(j0).connect === "needs_attention" && steps(j0).review === "not_started" && steps(j0).lodge === "not_started" &&
    j0.whats_left.some((w) => w.id === "nothing_captured" && w.step === "connect"));
  check("signup: the lodging-year default is the year just ended (FY 2025-26)", j0.lodging_fy === FY);

  // ── 1 Get set up: About you → dated situation periods (fill-gaps only) ──
  const fyB = fyBoundsFor(FY);
  let written = 0;
  for (const w of aboutYouWrites(ANSWERS, me, fyB)) if (!(await fillSituationPeriod(ON, u, w.write, W)).skipped) written++;
  const periods = (db.prepare(`SELECT fact, value, starts_on, ends_on FROM situation_periods WHERE user_id = ? ORDER BY fact`).all(u) as { fact: string; value: string; starts_on: string; ends_on: string }[]).map((p) => `${p.fact}=${p.value}@${p.starts_on}..${p.ends_on}`);
  check("setup: About you writes exactly the expected periods, each spanning the FY", written === 5 && JSON.stringify(periods) === JSON.stringify([
    "employment=tradesperson@2025-07-01..2026-06-30", "residency=resident@2025-07-01..2026-06-30", "spouse=no@2025-07-01..2026-06-30",
    "state=NSW@2025-07-01..2026-06-30", "wfh=yes@2025-07-01..2026-06-30",
  ]), periods);
  let again = 0;
  for (const w of aboutYouWrites(ANSWERS, me, fyB)) if (!(await fillSituationPeriod(ON, u, w.write, W)).skipped) again++;
  check("setup: re-running first run writes 0 rows", again === 0);
  check("setup: the legacy mirrors follow (occupation tradesperson, resident)", JSON.stringify(one(`SELECT occupation, tax_residency FROM persons WHERE id = ?`, me)) === JSON.stringify({ occupation: "tradesperson", tax_residency: "AU" }));
  const j1 = await snap();
  // The WFH tick already puts one item in Review (the hours to state, A7) — the only work before any money.
  check(`setup → done; Review holds just the WFH-hours fact; Lodge not started [${stepLine(j1)}]`,
    steps(j1).setup === "done" && steps(j1).connect === "needs_attention" && steps(j1).review === "in_progress" && reviewOf(j1).count === 1 &&
    JSON.stringify(j1.records?.facts_needed) === '["wfh_hours"]' && steps(j1).lodge === "not_started");

  // ── 2 Connect: two statements imported ──
  await importStatements(ON, u);
  const lines = one<{ n: number }>(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND kind = 'bank_line'`, u).n;
  check("connect: both statements import every fixture line (2 × 4), the transfers ignored", lines === 8 && one<{ n: number }>(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND status = 'ignored'`, u).n === 2);
  check("connect: no income is recorded from the deposits", one<{ n: number }>(`SELECT COUNT(*) AS n FROM income WHERE user_id = ?`, u).n === 0 && (await buildReport(ON, u, FY)).income.gross_cents === 0);

  // We noticed: the recurring Acme deposits are a payroll signal (a proposal — nothing recorded).
  const noticed = await listNoticed(ON, u, FY);
  const payroll = noticed.find((x) => x.kind === "payroll");
  check("we noticed: exactly one payroll signal — Acme, 2 deposits, $7,000 in", noticed.length === 1 && payroll?.evidence.n === 2 && payroll.evidence.total_cents === 700000 && /acme/i.test(payroll.evidence.label), noticed);
  const j2 = await snap();
  const rel0 = await relevanceView(ON, u, FY);
  const undecided0 = rel0.counts.relevant + rel0.counts.worth_a_look;
  // Bank credits but $0 income: the first-timer income-completeness blocker keeps Connect "needs attention".
  check(`connect: still needs attention — money came in but no income is recorded [${stepLine(j2)}]`, steps(j2).connect === "needs_attention" && j2.whats_left.some((w) => w.id.startsWith("income_not_recorded") && w.step === "connect"));
  check("review: ONE queue — the open 'we noticed' card + every undecided line + the WFH-hours fact (spec §0)",
    steps(j2).review === "in_progress" && reviewOf(j2).count === undecided0 + 1 + 1, { review: reviewOf(j2), undecided: undecided0, noticed: noticed.length });

  // "This is my wages": marks the employer, stamps the deposits, records NOTHING.
  const pc = await confirmNoticed(ON, u, payroll!.id, { occupation: "tradesperson" }, {
    now: NOW, descriptor: AU_DESCRIPTOR,
    recordCreditAsIncome: async () => { throw new Error("payroll must never record a deposit as income"); },
  });
  check("we noticed: 'This is my wages' records 0 income, stamps both deposits, asks for the income statement",
    pc.income_recorded === 0 && pc.stamped === 2 && pc.prompt === INCOME_STATEMENT_PROMPT && one<{ n: number }>(`SELECT COUNT(*) AS n FROM income WHERE user_id = ?`, u).n === 0, pc);
  check("we noticed: the confirmed card leaves the queue", (await listNoticed(ON, u, FY)).length === 0 && reviewOf(await j()).count === undecided0 + 1);
  const r2 = await computeFilingReadiness(ON, u, FY, deps);
  const inr = r2.findings.filter((f) => f.id.startsWith("income_not_recorded"));
  check("readiness: a per-employer 'income statement not recorded' BLOCKER names Acme", inr.length === 1 && inr[0]!.severity === "blocker" && /acme/i.test(inr[0]!.title), inr);

  // The income statement arrives ("Tax ready"): gross counted once; the employer blocker clears; Connect is done.
  incomeStatement(u);
  check("income statement: gross counted ONCE ($52k) — the $7k of deposits never added on top", (await buildReport(ON, u, FY)).income.gross_cents === 5200000);
  const j3 = await snap();
  check(`connect → done; Review in progress; Lodge not started [${stepLine(j3)}]`, steps(j3).setup === "done" && steps(j3).connect === "done" && steps(j3).review === "in_progress" && steps(j3).lodge === "not_started");

  // ── 3 Review: relevance cards for the occupation ──
  const rel = await relevanceView(ON, u, FY);
  const b1 = bunnings(u, "s1"), b2 = bunnings(u, "s2");
  check("review: both Bunnings lines are 'worth a look' for a tradesperson (tools rule), with the ATO tradesperson guide",
    rel.worth_a_look.length === 2 && rel.worth_a_look.every((w) => [b1, b2].includes(w.txn_id) && w.rule_id === "au-occ-tradie-tools" && w.occupation === "tradesperson" && /ato\.gov\.au/.test(w.ato_url ?? "")), rel.worth_a_look);
  check("review: every card explains why, without a dollar figure or tax-advice wording",
    rel.worth_a_look.every((w) => /Worth a look because you work as/.test(w.suggestion ?? "") && !/\$\s?\d/.test(w.suggestion ?? "") && !denylist.test(w.suggestion ?? "")));
  const others = (db.prepare(`SELECT id, merchant FROM transactions WHERE user_id = ? AND relevance = 'relevant'`).all(u) as { id: string; merchant: string }[]);
  check("review: the Officeworks lines are 'relevant' (to decide), never a tradesperson card", others.length === 2 && others.every((o) => /officeworks/i.test(o.merchant)) && !rel.worth_a_look.some((w) => !/bunnings/i.test(w.merchant ?? "")));
  const p0 = await pos();
  check("review: the scan claims nothing by itself (position = the flag-OFF read)", (await buildReport(OFF, u, FY)).taxable_position_cents === p0);

  // Claim one (the rule names D3/D5, so the user picks one) …
  const refused = await confirmWorthALook(ON, u, b1);
  check("claim: a confirm without the label pick is refused with the options (nothing written)", refused?.ok === false && refused.needs_label === true && (await pos()) === p0);
  const ok = await confirmWorthALook(ON, u, b1, { atoLabel: "D5" });
  const p1 = await pos();
  check("claim: confirming the $120.50 Bunnings line moves the position by exactly its amount", ok?.ok === true && p0 - p1 === 12050);
  // … and "Not work-related" on the rest (setDeductibility confirmed_not — the card's Not-for-work tap).
  for (const id of [b2, ...others.map((o) => o.id)]) run(`UPDATE transactions SET deductibility = ?, deductible_amount_cents = ? WHERE id = ? AND user_id = ?`, "confirmed_not", null, id, u);
  check("claim: 'Not work-related' moves nothing", (await pos()) === p1);

  // The confirmed claim now needs a record.
  const rec1 = await recordsView(ON, u, FY, auV1RulePack);
  check("records: 1 claim, no record yet, WFH hours still needed",
    rec1.block.claims_total === 1 && rec1.block.claims_with_record === 0 && JSON.stringify(rec1.block.facts_needed) === '["wfh_hours"]' && rec1.block.facts_done.length === 0, rec1.block);
  check("records: the claimed line is 'needs a record'", rec1.rows.find((r) => r.id === b1)?.status === "needs_record");
  const j4 = await snap();
  check(`review: the queue is now the claim's record + the WFH hours (2) [${stepLine(j4)}]`, steps(j4).review === "in_progress" && reviewOf(j4).count === 2);

  // Record: WFH hours (the fixed rate per hour adds to D5).
  wfhHours(u, 120);
  const rec2 = await recordsView(ON, u, FY, auV1RulePack);
  const p2 = await pos();
  check("records: entering WFH hours marks the fact done (and the fixed-rate amount counts)", JSON.stringify(rec2.block.facts_done) === '["wfh_hours"]' && p2 < p1);

  // Receipt match proposal → Match.
  receiptRow(u);
  const cfg = reconcileConfigFromPack(auV1RulePack);
  const props = await reconcileProposals(ON, u, FY, cfg, AU_DESCRIPTOR);
  check("receipt: exactly one confident proposal — the snapped receipt ↔ the claimed Bunnings line",
    props.proposals.length === 1 && props.proposals[0]!.receipt.id === `${u}-rcpt` && props.proposals[0]!.line.id === b1, props.proposals.map((p) => [p.receipt.id, p.line.id]));
  const j5 = await snap();
  check(`review: the proposal is a Review card (record still missing + the proposal = 2) [${stepLine(j5)}]`, steps(j5).review === "in_progress" && reviewOf(j5).count === 2);
  const tg = await receiptLinkTargets(ON, u, `${u}-rcpt`, b1, { sameDirection: true });
  if (tg) await applyReceiptLink(ON, u, `${u}-rcpt`, b1, tg.donor, { snapshot: true }); // linkReceipt → linkReceiptToLine (reconcile_proposals ON)
  check("receipt: Match links it — evidence, never a second deduction (position unchanged); no proposal left",
    !!tg && (await pos()) === p2 && (await reconcileProposals(ON, u, FY, cfg, AU_DESCRIPTOR)).proposals.length === 0);
  const rec3 = await recordsView(ON, u, FY, auV1RulePack);
  check("records: the claim now has its record (receipt) — the meter is complete",
    rec3.block.claims_with_record === 1 && rec3.rows.find((r) => r.id === b1)?.record?.kind === "receipt");

  // ── Readiness ──
  const rep = await buildReport(ON, u, FY);
  const ready = await computeFilingReadiness(ON, u, FY, deps);
  check("readiness: 0 blockers; no income_not_recorded finding", ready.readiness_score.blockers === 0 && !ready.findings.some((f) => f.id.startsWith("income_not_recorded")), ready.findings.filter((f) => f.severity === "blocker").map((f) => f.id));
  check("readiness: GENERAL-INFO framing, never a refund / tax payable", !denylist.test(JSON.stringify(ready.findings.map((f) => [f.title, f.general_info_note]))) && /general information/i.test(ready.disclaimer));
  const j6 = await snap();
  check(`setup, connect, review done; lodge not started [${stepLine(j6)}]`,
    steps(j6).setup === "done" && steps(j6).connect === "done" && steps(j6).review === "done" && reviewOf(j6).count === 0 && steps(j6).lodge === "not_started" && j6.readiness.blockers === 0);
  check("home: the estimate is shown (0 blockers), labelled, with no refund field", !!j6.readiness.estimate && !/refund|tax_payable/i.test(Object.keys(j6.readiness.estimate).join()) && j6.readiness.estimate.tracked_cents === rep.taxable_position_cents);

  // ── 4 Lodge in myTax: the worksheet in myTax order, tied back ──
  const ws = await buildMytaxWorksheet(ON, u, FY, { report: rep });
  const packOrder = (auV1RulePack as unknown as { mytax_sections: { key: string }[] }).mytax_sections.map((s) => s.key);
  const keys = ws.sections.map((s) => s.key);
  check(`worksheet: sections in myTax order, starting Contact & bank → Personalise [${keys.join(" → ")}]`,
    keys[0] === "contact_bank" && keys[1] === "personalise" && keys.every((k, i) => i === 0 || packOrder.indexOf(k) > packOrder.indexOf(keys[i - 1]!)));
  const d5 = ws.sections.find((s) => s.key === "deductions")?.lines.find((l) => l.key === "D5");
  check("worksheet: D5 = the claimed Bunnings line + the WFH fixed rate", d5?.amount_cents === 12050 + (rep.work_method?.wfh_cents ?? 0) && (rep.work_method?.wfh_cents ?? 0) > 0, d5);
  check("worksheet: salary is a CHECK line for Acme (prefilled) and the worksheet ties back", ws.sections.find((s) => s.key === "income_check")?.lines.some((l) => l.kind === "check" && l.amount_cents === 5200000) === true && ws.tie_back.ok && ws.tie_back.income_ok, ws.tie_back);
  check("worksheet: no refund / tax-payable field anywhere", !/"[^"]*(refund|tax_payable)[^"]*"\s*:/i.test(JSON.stringify(ws)));

  // Mark as lodged → the default year advances.
  const lodgedOn = "2026-08-28";
  check("lodge: the lodged-on date is valid for FY 2025-26", lodgedOnError(lodgedOn, FY, NOW, AU_DESCRIPTOR) === null);
  await markFyLodged(ON, u, FY, lodgedOn);
  const j7 = await snap();
  check(`lodge → done; every step done [${stepLine(j7)}]`, j7.steps.every((s) => s.status === "done") && j7.lodged);
  check("lodge: the lodging-year default advances to FY 2026-27", j0.lodging_fy === FY && j7.lodging_fy === FY + 1 && lodgingFy(NOW, AU_DESCRIPTOR.taxPeriod, [FY]) === FY + 1);

  // Progression: the first unfinished step only ever moves forward, through all four in order, and a step
  // once done stays done.
  const first = seen.map((x) => x.steps.findIndex((s) => s.status !== "done"));
  const monotone = first.every((v, i) => i === 0 || (v === -1 ? true : first[i - 1] !== -1 && v >= first[i - 1]!));
  const stayDone = seen.every((x, i) => i === 0 || seen[i - 1]!.steps.every((s, k) => s.status !== "done" || x.steps[k]!.status === "done"));
  check(`progression: setup → connect → review → lodge, never backwards [${first.join(",")}]`,
    monotone && stayDone && [0, 1, 2, 3, -1].every((k) => first.includes(k)));

  // Delete my data (APP 13) -> a returning user starts the journey again with a usable tenant: purgeTenant reseats
  // the profile AND the self person (#623), so Get set up isn't stuck on "your profile isn't ready".
  await purgeTenant(ON, u);
  const jp = await j();
  check(`purge: the tenant is reseated (profile + self person) and the journey starts over [${stepLine(jp)}]`,
    !!one(`SELECT 1 AS x FROM persons WHERE id = ? AND role = 'self'`, me) && !!one(`SELECT 1 AS x FROM profiles WHERE user_id = ?`, u) &&
    !jp.lodged && jp.lodging_fy === FY && jp.steps.every((s) => s.status !== "done") && steps(jp).review === "not_started" &&
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM situation_periods WHERE user_id = ?`, u).n === 0);
  return { position: rep.taxable_position_cents, deductions: rep.total_deductions_cents, income: rep.total_income_cents };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// OFF baseline: the same year with every journey flag OFF, through the legacy paths (Settings occupation,
// Sort-queue confirm, Reconcile Link, Income page). Its report + readiness must equal the committed baseline.
const VOLATILE = /(^|_)(generated_at|generatedat|created_at|updated_at|decided_at|now|timestamp|run_at|requested_at|_ts)$/i;
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) if (!VOLATILE.test(k)) out[k] = normalize((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

async function journeyOff(onTotals: { position: number; deductions: number; income: number }) {
  console.log("\nfirst-timer e2e — all journey flags OFF (baseline)\n");
  const u = "ftE2EOff";
  await ensureTenant(OFF, u);
  run(`UPDATE persons SET occupation = 'tradesperson' WHERE id = ?`, `person_self_${u}`); // Settings → occupation (legacy writer)
  await importStatements(OFF, u);
  check("OFF: no relevance written, no 'we noticed' signal, no worth-a-look card",
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND relevance IS NOT NULL`, u).n === 0 &&
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM noticed_signals WHERE user_id = ?`, u).n === 0 &&
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM claim_suggestions WHERE user_id = ?`, u).n === 0);
  check("OFF: the worth-a-look confirm declines (legacy confirm stands)", (await confirmWorthALook(OFF, u, bunnings(u, "s1"), { atoLabel: "D5" })) === null);
  check("OFF: GET /api/mytax-worksheet is a 404", (await mytaxWorksheetResponse(OFF, u, FY)).status === 404);
  // Sort queue: claim the same line as D5 (setDeductibility + the label), the other as not deductible.
  run(`UPDATE transactions SET deductibility = 'confirmed_deductible', deductible_amount_cents = NULL, ato_label = 'D5' WHERE id = ? AND user_id = ?`, bunnings(u, "s1"), u);
  run(`UPDATE transactions SET deductibility = 'confirmed_not', deductible_amount_cents = NULL WHERE id = ? AND user_id = ?`, bunnings(u, "s2"), u);
  wfhHours(u, 120);
  receiptRow(u);
  const tg = await receiptLinkTargets(OFF, u, `${u}-rcpt`, bunnings(u, "s1"), { sameDirection: false });
  if (tg) await applyReceiptLink(OFF, u, `${u}-rcpt`, bunnings(u, "s1"), tg.donor, { snapshot: false }); // linkReceiptToLine, flag OFF
  incomeStatement(u);

  const report = await buildReport(OFF, u, FY);
  const readiness = await computeFilingReadiness(OFF, u, FY, deps);
  check("OFF vs ON: the same year lands on the same money (position, deductions, income)",
    report.taxable_position_cents === onTotals.position && report.total_deductions_cents === onTotals.deductions && report.total_income_cents === onTotals.income,
    { off: [report.taxable_position_cents, report.total_deductions_cents, report.total_income_cents], on: onTotals });
  check("OFF: no first-timer journey finding renders", !readiness.findings.some((f) => /^(income_not_recorded:|study_loan_passthrough|residency_unsure|worksheet_unlabelled)/.test(f.id)));

  // Ids are tenant-prefixed in both runs; strip the tenant so the baseline names the fixture, not the run.
  const serialized = JSON.stringify(normalize({ report, readiness }), null, 2).split(u).join("<tenant>") + "\n";
  if (process.env.UPDATE_SNAPSHOT) {
    fs.writeFileSync(FIXTURE, serialized);
    console.log(`  wrote OFF baseline (${serialized.length} bytes) → ${path.relative(root, FIXTURE)}`);
    return;
  }
  if (!fs.existsSync(FIXTURE)) { check(`OFF baseline fixture exists (${path.relative(root, FIXTURE)}) — run with UPDATE_SNAPSHOT=1`, false); return; }
  const expected = fs.readFileSync(FIXTURE, "utf8");
  if (serialized === expected) { check("OFF: report + readiness byte-identical to the committed baseline", true); return; }
  const cur = serialized.split("\n"), exp = expected.split("\n");
  let i = 0;
  while (i < cur.length && i < exp.length && cur[i] === exp[i]) i++;
  check(`OFF: report + readiness byte-identical to the committed baseline — first difference at line ${i + 1}`, false, { expected: exp[i] ?? "(end)", current: cur[i] ?? "(end)" });
}

async function main() {
  const on = await journeyOn();
  await journeyOff(on);
  console.log(`\n=== e2e first-timer: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}
main();
