#!/usr/bin/env tsx
// Offline unit tests for the pure invariants that underpin statement import + async
// categorisation. No worker runtime / D1 / Claude — these are the fast, deterministic
// regression guards for the rules we keep re-learning. Run: npm run test:units
import { reconcileStatement, deriveBalances, isTransferLike, classifyMovement, movementTreatment, signedCents, lineFingerprint, type StatementLine } from "../src/lib/statements";
import { groupKey, groupForClarify, rulePatternForStem } from "../src/lib/clarify";
import { scoreClaimMatches } from "../src/lib/claim-match";
import { batchStatementStatus, isStaleBatch, BATCH_MAX_AGE_MS } from "../src/lib/batch";
import { extractSituationDraft, parseBatchMessage, mapBatchItems, type BatchItem } from "../src/extract";
import type { LLM } from "../src/llm";
import { isValidAbn, normaliseAbn } from "../web/src/lib/abn";
import { billableCents } from "../src/lib/billing";
import { costCents } from "../src/lib/usage";
import { BUCKETS } from "../src/lib/taxonomy";
import { applyUserRules } from "../src/lib/rules";
import type { UserRule } from "../src/lib/db";
import { parseRoles, hasRole, isAdmin, normaliseRoles, ROLES } from "../src/lib/roles";
import { buildGuidePrompt } from "../src/lib/guide";
import type { Progress } from "../src/lib/progress";
import { fyBounds, fyLabel } from "../src/lib/ledger-totals";
import { currentFyStartYear } from "../src/lib/report";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

const line = (o: Partial<StatementLine> & { amount_cents: number; direction: "debit" | "credit" }): StatementLine => ({
  date: "2026-01-01",
  description: o.description ?? "x",
  raw_description: o.raw_description ?? o.description ?? "x",
  balance_cents: null,
  ...o,
});

// ── Reconciliation: the completeness proof ───────────────────────────────────
console.log("reconcileStatement");
{
  // opening 100.00, -10, -20, +5 → expected 75.00; balances continuous.
  const lines: StatementLine[] = [
    line({ amount_cents: 1000, direction: "debit", balance_cents: 9000 }),
    line({ amount_cents: 2000, direction: "debit", balance_cents: 7000 }),
    line({ amount_cents: 500, direction: "credit", balance_cents: 7500 }),
  ];
  const bal = deriveBalances(lines)!;
  const r = reconcileStatement(lines, bal.opening_cents, bal.closing_cents);
  check("derives opening from first line + signed amount", bal.opening_cents === 10000);
  check("balanced statement reconciles (ok=true)", r.ok && r.available);
  check("diff is exactly 0 when balanced", r.diff_cents === 0);
  check("no first_bad_line when continuous", r.first_bad_line === null);

  // Tamper line 2's balance by $10 → continuity breaks at index 1, not 0.
  const tampered = lines.map((l, i) => (i === 1 ? { ...l, balance_cents: 8000 } : l));
  const t = reconcileStatement(tampered, bal.opening_cents, bal.closing_cents);
  check("tampered balance is caught (ok=false)", !t.ok);
  check("first_bad_line points at the tampered row", t.first_bad_line === 1);

  // Closing off by exactly -$10 (a dropped $10 debit) → diff = +1000 (expected > stated closing).
  const short = reconcileStatement(lines, bal.opening_cents, bal.closing_cents - 1000);
  check("dropped $10 surfaces as a $10 diff", Math.abs(short.diff_cents) === 1000 && !short.ok);

  // No balances → unavailable, not a false pass.
  const noBal = reconcileStatement([line({ amount_cents: 100, direction: "debit" })], null, null);
  check("no-balance statement reports available=false", !noBal.available && !noBal.ok);

  // Liability (credit card): debits INCREASE the balance owed, credits reduce it. Real figures
  // from a CommBank Ultimate Awards statement: opening $1,866.14, purchases $8,528.99,
  // payments $8,800.00 → closing $1,595.13. With the default (asset) sign it would NOT balance.
  const cc: StatementLine[] = [
    line({ amount_cents: 852899, direction: "debit", description: "purchases" }),
    line({ amount_cents: 880000, direction: "credit", description: "payments" }),
  ];
  const ccOk = reconcileStatement(cc, 186614, 159513, true);
  check("credit-card statement reconciles when liability-aware", ccOk.ok && ccOk.available && ccOk.diff_cents === 0);
  const ccAsset = reconcileStatement(cc, 186614, 159513, false);
  check("same credit-card statement does NOT balance under asset sign", !ccAsset.ok && ccAsset.diff_cents === 54202);
}

// ── Transfer detection: conservative (never drop a real expense) ─────────────
console.log("isTransferLike");
{
  check("flags credit-card bill payment", isTransferLike("CREDIT CARD PAYMENT THANK YOU"));
  check("flags internal transfer to savings", isTransferLike("Transfer to Savings"));
  // Regression: BPAY to a real biller (Origin Energy) must NOT be dropped.
  check("does NOT flag BPAY Origin Energy (real bill)", !isTransferLike("BPAY Origin Energy 12345"));
  check("does NOT flag Osko payment to a person", !isTransferLike("Osko Payment John Smith"));
  check("does NOT flag a normal merchant", !isTransferLike("WOOLWORTHS 1234 SYDNEY"));
}

// ── Stage A movement classifier: auto-ignore safe set vs CONFIRM/REVIEW set (B3) ─
console.log("classifyMovement");
{
  // ONLY card payments + keyword-internal transfers are auto-ignore-safe (ingest byte-identical to legacy).
  check("card payment → card_payment, auto-ignore safe", classifyMovement("CREDIT CARD PAYMENT THANK YOU").klass === "card_payment" && classifyMovement("CREDIT CARD PAYMENT THANK YOU").autoIgnoreSafe);
  check("to-savings → internal_transfer, auto-ignore safe", classifyMovement("Transfer to Savings").klass === "internal_transfer" && classifyMovement("Transfer to Savings").autoIgnoreSafe);
  // Masked own-account transfer is internal but CONFIRM-only (NOT auto-ignored at ingest).
  check("masked 'Transfer to xx6819 CommBank app' → internal_transfer, NOT auto-ignore", classifyMovement("Transfer to xx6819 CommBank app").klass === "internal_transfer" && classifyMovement("Transfer to xx6819 CommBank app").autoIgnoreSafe === false);
  // NAMED transfer (rental income!) and bare-BSB PayAnyone (real third-party payment) are NOT movements.
  check("NAMED 'Transfer From Catherine Soper' is NOT a movement (it's rental income)", classifyMovement("Transfer From Catherine Soper").klass === "none");
  check("PayAnyone 'Transfer To 062000 12345678 Joe Tradie' is NOT a movement (real third party)", classifyMovement("Transfer To 062000 12345678 Joe Tradie").klass === "none");
  check("'Transfer To The App Company Payroll' is NOT a movement (vendor named 'app')", classifyMovement("Transfer To The App Company Payroll").klass === "none");
  check("bare-BSB transfer is NOT auto-ignored at ingest", !isTransferLike("Transfer To 062000 12345678 Joe Tradie") && !isTransferLike("Transfer To The App Company Payroll"));
  // B3: loan/mortgage repayments are detected but NEVER auto-ignored AND never one-tap excluded.
  check("'Loan Repayment LN REPAY' → loan_repayment, NOT auto-ignore", classifyMovement("Loan Repayment LN REPAY 12345").klass === "loan_repayment" && classifyMovement("Loan Repayment LN REPAY 12345").autoIgnoreSafe === false);
  check("'Investment Loan Interest' is detected as loan_repayment", classifyMovement("Investment Loan Interest Charge").klass === "loan_repayment");
  check("loan repayment is NOT swept by isTransferLike (ingest leaves it captured)", !isTransferLike("Loan Repayment LN REPAY 12345"));
  // Investment-app deposits.
  check("'PayTo Stakeshop Deposit to Stake' → investment_deposit, NOT auto-ignore", classifyMovement("PayTo Stakeshop Pty Deposit to Stake").klass === "investment_deposit" && classifyMovement("PayTo Stakeshop Pty Deposit to Stake").autoIgnoreSafe === false);
  // Regressions: real third-party bills/merchants are NEVER classed as movements.
  check("BPAY Origin Energy is none", classifyMovement("BPAY Origin Energy 12345").klass === "none");
  check("Woolworths is none", classifyMovement("WOOLWORTHS 1234 SYDNEY").klass === "none");
  check("Osko to a person is none", classifyMovement("Osko Payment John Smith").klass === "none");
}

// ── Stage A movement treatment: ignorable vs review vs skip (B3 + income guard) ─
console.log("movementTreatment");
{
  // Loan lines are ALWAYS review-only — never one-tap excluded, regardless of rental status (B3).
  check("loan_repayment (debit) → review, never ignorable", movementTreatment("loan_repayment", "debit") === "review");
  check("loan_repayment (credit) → review", movementTreatment("loan_repayment", "credit") === "review");
  // An investment-app DEBIT is a capital movement (ignorable); a CREDIT is likely income → skip.
  check("investment_deposit DEBIT → ignorable", movementTreatment("investment_deposit", "debit") === "ignorable");
  check("investment_deposit CREDIT → skip (likely dividend/return = income)", movementTreatment("investment_deposit", "credit") === "skip");
  // Transfers / card payments are non-income movements either direction.
  check("internal_transfer either direction → ignorable", movementTreatment("internal_transfer", "credit") === "ignorable" && movementTreatment("internal_transfer", "debit") === "ignorable");
  check("card_payment → ignorable", movementTreatment("card_payment", "debit") === "ignorable");
  check("none → skip", movementTreatment("none", "debit") === "skip");
}

// ── Stage B clarify engine: group_key normalization + grouping/thresholds ─────
console.log("clarify.groupKey");
{
  // The flagship case: 9 phrasings of the same payee collapse to ONE key.
  const phrasings = [
    "Transfer From Catherine Soper",
    "Direct Credit 123456 Catherine Soper",
    "OSKO Deposit Catherine Soper Rent",
    "Catherine Soper PayID 06/05",
    "Transfer from CATHERINE SOPER 1234567",
    "NetBank Transfer Catherine Soper",
    "Catherine  Soper",
    "PayTo Catherine Soper Value Date 05/06",
    "Anytime Transfer Catherine Soper Rent Payment",
  ];
  const keys = new Set(phrasings.map((p) => groupKey(p)));
  check("9 Catherine Soper phrasings collapse to ONE group_key", keys.size === 1 && [...keys][0] === "catherine soper");
  // BPAY billers with distinct names stay SEPARATE.
  check("BPAY Origin Energy → its own stem", groupKey("BPAY Origin Energy 12345") === "energy origin");
  check("BPAY billers with different names don't merge", groupKey("BPAY Origin Energy 12345") !== groupKey("BPAY Telstra Corp 999"));
  // No usable identity → null (never forms a junk group).
  check("a bare numeric/noise description → null (ungroupable)", groupKey("OSKO Deposit 123456 06/05") === null);
  check("empty → null", groupKey("") === null && groupKey(null) === null);
  check("amazon variants merge (short suffix dropped)", groupKey("AMAZON AU") === groupKey("AMAZON US") && groupKey("AMAZON AU") === "amazon");
  // The learned-rule pattern must be a REAL substring of the raw merchant (the sorted stem isn't).
  const stem = groupKey("BPAY Origin Energy 12345")!; // "energy origin"
  const pat = rulePatternForStem(stem);
  check("rule pattern is a token of the stem", stem.split(" ").includes(pat));
  check("rule pattern substring-matches the raw merchant (sorted stem would NOT)", "bpay origin energy 12345".includes(pat) && !"bpay origin energy 12345".includes(stem));
}

console.log("clarify.groupForClarify");
{
  const mk = (raw: string, dir: "debit" | "credit", cents: number) => ({ raw_description: raw, merchant: raw, amount_cents: cents, amount_aud_cents: cents, direction: dir });
  // 3 same-payee credits → one group (K=3); a singleton is NOT grouped.
  const rows = [
    mk("Transfer From Catherine Soper", "credit", 50000),
    mk("Transfer From Catherine Soper", "credit", 50000),
    mk("Transfer From Catherine Soper", "credit", 50000),
    mk("Coles 4567 Bondi", "debit", 8000), // singleton → not grouped
  ];
  const groups = groupForClarify(rows);
  check("recurring credit (×3) forms a group", groups.length === 1 && groups[0]!.group_key === "catherine soper");
  check("the group carries count + total + credit direction", groups[0]!.n === 3 && groups[0]!.total_cents === 150000 && groups[0]!.direction === "credit");
  check("singleton (×1, sub-threshold) is NOT grouped (stays in review queue)", !groups.some((g) => g.group_key.includes("coles")));
  // A single big-dollar debit clears the $ threshold even with count 1.
  const big = groupForClarify([mk("ATO Tax Agent Fee", "debit", 30000)]);
  check("a single >=$250 pattern clears the $ threshold", big.length === 1 && big[0]!.direction === "debit");
  // Direction-aware suggestions.
  check("credit group suggests rental income with property pick", groups[0]!.suggestions.some((s) => s.kind === "income_property" && s.needs_property));
  check("debit group suggests private (payg) + ignore", big[0]!.suggestions.some((s) => s.kind === "bucket" && s.bucket === "payg") && big[0]!.suggestions.some((s) => s.kind === "ignore"));
}

// ── Phase 3 claim auto-matcher: scoreClaimMatches ─────────────────────────────
console.log("scoreClaimMatches");
{
  const rule = { scope_type: "bucket", scope_value: "payg", merchant_hint: "asic,union", ato_label: "union-fees", claim_type: "immediate", general_info_note: "" };
  const txn = (over: Partial<{ id: string; merchant: string | null; bucket: string | null; ato_label: string | null; direction: string | null; amount_cents: number | null; amount_aud_cents: number | null; txn_date: string | null }>) =>
    ({ id: "t", merchant: null, bucket: null, ato_label: null, direction: "debit", amount_cents: 1000, amount_aud_cents: 1000, txn_date: null, ...over });
  // Full match (merchant + bucket + label) → all three reasons; debit only.
  const full = scoreClaimMatches(rule, [txn({ id: "a", merchant: "ASIC Annual Fee", bucket: "payg", ato_label: "union-fees" })]);
  check("full match surfaces with all three reasons", full.length === 1 && full[0]!.reasons.length === 3);
  // Bucket-only (0.35) clears the 0.30 floor; merchant-only (0.45) too.
  check("bucket-only match (0.35) clears the floor", scoreClaimMatches(rule, [txn({ bucket: "payg" })]).length === 1);
  check("merchant-only match (0.45) clears the floor", scoreClaimMatches(rule, [txn({ merchant: "Union Dues NSW" })]).length === 1);
  // Label-only (0.25) is below the 0.30 floor → dropped.
  check("label-only (0.25) is below the floor → dropped", scoreClaimMatches(rule, [txn({ ato_label: "union-fees" })]).length === 0);
  // Credits are never claim evidence.
  check("a credit is never a claim candidate", scoreClaimMatches(rule, [txn({ merchant: "ASIC", bucket: "payg", direction: "credit" })]).length === 0);
  // An un-hinted rule earns no merchant points.
  const noHint = { ...rule, merchant_hint: null };
  check("un-hinted rule: a non-bucket txn scores 0 → dropped", scoreClaimMatches(noHint, [txn({ merchant: "ASIC" })]).length === 0);
  // Ordering: higher score first.
  const ranked = scoreClaimMatches(rule, [txn({ id: "weak", bucket: "payg" }), txn({ id: "strong", merchant: "ASIC", bucket: "payg", ato_label: "union-fees" })]);
  check("candidates ranked by score desc", ranked[0]!.id === "strong");
}

// ── signedCents ──────────────────────────────────────────────────────────────
console.log("signedCents");
{
  check("debit is negative", signedCents({ amount_cents: 500, direction: "debit" }) === -500);
  check("credit is positive", signedCents({ amount_cents: 500, direction: "credit" }) === 500);
}

// ── Batch outcome decisions ──────────────────────────────────────────────────
console.log("batchStatementStatus / isStaleBatch");
{
  check("all-errored, none applied → failed (not stuck categorising)", batchStatementStatus(0, 5) === "failed");
  check("some applied, some errored → imported", batchStatementStatus(3, 2) === "imported");
  check("all applied → imported", batchStatementStatus(10, 0) === "imported");
  check("nothing happened (0,0) → imported (no error to report)", batchStatementStatus(0, 0) === "imported");

  const now = 1_800_000_000_000; // fixed clock (Date.now() is unavailable here anyway)
  const justNow = new Date(now - 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  const old = new Date(now - BATCH_MAX_AGE_MS - 60_000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  check("a fresh submitted job is not stale", !isStaleBatch(justNow, now));
  check("a >24h submitted job is stale", isStaleBatch(old, now));
  check("unparseable timestamp is not treated as stale", !isStaleBatch("not-a-date", now));
}

// ── Fingerprint stability (re-upload de-dup) ─────────────────────────────────
console.log("lineFingerprint");
{
  const a = line({ amount_cents: 1234, direction: "debit", raw_description: "WOOLWORTHS  1234", balance_cents: 5000 });
  const b = line({ amount_cents: 1234, direction: "debit", raw_description: "woolworths 1234", balance_cents: 5000 });
  const c = line({ amount_cents: 9999, direction: "debit", raw_description: "WOOLWORTHS 1234", balance_cents: 5000 });
  const [fa, fb, fc] = await Promise.all([lineFingerprint("acct1", a), lineFingerprint("acct1", b), lineFingerprint("acct1", c)]);
  check("same line (case/whitespace-insensitive) → same fingerprint", fa === fb);
  check("different amount → different fingerprint", fa !== fc);
  const fOther = await lineFingerprint("acct2", a);
  check("account-scoped: same line, different account → different fingerprint", fa !== fOther);

  // Credit-card (balance-less) collisions the fingerprint must NOT merge:
  // a charge and its same-day same-amount refund (direction differs), and genuine repeat charges.
  const charge = line({ amount_cents: 9854, direction: "debit", raw_description: "SPLIT MY FARE MORPETH" });
  const refund = line({ amount_cents: 9854, direction: "credit", raw_description: "SPLIT MY FARE MORPETH" });
  const [fCharge, fRefund] = await Promise.all([lineFingerprint("cc", charge), lineFingerprint("cc", refund)]);
  check("charge vs same-day same-amount refund → different fingerprint (direction in key)", fCharge !== fRefund);
  const dup = line({ amount_cents: 1080, direction: "debit", raw_description: "CITY OF YARRA PARKING" });
  const [occ0, occ1, occ0b] = await Promise.all([
    lineFingerprint("cc", dup, 0),
    lineFingerprint("cc", dup, 1),
    lineFingerprint("cc", dup, 0),
  ]);
  check("two identical same-day lines → distinct fingerprints by occurrence", occ0 !== occ1);
  check("occurrence is deterministic → re-upload reproduces the same fingerprint", occ0 === occ0b);
}

// ── ABN checksum (onboarding inline validation) ──────────────────────────────
console.log("isValidAbn");
{
  check("ATO example 51 824 753 556 is valid", isValidAbn("51824753556"));
  check("tolerates spaces in a valid ABN", isValidAbn("51 824 753 556"));
  check("last-digit typo is rejected", !isValidAbn("51824753557"));
  check("wrong length is rejected", !isValidAbn("123456789"));
  check("empty is rejected", !isValidAbn(""));
  check("normaliseAbn strips spaces and punctuation", normaliseAbn("51 824 753 556") === "51824753556");
}

// ── Onboarding draft extraction: tool_use payload → validated SituationDraft ──
// Stub the LLM so this stays offline (no Claude call). We only assert the mapping +
// zod validation around the forced record_situation tool call.
console.log("extractSituationDraft");
{
  const stubLLM = (input: unknown): LLM => ({
    client: {} as Anthropic,
    modelId: "stub",
    async create() {
      return {
        content: [{ type: "tool_use", id: "t1", name: "record_situation", input }],
      } as unknown as Anthropic.Message;
    },
  });

  const draft = await extractSituationDraft(
    stubLLM({
      entities: [
        { kind: "company", name: "Acme Pty Ltd", detail: { abn: "51824753556", gst_registered: true } },
        { kind: "employment", name: "BigCo", detail: { employer: "BigCo" } },
      ],
      properties: [{ label: "Rental 1", address: "14 Rental St, Sydney NSW", status: "rented", ownership_pct: 50 }],
      rules: [{ pattern: "Ray White", bucket: "property_rented", ato_label: "rental:mgmt" }],
    }),
    "I run Acme, employed at BigCo, one rental.",
  );
  check("maps both entities", draft.entities.length === 2);
  check("preserves company ABN + GST flag", draft.entities[0].detail.abn === "51824753556" && draft.entities[0].detail.gst_registered === true);
  check("maps the property with ownership %", draft.properties.length === 1 && draft.properties[0].ownership_pct === 50);
  check("maps the suggested rule", draft.rules.length === 1 && draft.rules[0].bucket === "property_rented");

  // Defaults: empty arrays when the model returns nothing, missing detail → {}.
  const empty = await extractSituationDraft(stubLLM({ entities: [], properties: [], rules: [] }), "n/a");
  check("empty draft yields empty arrays", empty.entities.length === 0 && empty.properties.length === 0 && empty.rules.length === 0);

  // A bad enum value must be rejected by zod (guards against silent garbage).
  let threw = false;
  try {
    await extractSituationDraft(stubLLM({ entities: [{ kind: "bogus", name: "x", detail: {} }], properties: [], rules: [] }), "x");
  } catch {
    threw = true;
  }
  check("invalid entity kind is rejected by schema", threw);
}

// ── Depreciation engine: exact-cents golden tests (the deterministic core) ────
import { computeFyDeduction, rollSchedule, daysInFy, daysHeldInFy, balancingAdjustment, depreciableCostCents, isLowCostAsset, looksLikePersonalTransfer, type DepAsset } from "../src/lib/depreciation";

console.log("asset auto-classification heuristics (isLowCostAsset / looksLikePersonalTransfer)");
{
  const T = 30000; // $300 immediate-deduction threshold, in cents
  check("$100 (≤ $300) is low-cost → immediate", isLowCostAsset(10000, T) === true);
  check("$200 (≤ $300) is low-cost → immediate", isLowCostAsset(20000, T) === true);
  check("exactly $300 is low-cost (boundary inclusive)", isLowCostAsset(30000, T) === true);
  check("$472 (> $300) is NOT low-cost → depreciate", isLowCostAsset(47200, T) === false);
  check("no threshold known → never low-cost (don't mis-expense)", isLowCostAsset(10000, null) === false);
  check("zero/negative cost is not low-cost", isLowCostAsset(0, T) === false);
  // looksLikePersonalTransfer — catches P2P transfers, not real shop names.
  check("'Transfer To MATTHEW PETERS - Sofa Deposit' is a personal transfer", looksLikePersonalTransfer("Transfer To MATTHEW PETERS - Sofa Deposit") === true);
  check("Osko / PayID lines are personal transfers", looksLikePersonalTransfer("OSKO PAYMENT to John") === true && looksLikePersonalTransfer("PayID transfer") === true);
  check("'JB Hi Fi Prahran' is NOT a transfer (real shop)", looksLikePersonalTransfer("JB Hi Fi Prahran") === false);
  check("'IKEA Tempe NS AUS' is NOT a transfer (real shop)", looksLikePersonalTransfer("IKEA Tempe NS AUS") === false);
  check("a bare 'deposit' (e.g. rental bond) is NOT matched on its own", looksLikePersonalTransfer("Rental bond deposit") === false);
  check("empty/null merchant is not a transfer", looksLikePersonalTransfer(null) === false && looksLikePersonalTransfer("") === false);
}

console.log("depreciation: Div 40 diminishing value (ATO worked example $80k, 5yr life)");
{
  const a: DepAsset = { asset_class: "div40_plant", cost_cents: 8_000_000, acquired_date: "2025-07-01", effective_life_years: 5, method: "diminishing_value" };
  const y1 = computeFyDeduction(a, 2025, 8_000_000); // full non-leap year (2026 not leap)
  check("DV year 1 = $32,000 exactly", y1.deduction_cents === 3_200_000);
  check("DV year 1 closing = $48,000", y1.closing_cents === 4_800_000);
  const y2 = computeFyDeduction(a, 2026, y1.closing_cents);
  check("DV year 2 = $19,200 exactly", y2.deduction_cents === 1_920_000);
}

console.log("depreciation: Div 40 prime cost (straight line)");
{
  const a: DepAsset = { asset_class: "div40_plant", cost_cents: 8_000_000, acquired_date: "2025-07-01", effective_life_years: 5, method: "prime_cost" };
  const y1 = computeFyDeduction(a, 2025, 8_000_000);
  const y2 = computeFyDeduction(a, 2026, y1.closing_cents);
  check("PC year 1 = $16,000", y1.deduction_cents === 1_600_000);
  check("PC year 2 = $16,000 (constant on cost)", y2.deduction_cents === 1_600_000);
}

console.log("depreciation: leap-year days + part-year");
{
  check("FY 2027-28 spans 29 Feb 2028 → 366 days", daysInFy(2027) === 366);
  check("FY 2025-26 → 365 days", daysInFy(2025) === 365);
  // Acquired 1 Jan 2026 → held 1 Jan..30 Jun = 181 days in FY 2025.
  const a: DepAsset = { asset_class: "div40_plant", cost_cents: 8_000_000, acquired_date: "2026-01-01", effective_life_years: 5, method: "prime_cost" };
  check("part-year days held = 181", daysHeldInFy(a, 2025) === 181);
  const part = computeFyDeduction(a, 2025, 8_000_000);
  // 8,000,000 × 181/365 × 0.2 = 793,424.66 → 793,425 cents.
  check("part-year PC deduction rounds to $7,934.25", part.deduction_cents === 793_425);
}

console.log("depreciation: Div 43 capital works 2.5%");
{
  const a: DepAsset = { asset_class: "div43_capital_works", cost_cents: 20_000_000, acquired_date: "2025-07-01", div43_rate: 0.025 };
  const y1 = computeFyDeduction(a, 2025, 20_000_000);
  check("Div43 = $5,000/yr (2.5% of $200k)", y1.deduction_cents === 500_000);
}

console.log("depreciation: low-value pool 18.75% then 37.5%");
{
  const a: DepAsset = { asset_class: "low_value_pool", cost_cents: 80_000, acquired_date: "2025-07-01" };
  const y1 = computeFyDeduction(a, 2025, 80_000);
  check("LVP year 1 = 18.75% = $150", y1.deduction_cents === 15_000);
  const y2 = computeFyDeduction(a, 2026, y1.closing_cents);
  check("LVP year 2 = 37.5% of $650 = $243.75", y2.deduction_cents === 24_375);
}

console.log("depreciation: second-hand residential Div40 lockout");
{
  const a: DepAsset = { asset_class: "div40_plant", cost_cents: 100_000, acquired_date: "2025-07-01", effective_life_years: 5, method: "diminishing_value", is_second_hand: true };
  const y1 = computeFyDeduction(a, 2025, 100_000);
  check("second-hand Div40 deduction blocked (0)", y1.deduction_cents === 0);
  check("second-hand Div40 keeps adjustable value (CGT)", y1.closing_cents === 100_000 && y1.method_applied === "div40_locked");
}

console.log("depreciation: business-use apportionment + carry-forward roll");
{
  const a: DepAsset = { asset_class: "div40_plant", cost_cents: 8_000_000, acquired_date: "2025-07-01", effective_life_years: 5, method: "diminishing_value", business_use_pct: 50 };
  const y1 = computeFyDeduction(a, 2025, 8_000_000);
  check("50% business use halves the deduction ($16,000)", y1.deduction_cents === 1_600_000);
  check("apportionment does NOT change adjustable value", y1.closing_cents === 4_800_000);
  const sched = rollSchedule({ asset_class: "div40_plant", cost_cents: 8_000_000, acquired_date: "2025-07-01", effective_life_years: 5, method: "prime_cost" }, 2027);
  check("roll produces one row per FY (2025,2026,2027)", sched.length === 3 && sched[0].fy === "2025-26" && sched[2].fy === "2027-28");
  check("roll opening chains from prior closing", sched[1].opening_adjustable_value_cents === sched[0].closing_adjustable_value_cents);
}

console.log("depreciation: instant-asset-write-off threshold enforced (review High #2)");
{
  const IAWO = 2_000_000; // $20,000 threshold for the first-use FY
  // Under threshold → full immediate write-off in year 1 (unchanged behaviour).
  const small: DepAsset = { asset_class: "immediate", cost_cents: 30_000, acquired_date: "2025-07-01", instant_asset_write_off_cents: IAWO };
  check("under threshold → full write-off year 1", computeFyDeduction(small, 2025, 30_000).deduction_cents === 30_000);
  check("under threshold → method 'immediate'", computeFyDeduction(small, 2025, 30_000).method_applied === "immediate");
  // Over threshold WITH an effective life → declines as Div40 DV, NOT a full expense.
  const big: DepAsset = { asset_class: "immediate", cost_cents: 5_000_000, acquired_date: "2025-07-01", effective_life_years: 5, instant_asset_write_off_cents: IAWO };
  const y1 = computeFyDeduction(big, 2025, 5_000_000);
  check("over threshold is NOT fully expensed", y1.deduction_cents !== 5_000_000);
  check("over threshold → DV ($5m × 40% = $20,000)", y1.deduction_cents === 2_000_000);
  check("over threshold → method flags the fallback", y1.method_applied === "immediate_over_threshold_dv");
  // Over threshold WITH a prime-cost election → declines by prime cost, not forced to DV.
  const bigPc: DepAsset = { asset_class: "immediate", cost_cents: 5_000_000, acquired_date: "2025-07-01", effective_life_years: 5, method: "prime_cost", instant_asset_write_off_cents: IAWO };
  const pc = computeFyDeduction(bigPc, 2025, 5_000_000);
  check("over threshold + prime cost → PC ($5m × 1/5 = $10,000)", pc.deduction_cents === 1_000_000);
  check("over threshold + prime cost → method flags PC fallback", pc.method_applied === "immediate_over_threshold_pc");
  // Over threshold but no effective life → claim nothing + flag review (don't over-claim).
  const orphan: DepAsset = { asset_class: "immediate", cost_cents: 5_000_000, acquired_date: "2025-07-01", instant_asset_write_off_cents: IAWO };
  const o = computeFyDeduction(orphan, 2025, 5_000_000);
  check("over threshold w/o life → $0 claimed", o.deduction_cents === 0);
  check("over threshold w/o life → review flag", o.method_applied === "immediate_over_threshold_review");
  // No threshold supplied → unchanged (full write-off) so existing assets aren't disturbed.
  const noThresh: DepAsset = { asset_class: "immediate", cost_cents: 5_000_000, acquired_date: "2025-07-01" };
  check("no threshold supplied → full write-off (back-compat)", computeFyDeduction(noThresh, 2025, 5_000_000).deduction_cents === 5_000_000);
}

console.log("depreciation: car cost-limit caps the depreciable base (review High #2)");
{
  const CAR_LIMIT = 6_920_900; // $69,209
  // A $90k car, prime cost, 8yr life: depreciate on the $69,209 cap, not the full $90k.
  const car: DepAsset = { asset_class: "div40_plant", cost_cents: 9_000_000, acquired_date: "2025-07-01", effective_life_years: 8, method: "prime_cost", is_car: true, car_limit_cents: CAR_LIMIT };
  check("car base capped at the limit", depreciableCostCents(car) === CAR_LIMIT);
  // PC year1 = 6,920,900 × 365/365 × (1/8) = 865,112.5 → 865,113.
  check("car PC year1 uses capped base ($8,651.13)", computeFyDeduction(car, 2025, CAR_LIMIT).deduction_cents === 865_113);
  // A cheaper car under the limit → full cost (no cap).
  const cheap: DepAsset = { asset_class: "div40_plant", cost_cents: 4_000_000, acquired_date: "2025-07-01", effective_life_years: 8, method: "prime_cost", is_car: true, car_limit_cents: CAR_LIMIT };
  check("car under the limit uses full cost", depreciableCostCents(cheap) === 4_000_000);
  // Non-car ignores the limit entirely.
  const plant: DepAsset = { asset_class: "div40_plant", cost_cents: 9_000_000, acquired_date: "2025-07-01", effective_life_years: 8, method: "prime_cost", car_limit_cents: CAR_LIMIT };
  check("non-car ignores the car limit", depreciableCostCents(plant) === 9_000_000);
  // rollSchedule seeds the opening value from the capped base.
  check("roll opens at the capped base", rollSchedule(car, 2025)[0].opening_adjustable_value_cents === CAR_LIMIT);
}

console.log("depreciation: balancing adjustment on disposal");
{
  check("termination > adjustable → assessable (+)", balancingAdjustment(4_800_000, 5_000_000) === 200_000);
  check("termination < adjustable → deductible (−)", balancingAdjustment(4_800_000, 3_000_000) === -1_800_000);
}

// ── Claimability matcher: rules-first, defer gating ───────────────────────────
import { matchClaimRules, suggestionText, enumerateSituationClaims, classifyClaim, uncoveredOccupations, ruleKey, type ClaimRule, type ClaimSituation } from "../src/lib/claimability";
import rulePack from "../src/rulepacks/au-v1.json" assert { type: "json" };

console.log("claimability");
{
  const rules = rulePack.claimability as ClaimRule[];
  // A plumbing repair on a rented property → immediate rental repairs.
  const repair = matchClaimRules(rules, { bucket: "property_rented", merchant: "Joe's Plumbing", property_status: "rented" });
  check("rented + plumber → immediate repair", repair.some((r) => r.claim_type === "immediate" && r.ato_label === "rental:repairs"));
  // A dishwasher on a rented property → Div 40 (not immediate).
  const appliance = matchClaimRules(rules, { bucket: "property_rented", merchant: "The Good Guys dishwasher" });
  check("rented + appliance → div40", appliance.some((r) => r.claim_type === "div40"));
  // Vacant property → defer_to_agent rule fires.
  const vacant = matchClaimRules(rules, { property_status: "vacant" });
  check("vacant → defer_to_agent", vacant.some((r) => r.defer_to_agent === 1));
  check("defer rules append the registered-agent disclaimer", suggestionText(vacant.find((r) => r.defer_to_agent === 1)!).includes("registered tax agent"));
  // Novated lease entity → car not deductible + defer.
  const lease = matchClaimRules(rules, { entity_kinds: ["novated_lease"] });
  check("novated lease → not_deductible + defer", lease.some((r) => r.claim_type === "not_deductible" && r.defer_to_agent === 1));
  // Occupation gate: nurse uniform matches; a random merchant for an IT pro does not over-fire.
  const nurse = matchClaimRules(rules, { occupations: ["nurse"], merchant: "Scrubs uniform shop" });
  check("nurse + uniform → immediate D3/D5", nurse.some((r) => r.ato_label === "D3/D5"));
  const noOcc = matchClaimRules(rules, { occupations: [], merchant: "Scrubs uniform shop" });
  check("no occupation → occupation rules do NOT fire", !noOcc.some((r) => r.scope_type === "occupation"));
  // A plain company receipt with no matching hint → no overreach.
  const plain = matchClaimRules(rules, { bucket: "company", merchant: "Random Cafe" });
  check("company cafe → no claimability overreach", plain.length === 0);

  // Tenant renting their home → rent is generally NOT deductible + defer.
  const rentHome = matchClaimRules(rules, { property_status: "renting_residence" });
  check("renting_residence → not_deductible + defer", rentHome.some((r) => r.claim_type === "not_deductible" && r.defer_to_agent === 1));

  // Tenant renting business premises (no entity) → the base business:rent rule fires; the
  // company-gated rule does NOT (requires_entity_kind: company).
  const rentBizNoEntity = matchClaimRules(rules, { property_status: "renting_business" });
  check("renting_business → business:rent fires", rentBizNoEntity.some((r) => r.ato_label === "business:rent"));
  check("renting_business without company → company:rent gate does NOT fire", !rentBizNoEntity.some((r) => r.ato_label === "company:rent"));

  // Same status WITH a company entity → the requires_entity_kind gate now lets company:rent through.
  const rentBizCompany = matchClaimRules(rules, { property_status: "renting_business", entity_kinds: ["company"] });
  check("renting_business + company → company:rent fires", rentBizCompany.some((r) => r.ato_label === "company:rent"));

  // The new gate must not regress existing rules (no requires_entity_kind ⇒ still matches).
  check("entity gate doesn't break ungated rules", matchClaimRules(rules, { property_status: "vacant" }).length >= 1);
}

// ── "Find My Claims" situational helpers: enumerate / classify / uncovered ────
// These answer "what could this person claim given who they are" BEFORE any matching transaction
// is ingested — so they ignore merchant_hint. classifyClaim then buckets each into the 3 groups
// the File page renders: Already capturing / Worth checking / Confirm with your agent.
console.log("claimability situational sweep (enumerateSituationClaims / classifyClaim / uncoveredOccupations)");
{
  const rules = rulePack.claimability as ClaimRule[];

  // enumerateSituationClaims: a nurse with a rented property surfaces BOTH the occupation rule and
  // the property_status rules — across all of the situation's occupations/entities/statuses.
  const nurseRenter: ClaimSituation = { occupations: ["nurse"], entity_kinds: [], property_statuses: ["renting_residence"] };
  const enumerated = enumerateSituationClaims(rules, nurseRenter);
  check("enumerate surfaces the nurse occupation rule", enumerated.some((r) => r.scope_type === "occupation" && r.scope_value === "nurse"));
  check("enumerate surfaces the renting_residence status rule", enumerated.some((r) => r.scope_type === "property_status" && r.scope_value === "renting_residence"));
  // Merchant is ignored: the nurse uniform rule shows up with NO merchant supplied (situational).
  check("enumerate ignores merchant_hint (situational, not transactional)", enumerated.some((r) => r.ato_label === "D3/D5"));
  // Bucket-scoped rules are NOT situational on their own → excluded from the sweep.
  check("enumerate excludes bucket-scoped rules", !enumerated.some((r) => r.scope_type === "bucket"));
  // De-dupe by ruleKey: feeding the same rule twice yields one row.
  const nurseRule = rules.find((r) => r.scope_type === "occupation" && r.scope_value === "nurse")!;
  const deduped = enumerateSituationClaims([nurseRule, { ...nurseRule }], { occupations: ["nurse"], entity_kinds: [], property_statuses: [] });
  check("enumerate de-dupes by ruleKey", deduped.length === 1);

  // Every pack rule must carry a UNIQUE id — ruleKey() de-dupes by it, so two rules sharing a key
  // would silently collapse (the bug where 6 'all' generics + the teacher/tradie/rent pairs all shared
  // 'occupation:all' / 'scope:value' and only the first survived the sweep).
  const keys = rules.map(ruleKey);
  check("every pack rule has a unique ruleKey (no collision drops)", new Set(keys).size === keys.length);

  // 'all' is the cross-occupation wildcard: generics (WFH/donations/tax-agent fees/…) must surface
  // for EVERY tenant, even one whose occupation is unauthored — regression guard for the bug where
  // scope_value 'all' silently never fired because no occupation list contains "all".
  const teacherSweep = enumerateSituationClaims(rules, { occupations: ["teacher"], entity_kinds: [], property_statuses: [] });
  const genericCount = rules.filter((r) => r.scope_value === "all").length;
  check("enumerate surfaces ALL 'all' generics (not just the first) for any occupation",
    teacherSweep.filter((r) => r.scope_value === "all").length === genericCount && genericCount >= 6);
  check("enumerate surfaces 'all' generics even with NO occupation set",
    enumerateSituationClaims(rules, { occupations: [], entity_kinds: [], property_statuses: [] })
      .some((r) => r.scope_value === "all"));
  // Both teacher rules (supplies + renewals) survive — they no longer collapse to one 'occupation:teacher' key.
  check("enumerate surfaces BOTH teacher rules (distinct ids, no collapse)",
    teacherSweep.filter((r) => r.scope_type === "occupation" && r.scope_value === "teacher").length === 2);
  // matchClaimRules (per-transaction path) also honours the 'all' wildcard, gated by merchant_hint.
  check("matchClaimRules fires an 'all' generic on a matching merchant for any occupation",
    matchClaimRules(rules, { bucket: "payg", merchant: "tax agent fees", occupations: ["teacher"] })
      .some((r) => r.scope_value === "all"));
  check("matchClaimRules does NOT fire an 'all' generic when the merchant doesn't match",
    !matchClaimRules(rules, { bucket: "payg", merchant: "woolworths groceries", occupations: ["teacher"] })
      .some((r) => r.scope_value === "all"));

  // requires_entity_kind AND-gate still honoured. Use synthetic rules with distinct ids so the gate
  // is tested in isolation (the bundled business:rent/company:rent pair share a scope pair and so —
  // correctly, per the ruleKey contract — collapse under de-dupe when neither carries a D1 id).
  const ungated: ClaimRule = { id: "g-base", scope_type: "property_status", scope_value: "renting_business", claim_type: "apportioned", general_info_note: "Business rent is generally deductible.", defer_to_agent: 1 };
  const gated: ClaimRule = { id: "g-company", scope_type: "property_status", scope_value: "renting_business", requires_entity_kind: "company", claim_type: "apportioned", general_info_note: "Company rent.", defer_to_agent: 1 };
  const gateRules = [ungated, gated];
  const bizNoCo = enumerateSituationClaims(gateRules, { occupations: [], entity_kinds: [], property_statuses: ["renting_business"] });
  check("enumerate respects requires_entity_kind gate (no company → gated rule excluded)", bizNoCo.some((r) => r.id === "g-base") && !bizNoCo.some((r) => r.id === "g-company"));
  const bizCo = enumerateSituationClaims(gateRules, { occupations: [], entity_kinds: ["company"], property_statuses: ["renting_business"] });
  check("enumerate lets gated rule through with the entity (company → gated rule included)", bizCo.some((r) => r.id === "g-company"));

  // classifyClaim — the 3-way bucketing.
  const noSpend = { bucketsWithSpend: [] as string[], firedRuleIds: [] as string[], dismissedRuleIds: [] as string[] };

  // nurse uniform rule, no uniform spend, never fired → "Worth checking".
  check("nurse with no uniform spend → check", classifyClaim(nurseRule, noSpend) === "check");

  // rental decline-in-value (Div40) rule, no depreciation spend → "Worth checking".
  const rentalDep = rules.find((r) => r.ato_label === "rental:decline-in-value")!;
  check("rental with no depreciation spend → check", classifyClaim(rentalDep, noSpend) === "check");

  // novated lease → defer_to_agent → "Confirm with your agent".
  const novated = rules.find((r) => r.scope_value === "novated_lease")!;
  check("novated_lease → defer", classifyClaim(novated, noSpend) === "defer");

  // A bucket-scoped rule whose bucket HAS spend → "Already capturing".
  const rentalRepairs = rules.find((r) => r.ato_label === "rental:repairs")!; // scope_value: property_rented
  check("covered-with-spend → capturing", classifyClaim(rentalRepairs, { ...noSpend, bucketsWithSpend: ["property_rented"] }) === "capturing");
  // Same rule, no spend in its bucket → falls back to "check".
  check("same bucket rule with no spend → check", classifyClaim(rentalRepairs, noSpend) === "check");

  // A rule whose suggestion already FIRED (by ruleKey) → "Already capturing", even with no bucket spend.
  check("rule that already fired a suggestion → capturing", classifyClaim(nurseRule, { ...noSpend, firedRuleIds: [ruleKey(nurseRule)] }) === "capturing");

  // Dismissed filtering is the CALLER's job: classifyClaim does NOT treat a dismissed id specially.
  // A dismissed-but-fired rule still reads 'capturing' (it's covered); the caller must drop dismissed
  // rows BEFORE classifying so they never resurface as 'check'. Assert that contract explicitly.
  check("a dismissed rule is excluded by the caller (classify ignores dismissedRuleIds)",
    classifyClaim(nurseRule, { ...noSpend, firedRuleIds: [ruleKey(nurseRule)], dismissedRuleIds: [ruleKey(nurseRule)] }) === "capturing");

  // Set inputs work as well as arrays (the DO passes Sets).
  check("classifyClaim accepts Set inputs", classifyClaim(rentalRepairs, { bucketsWithSpend: new Set(["property_rented"]), firedRuleIds: new Set<string>(), dismissedRuleIds: new Set<string>() }) === "capturing");

  // uncoveredOccupations: nurse is authored; a bogus occupation never in the pack is uncovered → it
  // alone is returned (this is the trigger for the AI occupation gap-fill step).
  check("uncoveredOccupations flags the unauthored occupation", JSON.stringify(uncoveredOccupations(rules, ["nurse", "definitely_not_authored"])) === '["definitely_not_authored"]');
  check("uncoveredOccupations returns none when all are authored", uncoveredOccupations(rules, ["nurse", "it_professional"]).length === 0);
  // Foreign/non-AU residency is handled by the CALLER (surface as defer, never assert AU deductions) —
  // these pure helpers stay AU-rule-pack agnostic; nothing here asserts a deduction or a $ figure.
}

// ── CGT: cost-base, Div43 reduction, 50% discount, main-residence, losses ─────
import { computeCapitalGain } from "../src/lib/cgt";

console.log("cgt");
{
  // $500k cost base, $700k proceeds, held >12mo, resident → $200k gain, 50% discount = $100k net.
  const g = computeCapitalGain({ cost_base_cents: 50_000_000, proceeds_cents: 70_000_000, acquired_date: "2015-01-01", disposal_date: "2025-01-01", is_resident_individual: true });
  check("gross gain = $200,000", g.gross_gain_cents === 20_000_000);
  check("50% discount applied (resident, >12mo)", g.discount_applied && g.discount_cents === 10_000_000);
  check("net gain = $100,000", g.net_gain_cents === 10_000_000);

  // Div 43 claimed reduces the cost base → larger gain (per the ATO note).
  const d = computeCapitalGain({ cost_base_cents: 50_000_000, proceeds_cents: 70_000_000, div43_claimed_cents: 4_000_000, acquired_date: "2015-01-01", disposal_date: "2025-01-01", is_resident_individual: true });
  check("Div43 $40k reduces cost base → gain up by $40k", d.gross_gain_cents === 24_000_000);

  // Held < 12 months → no discount.
  const short = computeCapitalGain({ cost_base_cents: 50_000_000, proceeds_cents: 60_000_000, acquired_date: "2024-07-01", disposal_date: "2025-01-01", is_resident_individual: true });
  check("held <12mo → no discount", !short.discount_applied && short.net_gain_cents === 10_000_000);

  // Main residence → fully exempt.
  const home = computeCapitalGain({ cost_base_cents: 50_000_000, proceeds_cents: 90_000_000, acquired_date: "2010-01-01", disposal_date: "2025-01-01", is_resident_individual: true, main_residence_exempt: true });
  check("main residence → net gain 0", home.net_gain_cents === 0);

  // Capital loss → surfaced, never discounted.
  const loss = computeCapitalGain({ cost_base_cents: 50_000_000, proceeds_cents: 45_000_000, acquired_date: "2015-01-01", disposal_date: "2025-01-01", is_resident_individual: true });
  check("loss surfaced (−$50k), not discounted", loss.is_capital_loss && loss.net_gain_cents === -5_000_000);

  // Foreign resident → no 50% discount.
  const foreign = computeCapitalGain({ cost_base_cents: 50_000_000, proceeds_cents: 70_000_000, acquired_date: "2015-01-01", disposal_date: "2025-01-01", is_resident_individual: false });
  check("foreign resident → no discount", !foreign.discount_applied && foreign.net_gain_cents === 20_000_000);
}

// ── FILING READINESS: deterministic engine + the no-tax-advice invariant ──────
import { assessReadiness, type FilingReadinessSignals } from "../src/lib/readiness";
import type { Report } from "../src/lib/report";
import type { Situation } from "../src/lib/db";

console.log("readiness");
{
  const mkReport = (p: Partial<Report> = {}): Report => ({
    fy: "2025-26", start: "2025-07-01", end: "2026-06-30",
    by_bucket: [], deduction_breakdown: [], by_property: [], company_quarters: [],
    undated: { n: 0, total_cents: 0 }, undated_detail: [], abn: null, gst_credits_cents: 0,
    income: { by_type: [], gross_cents: 0, withholding_cents: 0, franking_credit_cents: 0, foreign_tax_paid_cents: 0 },
    depreciation_cents: 0, per_property: [], total_income_cents: 0, total_deductions_cents: 0, company_tracked_cents: 0, taxable_position_cents: 0,
    ...p,
  });
  const mkSituation = (p: Partial<Situation> = {}): Situation => ({
    profile: {} as Situation["profile"], persons: [], properties: [], entities: [], rules: [], ...p,
  });
  const noSignals = (p: Partial<FilingReadinessSignals> = {}): FilingReadinessSignals => ({
    unknownBucketCents: 0, unknownBucketN: 0, lowConfidenceN: 0, needsReviewIncomeN: 0, needsReviewAssetsN: 0,
    hasDividendStatementDoc: true, rentalPropsMissingSummary: [], disposedAssetsN: 0,
    instantAssetWriteOffCentsThisFy: null, instantAssetWriteOffCentsPrevFy: null, ...p,
  });
  const run = (r: Report, sig: FilingReadinessSignals, claimMatches: ClaimRule[] = [], sit = mkSituation()) =>
    assessReadiness({ report: r, situation: sit, claimMatches, signals: sig, generatedAt: "2026-06-03T00:00:00Z" });

  // Clean PAYG-only return → ready, zero findings, position mirrors the report exactly.
  const clean = run(mkReport({ income: { by_type: [{ income_type: "salary_payg", n: 1, gross_cents: 9_000_000, net_cents: 7_000_000, withholding_cents: 2_000_000, franking_credit_cents: 0, foreign_tax_paid_cents: 0 }], gross_cents: 9_000_000, withholding_cents: 2_000_000, franking_credit_cents: 0, foreign_tax_paid_cents: 0 }, total_income_cents: 9_000_000, taxable_position_cents: 9_000_000 }), noSignals());
  check("clean PAYG → ready, no findings", clean.readiness_score.ready && clean.findings.length === 0);
  check("position mirrors report taxable position", clean.position.indicative_taxable_position_cents === 9_000_000);

  // Unknown-bucket spend → BLOCKER finding + NOT ready (review Medium: the gate used to be vacuous).
  const unknown = run(mkReport({ by_bucket: [{ bucket: "unknown", ato_label: null, n: 3, total_cents: 50_000, gst_cents: 0 }] }), noSignals({ unknownBucketN: 3, unknownBucketCents: 50_000 }));
  check("unknown bucket → blocker finding", unknown.findings.some((f) => f.id === "unknown_bucket" && f.severity === "blocker"));
  check("unknown bucket → NOT ready", !unknown.readiness_score.ready && unknown.readiness_score.blockers === 1);

  // Undated receipts that hit the report → BLOCKER + NOT ready.
  const undated = run(mkReport({ undated: { n: 2, total_cents: 12_345 } }), noSignals());
  check("undated receipts → blocker finding", undated.findings.some((f) => f.id === "undated_receipts" && f.severity === "blocker"));
  check("undated receipts → NOT ready", !undated.readiness_score.ready);
  // A review/info-only finding still leaves the user ready (only blockers gate readiness).
  const infoOnly = run(mkReport(), noSignals({ disposedAssetsN: 1 }));
  check("review/info findings alone still → ready", infoOnly.readiness_score.ready && infoOnly.readiness_score.blockers === 0);

  // Franking credits but no dividend statement on file → review finding.
  const franking = run(mkReport({ income: { by_type: [], gross_cents: 0, withholding_cents: 0, franking_credit_cents: 30_000, foreign_tax_paid_cents: 0 } }), noSignals({ hasDividendStatementDoc: false }));
  check("franking + no doc → finding", franking.findings.some((f) => f.id === "franking_no_doc"));

  // Rental income but no agent summary doc → review finding (+ no-depreciation info finding).
  const rental = run(mkReport({ per_property: [{ property_id: "p1", label: "Unit 1", income_cents: 2_000_000, deduction_cents: 100_000, depreciation_cents: 0, net_cents: 1_900_000 }] }), noSignals({ rentalPropsMissingSummary: [{ property_id: "p1", label: "Unit 1" }] }));
  check("rental income + no agent summary → finding", rental.findings.some((f) => f.id === "rental_no_summary:p1"));
  check("rental income + no depreciation → info finding", rental.findings.some((f) => f.id === "no_depreciation:p1" && f.severity === "info"));

  // IAWO threshold change → info + defer.
  const iawo = run(mkReport(), noSignals({ instantAssetWriteOffCentsThisFy: 10_000_000, instantAssetWriteOffCentsPrevFy: 200_000_000 }));
  check("IAWO threshold change → defer finding", iawo.findings.some((f) => f.id === "iawo_threshold_changed" && f.defer_to_agent));
  // Same threshold → no finding.
  check("IAWO unchanged → no finding", !run(mkReport(), noSignals({ instantAssetWriteOffCentsThisFy: 200_000_000, instantAssetWriteOffCentsPrevFy: 200_000_000 })).findings.some((f) => f.id === "iawo_threshold_changed"));

  // Disposed asset → review + defer.
  const disposed = run(mkReport(), noSignals({ disposedAssetsN: 1 }));
  check("disposed asset → defer review finding", disposed.findings.some((f) => f.id === "disposed_assets" && f.defer_to_agent && f.severity === "review"));

  // Defer-to-agent claim rule passthrough → judgement finding using the rule's note verbatim.
  const deferRule: ClaimRule = { scope_type: "property_status", scope_value: "vacant", claim_type: "apportioned", general_info_note: "Holding costs are only deductible while genuinely available for rent.", defer_to_agent: 1 };
  const judged = run(mkReport(), noSignals(), [deferRule]);
  check("defer claim rule → judgement finding", judged.findings.some((f) => f.category === "judgement" && f.general_info_note.includes("registered tax agent")));
  // Non-defer rule → NOT surfaced as a judgement finding (avoid noise).
  check("non-defer rule → no judgement finding", run(mkReport(), noSignals(), [{ ...deferRule, defer_to_agent: 0 }]).findings.length === 0);

  // THE INVARIANT: no generated finding/position text asserts tax payable, a refund, or a rate.
  // (The fixed position caption intentionally NEGATES those words and is excluded — it's a vetted constant.)
  const denylist = /refund|tax payable|marginal rate|\b\d{1,2}%\s*(tax|bracket)/i;
  const everything = [unknown, franking, rental, iawo, disposed, judged, clean];
  const generatedText = everything.flatMap((r) => [
    ...r.findings.flatMap((f) => [f.title, f.general_info_note]),
    ...r.position.lines.flatMap((l) => [l.basis, l.why]),
  ]);
  check("no generated text predicts tax payable / refund / rate", !generatedText.some((t) => denylist.test(t)));
}

// ── DEDUCTIBILITY: deny-by-default matcher + the headline/display reconciliation ──
import { verdictForTxn } from "../src/lib/deductibility";
import { deductionGroupForRow } from "../src/lib/report";

console.log("deductibility (deny-by-default)");
{
  const section = (rulePack as { payg_deductibility?: Parameters<typeof verdictForTxn>[3] }).payg_deductibility;
  // verdictForTxn: only payg is classified; precedence deny → apportion → allow → undetermined.
  check("groceries → likely_not", verdictForTxn("payg", "payg:groceries", "Coles", section).deductibility === "likely_not");
  check("personal-spend → likely_not", verdictForTxn("payg", "payg:personal-spend", null, section).deductibility === "likely_not");
  check("loan repayment → likely_not", verdictForTxn("payg", "payg:loan-repayment", null, section).deductibility === "likely_not");
  check("meals-entertainment → likely_not", verdictForTxn("payg", "payg:meals-entertainment", null, section).deductibility === "likely_not");
  check("wfh electricity → needs_apportionment", verdictForTxn("payg", "payg:utilities", "Origin Energy electricity", section).deductibility === "needs_apportionment");
  // Matcher NEVER auto-asserts a positive deduction: clearly-deductible payg (union/tax-affairs) stays
  // undetermined → excluded by deny-by-default → surfaced for the user to confirm (resolved stays ~$0).
  check("union fees → undetermined (not auto-claimed)", verdictForTxn("payg", "payg:union-fees", "ASU membership", section).deductibility === "undetermined");
  check("unclassified payg → undetermined (deny-by-default excludes it)", verdictForTxn("payg", "payg:other", "Mystery Shop", section).deductibility === "undetermined");
  check("non-payg bucket → undetermined (handled by bucket)", verdictForTxn("company", "company:software", "Anthropic", section).deductibility === "undetermined");
  check("asset → undetermined (handled by bucket)", verdictForTxn("asset", "asset:furniture", "Officeworks", section).deductibility === "undetermined");

  // deductionGroupForRow: flag OFF = legacy (payg/property count; asset/unknown excluded; company apart).
  check("OFF: payg undetermined counts", deductionGroupForRow("payg", "undetermined", false) === "deduction");
  check("OFF: asset excluded", deductionGroupForRow("asset", "undetermined", false) === "excluded");
  check("OFF: company apart", deductionGroupForRow("company", "undetermined", false) === "company");
  // flag ON = deny-by-default.
  check("ON: payg undetermined excluded", deductionGroupForRow("payg", "undetermined", true) === "excluded");
  check("ON: payg likely_deductible counts", deductionGroupForRow("payg", "likely_deductible", true) === "deduction");
  check("ON: payg likely_not excluded", deductionGroupForRow("payg", "likely_not", true) === "excluded");
  check("ON: needs_apportionment excluded", deductionGroupForRow("payg", "needs_apportionment", true) === "excluded");
  check("ON: property_rented undetermined still counts (capture-now preserved)", deductionGroupForRow("property_rented", "undetermined", true) === "deduction");
  check("ON: property_rented confirmed_not excluded", deductionGroupForRow("property_rented", "confirmed_not", true) === "excluded");

  // RECONCILIATION: the readiness "Deductions" lines sum to the same gross the headline math uses,
  // and private/capital/company spend lands in the excluded/company sections — not under Deductions.
  const breakdown = [
    { bucket: "payg", ato_label: "payg:union-fees", deductibility: "likely_deductible", n: 1, total_cents: 50_000, gst_cents: 0 },
    { bucket: "payg", ato_label: "payg:groceries", deductibility: "likely_not", n: 3, total_cents: 323_035, gst_cents: 0 },
    { bucket: "payg", ato_label: "payg:other", deductibility: "undetermined", n: 2, total_cents: 120_000, gst_cents: 0 },
    { bucket: "property_rented", ato_label: "rental:mgmt", deductibility: "undetermined", n: 1, total_cents: 200_000, gst_cents: 0 },
    { bucket: "company", ato_label: "company:software", deductibility: "undetermined", n: 1, total_cents: 300_000, gst_cents: 0 },
    { bucket: "asset", ato_label: "asset:furniture", deductibility: "likely_not", n: 1, total_cents: 30_000, gst_cents: 0 },
    { bucket: "unknown", ato_label: null, deductibility: "undetermined", n: 1, total_cents: 9_999, gst_cents: 0 },
  ];
  // Local builders (the readiness block's helpers are block-scoped). Cast is runtime-safe: assessReadiness
  // only reads the fields set here (tsx strips types; this script isn't part of `npm run typecheck`).
  const mkR = (bd: typeof breakdown): Report => ({
    fy: "2025-26", income: { by_type: [], gross_cents: 0, withholding_cents: 0, franking_credit_cents: 0, foreign_tax_paid_cents: 0 },
    deduction_breakdown: bd, per_property: [], depreciation_cents: 0, undated: { n: 0, total_cents: 0 }, gst_credits_cents: 0, abn: null, taxable_position_cents: 0,
  } as unknown as Report);
  const mkS = (): Situation => ({ profile: {}, persons: [], properties: [], entities: [], rules: [] } as unknown as Situation);
  const mkSig = (): FilingReadinessSignals => ({
    unknownBucketCents: 0, unknownBucketN: 0, lowConfidenceN: 0, needsReviewIncomeN: 0, needsReviewAssetsN: 0,
    hasDividendStatementDoc: true, rentalPropsMissingSummary: [], disposedAssetsN: 0, instantAssetWriteOffCentsThisFy: null, instantAssetWriteOffCentsPrevFy: null,
  });
  const headlineGross = breakdown.filter((b) => deductionGroupForRow(b.bucket, b.deductibility, true) === "deduction").reduce((s, b) => s + b.total_cents, 0);
  const ready = assessReadiness({ report: mkR(breakdown), situation: mkS(), claimMatches: [], signals: mkSig(), generatedAt: "2026-06-03T00:00:00Z", excludeNonDeductible: true });
  const deductionLineSum = ready.position.lines.filter((l) => l.group === "deduction").reduce((s, l) => s + l.amount_cents, 0);
  check("ON: deduction lines == headline gross (union + rental only)", deductionLineSum === headlineGross && deductionLineSum === 250_000);
  check("ON: groceries + asset land in 'excluded'", ready.position.lines.some((l) => l.group === "excluded" && l.label.includes("groceries")) && ready.position.lines.some((l) => l.group === "excluded" && l.label.includes("asset")));
  check("ON: company spend in its own 'company' group", ready.position.lines.some((l) => l.group === "company" && l.label.includes("company")));
  check("ON: unresolved payg → review finding", ready.findings.some((fd) => fd.id === "payg_unresolved" && fd.severity === "review"));
  check("ON: unknown never rendered as a deduction line", !ready.position.lines.some((l) => l.label.includes("unknown")));
  check("ON: excluded/company copy doesn't trip the tax-advice denylist", !ready.position.lines.flatMap((l) => [l.why, l.basis]).concat(ready.findings.flatMap((fd) => [fd.title, fd.general_info_note])).some((t) => /refund|tax payable|marginal rate|\b\d{1,2}%\s*(tax|bracket)/i.test(t)));

  // Flag OFF: byte-identical basis — payg + property all count; no deny-by-default finding.
  const legacy = assessReadiness({ report: mkR(breakdown), situation: mkS(), claimMatches: [], signals: mkSig(), generatedAt: "2026-06-03T00:00:00Z" });
  const legacyDeduction = legacy.position.lines.filter((l) => l.group === "deduction").reduce((s, l) => s + l.amount_cents, 0);
  check("OFF: payg + property all count (legacy basis)", legacyDeduction === 50_000 + 323_035 + 120_000 + 200_000);
  check("OFF: no payg_unresolved finding", !legacy.findings.some((fd) => fd.id === "payg_unresolved"));
}

// ── Taxonomy ↔ rule pack ↔ UI agree (no silent bucket drift) ─────────────────
console.log("applyUserRules (direction-aware)");
{
  const mk = (pattern: string, bucket: string, match_type = "merchant_contains"): UserRule => ({
    id: pattern, user_id: "me", match_type, pattern, bucket, ato_label: `${bucket}:x`, property_id: null, priority: 100,
  });
  const rules = [mk("bunnings", "company"), mk("stripe", "income_business")];
  check("expense rule fires on a debit", applyUserRules("Bunnings Richmond", rules, "debit")?.bucket === "company");
  check("expense rule does NOT fire on a credit (refund stays for the LLM)", applyUserRules("Bunnings Richmond", rules, "credit") === null);
  check("income rule fires on a credit", applyUserRules("Stripe payout", rules, "credit")?.bucket === "income_business");
  check("income rule does NOT fire on a debit (no mis-bucketed expense)", applyUserRules("Stripe fee", rules, "debit") === null);
  check("direction-less call stays unconstrained (back-compat)", applyUserRules("Bunnings", rules)?.bucket === "company");
  check("merchant_exact respects exact match", applyUserRules("bunnings", [mk("bunnings", "company", "merchant_exact")], "debit")?.bucket === "company");
  check("merchant_exact no partial match", applyUserRules("bunnings warehouse", [mk("bunnings", "company", "merchant_exact")], "debit") === null);
}

console.log("buildGuidePrompt (Guide me)");
{
  const progress = {
    imported: { statements: 2, transactions: 338 }, categorised: 300, needs_review: 12, undated: 0,
    unreconciled_receipts: 0, has_qbo: false, done: false, next_action: { kind: "review", count: 12, label: "x", href: "/" },
  } as unknown as Progress;
  const { system, user } = buildGuidePrompt("inbox", progress, "Taxpayer: nurse");
  check("system names the tab's purpose", system.includes("review queue"));
  check("system carries the GENERAL-INFO guardrail", system.toLowerCase().includes("never tax advice"));
  check("user embeds the live numbers", user.includes('"needs_review":12') && user.includes("338"));
  check("user embeds the situation summary", user.includes("Taxpayer: nurse"));
  check("unknown tab degrades gracefully", buildGuidePrompt("bogus", progress, "").system.includes('"bogus"'));
}

console.log("roles");
{
  const p = (roles: string) => ({ roles }) as { roles: string };
  check("no roles → default individual", JSON.stringify(parseRoles(null)) === '["individual"]');
  check("hasRole reads the array", hasRole(p('["admin","individual"]'), "admin"));
  check("isAdmin true for admin", isAdmin(p('["admin"]')));
  check("isAdmin false for individual-only", !isAdmin(p('["individual"]')));
  check("malformed JSON → individual", JSON.stringify(parseRoles(p("not json"))) === '["individual"]');
  check("normaliseRoles drops unknowns", JSON.stringify(normaliseRoles(["admin", "bogus", "accountant"])) === '["admin","accountant"]');
  check("normaliseRoles empty → individual", JSON.stringify(normaliseRoles([])) === '["individual"]');
  // web mirror (web/src/types.ts ROLES) must match the server taxonomy.
  const webRolesSrc = fs.readFileSync(path.join(process.cwd(), "web", "src", "types.ts"), "utf8");
  const rStart = webRolesSrc.indexOf("export const ROLES");
  const rBlock = webRolesSrc.slice(rStart, webRolesSrc.indexOf("]", rStart));
  const webRoles = [...rBlock.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
  check("web ROLES match the server taxonomy", JSON.stringify(webRoles) === JSON.stringify([...ROLES]));
}

console.log("bucket taxonomy");
{
  const root = process.cwd();
  const rulePack = JSON.parse(fs.readFileSync(path.join(root, "src", "rulepacks", "au-v1.json"), "utf8")) as { buckets: Record<string, string> };
  const uiSource = fs.readFileSync(path.join(root, "web", "src", "components", "ui.tsx"), "utf8");
  const taxonomy = [...BUCKETS].sort();
  const rulepackKeys = Object.keys(rulePack.buckets).sort();
  // Read BUCKET_LABEL keys textually (avoids importing TSX into the node test).
  const start = uiSource.indexOf("BUCKET_LABEL");
  const labelBlock = uiSource.slice(start, uiSource.indexOf("};", start));
  const uiKeys = [...labelBlock.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]!);
  check("rule-pack buckets match the taxonomy", JSON.stringify(taxonomy) === JSON.stringify(rulepackKeys));
  check("UI BUCKET_LABEL covers every taxonomy bucket", taxonomy.every((b) => uiKeys.includes(b)));
  check("income + refund buckets present", ["income_business", "income_property", "income_personal", "refund"].every((b) => taxonomy.includes(b)));
  // web types.ts BUCKETS drives the rule editor + the transaction-correction dropdown — it must
  // offer exactly the taxonomy (it was silently stale at 5, hiding income_*/refund/asset).
  const typesSource = fs.readFileSync(path.join(root, "web", "src", "types.ts"), "utf8");
  const tStart = typesSource.indexOf("export const BUCKETS");
  const tBlock = typesSource.slice(tStart, typesSource.indexOf("]", tStart));
  const webBuckets = [...tBlock.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!).sort();
  check("web types BUCKETS match the taxonomy", JSON.stringify(webBuckets) === JSON.stringify(taxonomy));
}

// ── Billing: marked-up "billable" figure is pure + sane (the per-user cost-billing seam) ─────
console.log("costCents (AI spend pricing)");
{
  const H = "claude-haiku-4-5-20251001";
  check("input priced at $1/M (1M → 100c)", Math.round(costCents(H, { input_tokens: 1_000_000 })) === 100);
  check("output priced at $5/M (1M → 500c)", Math.round(costCents(H, { output_tokens: 1_000_000 })) === 500);
  check("cache-read 10× cheaper than input", costCents(H, { cache_read_input_tokens: 1_000_000 }) === 10);
  check("unknown model falls back to Haiku rate", costCents("unknown-model", { input_tokens: 1_000_000 }) === 100);
  check("empty usage → 0c", costCents(H, {}) === 0);

  // C5: a real ~40-line chunk is sub-cent. Quantising to 4dp must PRESERVE the fraction — rounding
  // to whole cents would floor it to 0 and the daily budget counter would never move (silent free
  // inference past the cap). 1500 in + 200 out = (1500×1 + 200×5)/1e6×100 = 0.25c.
  const chunk = costCents(H, { input_tokens: 1500, output_tokens: 200 });
  check("sub-cent call keeps its value (0.25c, not floored to 0)", chunk === 0.25);
  check("a tiny call is non-zero (300 in → 0.03c)", costCents(H, { input_tokens: 300 }) === 0.03);
  // Deterministic accumulation: summing N identical sub-cent calls is exact (no float drift blowup),
  // so the running KV total the gate reads stays trustworthy.
  let total = 0;
  for (let i = 0; i < 1000; i++) total = Math.round((total + chunk) * 10_000) / 10_000;
  check("1000 × 0.25c sums to exactly 250c (no drift)", total === 250);
  // Quantisation is bounded to 4 decimal places (1e-4 cents) — never a long float tail.
  check("cost is quantised to ≤4 decimal places", Number.isInteger(costCents(H, { input_tokens: 333, output_tokens: 77 }) * 10_000));
}

console.log("billableCents");
{
  check("zero usage → zero billable (no flat fee on nothing)", billableCents(0, 30, 50) === 0);
  check("markup only: 100c +30% → 130c", billableCents(100, 30, 0) === 130);
  check("markup + flat fee: 100c +30% +50c → 180c", billableCents(100, 30, 50) === 180);
  check("zero policy is a pass-through (100c → 100c)", billableCents(100, 0, 0) === 100);
  check("rounds to whole cents (33c +30% = 42.9 → 43)", billableCents(33, 30, 0) === 43);
  check("never bills less than measured cost (markup ≥ 0)", billableCents(250, 0, 0) >= 250);
  check("negative/garbage inputs floor at 0", billableCents(-100, -5, -5) === 0);
}

// ── Progress / next-action engine: the "what do I do now" precedence (pure, offline) ─────────
import { nextAction, isDone, buildProgress, type ProgressCounts } from "../src/lib/progress";

console.log("progress next-action engine");
{
  const base: ProgressCounts = {
    imported_statements: 0, imported_transactions: 0, categorised: 0,
    needs_review: 0, undated: 0, unreconciled_receipts: 0, has_qbo: false,
  };
  // Precedence branch 1: nothing imported → import (→ /accounts).
  check("nothing imported → import (/accounts)", nextAction(base).kind === "import" && nextAction(base).href === "/accounts");
  check("empty tenant is NOT 'done' (no data)", isDone(base) === false);

  const imported: ProgressCounts = { ...base, imported_statements: 3, imported_transactions: 412, categorised: 412 };

  // The spec's worked example: imported, no receipts, 6 low-confidence + 2 undated.
  const work: ProgressCounts = { ...imported, needs_review: 6, undated: 2 };
  check("needs_review>0 → review (/), count 6", nextAction(work).kind === "review" && nextAction(work).count === 6 && nextAction(work).href === "/");
  check("outstanding exceptions → not done", isDone(work) === false);
  const wp = buildProgress(work);
  check("progress surfaces 6 review / 2 undated, done=false", wp.needs_review === 6 && wp.undated === 2 && wp.done === false);

  // Precedence branch 2: review cleared, undated remains → date (→ /reports).
  const dated: ProgressCounts = { ...imported, needs_review: 0, undated: 2 };
  check("review cleared, undated>0 → date (/reports), count 2", nextAction(dated).kind === "date" && nextAction(dated).count === 2 && nextAction(dated).href === "/reports");

  // Precedence branch 3: needs_review takes priority over undated.
  check("needs_review precedes undated", nextAction({ ...imported, needs_review: 1, undated: 5 }).kind === "review");

  // Precedence branch 4: everything cleared → export (→ /filing, the lodge-ready finish line).
  const cleared: ProgressCounts = { ...imported, needs_review: 0, undated: 0 };
  check("all cleared → export (/filing)", nextAction(cleared).kind === "export" && nextAction(cleared).href === "/filing");
  check("all cleared with data → done", isDone(cleared) === true && buildProgress(cleared).done === true);
}

// ── QBO token envelope encryption: seal/open round-trip + dual-read (offline, real WebCrypto) ─
import { sealToken, openToken, readToken, tokenEncryptionEnabled } from "../src/lib/token-crypto";
import type { Env } from "../src/env";

console.log("token-crypto (QBO envelope encryption)");
{
  const env = { QBO_TOKEN_KEY: "unit-test-secret-key" } as Env;
  const plain = "AB11657891234567.refresh.tok-abc123_def456";

  const sealed = await sealToken(env, plain);
  check("sealed value does not contain the plaintext", sealed !== plain && !sealed.includes(plain));
  check("seal → open round-trips to the original token", (await openToken(env, sealed)) === plain);

  const sealed2 = await sealToken(env, plain);
  check("random IV → two seals of the same token differ", sealed !== sealed2);
  check("…but both decrypt to the same plaintext", (await openToken(env, sealed2)) === plain);

  // Dual-read: enc_ver 0 (or null) = legacy plaintext passthrough; 1 = decrypt; null value = null.
  check("readToken enc_ver=0 returns the stored plaintext as-is", (await readToken(env, plain, 0)) === plain);
  check("readToken enc_ver=null treated as legacy plaintext", (await readToken(env, plain, null)) === plain);
  check("readToken enc_ver=1 decrypts a sealed value", (await readToken(env, sealed, 1)) === plain);
  check("readToken null value → null (cleared access token)", (await readToken(env, null, 1)) === null);

  // Graceful activation: no key → encryption disabled (writes stay plaintext).
  check("tokenEncryptionEnabled false without QBO_TOKEN_KEY", tokenEncryptionEnabled({} as Env) === false);
  check("tokenEncryptionEnabled true with QBO_TOKEN_KEY", tokenEncryptionEnabled(env) === true);

  // A different key must NOT decrypt (GCM auth tag) — the secret is load-bearing.
  let threw = false;
  try {
    await openToken({ QBO_TOKEN_KEY: "a-different-secret" } as Env, sealed);
  } catch {
    threw = true;
  }
  check("a wrong key cannot decrypt (GCM authentication tag)", threw);

  // Reading an encrypted row with the key UNSET fails with a clear message, not an opaque crypto throw.
  let clearMsg = "";
  try {
    await readToken({} as Env, sealed, 1);
  } catch (e) {
    clearMsg = (e as Error).message;
  }
  check("enc_ver=1 with no key → actionable error", clearMsg.includes("QBO_TOKEN_KEY"));
}

// ── Retention purge list completeness: every tenant table is erased (except audit_log) ──────
import { PURGE_TABLES, redactSecrets } from "../src/lib/retention";

console.log("retention PURGE_TABLES completeness");
{
  const schema = fs.readFileSync(path.join(process.cwd(), "schema.sql"), "utf8");
  const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g;
  let m: RegExpExecArray | null;
  const tenantTables: string[] = [];
  while ((m = re.exec(schema))) {
    if (/\buser_id\b/.test(m[2]!)) tenantTables.push(m[1]!);
  }
  // Every user_id table must be purged EXCEPT audit_log (the deliberate deletion breadcrumb).
  const shouldPurge = tenantTables.filter((t) => t !== "audit_log").sort();
  const purges = [...PURGE_TABLES].sort();
  check("PURGE_TABLES covers every tenant table except audit_log", JSON.stringify(purges) === JSON.stringify(shouldPurge));
  check("PURGE_TABLES never includes audit_log (breadcrumb is kept)", !purges.includes("audit_log"));
  check("PURGE_TABLES has no table missing from schema", purges.every((t) => tenantTables.includes(t)));
  // daily_cost is keyed by `scope` (not a user_id column) so it's outside the list above — assert
  // purgeTenant still erases the tenant's per-day spend rows by scope (regression guard).
  const retentionSrc = fs.readFileSync(path.join(process.cwd(), "src", "lib", "retention.ts"), "utf8");
  check("purgeTenant erases daily_cost by scope", /DELETE FROM daily_cost WHERE scope = \?/.test(retentionSrc));
  // purgeTenant erases external stores BEFORE the D1 wipe (so a store failure can't leave orphaned
  // bytes audited as "complete"). Guard the ordering: the R2 list+delete must appear before the D1 batch.
  check("purge deletes R2 before the D1 wipe", retentionSrc.indexOf("RECEIPTS.delete") < retentionSrc.indexOf("env.DB.batch("));
  check("purge reseats the empty profile atomically (OR IGNORE, in-batch)", /INSERT OR IGNORE INTO profiles/.test(retentionSrc));

  // APP-12 export strips secret columns but keeps the rest of the row (review Medium).
  const tk = redactSecrets("tenant_keys", [{ key_id: "k1", secret: "shhh", label: "web" }]);
  check("export strips tenant_keys.secret", tk[0]!.secret === undefined && tk[0]!.key_id === "k1" && tk[0]!.label === "web");
  const qbo = redactSecrets("qbo_connections", [{ realm_id: "r1", access_token: "a", refresh_token: "b", enc_ver: 1 }]);
  check("export strips QBO access+refresh tokens", qbo[0]!.access_token === undefined && qbo[0]!.refresh_token === undefined && qbo[0]!.realm_id === "r1");
  const plain = redactSecrets("transactions", [{ id: "t1", merchant: "X" }]);
  check("export leaves non-secret tables untouched", plain[0]!.merchant === "X");
  // The export now drives off PURGE_TABLES (dual of purge), so it can't omit a purged table.
  check("export covers every purged table", /PURGE_TABLES\.map\(async \(t\)/.test(retentionSrc));
}

// ── Bedrock SigV4 signer: structure + determinism (offline, real WebCrypto) ──────────────────
import { signBedrockInvoke, sha256Hex } from "../src/lib/sigv4";

console.log("sigv4 (Bedrock InvokeModel signer)");
{
  // Known SHA-256 of the empty string validates the WebCrypto primitive.
  check("sha256Hex('') matches the known vector", (await sha256Hex("")) === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

  const fixed = new Date("2026-06-05T01:02:03.456Z");
  const opts = {
    region: "ap-southeast-2",
    accessKeyId: "AKIATESTKEY",
    secretAccessKey: "secretKey/with+special",
    modelId: "apac.anthropic.claude-haiku-4-5-20251001-v1:0",
    body: JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 10, messages: [] }),
    now: fixed,
  };
  const s = await signBedrockInvoke(opts);

  // AWS convention: LITERAL path on the wire, %3A only in the signed canonical path.
  check("wire URL keeps the literal model id (colon NOT encoded)", s.url === "https://bedrock-runtime.ap-southeast-2.amazonaws.com/model/apac.anthropic.claude-haiku-4-5-20251001-v1:0/invoke");
  check("x-amz-date is YYYYMMDDTHHMMSSZ", s.headers["x-amz-date"] === "20260605T010203Z");
  check("Authorization has the right scope", s.headers.authorization.includes("Credential=AKIATESTKEY/20260605/ap-southeast-2/bedrock/aws4_request"));
  check("SignedHeaders are the four we sign", s.headers.authorization.includes("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date"));
  check("signature is 64 hex chars", /Signature=[0-9a-f]{64}$/.test(s.headers.authorization));
  check("payload hash header matches sha256(body)", s.headers["x-amz-content-sha256"] === (await sha256Hex(opts.body)));

  // Deterministic for fixed inputs; sensitive to the body.
  const again = await signBedrockInvoke(opts);
  check("same inputs + clock → identical signature", again.headers.authorization === s.headers.authorization);
  const other = await signBedrockInvoke({ ...opts, body: JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 11, messages: [] }) });
  check("different body → different signature", other.headers.authorization !== s.headers.authorization);
}

// ── FY bounds: the per-FY dashboard/progress scoping math ────────────────────
// The dashboard, summary bar and report all scope `WHERE txn_date BETWEEN start AND end` to the
// active FY. These guard the Jul–Jun boundary the SQL string-compares against (txn_date is ISO
// YYYY-MM-DD), and the current-FY default the API falls back to when ?fy= is absent.
console.log("fyBounds / currentFyStartYear (per-FY scoping)");
{
  const b = fyBounds(2024);
  check("FY 2024 starts 1 Jul 2024", b.start === "2024-07-01");
  check("FY 2024 ends 30 Jun 2025", b.end === "2025-06-30");
  // ISO YYYY-MM-DD string comparison must place real txns inside/outside the range correctly.
  check("1 Jul 2024 is in range (>= start)", "2024-07-01" >= b.start && "2024-07-01" <= b.end);
  check("30 Jun 2025 is in range (<= end)", "2025-06-30" >= b.start && "2025-06-30" <= b.end);
  check("30 Jun 2024 is BEFORE the FY (prior year)", !("2024-06-30" >= b.start));
  check("1 Jul 2025 is AFTER the FY (next year)", !("2025-07-01" <= b.end));
  check("label matches the start year", fyLabel(2024) === "2024-25");
  // currentFyStartYear: AU FY rolls over on 1 July. June → prior start year; July → new start year.
  check("30 Jun 2026 → FY start 2025", currentFyStartYear(new Date("2026-06-30T00:00:00Z")) === 2025);
  check("1 Jul 2026 → FY start 2026", currentFyStartYear(new Date("2026-07-01T00:00:00Z")) === 2026);
}

// ── Batch AI categorisation: validation + id-mapping (review High #1 + the index-vs-id bug) ──
// The batch path used to cast the model's tool output straight to the DB and match results to
// transactions by ARRAY INDEX. These guard the two fixes: (1) parseBatchMessage validates/sanitises
// (drops hallucinated buckets, hygienes ato_label, clamps confidence); (2) mapBatchItems matches by
// the model-echoed line number and refuses to positionally mis-map when items were dropped.
console.log("parseBatchMessage (validate + sanitise batch output)");
{
  const msg = (items: unknown[]) =>
    ({ content: [{ type: "tool_use", name: "record_batch", input: { items } }] }) as unknown as Anthropic.Message;
  const parsed = parseBatchMessage(
    msg([
      { line: 1, bucket: "payg", ato_label: "D5", confidence: 0.9, reasoning: "ok" },
      { line: 2, bucket: "not_a_bucket", ato_label: "x", confidence: 0.5, reasoning: "bad" }, // dropped
      { line: 3, bucket: "company", ato_label: "x".repeat(200), confidence: 5, reasoning: "z" }, // sanitised
    ]),
  );
  check("drops the item with a hallucinated bucket", parsed.length === 2);
  check("keeps valid buckets only", parsed.every((p) => p.bucket === "payg" || p.bucket === "company"));
  check("junk/over-long ato_label falls back to the bucket name", parsed[1]!.ato_label === "company");
  check("confidence is clamped to 0..1", parsed[1]!.confidence === 1);
  check("non-tool / empty message yields []", parseBatchMessage({ content: [] } as unknown as Anthropic.Message).length === 0);
}

console.log("mapBatchItems (match results to line ids by echoed line, not array index)");
{
  const it = (line: number | null, bucket = "payg"): BatchItem => ({ line, bucket, ato_label: bucket, confidence: 1, reasoning: "" });
  const ids = ["a", "b", "c"];
  // Reordered items still land on the right id by line number.
  const reordered = mapBatchItems(ids, [it(3, "company"), it(1, "payg"), it(2, "asset")]);
  check("maps by line number regardless of order", reordered.find((r) => r.id === "c")!.item.bucket === "company");
  check("line 1 → first id", reordered.find((r) => r.id === "a")!.item.bucket === "payg");
  // A dropped middle item (length mismatch, others still lined) must NOT shift the tail positionally.
  const dropped = mapBatchItems(ids, [it(1, "payg"), it(3, "company")]); // line 2 missing
  check("dropped item costs only itself (no positional shift)", dropped.length === 2 && dropped.find((r) => r.id === "b") === undefined);
  check("surviving lines keep their correct id", dropped.find((r) => r.id === "c")!.item.bucket === "company");
  // No line numbers at all but exact length → positional fallback (back-compat).
  const positional = mapBatchItems(ids, [it(null, "payg"), it(null, "company"), it(null, "asset")]);
  check("falls back to positional only when lengths match exactly", positional.length === 3 && positional[1]!.id === "b");
  // No lines AND length mismatch → refuse to positionally guess (map nothing).
  const refuse = mapBatchItems(ids, [it(null, "payg"), it(null, "company")]);
  check("refuses positional mapping when items were dropped", refuse.length === 0);
  // MIXED: some items carry valid lines, one is null, lengths happen to match → must NOT fall back to
  // positional (that would mis-bucket every line); map the lined items by line, skip the line-less one.
  const mixed = mapBatchItems(ids, [it(3, "company"), it(1, "payg"), it(null, "asset")]);
  check("mixed line info maps by line, not position", mixed.find((r) => r.id === "a")!.item.bucket === "payg" && mixed.find((r) => r.id === "c")!.item.bucket === "company");
  check("mixed line info leaves the line-less item unmapped", mixed.find((r) => r.id === "b") === undefined);
  // Duplicate line claim is ignored (first wins).
  const dup = mapBatchItems(ids, [it(1, "payg"), it(1, "company"), it(2, "asset")]);
  check("duplicate line claim ignored", dup.filter((r) => r.id === "a").length === 1);
}

console.log(`\n=== units: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
