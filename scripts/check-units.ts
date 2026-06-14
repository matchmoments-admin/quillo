#!/usr/bin/env tsx
// Offline unit tests for the pure invariants that underpin statement import + async
// categorisation. No worker runtime / D1 / Claude — these are the fast, deterministic
// regression guards for the rules we keep re-learning. Run: npm run test:units
import { reconcileStatement, deriveBalances, isTransferLike, isLoanInterestLine, classifyMovement, movementTreatment, signedCents, lineFingerprint, type StatementLine } from "../src/lib/statements";
import { groupKey, groupForClarify, rulePatternForStem, isClarifyLeftover, isInsuranceLikeStem, suggestionsFor } from "../src/lib/clarify";
import { resolveLoanInterest, deductibleInterestCents } from "../src/lib/loan-interest";
import { scoreClaimMatches } from "../src/lib/claim-match";
import { batchStatementStatus, isStaleBatch, BATCH_MAX_AGE_MS } from "../src/lib/batch";
import { extractSituationDraft, parseBatchMessage, mapBatchItems, type BatchItem } from "../src/extract";
import type { LLM } from "../src/llm";
import { isValidAbn, normaliseAbn } from "../web/src/lib/abn";
import { billableCents } from "../src/lib/billing";
import { costCents, isPricedModel, toE4, centsFromE4 } from "../src/lib/usage";
import { LLM_MODEL_IDS } from "../src/llm";
import { computeWorkMethodDeductions, workUseRatesForFy, deriveWfhHours, generateWfhDiary } from "../src/lib/work-use";
import { BUCKETS } from "../src/lib/taxonomy";
import {
  billerNormalize, classifyBiller, annualiseSpendCents, daysBetween, detectRecurrence,
  classifyCadence, paymentsPerYear, runRateCopy, recurringCopy, assertFactual, signpostFor,
  ADVISORY_DISCLAIMER, savingsProjection, savingsProjectionCopy,
} from "../src/lib/advisory";
import { applyUserRules } from "../src/lib/rules";
import type { UserRule } from "../src/lib/db";
import { parseRoles, hasRole, isAdmin, isPartner, normaliseRoles, ROLES } from "../src/lib/roles";
import {
  resolvePartnerId,
  listPartnerReferrals,
  canAdvanceReferral,
  buildReferralUrl,
  matchEnergyOffer,
  getOfferById,
  sanitizeRevenueCents,
  ctaFromOffer,
  opportunityTakesEnergyCta,
  type PartnerDB,
} from "../src/lib/partners";
import { buildGuidePrompt, buildAskSystem, summariseReportForAsk, renderTxnDigest } from "../src/lib/guide";
import { validateProposedActions } from "../src/extract";
import type { Progress } from "../src/lib/progress";
import { fyBounds, fyLabel, basPositionFrom, fyStartYearStr, parseFyStartYear, normaliseFyLabel } from "../src/lib/ledger-totals";
import { currentFyStartYear, reportToCsv, type Report } from "../src/lib/report";
import { resolveJurisdiction, fyBoundsFor, fyStartYearForDate, fyStartYearSqlExpr, baseCurrencyOf, AU_DESCRIPTOR, UK_DESCRIPTOR } from "../src/lib/jurisdiction";
import { toBaseCurrency } from "../src/lib/fx";
import { currencySymbol, currencyLocale } from "../web/src/lib/currency";
import { csvCell, substantiationStatus, impliedWorkUsePct, scheduleToCsv, type AccountantSchedule } from "../src/lib/accountant-schedule";
import { exclusionReason } from "../src/lib/readiness";
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

  // BUG FIX: a credit-card CSV with per-line balances must DERIVE the opening with the liability
  // sign too — deriveBalances used to ignore isLiability, so the opening was off by 2×signedCents
  // and EVERY such import failed reconcile (forcing force=true). Owed: 1866.14 → +8528.99 purchase
  // (=10395.13) → −8800.00 payment (=1595.13 closing).
  const ccBal: StatementLine[] = [
    line({ amount_cents: 852899, direction: "debit", balance_cents: 1039513, description: "purchases" }),
    line({ amount_cents: 880000, direction: "credit", balance_cents: 159513, description: "payments" }),
  ];
  const dLia = deriveBalances(ccBal, true)!;
  check("deriveBalances(liability) recovers the true opening (1866.14)", dLia.opening_cents === 186614 && dLia.closing_cents === 159513);
  const rLia = reconcileStatement(ccBal, dLia.opening_cents, dLia.closing_cents, true);
  check("liability CSV now reconciles end-to-end (derive + reconcile)", rLia.ok && rLia.diff_cents === 0);
  // The old asset-math derive produced a wrong opening → reconcile failed (the bug we fixed).
  const dAsset = deriveBalances(ccBal, false)!;
  check("asset-math derive on a liability CSV gives the WRONG opening", dAsset.opening_cents === 1892412);
  check("...and that wrong opening fails reconcile (proves the flag is load-bearing)", !reconcileStatement(ccBal, dAsset.opening_cents, dAsset.closing_cents, true).ok);
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

// ── #165 loan-interest line detector (used only on a LOAN account's own lines) ─
console.log("isLoanInterestLine");
{
  check("'Interest Charged' is an interest line", isLoanInterestLine("Interest Charged"));
  check("'Loan Interest' is an interest line", isLoanInterestLine("Home Loan Interest 12345"));
  check("'Debit Interest' is an interest line", isLoanInterestLine("Debit Interest"));
  check("'Interest Charge' is an interest line", isLoanInterestLine("INTEREST CHARGE FOR THE PERIOD"));
  check("'Interest Rate Change' is NOT a charge (rate notice)", !isLoanInterestLine("Interest Rate Change Notice"));
  check("'Interest Saver Sweep' is NOT a charge", !isLoanInterestLine("Interest Saver Sweep"));
  check("'Interest Free Period' is NOT a charge", !isLoanInterestLine("Interest Free Period Ends"));
  check("'Offset Interest Benefit' is NOT a charge", !isLoanInterestLine("Offset Interest Benefit"));
  check("a normal repayment line is NOT an interest line", !isLoanInterestLine("Loan Repayment LN REPAY 12345"));
  check("Woolworths is NOT an interest line", !isLoanInterestLine("WOOLWORTHS 1234 SYDNEY"));
}

// ── Stage A movement treatment: ignorable vs review vs skip (B3 + income guard) ─
console.log("movementTreatment");
{
  // Loan lines are ALWAYS review-only — never one-tap excluded, regardless of rental status (B3).
  check("loan_repayment (debit) → review, never ignorable", movementTreatment("loan_repayment", "debit") === "review");
  check("loan_repayment (credit) → review", movementTreatment("loan_repayment", "credit") === "review");
  // An investment-app deposit is a CAPITAL movement, routed BOTH directions to "skip" so it falls
  // through the sweep into the clarify "capital" answer (a debit = money invested = CGT-relevant
  // capital; a credit = likely dividend/return = income) — never silently one-tap excluded.
  check("investment_deposit DEBIT → skip (capital decision routed to clarify, not a one-tap exclude)", movementTreatment("investment_deposit", "debit") === "skip");
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
  // Debit "Rental-property expense" now carries needs_property so the UI captures + persists a
  // property_id (was unattributed before) — symmetric with the credit rental-income answer.
  check("debit group offers Rental-property expense needing a property", big[0]!.suggestions.some((s) => s.kind === "bucket" && s.bucket === "property_rented" && s.needs_property === true));
  // Phase 6d — own-home rent routing: a tenant (renting_residence) sees a "rent I pay (private)" answer
  // on a rent-like debit group; without a tenant home, or on a non-rent group, it isn't offered.
  const rentRows = [mk("ANZ CARDS rent payment", "debit", 250000), mk("ANZ CARDS rent payment", "debit", 250000), mk("ANZ CARDS rent payment", "debit", 250000)];
  const rentTenant = groupForClarify(rentRows, undefined, { hasTenantHome: true });
  check("tenant + rent group → 'rent I pay (private)' offered", rentTenant[0]!.suggestions.some((s) => /rent I pay/i.test(s.label) && s.bucket === "payg" && s.ato_label === "personal-spend"));
  check("non-tenant + rent group → no rent-private suggestion", !groupForClarify(rentRows, undefined, { hasTenantHome: false })[0]!.suggestions.some((s) => /rent I pay/i.test(s.label)));
  check("tenant + non-rent group → no rent-private suggestion", !groupForClarify([mk("Coles 1234", "debit", 30000)], undefined, { hasTenantHome: true })[0]!.suggestions.some((s) => /rent I pay/i.test(s.label)));
  // Part B (claimable-only grouping): an income-protection / life insurer stem surfaces the ONE
  // claimable insurance answer; a generic stem and a HEALTH fund do not (health = private, not claimable).
  check("isInsuranceLikeStem matches income-protection / life insurers", isInsuranceLikeStem("TAL income protection") && isInsuranceLikeStem("Zurich life insurance") && isInsuranceLikeStem("AIA salary continuance"));
  check("isInsuranceLikeStem excludes health funds + generic debits", !isInsuranceLikeStem("BUPA AUSTRALIA") && !isInsuranceLikeStem("Medibank Private") && !isInsuranceLikeStem("Coles 1234"));
  const ipDebit = suggestionsFor("debit", { isInsuranceLike: true });
  const genericDebit = suggestionsFor("debit", {});
  check("insurer-like debit → income-protection one-tap (claimable, outside super)", ipDebit.some((s) => s.kind === "bucket" && s.ato_label === "insurance:income-protection"));
  check("generic debit → NO income-protection option (only shown on insurer-like stems)", !genericDebit.some((s) => s.ato_label === "insurance:income-protection"));
  check("donation + union one-tap present in every debit set (common + claimable)", genericDebit.some((s) => s.ato_label === "donation") && genericDebit.some((s) => s.ato_label === "union-fees"));
  check("no private-health one-tap label is offered (owner: claimable-only)", !genericDebit.concat(ipDebit).some((s) => /health/i.test(s.label)));
}

// ── Sort S1: isClarifyLeftover — the SINGLE predicate the scan, answer + apply-to-siblings share ──
console.log("clarify.isClarifyLeftover");
{
  // A plain merchant line (movement 'skip') IS a clarify leftover — apply-to-siblings may touch it.
  check("plain merchant debit → leftover (true)", isClarifyLeftover({ raw_description: "BPAY Origin Energy 12345", direction: "debit" }));
  check("plain merchant credit → leftover (true)", isClarifyLeftover({ raw_description: "Transfer From Catherine Soper", direction: "credit" }));
  // Movement-owned lines are NOT leftovers — a dedicated step owns them, so a pattern answer must skip.
  check("loan repayment → NOT a leftover (loan-split step owns it)", !isClarifyLeftover({ raw_description: "Loan Repayment LN REPAY", direction: "debit" }));
  check("internal transfer → NOT a leftover (movement sweep owns it)", !isClarifyLeftover({ raw_description: "Transfer to Savings", direction: "debit" }));
  // Reads raw_description first, then merchant — mirrors the scan/answer fallback order.
  check("falls back to merchant when raw_description is null", isClarifyLeftover({ raw_description: null, merchant: "Origin Energy", direction: "debit" }));
}

// ── Sort S4: evidence-first loan interest resolver (#157) ─────────────────────
console.log("loan-interest.resolveLoanInterest");
{
  // 1. An evidenced summary wins and carries its source through.
  const lender = resolveLoanInterest({ interest_cents: 1234500, source: "lender_summary" }, { interest_rate_pct: 6.25, balance_cents: 45000000 });
  check("lender summary wins over the rate estimate", lender?.interest_cents === 1234500 && lender?.source === "lender_summary");
  const parsed = resolveLoanInterest({ interest_cents: 999900, source: "statement_parsed" }, {});
  check("parsed-statement figure used as-is", parsed?.interest_cents === 999900 && parsed?.source === "statement_parsed");
  // 2. No summary → derive a LABELLED estimate from rate × balance only when both are known.
  const est = resolveLoanInterest(null, { interest_rate_pct: 6, balance_cents: 50000000 });
  check("no summary → rate×balance estimate, labelled 'estimate'", est?.interest_cents === 3000000 && est?.source === "estimate");
  check("estimate needs BOTH rate and balance — rate only → null", resolveLoanInterest(null, { interest_rate_pct: 6 }) === null);
  check("estimate needs BOTH rate and balance — balance only → null", resolveLoanInterest(null, { balance_cents: 50000000 }) === null);
  check("no summary + no facts → null (nothing to attribute)", resolveLoanInterest(null, {}) === null);
  check("a zero/garbage summary is ignored (not a real figure)", resolveLoanInterest({ interest_cents: 0, source: "lender_summary" }, {}) === null);
  // 3. Deductible portion applies the loan→property share, clamped to 0–100.
  check("deductible portion applies the share", deductibleInterestCents(1000000, 80) === 800000);
  check("share clamps above 100", deductibleInterestCents(1000000, 150) === 1000000);
  check("share clamps below 0", deductibleInterestCents(1000000, -5) === 0);
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
import { computeFyDeduction, rollSchedule, daysInFy, daysHeldInFy, balancingAdjustment, depreciableCostCents, isLowCostAsset, looksLikePersonalTransfer, assetDepreciatesForTaxpayer, type DepAsset } from "../src/lib/depreciation";

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
  // D.3: an employer-owned or reimbursed asset earns the taxpayer NO decline-in-value (computeDepreciation
  // writes no schedule at source). Default self/0 keeps every normal asset depreciating.
  check("self-owned, not reimbursed → depreciates", assetDepreciatesForTaxpayer({ owned_by: "self", reimbursed: 0 }) === true);
  check("employer-owned → no decline-in-value", assetDepreciatesForTaxpayer({ owned_by: "employer", reimbursed: 0 }) === false);
  check("reimbursed → no decline-in-value", assetDepreciatesForTaxpayer({ owned_by: "self", reimbursed: 1 }) === false);
  check("missing fields default to depreciating (legacy assets unchanged)", assetDepreciatesForTaxpayer({}) === true);
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
import { computeCapitalGain, computeNetCapitalGain, propertyToCgtInputs, DEFAULT_CGT_RULES } from "../src/lib/cgt";
import { ordinaryAssessableCents, totalDistributionCents, validateComponents, ammaToCgtEvents, parseAmmaComponents, type AmmaComponents } from "../src/lib/managed-fund";
import { essAssessable } from "../src/lib/ess";
import { gstFromInclusiveCents, computeBasNet } from "../src/lib/gst";
import { businessUsePct, logbookDeductionCents, chooseCarMethod } from "../src/lib/car-logbook";
import { occupationGuide, occupationScopes } from "../src/lib/occupations";
import { summariseTrustDistributions } from "../src/lib/trust";
import { ecpiExemptFraction, computeSmsfPosition } from "../src/lib/smsf";

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

console.log("cgt property synthesis (Slice F)");
{
  // A disposed investment property → a discountable cgt_event apportioned by ownership share.
  const inv = propertyToCgtInputs({ cost_base_cents: 50_000_000, proceeds_cents: 70_000_000, acquired_date: "2020-01-01", disposal_date: "2025-09-01", ownership_pct: 100, is_resident_individual: true });
  check("property → synth event (full share, discount eligible)", "event" in inv && inv.event.proceeds_cents === 70_000_000 && inv.event.cost_base_used_cents === 50_000_000 && inv.event.discount_eligible === true);

  // 50% ownership halves BOTH proceeds and cost base used.
  const half = propertyToCgtInputs({ cost_base_cents: 50_000_000, proceeds_cents: 70_000_000, acquired_date: "2020-01-01", disposal_date: "2025-09-01", ownership_pct: 50, is_resident_individual: true });
  check("property → 50% ownership apportions proceeds + cost base", "event" in half && half.event.proceeds_cents === 35_000_000 && half.event.cost_base_used_cents === 25_000_000);

  // Div 43 capital-works claimed reduces the cost base used (increasing the gain).
  const div43 = propertyToCgtInputs({ cost_base_cents: 50_000_000, proceeds_cents: 70_000_000, div43_claimed_cents: 4_000_000, acquired_date: "2020-01-01", disposal_date: "2025-09-01", ownership_pct: 100, is_resident_individual: true });
  check("property → Div 43 reduces cost base used", "event" in div43 && div43.event.cost_base_used_cents === 46_000_000);

  // Non-resident → discount denied even on a 12-month+ hold.
  const nonRes = propertyToCgtInputs({ cost_base_cents: 50_000_000, proceeds_cents: 70_000_000, acquired_date: "2020-01-01", disposal_date: "2025-09-01", ownership_pct: 100, is_resident_individual: false });
  check("property → non-resident gets no discount", "event" in nonRes && nonRes.event.discount_eligible === false);

  // A flagged main residence defers — no event is synthesised (never auto-exempt / auto-tax).
  const home = propertyToCgtInputs({ cost_base_cents: 60_000_000, proceeds_cents: 90_000_000, acquired_date: "2015-01-01", disposal_date: "2025-10-01", ownership_pct: 100, is_resident_individual: true, main_residence_exempt: true });
  check("property → main residence defers (no synthetic event)", "defer" in home && home.defer === "main_residence");
}

console.log("managed-fund AMMA components (Slice B)");
{
  const mk = (p: Partial<AmmaComponents> = {}): AmmaComponents => ({
    franked_cents: 0, unfranked_cents: 0, interest_cents: 0, other_income_cents: 0, foreign_income_cents: 0,
    franking_credit_cents: 0, foreign_tax_paid_cents: 0, capital_gain_discounted_cents: 0, capital_gain_other_cents: 0,
    amit_cost_base_net_amount_cents: 0, ...p,
  });
  // Ordinary assessable = franked + unfranked + interest + other + foreign (NOT capital gains / cost base).
  const c = mk({ franked_cents: 100_000, unfranked_cents: 50_000, interest_cents: 20_000, other_income_cents: 10_000, foreign_income_cents: 30_000, capital_gain_discounted_cents: 200_000, amit_cost_base_net_amount_cents: 40_000 });
  check("AMMA ordinary assessable excludes CG + cost-base", ordinaryAssessableCents(c) === 210_000);
  check("AMMA total distribution = ordinary + CG + cost-base", totalDistributionCents(c) === 210_000 + 200_000 + 40_000);

  // CG events: one per non-zero bucket; discounted → discount_eligible true, other → false; cost_base_used 0.
  const evs = ammaToCgtEvents(mk({ capital_gain_discounted_cents: 200_000, capital_gain_other_cents: 60_000 }));
  check("AMMA → two CG events with correct discount flags", evs.length === 2 && evs[0].proceeds_cents === 200_000 && evs[0].discount_eligible === true && evs[0].cost_base_used_cents === 0 && evs[1].discount_eligible === false);
  check("AMMA → zero CG buckets produce no events", ammaToCgtEvents(mk({ interest_cents: 5_000 })).length === 0);
  // The discounted CG event feeds the engine as a GROSS gain → 50% discount → half net.
  const net = computeNetCapitalGain(evs.map((e) => ({ ...e })), DEFAULT_CGT_RULES);
  check("AMMA discounted CG halved by the engine; other-method full", net.net_capital_gain_cents === 100_000 + 60_000);

  // Validation: rejects negatives (on income/CG), all-zero; allows a negative cost-base (an increase).
  check("AMMA validate: rejects a negative income bucket", validateComponents(mk({ interest_cents: -1 })).ok === false);
  check("AMMA validate: rejects all-zero", validateComponents(mk()).ok === false);
  check("AMMA validate: allows a negative AMIT cost-base amount", validateComponents(mk({ amit_cost_base_net_amount_cents: -5_000 })).ok === true);

  // parseAmmaComponents round-trips a {components} blob and ignores a legacy/plain detail_json.
  const round = parseAmmaComponents(JSON.stringify({ components: c }));
  check("AMMA parse: round-trips a components blob", round?.capital_gain_discounted_cents === 200_000 && round?.franked_cents === 100_000);
  check("AMMA parse: a legacy detail_json (no components) → null", parseAmmaComponents(JSON.stringify({ payer: "x" })) === null && parseAmmaComponents(null) === null);
}

console.log("cgt portfolio (#138)");
{
  const R = DEFAULT_CGT_RULES;
  // One discountable $10k gain → 50% → $5k net.
  const a = computeNetCapitalGain([{ proceeds_cents: 3_000_000, cost_base_used_cents: 2_000_000, discount_eligible: true }], R);
  check("single discountable gain → 50% discount → $5k", a.net_capital_gain_cents === 500_000 && a.discount_applied_cents === 500_000);

  // Losses offset NON-discountable gains first (optimal): $10k disc gain + $6k non-disc gain − $6k loss.
  // Loss eats the non-disc gain entirely, disc gain halved → $5k.
  const b = computeNetCapitalGain([
    { proceeds_cents: 1_000_000, cost_base_used_cents: 0, discount_eligible: true },   // $10k disc
    { proceeds_cents: 600_000, cost_base_used_cents: 0, discount_eligible: false },    // $6k non-disc
    { proceeds_cents: 0, cost_base_used_cents: 600_000, discount_eligible: false },    // $6k loss
  ], R);
  check("loss applied to non-disc gain first → disc gain halved → $5k", b.net_capital_gain_cents === 500_000);

  // Carried-forward loss exceeds gains → net 0, remainder carries forward.
  const c = computeNetCapitalGain([{ proceeds_cents: 1_000_000, cost_base_used_cents: 0, discount_eligible: true }], R, 1_500_000);
  check("prior loss > gains → net 0, $5k carries forward", c.net_capital_gain_cents === 0 && c.loss_carried_forward_cents === 500_000);

  // discount_eligible derived from dates when not given (held >12mo).
  const d = computeNetCapitalGain([{ proceeds_cents: 1_000_000, cost_base_used_cents: 0, acquired_date: "2023-01-01", event_date: "2025-09-01" }], R);
  check("discount eligibility derived from dates (held >12mo) → $5k", d.net_capital_gain_cents === 500_000);

  // Non-discountable (held <12mo via dates) → full gain assessable.
  const e = computeNetCapitalGain([{ proceeds_cents: 1_000_000, cost_base_used_cents: 0, acquired_date: "2025-03-01", event_date: "2025-09-01" }], R);
  check("held <12mo → no discount → full $10k", e.net_capital_gain_cents === 1_000_000);
}

console.log("ess (#141)");
{
  // taxed-upfront + deferral → assessable now; startup (≤10%) → deferred to CGT.
  const a = essAssessable([
    { scheme_type: "taxed_upfront", discount_cents: 500_000 },
    { scheme_type: "deferral", discount_cents: 300_000 },
    { scheme_type: "startup", discount_cents: 1_000_000, ownership_gt_10pct: false },
  ]);
  check("upfront+deferral assessable ($8k), startup deferred to CGT ($10k)", a.assessable_discount_cents === 800_000 && a.startup_deferred_to_cgt_cents === 1_000_000 && !a.ineligible_startup_flag);

  // founder >10% on a 'startup' grant → concession unavailable → discount assessable + flagged.
  const b = essAssessable([{ scheme_type: "startup", discount_cents: 1_000_000, ownership_gt_10pct: true }]);
  check("startup grant with >10% ownership → assessable + ineligible flag", b.assessable_discount_cents === 1_000_000 && b.startup_deferred_to_cgt_cents === 0 && b.ineligible_startup_flag);
}

console.log("gst/bas (#137)");
{
  check("$1,100 inclusive → $100 GST", gstFromInclusiveCents(110_000) === 10_000);
  check("$45,000 fares → $4,090.91 output GST (rounded)", gstFromInclusiveCents(4_500_000) === 409_091);
  const net = computeBasNet(4_500_000, 45_454);
  check("net BAS = output − input", net.output_gst_cents === 409_091 && net.input_gst_cents === 45_454 && net.net_gst_cents === 363_637);
  const refund = computeBasNet(1_100_000, 200_000); // more credits than output → refund (negative net)
  check("input > output → negative net (refund)", refund.net_gst_cents === 100_000 - 200_000);

  // #174: recorded BAS periods OVERRIDE the ledger estimate; none → fall back to the estimate.
  const ledger = computeBasNet(4_500_000, 45_454);
  const overridden = basPositionFrom({ n: 2, output_gst_cents: 500_000, input_gst_cents: 80_000 }, ledger);
  check("recorded BAS periods win (output)", overridden.output_gst_cents === 500_000 && overridden.source === "recorded");
  check("recorded BAS net = recorded out − in", overridden.net_gst_cents === 420_000);
  const fellBack = basPositionFrom({ n: 0, output_gst_cents: 0, input_gst_cents: 0 }, ledger);
  check("no recorded periods → ledger estimate, source=ledger", fellBack.output_gst_cents === ledger.output_gst_cents && fellBack.source === "ledger");
  check("null recorded → ledger estimate", basPositionFrom(null, ledger).source === "ledger");
}

console.log("car logbook (#142)");
{
  check("business-use % = business/total km", businessUsePct(27_000, 30_000) === 90);
  check("zero total km → 0%", businessUsePct(100, 0) === 0);
  // 90% × ($10k running + $2k car decline) = $10,800.
  check("logbook = pct × (running + car dep)", logbookDeductionCents(1_000_000, 200_000, 90) === 1_080_000);
  // logbook ($9k) beats capped cents-per-km ($4,400).
  const win = chooseCarMethod(900_000, 440_000);
  check("higher method wins (logbook)", win.method === "logbook" && win.deduction_cents === 900_000);
  // a low-business-use car → cents-per-km wins; tie favours cents-per-km.
  check("tie favours cents-per-km", chooseCarMethod(440_000, 440_000).method === "cents_per_km");
}

console.log("occupations (#143)");
{
  const nurse = occupationGuide("nurse");
  check("nurse guide has suggestions + warnings", !!nurse && nurse.suggest.length > 0 && nurse.warn.length > 0);
  check("nurse warning pre-empts the conventional-clothing error", !!nurse && nurse.warn.some((w) => /conventional clothing/i.test(w)));
  check("tradie guide covers tools + PPE", (occupationGuide("tradie")?.suggest.join(" ") ?? "").match(/tool/i) != null);
  check("unknown scope → null", occupationGuide("astronaut") === null && occupationGuide(null) === null);
  check("scopes exclude the _note metadata key", occupationScopes().length >= 4 && !occupationScopes().includes("_note"));
}

console.log("trust distributions (#139)");
{
  const t = summariseTrustDistributions([
    { character: "franked_dividend", amount_cents: 5_000_000, franking_credit_cents: 1_500_000 },
    { character: "discount_capital_gain", amount_cents: 1_000_000 },
    { character: "ordinary", amount_cents: 2_000_000 },
  ]);
  check("all distributed income is assessable to the beneficiary ($80k)", t.assessable_cents === 8_000_000);
  check("franking credit carried (not grossed-up)", t.franking_credit_cents === 1_500_000);
  check("character retained per type", t.by_character.franked_dividend === 5_000_000 && t.by_character.discount_capital_gain === 1_000_000);
}

console.log("smsf / ecpi (#140)");
{
  check("fully pension phase → ECPI 100%", ecpiExemptFraction([{ pension_balance_cents: 2_000_000_00, accumulation_balance_cents: 0 }]) === 1);
  check("half pension / half accumulation → 50%", ecpiExemptFraction([{ pension_balance_cents: 1_000_000, accumulation_balance_cents: 1_000_000 }]) === 0.5);
  check("no assets → 0", ecpiExemptFraction([]) === 0);
  const full = computeSmsfPosition(4_000_000, 1);
  check("100% ECPI → fund taxable income $0", full.fund_taxable_income_cents === 0 && full.ecpi_exempt_cents === 4_000_000);
  const half = computeSmsfPosition(4_000_000, 0.5);
  check("50% ECPI → half the earnings taxable", half.fund_taxable_income_cents === 2_000_000);
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
    profile: {} as Situation["profile"], persons: [], properties: [], entities: [], rules: [], loans_properties: [], ...p,
  });
  const noSignals = (p: Partial<FilingReadinessSignals> = {}): FilingReadinessSignals => ({
    unknownBucketCents: 0, unknownBucketN: 0, lowConfidenceN: 0, needsReviewIncomeN: 0, needsReviewAssetsN: 0,
    hasDividendStatementDoc: true, rentalPropsMissingSummary: [], disposedAssetsN: 0,
    instantAssetWriteOffCentsThisFy: null, instantAssetWriteOffCentsPrevFy: null, capitalLossCarryinCents: 0, ...p,
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

  // Trust entity → a defer-to-agent "resolve distributions before 30 June" finding (the one place a
  // trust is flagged at hand-off; no trust position is in the personal headline).
  const trustReport = mkReport({ income: { by_type: [{ income_type: "salary_payg", n: 1, gross_cents: 5_000_000, net_cents: 4_000_000, withholding_cents: 1_000_000, franking_credit_cents: 0, foreign_tax_paid_cents: 0 }], gross_cents: 5_000_000, withholding_cents: 1_000_000, franking_credit_cents: 0, foreign_tax_paid_cents: 0 }, total_income_cents: 5_000_000, taxable_position_cents: 5_000_000 });
  const trust = run(trustReport, noSignals(), [], mkSituation({ entities: [{ id: "e1", kind: "trust", name: "Smith Family Trust", detail_json: null }] }));
  check("trust entity → distribution-resolution defer finding", trust.findings.some((f) => f.id === "trust_resolution:e1" && f.defer_to_agent && f.severity === "review"));
  check("trust finding doesn't block readiness (review, not blocker)", trust.readiness_score.ready);
  // No trust → no trust finding.
  check("no trust entity → no trust finding", !run(mkReport(), noSignals()).findings.some((f) => f.id.startsWith("trust_resolution:")));

  // E: a partnership distribution renders as an assessable "income" position line (buildReport already
  // added it to the headline), distinct from the trust line.
  const partn = run(mkReport({ partnership: { assessable_cents: 5_000_000, franking_credit_cents: 1_500_000, by_character: { franked_dividend: 5_000_000 } }, taxable_position_cents: 5_000_000, total_income_cents: 5_000_000 }), noSignals());
  check("partnership distribution → assessable income line", partn.position.lines.some((l) => l.group === "income" && l.label === "partnership_distribution" && l.amount_cents === 5_000_000));
  check("no partnership → no partnership line", !run(mkReport(), noSignals()).position.lines.some((l) => l.label === "partnership_distribution"));

  // Capital-loss carry-in → a defer-to-agent info finding, and it is NEVER applied to the headline
  // (capital losses offset capital gains only). taxable_position must equal the report's, unchanged.
  const capLoss = run(trustReport, noSignals({ capitalLossCarryinCents: 800_000 }));
  check("capital-loss carry-in → defer info finding", capLoss.findings.some((f) => f.id === "capital_loss_carryin" && f.defer_to_agent && f.severity === "info"));
  check("capital-loss carry-in does NOT change the position", capLoss.position.indicative_taxable_position_cents === trustReport.taxable_position_cents);
  check("no capital-loss → no capital-loss finding", !run(trustReport, noSignals()).findings.some((f) => f.id === "capital_loss_carryin"));

  // Phase 3b: sole-trader business income → a defer-to-agent PSI (Div 86) review nudge. Does NOT change
  // the position; pure judgement passthrough.
  const psiReport = mkReport({ income: { by_type: [{ income_type: "business", n: 1, gross_cents: 11_000_000, net_cents: 11_000_000, withholding_cents: 0, franking_credit_cents: 0, foreign_tax_paid_cents: 0 }], gross_cents: 11_000_000, withholding_cents: 0, franking_credit_cents: 0, foreign_tax_paid_cents: 0 }, total_income_cents: 11_000_000, taxable_position_cents: 11_000_000 });
  const psi = run(psiReport, noSignals());
  check("business income → PSI defer review finding", psi.findings.some((f) => f.id === "psi_check" && f.defer_to_agent && f.severity === "review"));
  check("PSI nudge doesn't change the position or block readiness", psi.readiness_score.ready && psi.position.indicative_taxable_position_cents === 11_000_000);
  check("no business income → no PSI finding", !run(trustReport, noSignals()).findings.some((f) => f.id === "psi_check"));
  // S2: psi_status variants — declared "applies" sharpens the nudge; "all assessed as not_psi" suppresses it.
  const psiApplies = run(psiReport, noSignals({ psiAppliesDeclared: true }));
  check("PSI declared 'applies' → sharpened Div 86 defer finding", psiApplies.findings.some((f) => f.id === "psi_check" && f.defer_to_agent && f.title.includes("PSI applies")));
  check("PSI sharpened nudge doesn't change the position", psiApplies.position.indicative_taxable_position_cents === 11_000_000);
  check("PSI all assessed (not applies) → PSI nudge suppressed", !run(psiReport, noSignals({ psiAllAssessed: true })).findings.some((f) => f.id === "psi_check"));

  // Phase 3b: income at/above the Div 293 threshold → a defer-to-agent review nudge. Triggered only
  // when the pack supplies a reference-only threshold; never computes the surcharge.
  const div293 = run(psiReport, noSignals({ div293ThresholdCents: 25_000_000 }));
  check("income below Div 293 threshold → no finding", !div293.findings.some((f) => f.id === "div293_income"));
  const div293Hit = run(mkReport({ income: { by_type: [{ income_type: "salary_payg", n: 1, gross_cents: 26_000_000, net_cents: 18_000_000, withholding_cents: 8_000_000, franking_credit_cents: 0, foreign_tax_paid_cents: 0 }], gross_cents: 26_000_000, withholding_cents: 8_000_000, franking_credit_cents: 0, foreign_tax_paid_cents: 0 }, total_income_cents: 26_000_000, taxable_position_cents: 26_000_000 }), noSignals({ div293ThresholdCents: 25_000_000 }));
  check("income above Div 293 threshold → defer review finding", div293Hit.findings.some((f) => f.id === "div293_income" && f.defer_to_agent && f.severity === "review"));
  const div293NoThreshold = run(mkReport({ income: { by_type: [], gross_cents: 99_000_000, withholding_cents: 0, franking_credit_cents: 0, foreign_tax_paid_cents: 0 } }), noSignals());
  check("high income but no Div 293 threshold supplied → no finding", !div293NoThreshold.findings.some((f) => f.id === "div293_income"));

  // S1 (Phase 4): business turnover at/above the GST registration threshold + not registered → defer nudge.
  const gstBiz = (gross: number) => mkReport({ income: { by_type: [{ income_type: "business", n: 1, gross_cents: gross, net_cents: gross, withholding_cents: 0, franking_credit_cents: 0, foreign_tax_paid_cents: 0 }], gross_cents: gross, withholding_cents: 0, franking_credit_cents: 0, foreign_tax_paid_cents: 0 }, total_income_cents: gross, taxable_position_cents: gross });
  const gstOver = run(gstBiz(8_000_000), noSignals({ gstRegistrationThresholdCents: 7_500_000, isGstRegistered: false }));
  check("turnover ≥ GST threshold + not registered → defer review finding", gstOver.findings.some((f) => f.id === "gst_registration_threshold" && f.defer_to_agent && f.severity === "review"));
  check("GST nudge doesn't change the position", gstOver.position.indicative_taxable_position_cents === 8_000_000);
  const gstUnder = run(gstBiz(5_000_000), noSignals({ gstRegistrationThresholdCents: 7_500_000, isGstRegistered: false }));
  check("turnover below GST threshold → no finding", !gstUnder.findings.some((f) => f.id === "gst_registration_threshold"));
  const gstReg = run(gstBiz(8_000_000), noSignals({ gstRegistrationThresholdCents: 7_500_000, isGstRegistered: true }));
  check("already GST-registered → no finding even above threshold", !gstReg.findings.some((f) => f.id === "gst_registration_threshold"));
  const gstNoThreshold = run(gstBiz(8_000_000), noSignals({ isGstRegistered: false }));
  check("no GST threshold supplied → no finding", !gstNoThreshold.findings.some((f) => f.id === "gst_registration_threshold"));

  // S4: a non-cash benefit (captured but excluded) → a defer review nudge + an "excluded" position line,
  // and it is NEVER counted in the headline (incomeTotals already excluded it from gross_cents).
  const nonCash = run(mkReport({ income: { by_type: [{ income_type: "salary_payg", n: 1, gross_cents: 8_000_000, net_cents: 6_000_000, withholding_cents: 2_000_000, franking_credit_cents: 0, foreign_tax_paid_cents: 0 }], gross_cents: 8_000_000, withholding_cents: 2_000_000, franking_credit_cents: 0, foreign_tax_paid_cents: 0, excluded_by_type: [{ income_type: "non_cash_benefit", gross_cents: 500_000, n: 1 }], non_cash_cents: 500_000 }, total_income_cents: 8_000_000, taxable_position_cents: 8_000_000 }), noSignals());
  check("non-cash benefit → defer review nudge", nonCash.findings.some((f) => f.id === "non_cash_benefit" && f.defer_to_agent && f.severity === "review"));
  check("non-cash benefit → an 'excluded' line, headline unchanged", nonCash.position.lines.some((l) => l.group === "excluded" && l.label === "non_cash_benefit" && l.amount_cents === 500_000) && nonCash.position.indicative_taxable_position_cents === 8_000_000);
  check("no non-cash → no non-cash finding", !run(mkReport(), noSignals()).findings.some((f) => f.id === "non_cash_benefit"));

  // D: a super pension (captured but excluded) → its OWN defer nudge + its OWN "excluded" line, never
  // mislabelled as a non-cash benefit, never counted in the headline.
  const pension = run(mkReport({ income: { by_type: [{ income_type: "interest", n: 1, gross_cents: 200_000, net_cents: 200_000, withholding_cents: 0, franking_credit_cents: 0, foreign_tax_paid_cents: 0 }], gross_cents: 200_000, withholding_cents: 0, franking_credit_cents: 0, foreign_tax_paid_cents: 0, excluded_by_type: [{ income_type: "super_pension", gross_cents: 4_000_000, n: 1 }] }, total_income_cents: 200_000, taxable_position_cents: 200_000 }), noSignals());
  check("super pension → its own defer review nudge", pension.findings.some((f) => f.id === "super_pension" && f.defer_to_agent && f.severity === "review"));
  check("super pension → not mislabelled as a non-cash benefit", !pension.findings.some((f) => f.id === "non_cash_benefit"));
  check("super pension → an 'excluded' line, headline unchanged", pension.position.lines.some((l) => l.group === "excluded" && l.label === "super_pension" && l.amount_cents === 4_000_000) && pension.position.indicative_taxable_position_cents === 200_000);

  // F: a disposed property flagged as a main residence → a defer review nudge (the gain is kept out of the
  // position; we never auto-apply the exemption).
  const mainRes = run(mkReport(), noSignals({ mainResidenceDisposalN: 1 }));
  check("main-residence disposal → defer review nudge", mainRes.findings.some((f) => f.id === "main_residence_disposal" && f.defer_to_agent && f.severity === "review"));
  check("no main-residence disposal → no such finding", !run(mkReport(), noSignals()).findings.some((f) => f.id === "main_residence_disposal"));

  // B: a managed-fund AMIT cost-base adjustment → an info defer nudge (not assessable; future cost base).
  const mfCb = run(mkReport(), noSignals({ mfCostBaseAdjustmentCents: 40_000 }));
  check("AMIT cost-base amount → defer info nudge", mfCb.findings.some((f) => f.id === "mf_cost_base" && f.defer_to_agent && f.severity === "info"));
  check("no AMIT cost-base amount → no such finding", !run(mkReport(), noSignals()).findings.some((f) => f.id === "mf_cost_base"));

  // THE INVARIANT: no generated finding/position text asserts tax payable, a refund, or a rate.
  // (The fixed position caption intentionally NEGATES those words and is excluded — it's a vetted constant.)
  const denylist = /refund|tax payable|marginal rate|\b\d{1,2}%\s*(tax|bracket)/i;
  const everything = [unknown, franking, rental, iawo, disposed, judged, clean, trust, capLoss, psi, psiApplies, div293Hit, gstOver, nonCash, pension, mainRes, mfCb, partn];
  const generatedText = everything.flatMap((r) => [
    ...r.findings.flatMap((f) => [f.title, f.general_info_note]),
    ...r.position.lines.flatMap((l) => [l.basis, l.why]),
  ]);
  check("no generated text predicts tax payable / refund / rate", !generatedText.some((t) => denylist.test(t)));
}

// ── DEDUCTIBILITY: deny-by-default matcher + the headline/display reconciliation ──
import { verdictForTxn } from "../src/lib/deductibility";
import { deductionGroupForRow, positionAmountCents } from "../src/lib/report";
import { splitAttribution, classifyAttribution } from "../src/lib/attribution";
import { prepareAttributions } from "../src/lib/attribution-write";

console.log("deductibility (deny-by-default)");
{
  const section = (rulePack as { payg_deductibility?: Parameters<typeof verdictForTxn>[3] }).payg_deductibility;
  // verdictForTxn: only payg is classified; precedence deny → apportion → allow → undetermined.
  check("groceries → likely_not", verdictForTxn("payg", "payg:groceries", "Coles", section).deductibility === "likely_not");
  check("personal-spend → likely_not", verdictForTxn("payg", "payg:personal-spend", null, section).deductibility === "likely_not");
  check("loan repayment → likely_not", verdictForTxn("payg", "payg:loan-repayment", null, section).deductibility === "likely_not");
  check("meals-entertainment → likely_not", verdictForTxn("payg", "payg:meals-entertainment", null, section).deductibility === "likely_not");
  check("wfh electricity → needs_apportionment", verdictForTxn("payg", "payg:utilities", "Origin Energy electricity", section).deductibility === "needs_apportionment");
  // Stage D (B1): clearly-deductible payg (union/tax-affairs/donations/income-protection) is positively
  // SUGGESTED — 'suggested_deductible' is still excluded from the position (never auto-claimed) and
  // surfaced for the user to confirm, so resolved_deductible_cents stays ~$0 until they do.
  check("union fees → suggested_deductible (confirm-required, not auto-claimed)", verdictForTxn("payg", "payg:union-fees", "ASU union membership", section).deductibility === "suggested_deductible");
  check("tax-agent fees → suggested_deductible", verdictForTxn("payg", "payg:tax-affairs", "H&R Block tax agent", section).deductibility === "suggested_deductible");
  check("DGR donation → suggested_deductible", verdictForTxn("payg", "payg:donation", "RSPCA donation", section).deductibility === "suggested_deductible");
  check("a SUGGESTION is excluded from the position until confirmed (B1)", deductionGroupForRow("payg", "suggested_deductible", true) === "excluded" && deductionGroupForRow("payg", "suggested_deductible", false) === "excluded");
  check("deny still wins over suggest (groceries stay denied)", verdictForTxn("payg", "payg:groceries", "Coles", section).deductibility === "likely_not");
  // Part B (claimable-only grouping): the new one-tap insurance/donation/union labels must stamp the
  // verdict the clarify card promises. Income-protection is claimable (outside super); private health
  // + life/TPD are NOT — and 'insurance:income-protection' must NOT be caught by the life/health deny.
  check("income-protection (outside super) → suggested_deductible", verdictForTxn("payg", "insurance:income-protection", "TAL income protection", section).deductibility === "suggested_deductible");
  check("private health insurance → likely_not (private — rebate/MLS, not a deduction)", verdictForTxn("payg", "health:private-insurance", "BUPA AUSTRALIA", section).deductibility === "likely_not");
  check("life/TPD insurance → likely_not", verdictForTxn("payg", "insurance:life", "Zurich life insurance", section).deductibility === "likely_not");
  check("donation label → suggested_deductible", verdictForTxn("payg", "donation", "Direct Debit RSPCA", section).deductibility === "suggested_deductible");
  check("union-fees label → suggested_deductible", verdictForTxn("payg", "union-fees", "ASU membership", section).deductibility === "suggested_deductible");
  // Phase 3 deny-list precision: flowers + swimwear are private spend → likely_not (belt-and-suspenders;
  // they were already excluded as 'undetermined', this just stamps them clearly and keeps them out of suggestions).
  check("florist → likely_not", verdictForTxn("payg", "payg:other", "Flawless Flowers florist", section).deductibility === "likely_not");
  check("swimwear → likely_not", verdictForTxn("payg", "payg:other", "Cupshe swimwear", section).deductibility === "likely_not");
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
  // G7 (0030): employer-reimbursed spend is NEVER deductible, regardless of bucket/flag, and the
  // default reimbursed=0 leaves every existing call byte-identical.
  check("reimbursed payg excluded even when it would otherwise count", deductionGroupForRow("payg", "likely_deductible", true, 1) === "excluded");
  check("reimbursed property excluded", deductionGroupForRow("property_rented", "undetermined", true, 1) === "excluded");
  check("reimbursed=0 default keeps legacy result (byte-identical)", deductionGroupForRow("payg", "likely_deductible", true, 0) === "deduction" && deductionGroupForRow("payg", "likely_deductible", true) === "deduction");
  // G3 (0031): a rent-free / off-market-renovating property's spend is excluded from the headline but
  // still classified (visible), and propertyDenied=0 default leaves every existing call unchanged.
  check("rent-free property spend excluded (propertyDenied=1)", deductionGroupForRow("property_rented", "undetermined", true, 0, 1) === "excluded");
  check("propertyDenied=0 default keeps legacy result (byte-identical)", deductionGroupForRow("property_rented", "undetermined", true, 0, 0) === "deduction" && deductionGroupForRow("property_rented", "undetermined", true) === "deduction");

  // ── PHASE 5: loan interest/principal split — positionAmountCents (mirrors the buildReport SUM) ──
  // A split mortgage line keeps amount_cents = gross (so statement reconciliation is untouched) and
  // carries deductible_amount_cents = the interest. When the loan_split flag honours apportionment,
  // the position counts the INTEREST only — the principal can never leak into the rental net.
  const mortgage = { deductibility: "confirmed_deductible", amount_cents: 240_000, amount_aud_cents: 240_000, deductible_amount_cents: 175_000 };
  check("loan_split ON: confirmed split counts interest only (not gross)", positionAmountCents(mortgage, true) === 175_000);
  check("loan_split OFF: confirmed split counts gross (legacy, byte-identical)", positionAmountCents(mortgage, false) === 240_000);
  check("no apportioned amount → gross either way (un-split rows unchanged)", positionAmountCents({ deductibility: "undetermined", amount_cents: 5_000, amount_aud_cents: 5_000 }, true) === 5_000);
  // Scoping: ONLY confirmed_deductible honours the apportioned amount. The 0021 backfill stamped
  // likely_not (private) rows with deductible_amount_cents=0 — those must still show GROSS (they're
  // excluded from the headline anyway), else flipping the flag would zero the "excluded as private"
  // display. This is the prod-data safety check that gates enabling loan_split.
  check("likely_not w/ deductible=0 still shows GROSS (0021 backfill display safe)", positionAmountCents({ deductibility: "likely_not", amount_cents: 102_395, amount_aud_cents: 102_395, deductible_amount_cents: 0 }, true) === 102_395);
  check("confirmed_deductible w/ 0 apportioned → 0 (fully clawed back, honoured)", positionAmountCents({ deductibility: "confirmed_deductible", amount_cents: 5_000, amount_aud_cents: 5_000, deductible_amount_cents: 0 }, true) === 0);
  check("AUD fallback when no apportioned amount", positionAmountCents({ deductibility: "confirmed_deductible", amount_cents: 9_000, amount_aud_cents: 8_000 }, true) === 8_000);

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
  const mkS = (): Situation => ({ profile: {}, persons: [], properties: [], entities: [], rules: [], loans_properties: [] } as unknown as Situation);
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

  // ── PHASE B / G2: attribution snapshot math + track routing (payer ≠ claimant) ──
  // splitAttribution: gross × owner-share% × work-use%, rounded to whole cents.
  check("co-owner 50% of a $1,000 bill paid 100% by one owner → $500 (TR 93/32)", splitAttribution({ amount_cents: 100_000, owner_share_pct: 50 }) === 50_000);
  check("company claims the whole $90 SaaS bill (no split) → $90", splitAttribution({ amount_cents: 9_000, owner_share_pct: 100 }) === 9_000);
  check("mixed: 50% owner × 80% work-use of $1,000 → $400", splitAttribution({ amount_cents: 100_000, owner_share_pct: 50, work_use_pct: 80 }) === 40_000);
  check("null shares default to 100% (whole amount)", splitAttribution({ amount_cents: 12_345 }) === 12_345);
  check("shares clamp to [0,100] (120% → 100%, -5% → 0%)", splitAttribution({ amount_cents: 10_000, owner_share_pct: 120 }) === 10_000 && splitAttribution({ amount_cents: 10_000, owner_share_pct: -5 }) === 0);
  check("rounds to whole cents (33.33% of $1.00 → 33c)", splitAttribution({ amount_cents: 100, owner_share_pct: 33.333 }) === 33);

  // classifyAttribution: the routing track (the counterpart to deductionGroupForRow).
  check("rental-property activity → property track (even for an individual)", classifyAttribution({ entity_type: "individual", activity_type: "rental_property" }) === "property");
  check("company entity, business activity → company track", classifyAttribution({ entity_type: "company", activity_type: "business" }) === "company");
  check("individual taxpayer, salary activity → individual headline", classifyAttribution({ entity_type: "individual", activity_type: "salary_wages" }) === "individual");
  check("private_non_deductible provision → excluded, beats every track", classifyAttribution({ entity_type: "company", activity_type: "rental_property", deduction_provision: "private_non_deductible" }) === "excluded");
  check("missing fields default to the individual headline", classifyAttribution({}) === "individual");

  // Reconciliation WITH attribution present: the individual + property attribution amounts render as a
  // "deduction" line (so lines-sum still == the headline gross), and the company amount lands in the
  // company group — never the personal headline. Guards the invariant the reader's Report.attribution
  // field exists to protect (review finding #1).
  const attrReport = { ...mkR([]), attribution: { individual_cents: 30_000, company_cents: 50_000, property_cents: 20_000 } } as Report;
  const attrReady = assessReadiness({ report: attrReport, situation: mkS(), claimMatches: [], signals: mkSig(), generatedAt: "2026-06-03T00:00:00Z", excludeNonDeductible: true });
  const attrDeductionLines = attrReady.position.lines.filter((l) => l.group === "deduction").reduce((s, l) => s + l.amount_cents, 0);
  check("attribution: individual+property (30k+20k) render as one deduction line", attrDeductionLines === 50_000);
  check("attribution: company (50k) renders in the company group, not the headline", attrReady.position.lines.some((l) => l.group === "company" && l.amount_cents === 50_000));
  check("attribution: no attribution field → no attributed lines (byte-identical)", !assessReadiness({ report: mkR([]), situation: mkS(), claimMatches: [], signals: mkSig(), generatedAt: "2026-06-03T00:00:00Z", excludeNonDeductible: true }).position.lines.some((l) => l.label.includes("Attributed")));

  // prepareAttributions (the writer): snapshot + validation + shareholder-loan flag.
  const isCo = (eid: string) => eid === "co_startup";
  const r1 = prepareAttributions(100_000, [{ entity_id: "ind_self", attributed_pct: 50 }], { isCompany: isCo });
  check("writer: co-owner 50% snapshots $500, no shareholder loan", !r1.error && r1.rows[0].attributed_amount_cents === 50_000 && r1.rows[0].creates_shareholder_loan === 0);
  const r2 = prepareAttributions(9_000, [{ entity_id: "co_startup", attributed_pct: 100 }], { isCompany: isCo });
  check("writer: a cost attributed to the company flags a shareholder loan (person_funds_company)", !r2.error && r2.rows[0].creates_shareholder_loan === 1 && r2.rows[0].attributed_amount_cents === 9_000);
  const r3 = prepareAttributions(100_000, [{ entity_id: "a", attributed_pct: 60 }, { entity_id: "b", attributed_pct: 60 }], { isCompany: isCo });
  check("writer: percentages over 100% are rejected", !!r3.error && r3.rows.length === 0);
  const r4 = prepareAttributions(10_000, [{ entity_id: "a", attributed_amount_cents: 20_000 }], { isCompany: isCo });
  check("writer: an explicit amount exceeding the transaction is rejected", !!r4.error);
  const r5 = prepareAttributions(10_000, [{ entity_id: "" }], { isCompany: isCo });
  check("writer: an attribution with no entity_id is rejected", !!r5.error);
  check("writer: empty items → no rows, no error (clears attributions)", prepareAttributions(10_000, [], { isCompany: isCo }).rows.length === 0);
  // review #1: a negative explicit amount is rejected (can't slip past a sign-naive sum guard).
  check("writer: a negative attributed amount is rejected", !!prepareAttributions(10_000, [{ entity_id: "a", attributed_amount_cents: -50_000 }], { isCompany: isCo }).error);
  check("writer: a negative-amount over-claim on a credit txn is rejected", !!prepareAttributions(-10_000, [{ entity_id: "a", attributed_amount_cents: -50_000 }], { isCompany: isCo }).error);
  // review #4: when both pct and an explicit amount are given, the amount wins and pct is cleared
  // (so a stray pct can't falsely trip the 100% guard).
  const r6 = prepareAttributions(100_000, [{ entity_id: "a", attributed_pct: 60, attributed_amount_cents: 30_000 }, { entity_id: "b", attributed_pct: 60, attributed_amount_cents: 30_000 }], { isCompany: isCo });
  check("writer: explicit amounts win over pct (no false >100% rejection)", !r6.error && r6.rows[0].attributed_amount_cents === 30_000 && r6.rows[0].attributed_pct === null);

  // ── #67 work-use computed deductions: pure calc + readiness lines reconcile to the headline ──
  const rates = { wfh_cents_per_hour: 70, car_cents_per_km: 88, car_km_cap: 5000 };
  const wfhOnly = computeWorkMethodDeductions({ wfh_hours: 600, car_work_km: null }, rates);
  check("WFH fixed rate: 600 hrs × 70c = $420", wfhOnly.wfh_cents === 42_000 && wfhOnly.car_cents === 0 && wfhOnly.total_cents === 42_000);
  const carCapped = computeWorkMethodDeductions({ wfh_hours: null, car_work_km: 8000 }, rates);
  check("car cents/km is capped at 5,000 km (5000 × 88c = $4,400, not 8000)", carCapped.car_cents === 440_000);
  const both = computeWorkMethodDeductions({ wfh_hours: 100, car_work_km: 1000 }, rates);
  check("both methods sum (100×70c + 1000×88c)", both.total_cents === 7_000 + 88_000);
  check("negative/empty inputs floor to 0", computeWorkMethodDeductions({ wfh_hours: -5, car_work_km: null }, rates).total_cents === 0);
  // D.1: derive WFH hours from days/week (≈ days × 7.6h × 48 weeks). "2 days/week" → ~730 hrs.
  check("WFH days/week: 2 days → ~730 hrs (2 × 7.6 × 48)", deriveWfhHours(2, null) === 730);
  check("WFH days/week: explicit weeks override (3 days × 44 weeks)", deriveWfhHours(3, 44) === Math.round(3 * 7.6 * 44));
  check("WFH days/week: no days → null (nothing to derive)", deriveWfhHours(null, 48) === null && deriveWfhHours(0, 48) === null);
  check("workUseRatesForFy falls back to defaults when a field is missing", workUseRatesForFy({}).car_cents_per_km === 88 && workUseRatesForFy(undefined).wfh_cents_per_hour === 70);

  // Part 1 — generateWfhDiary: deterministic per-day record over the real FY bounds (jurisdiction-aware,
  // leap-year safe). total_hours = total_days × 7.6; leave + weekday selection exclude days correctly.
  {
    // FY2025 (AU = 2025-07-01 .. 2026-06-30, non-leap) — every weekday ticked → 365 days walked.
    const allDays = generateWfhDiary({ fyStartYear: 2025, weekdays: [0, 1, 2, 3, 4, 5, 6], leaveRanges: [] });
    check("diary walks every day of a non-leap FY (365)", allDays.total_days === 365 && allDays.days.length === 365);
    check("total_hours = total_days × 7.6", allDays.total_hours === Math.round(365 * 7.6 * 10) / 10);
    // FY2023 spans the 29 Feb 2024 leap day → 366 days, and the diary contains that exact date (no off-by-one).
    const leap = generateWfhDiary({ fyStartYear: 2023, weekdays: [0, 1, 2, 3, 4, 5, 6], leaveRanges: [] });
    check("diary is leap-year safe (366 days, includes 2024-02-29)", leap.total_days === 366 && leap.days.some((d) => d.date === "2024-02-29"));
    // Weekdays-only (Mon–Fri) excludes weekends.
    const wkdays = generateWfhDiary({ fyStartYear: 2025, weekdays: [0, 1, 2, 3, 4], leaveRanges: [] });
    check("weekends excluded unless ticked", wkdays.total_days < 365 && wkdays.days.every((d) => d.weekday <= 4));
    // Leave range (all of July 2025, inclusive) drops exactly 31 days from the all-day diary.
    const withLeave = generateWfhDiary({ fyStartYear: 2025, weekdays: [0, 1, 2, 3, 4, 5, 6], leaveRanges: [{ start: "2025-07-01", end: "2025-07-31" }] });
    check("inclusive leave range excludes its days (−31)", withLeave.total_days === 334 && !withLeave.days.some((d) => d.date >= "2025-07-01" && d.date <= "2025-07-31"));
    check("no weekdays ticked → empty diary (0 days/hours)", generateWfhDiary({ fyStartYear: 2025, weekdays: [], leaveRanges: [] }).total_days === 0);
    check("hoursPerDay override flows through", generateWfhDiary({ fyStartYear: 2025, weekdays: [2], leaveRanges: [], hoursPerDay: 5 }).days.every((d) => d.hours === 5));
  }

  // Readiness renders the computed amounts as "deduction" lines (so lines-sum still == headline) and
  // says they REPLACE the itemised costs (no double-claim). Mock a report carrying work_method.
  const wmReport = { ...mkR([]), work_method: both } as unknown as Report;
  const wmReady = assessReadiness({ report: wmReport, situation: mkS(), claimMatches: [], signals: mkSig(), generatedAt: "2026-06-03T00:00:00Z", excludeNonDeductible: true });
  const wmLineSum = wmReady.position.lines.filter((l) => l.group === "deduction").reduce((s, l) => s + l.amount_cents, 0);
  check("work-method amounts render as deduction lines (sum == computed total)", wmLineSum === both.total_cents);
  check("work-method 'why' explains the no-double-claim exclusion", wmReady.position.lines.some((l) => /not also claimed|aren't claimed again|stay excluded|already covers/i.test(l.why)));
  check("work-method lines never trip the tax-advice denylist", !wmReady.position.lines.flatMap((l) => [l.why, l.basis]).some((t) => /refund|tax payable|marginal rate|\b\d{1,2}%\s*(tax|bracket)/i.test(t)));
  // Absent work_method (flag off / no inputs) → no work lines, legacy reconciliation intact.
  check("no work_method ⇒ no work-use deduction lines (legacy intact)", !assessReadiness({ report: mkR([]), situation: mkS(), claimMatches: [], signals: mkSig(), generatedAt: "2026-06-03T00:00:00Z", excludeNonDeductible: true }).position.lines.some((l) => /Working from home|Car \(cents/.test(l.label)));

  // ── #74 empty FY must read "start here", not "ready" ──
  const emptyReady = assessReadiness({ report: mkR([]), situation: mkS(), claimMatches: [], signals: mkSig(), generatedAt: "2026-06-03T00:00:00Z", excludeNonDeductible: true });
  check("empty FY ⇒ nothing_captured blocker, ready=false", emptyReady.findings.some((fd) => fd.id === "nothing_captured" && fd.severity === "blocker") && emptyReady.readiness_score.ready === false);
  check("nothing_captured copy is a start-here nudge, not tax advice", !/refund|tax payable|marginal rate/i.test(emptyReady.findings.find((fd) => fd.id === "nothing_captured")!.general_info_note));
  check("FY with data ⇒ no nothing_captured finding", !assessReadiness({ report: mkR(breakdown), situation: mkS(), claimMatches: [], signals: mkSig(), generatedAt: "2026-06-03T00:00:00Z", excludeNonDeductible: true }).findings.some((fd) => fd.id === "nothing_captured"));
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

console.log("buildAskSystem (Ask Quillo)");
{
  const system = buildAskSystem("Taxpayer: nurse", '{"work_method":{"wfh_deduction_cents":51100}}');
  // Hard guardrails: no advice, no refund/payable, no rates — the safety contract for free-text Q&A.
  check("ask system forbids advice", system.toLowerCase().includes("not a tax agent") || system.toLowerCase().includes("never tax advice") || system.toLowerCase().includes("general information only"));
  check("ask system forbids a refund/payable figure", system.toLowerCase().includes("never state tax payable") && system.toLowerCase().includes("refund"));
  check("ask system forbids tax rates", system.toLowerCase().includes("rates"));
  check("ask system embeds the position JSON + situation (context in system for multi-turn)", system.includes("wfh_deduction_cents") && system.includes("Taxpayer: nurse"));
  check("ask forces a single give_answer call", system.includes("give_answer"));
  check("ask system allows a debit-only suggested rule", system.includes("suggested_rule"));

  // summariseReportForAsk: headline figures present + RAW (not redact-mangled) so the answer can cite them.
  const fakeReport = {
    fy: "2024-25", taxable_position_cents: 4_280_50, total_income_cents: 95_000_00, total_deductions_cents: 3_280_50,
    resolved_deductible_cents: 0, depreciation_cents: 1_000_00, gst_credits_cents: 0, undated: { total_cents: 0 },
    deduction_breakdown: [{ bucket: "payg", ato_label: "D5", n: 3, total_cents: 3_280_50 }],
    income_by_bucket: [{ bucket: "income_personal", n: 12, total_cents: 95_000_00 }], per_property: [],
  } as unknown as Parameters<typeof summariseReportForAsk>[0];
  const summary = summariseReportForAsk(fakeReport);
  check("ask summary keeps the headline taxable position verbatim", summary.includes("428050"));
  check("ask summary keeps deduction figures verbatim (not redacted)", summary.includes("328050") && !summary.includes("REDACTED"));
  check("ask summary leads with the position fields", summary.indexOf("indicative_taxable_position_cents") < summary.indexOf("deductions_by_category"));
}

console.log("Ask Quillo C3 (ask_actions): digest + proposed-action validation");
{
  // Flag-off contract: the 2-arg prompt is BYTE-IDENTICAL to the pre-C3 prompt (no digest, no actions).
  const s2 = buildAskSystem("Taxpayer: nurse", "{}");
  check("no-digest call ≡ undefined-digest call (byte-identity)", s2 === buildAskSystem("Taxpayer: nurse", "{}", undefined));
  check("no-digest prompt carries no actions text", !s2.includes("PROPOSED ACTIONS") && !s2.includes("T-code"));

  const rows = [
    { id: "real-1", txn_date: "2025-09-01", merchant: "OFFICEWORKS", amount_aud_cents: 4599, bucket: "payg", ato_label: "D5", deductibility: "undetermined", property_id: null },
    { id: "real-2", txn_date: "2025-09-02", merchant: "card 4111111111111111 ref", amount_aud_cents: 31250, bucket: "property_rented", ato_label: null, deductibility: "needs_apportionment", property_id: "prop9" },
  ];
  const digest = renderTxnDigest(rows, 5);
  check("digest aliases are sequential T-codes", digest.text.startsWith("T1|") && digest.text.includes("\nT2|"));
  check("digest alias map round-trips to the real ids + gross", digest.aliasToId.get("T1")?.id === "real-1" && digest.aliasToId.get("T1")?.amount_cents === 4599 && digest.aliasToId.get("T2")?.id === "real-2");
  check("digest notes the truncated remainder", digest.text.includes("3 more transactions not shown"));
  check("digest redacts card-number digits in merchant strings", !digest.text.includes("4111111111111111"));
  check("digest carries the property scope on the bucket", digest.text.includes("property_rented:prop9"));
  check("empty digest renders a placeholder, not a malformed section", renderTxnDigest([], 0).text.includes("no transactions captured"));
  // Char-cap honesty: an alias is registered ONLY when its whole line fits — a model can never act on a
  // row it was not fully shown (the map and the text always agree).
  const many = Array.from({ length: 400 }, (_, i) => ({ id: `id-${i}`, txn_date: "2025-09-01", merchant: `Merchant ${i} with a fairly long descriptive trailing label for size`, amount_aud_cents: 1000 + i, bucket: "payg", ato_label: "D5", deductibility: "undetermined", property_id: null }));
  const capped = renderTxnDigest(many, 400);
  check("char cap drops whole rows and keeps map == text", capped.text.length <= 12100 && capped.aliasToId.size < 400 && capped.aliasToId.size > 0 && capped.text.includes(`(${400 - capped.aliasToId.size} more transactions not shown`));
  const lastAlias = `T${capped.aliasToId.size}`;
  check("last registered alias's line is fully present in the text", capped.text.includes(`${lastAlias}|2025-09-01`) && !capped.aliasToId.has(`T${capped.aliasToId.size + 1}`));

  const s3 = buildAskSystem("Taxpayer: nurse", "{}", digest.text);
  check("digest prompt includes the rows + actions guardrail", s3.includes("T1|") && s3.includes("PROPOSED ACTIONS"));
  check("digest prompt hard-gates confirmed_deductible", s3.includes("NEVER propose state confirmed_deductible"));
  check("digest prompt frames proposals as confirm-first", s3.toLowerCase().includes("must confirm"));

  // validateProposedActions: only executable-exactly-as-described proposals survive.
  const aliases = digest.aliasToId;
  const v = (raw: unknown) => validateProposedActions(raw, aliases);
  const base = { title: "Fix things", rationale: "Because you asked" };
  check("invalid kind dropped", v([{ ...base, kind: "delete_everything", txn_refs: ["T1"] }]).length === 0);
  check("unknown T-code refs dropped; action with none left dropped", v([{ ...base, kind: "set_deductibility", state: "confirmed_not", txn_refs: ["T99"] }]).length === 0);
  check("known refs resolve to REAL ids", (v([{ ...base, kind: "set_deductibility", state: "confirmed_not", txn_refs: ["T1", "T99", "T1"] }])[0] as { txn_ids: string[] }).txn_ids.join(",") === "real-1");
  // Cap applies to DISTINCT targets (dedupe first): 51 duplicate refs of one row are 1 target → keep.
  check("51 duplicate refs dedupe to 1 target and survive", v([{ ...base, kind: "set_deductibility", state: "confirmed_not", txn_refs: Array.from({ length: 51 }, () => "T1") }]).length === 1);
  check("more than 3 proposals capped to 3", v(Array.from({ length: 4 }, () => ({ ...base, kind: "add_rule", pattern: "Adobe", bucket: "payg" }))).length === 3);
  check("recategorise to a credit bucket dropped", v([{ ...base, kind: "recategorise", bucket: "income_personal", txn_refs: ["T1"] }]).length === 0);
  check("recategorise to 'unknown' dropped", v([{ ...base, kind: "recategorise", bucket: "unknown", txn_refs: ["T1"] }]).length === 0);
  check("non-proposable deductibility state dropped", v([{ ...base, kind: "set_deductibility", state: "suggested_deductible", txn_refs: ["T1"] }]).length === 0);
  check("apportioned amount stripped unless confirmed_deductible", (v([{ ...base, kind: "set_deductibility", state: "likely_not", txn_refs: ["T1"], deductible_amount_cents: 5000 }])[0] as { deductible_amount_cents?: number }).deductible_amount_cents === undefined);
  check("apportioned amount kept on a single confirmed claim within its gross", (v([{ ...base, kind: "set_deductibility", state: "confirmed_deductible", txn_refs: ["T1"], deductible_amount_cents: 3000 }])[0] as { deductible_amount_cents?: number }).deductible_amount_cents === 3000);
  // setDeductibility stamps the SAME amount on every txn — a multi-txn amount would multiply the claim.
  check("apportioned amount stripped on a MULTI-txn proposal", (v([{ ...base, kind: "set_deductibility", state: "confirmed_deductible", txn_refs: ["T1", "T2"], deductible_amount_cents: 3000 }])[0] as { deductible_amount_cents?: number }).deductible_amount_cents === undefined);
  check("apportioned amount above the txn's gross stripped (hallucinated figure)", (v([{ ...base, kind: "set_deductibility", state: "confirmed_deductible", txn_refs: ["T1"], deductible_amount_cents: 999999 }])[0] as { deductible_amount_cents?: number }).deductible_amount_cents === undefined);
  const trio = v([
    { ...base, kind: "set_deductibility", state: "confirmed_not", txn_refs: ["T1"] },
    { ...base, kind: "recategorise", bucket: "payg", ato_label: "D5", txn_refs: ["T2"] },
    { ...base, kind: "add_rule", pattern: "Adobe", bucket: "payg" },
  ]);
  check("a valid set_deductibility + recategorise + add_rule trio passes through", trio.length === 3 && trio.map((t) => t.kind).join(",") === "set_deductibility,recategorise,add_rule");
  check("missing title/rationale dropped", v([{ kind: "add_rule", pattern: "Adobe", bucket: "payg" }]).length === 0);
  // property_id routing (chat track): honoured ONLY for a property bucket AND an owned id.
  const owned = new Set(["prop9"]);
  const vp = (raw: unknown) => validateProposedActions(raw, aliases, owned);
  check("property_id kept on a property-bucket recategorise to an OWNED property", (vp([{ ...base, kind: "recategorise", bucket: "property_rented", txn_refs: ["T2"], property_id: "prop9" }])[0] as { property_id?: string }).property_id === "prop9");
  check("property_id kept on an add_rule to an OWNED property", (vp([{ ...base, kind: "add_rule", pattern: "Smith RE", bucket: "property_rented", property_id: "prop9" }])[0] as { property_id?: string }).property_id === "prop9");
  check("property_id dropped on a NON-property bucket (payg) even if owned", (vp([{ ...base, kind: "recategorise", bucket: "payg", txn_refs: ["T1"], property_id: "prop9" }])[0] as { property_id?: string }).property_id === undefined);
  check("property_id dropped when the id is NOT one the tenant owns", (vp([{ ...base, kind: "recategorise", bucket: "property_rented", txn_refs: ["T2"], property_id: "ghost" }])[0] as { property_id?: string }).property_id === undefined);
  check("property_id dropped when no owned-property set is supplied (single-turn ask)", (v([{ ...base, kind: "recategorise", bucket: "property_rented", txn_refs: ["T2"], property_id: "prop9" }])[0] as { property_id?: string }).property_id === undefined);
}

console.log("roles");
{
  const p = (roles: string) => ({ roles }) as { roles: string };
  check("no roles → default individual", JSON.stringify(parseRoles(null)) === '["individual"]');
  check("hasRole reads the array", hasRole(p('["admin","individual"]'), "admin"));
  check("isAdmin true for admin", isAdmin(p('["admin"]')));
  check("isAdmin false for individual-only", !isAdmin(p('["individual"]')));
  check("isPartner true for partner", isPartner(p('["partner"]')));
  check("isPartner false for admin (admin ≠ partner)", !isPartner(p('["admin"]')));
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

console.log("partner isolation (advisory phase 2 scaffold)");
{
  // The whole point of Slice 1: prove the SECOND isolation axis (partner_id) holds. A fake D1 that
  // honours the WHERE-binding lets us assert, deterministically and without real D1, that a partner
  // only ever reads its OWN rows — the leak this scaffold exists to prevent.
  const members = [
    { user_id: "staff-A", partner_id: "org-A" },
    { user_id: "staff-B", partner_id: "org-B" },
  ];
  const referrals = [
    { id: "r1", user_id: "consumer-1", partner_id: "org-A", status: "created", revenue_cents: 0, created_at: "2026-01-01" },
    { id: "r2", user_id: "consumer-2", partner_id: "org-A", status: "clicked", revenue_cents: 0, created_at: "2026-01-02" },
    { id: "r3", user_id: "consumer-3", partner_id: "org-B", status: "paid", revenue_cents: 5000, created_at: "2026-01-03" },
  ];
  const fakeDb: PartnerDB = {
    prepare(sql: string) {
      return {
        bind(...vals: unknown[]) {
          const arg = vals[0];
          return {
            async first<T>() {
              if (/FROM partner_members/.test(sql)) {
                const m = members.find((x) => x.user_id === arg);
                return (m ? { partner_id: m.partner_id } : null) as T | null;
              }
              return null as T | null;
            },
            async all<T>() {
              if (/FROM referrals/.test(sql)) {
                return { results: referrals.filter((x) => x.partner_id === arg) as unknown as T[] };
              }
              return { results: [] as T[] };
            },
          };
        },
      };
    },
  };

  // resolvePartnerId maps a staff tenant → its one org; a non-staff tenant → null (no access).
  const pidA = await resolvePartnerId(fakeDb, "staff-A");
  const pidNone = await resolvePartnerId(fakeDb, "stranger");
  check("resolvePartnerId maps staff → their org", pidA === "org-A");
  check("resolvePartnerId → null for a non-partner tenant", pidNone === null);

  // The isolation invariant: org A sees ONLY org A's referrals, never org B's.
  const aRows = await listPartnerReferrals(fakeDb, "org-A");
  const bRows = await listPartnerReferrals(fakeDb, "org-B");
  check("partner A reads exactly its own referrals", JSON.stringify(aRows.map((r) => r.id)) === '["r1","r2"]');
  check("partner A cannot see partner B's referral", !aRows.some((r) => r.id === "r3"));
  check("partner B reads exactly its own referral", JSON.stringify(bRows.map((r) => r.id)) === '["r3"]');

  // Source guard: the only partner_id bound into a referrals read is one resolved from partner_members
  // — never a value off the request. (Mirrors the regex-on-source guards used elsewhere in this file.)
  const partnersSrc = fs.readFileSync(path.join(process.cwd(), "src", "lib", "partners.ts"), "utf8");
  check("referrals read is scoped by partner_id", /FROM referrals WHERE partner_id = \?/.test(partnersSrc));

  // Partner portal: leads must be scoped by partner_id AND must NOT expose the consumer's user_id /
  // opportunity_id (Tier-1 keeps PII in Quillo — the partner never learns who the lead is).
  const leadsSelect = partnersSrc.match(/SELECT referral_token, status, revenue_cents, created_at, updated_at FROM referrals WHERE partner_id = \?/);
  check("portal leads query is scoped by partner_id", leadsSelect != null);
  check("portal leads query omits user_id", leadsSelect != null && !/user_id/.test(leadsSelect![0]));
  check("portal leads query omits opportunity_id", leadsSelect != null && !/opportunity_id/.test(leadsSelect![0]));
  check("portal resolves partner_id from the caller's own tenant", /resolvePartnerId\(db, staffUserId\)/.test(partnersSrc));
}

console.log("referral lifecycle (advisory phase 2 slice 2)");
{
  // Forward-only transitions; terminals are sinks; no backwards moves.
  check("clicked → converted allowed", canAdvanceReferral("clicked", "converted"));
  check("converted → paid allowed", canAdvanceReferral("converted", "paid"));
  check("paid → converted rejected (no rewind)", !canAdvanceReferral("paid", "converted"));
  check("clicked → paid rejected (must pass converted)", !canAdvanceReferral("clicked", "paid"));
  check("dismissed → anything rejected (terminal)", !canAdvanceReferral("dismissed", "clicked"));

  // Token is appended as a query param, surviving an existing query string.
  check("buildReferralUrl appends ?ref on a bare url", buildReferralUrl("https://x.test/go", "tok1") === "https://x.test/go?ref=tok1");
  check("buildReferralUrl appends &ref when a query exists", buildReferralUrl("https://x.test/go?a=1", "tok2") === "https://x.test/go?a=1&ref=tok2");

  // Only energy/gas/essential-switch opportunities take the CTA.
  check("energy opportunity takes CTA", opportunityTakesEnergyCta({ category: "energy" }));
  check("essential_switch takes CTA", opportunityTakesEnergyCta({ opportunity_type: "essential_switch" }));
  check("run_rate/insurance does NOT take CTA", !opportunityTakesEnergyCta({ opportunity_type: "run_rate", category: "insurance" }));

  // matchEnergyOffer picks an active energy offer + builds a factual disclosure naming the relationship.
  const offerDb: PartnerDB = {
    prepare(_sql: string) {
      return {
        bind(..._v: unknown[]) {
          return {
            async first<T>() {
              return {
                offer_id: "of1", target_url: "https://econnex.test/compare", offer_title: null,
                partner_id: "pa1", partner_name: "Econnex", disclosure_text: null,
              } as unknown as T;
            },
            async all<T>() { return { results: [] as T[] }; },
          };
        },
      };
    },
  };
  const m = await matchEnergyOffer(offerDb);
  check("matchEnergyOffer returns the active offer", m?.partner_name === "Econnex" && m?.target_url === "https://econnex.test/compare");
  const cta = ctaFromOffer(m!);
  check("CTA label defaults to 'Get a quote from <partner>'", cta.cta_label === "Get a quote from Econnex");
  check("CTA disclosure names the fee + 'not advice'", /Econnex/.test(cta.disclosure) && /fee/.test(cta.disclosure) && /not advice/.test(cta.disclosure));

  // getOfferById pins to a specific offer (active by default; anyStatus for a stable re-click rebuild).
  const byIdDb = (active: number, status: string): PartnerDB => ({
    prepare(sql: string) {
      return {
        bind(...v: unknown[]) {
          return {
            async first<T>() {
              const wantsLive = /o\.active = 1/.test(sql);
              if (wantsLive && (active !== 1 || status !== "active")) return null as T | null;
              return { offer_id: v[0], target_url: "https://econnex.test/c", offer_title: "Quote", partner_id: "pa1", partner_name: "Econnex", disclosure_text: null } as unknown as T;
            },
            async all<T>() { return { results: [] as T[] }; },
          };
        },
      };
    },
  });
  check("getOfferById returns a live offer", (await getOfferById(byIdDb(1, "active"), "of1"))?.offer_id === "of1");
  check("getOfferById (default) skips a deactivated offer", (await getOfferById(byIdDb(0, "active"), "of1")) === null);
  check("getOfferById anyStatus rebuilds a deactivated offer", (await getOfferById(byIdDb(0, "active"), "of1", { anyStatus: true }))?.offer_id === "of1");

  // Revenue sanitiser: rejects NaN/Infinity/negative, rounds, caps at $1M.
  check("sanitizeRevenueCents passes a normal figure", sanitizeRevenueCents(5000) === 5000);
  check("sanitizeRevenueCents rounds", sanitizeRevenueCents(49.6) === 50);
  check("sanitizeRevenueCents → 0 for negative", sanitizeRevenueCents(-100) === 0);
  check("sanitizeRevenueCents → 0 for Infinity", sanitizeRevenueCents(Infinity) === 0);
  check("sanitizeRevenueCents → 0 for NaN/garbage", sanitizeRevenueCents("abc") === 0);
  check("sanitizeRevenueCents caps at $1,000,000", sanitizeRevenueCents(99999999999) === 100_000_000);
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
  // #80: PRICING must cover every model getLLM can emit, or spend is silently mis-costed and the
  // budget gate under-reads. This golden fails CI if a model is swapped in llm.ts without pricing it.
  check("every getLLM model id has a PRICING entry", LLM_MODEL_IDS.every((m) => isPricedModel(m)));
  check("a real (priced) model is recognised", isPricedModel(H));
  check("an unpriced model id is flagged, not silently accepted", isPricedModel("claude-opus-not-priced") === false);
  // costCents still returns the Haiku floor for an unknown id so spend is never LOST (the recording
  // path logs loudly) — but isPricedModel above is the guard that keeps that path from ever shipping.
  check("unknown model is cost-estimated at the Haiku floor (spend never lost)", costCents("unknown-model", { input_tokens: 1_000_000 }) === 100);
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

console.log("money integer scale (0051: cost_e4 / cents_e4)");
{
  const H = "claude-haiku-4-5-20251001";
  // The spend columns are stored as integer 1e-4-cent units so SUM() is exact. The ×10000 scale is
  // lossless vs costCents' 4-dp quantisation, and every read divides back to cents ONCE.
  check("toE4 round-trips a sub-cent value (0.25c → 2500 → 0.25c)", toE4(0.25) === 2500 && centsFromE4(2500) === 0.25);
  check("toE4 keeps a tiny call (0.03c → 300)", toE4(0.03) === 300);
  check("toE4 is always an exact integer (no float tail)", Number.isInteger(toE4(costCents(H, { input_tokens: 333, output_tokens: 77 }))));
  // Integer accumulation is EXACT — 1000 × 0.25c summed as units then divided once = 250c, no drift.
  const unit = toE4(costCents(H, { input_tokens: 1500, output_tokens: 200 }));
  let units = 0;
  for (let i = 0; i < 1000; i++) units += unit; // integer addition, never floats
  check("1000 × 0.25c accumulates to exactly 250c via integer units", Number.isInteger(units) && centsFromE4(units) === 250);
  // Guard against a regression to the legacy REAL columns: the budget gate must read cents_e4 and the
  // billing/admin rollups must SUM cost_e4 (not the float cost_cents).
  const usageSrc = fs.readFileSync(new URL("../src/lib/usage.ts", import.meta.url), "utf8");
  const queriesSrc = fs.readFileSync(new URL("../src/lib/queries.ts", import.meta.url), "utf8");
  check("budget gate reads the integer tally (cents_e4)", /SELECT cents_e4 FROM daily_cost/.test(usageSrc));
  check("daily_cost upsert increments cents_e4", /cents_e4 = cents_e4 \+ excluded\.cents_e4/.test(usageSrc));
  check("spend rollups SUM the integer column (cost_e4), not the float", /SUM\(cost_e4\)/.test(queriesSrc) && !/SUM\(cost_cents\)/.test(queriesSrc));
  // A user confirm/correct stamps status='corrected'. The confidence clause must be guarded with
  // `status != 'corrected'` so a low-confidence CONFIRMED row leaves the queue (the confirm-does-nothing
  // bug), WITHOUT excluding 'corrected' wholesale — an unknown-bucket row corrected on a non-bucket field
  // (e.g. a date fix) must stay in review (it's still uncategorised), so the unknown clause has no guard.
  const needsReviewClause = (queriesSrc.match(/NEEDS_REVIEW\s*=\s*([\s\S]*?);/) ?? [])[1] ?? "";
  check("NEEDS_REVIEW guards the confidence clause against confirmed rows", /confidence < 0\.85 AND status != 'corrected'/.test(needsReviewClause));
  check("NEEDS_REVIEW does NOT exclude 'corrected' wholesale (unknown-bucket rows stay in review)", !/NOT IN \([^)]*'corrected'[^)]*\)/.test(needsReviewClause) && /bucket = 'unknown'/.test(needsReviewClause));
}

console.log("fy representation seam (canonical helpers + guardrail)");
{
  // `fy` is stored three internally-consistent ways; these helpers are the only sanctioned producers/
  // parsers. Lock their behaviour + guard that the fragile open-coded casts don't creep back.
  check("fyLabel(2025) → '2025-26'", fyLabel(2025) === "2025-26");
  check("fyStartYearStr(2025) → '2025'", fyStartYearStr(2025) === "2025");
  check("parseFyStartYear reads every stored form back to the start year",
    parseFyStartYear("2025-26") === 2025 && parseFyStartYear("2025") === 2025 && parseFyStartYear(2025) === 2025);
  check("parseFyStartYear(blank) → NaN", Number.isNaN(parseFyStartYear("")) && Number.isNaN(parseFyStartYear(null)));
  check("normaliseFyLabel coerces any caller input to the label",
    normaliseFyLabel("2025") === "2025-26" && normaliseFyLabel(2025) === "2025-26" && normaliseFyLabel("2025-26") === "2025-26");
  check("normaliseFyLabel(blank) → null", normaliseFyLabel(null) === null && normaliseFyLabel("") === null);
  check("label round-trips: label → start year → label", fyLabel(parseFyStartYear("2025-26")) === "2025-26");
  // Guardrail: the fragile casts the seam replaced must not reappear.
  const agentSrc = fs.readFileSync(new URL("../src/agent.ts", import.meta.url), "utf8");
  const reportSrc = fs.readFileSync(new URL("../src/lib/report.ts", import.meta.url), "utf8");
  check("clarify fy reads go through parseFyStartYear, not Number(q.fy)", !/Number\(q\.fy\)/.test(agentSrc));
  check("checklist generate normalises its fy input", /normaliseFyLabel\(fy\)/.test(agentSrc));
  check("loan-interest reads bind fyStartYearStr, not open-coded String(startYear)", !/String\(startYear\)/.test(reportSrc));
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
  check("needs_review>0 → review (/inbox), count 6", nextAction(work).kind === "review" && nextAction(work).count === 6 && nextAction(work).href === "/inbox");
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

// ── Accountant schedule (#179/#181): CSV escaping, substantiation, exclusion reasons ──
console.log("csvCell (RFC-4180 + formula-injection guard)");
{
  check("plain string passes through", csvCell("rent") === "rent");
  check("number passes through", csvCell(150) === "150");
  check("null → empty", csvCell(null) === "");
  check("comma is quoted", csvCell("Bunnings, Alexandria") === '"Bunnings, Alexandria"');
  check("internal quotes doubled", csvCell('say "hi"') === '"say ""hi"""');
  check("newline is quoted", csvCell("a\nb") === '"a\nb"');
  check("leading = is neutralised (formula injection)", csvCell("=SUM(A1:A9)") === "'=SUM(A1:A9)");
  check("leading + - @ neutralised too", csvCell("+1") === "'+1" && csvCell("-x") === "'-x" && csvCell("@cmd") === "'@cmd");
  check("neutralised AND quoted when both apply", csvCell("=HYPERLINK(\"x\"),y") === "\"'=HYPERLINK(\"\"x\"\"),y\"");
}

console.log("substantiationStatus (what backs a claim)");
{
  check("receipt row with its key → receipt", substantiationStatus({ kind: "receipt", receipt_key: "r2/x.jpg" }) === "receipt");
  check("document linked → document", substantiationStatus({ kind: "bank_line", document_id: "doc1" }) === "document");
  check("bank line with a matched receipt → receipt_linked", substantiationStatus({ kind: "bank_line", linked_receipts: 1 }) === "receipt_linked");
  check("bare bank line → bank_line_only", substantiationStatus({ kind: "bank_line" }) === "bank_line_only");
}

console.log("impliedWorkUsePct (apportioned confirmed rows only)");
{
  check("confirmed + apportioned → derived %", impliedWorkUsePct({ deductibility: "confirmed_deductible", deductible_amount_cents: 6000, gross_cents: 20000 }) === 30);
  check("unconfirmed row → null (no implied %)", impliedWorkUsePct({ deductibility: "likely_deductible", deductible_amount_cents: 6000, gross_cents: 20000 }) === null);
  check("confirmed without an apportioned amount → null", impliedWorkUsePct({ deductibility: "confirmed_deductible", deductible_amount_cents: null, gross_cents: 20000 }) === null);
}

console.log("exclusionReason (NOT-CLAIMED reason precedence)");
{
  check("reimbursed wins over everything", exclusionReason("payg", "likely_not", 1, 0).includes("Employer-reimbursed"));
  check("rent-free property wins next", exclusionReason("property_rented", "undetermined", 0, 1).includes("rent-free"));
  check("capital → decline-in-value reason", exclusionReason("asset", null, 0, 0).includes("decline in value"));
  check("private → s8-1(2)(b) reason", exclusionReason("payg", "likely_not", 0, 0).includes("not deductible"));
  check("unresolved payg → deny-by-default reason", exclusionReason("payg", "undetermined", 0, 0).includes("excluded by default"));
}

// ── Legacy reportToCsv byte-pin: the flag-OFF CSV can never drift (#179 byte-identity guard) ──
console.log("reportToCsv (flag-off byte-identity pin)");
{
  const fixture: Report = {
    fy: "2025-26", start: "2025-07-01", end: "2026-06-30",
    by_bucket: [{ bucket: "payg", ato_label: "D5", n: 2, total_cents: 30000, gst_cents: 0 }],
    deduction_breakdown: [{ bucket: "payg", ato_label: "D5", n: 2, total_cents: 30000, gst_cents: 0, deductibility: "likely_deductible" }],
    income_by_bucket: [], by_property: [],
    company_quarters: [{ quarter: "Q1 Jul–Sep", total_cents: 0, gst_cents: 0 }],
    undated: { n: 0, total_cents: 0 }, undated_detail: [], abn: null, gst_credits_cents: 0,
    income: { by_type: [{ income_type: "salary_payg", n: 1, gross_cents: 8000000, net_cents: 8000000, withholding_cents: 0, franking_credit_cents: 0, foreign_tax_paid_cents: 0 }], gross_cents: 8000000, withholding_cents: 0, franking_credit_cents: 0, foreign_tax_paid_cents: 0 },
    depreciation_cents: 0, per_property: [], total_income_cents: 8000000, total_deductions_cents: 30000,
    company_tracked_cents: 0, refunds_cents: 0, resolved_deductible_cents: 0, taxable_position_cents: 7970000,
  };
  const pinned =
    "Quillo tax summary,FY 2025-26,2025-07-01 to 2026-06-30\n" +
    "ABN,(not set)\n" +
    "GST credits (ITC) on company expenses,0.00\n" +
    "General information only — not tax advice. Confirm with a registered tax/BAS agent.\n" +
    "\n" +
    "Tax position (indicative),Amount (AUD)\n" +
    "Total income (gross),80000.00\n" +
    "Total deductions,300.00\n" +
    "Decline in value (depreciation),0.00\n" +
    "Indicative taxable position (individual),79700.00\n" +
    "\n" +
    "Income type,Count,Gross (AUD),Withholding,Franking credit,Foreign tax paid\n" +
    "salary_payg,1,80000.00,0.00,0.00,0.00\n" +
    "\n" +
    "Bucket,ATO label,Count,Total (AUD),GST\n" +
    "payg,D5,2,300.00,0.00\n" +
    "\n" +
    "Property,Rent income (AUD),Deductions,Depreciation,Net (negative gearing)\n" +
    "\n" +
    "Company BAS quarter,Total (AUD),GST\n" +
    "Q1 Jul–Sep,0.00,0.00\n";
  check("legacy CSV output is byte-identical to the pin", reportToCsv(fixture) === pinned);
}

console.log("scheduleToCsv (section layout + escaping + tie-back note)");
{
  const sched: AccountantSchedule = {
    fy: "2025-26", start: "2025-07-01", end: "2026-06-30", abn: null,
    disclaimer: "General information only.",
    sections: [
      { key: "work_related", title: "Work-related", columns: ["Date", "Merchant", "Amount"], rows: [["2025-09-01", "Bunnings, Alexandria", "150.00"], ["2025-09-02", "=SUM(A1)", "80.00"]], subtotal_cents: 23000 },
      { key: "x", title: "Ties badly", columns: ["A"], rows: [["1"]], tie_back: { label: "demo", report_cents: 100, actual_cents: 90, ok: false }, notes: ["a note"] },
    ],
  };
  const csv = scheduleToCsv(sched);
  check("title + header + rows + subtotal render in order", csv.includes("WORK-RELATED\nDate,Merchant,Amount\n") && csv.includes("\nSubtotal,230.00\n"));
  check("merchant with a comma is quoted", csv.includes('"Bunnings, Alexandria"'));
  check("formula merchant is neutralised", csv.includes("'=SUM(A1)"));
  check("a failed tie-back renders a visible NOTE", csv.includes("does not tie to the report demo"));
  check("section notes render", csv.includes("Note: a note"));
}

// ── Advisory engine: biller normalisation (channel-strip, no entity merge) ────
console.log("advisory.billerNormalize");
{
  // Same biller phrased via different channels collapses to ONE key (order preserved, not sorted).
  check("BPAY + OSKO Origin Energy → same key", billerNormalize("BPAY Origin Energy 12345") === "origin energy" && billerNormalize("OSKO ORIGIN ENERGY") === "origin energy");
  check("key preserves word ORDER (not clarify's sorted stem)", billerNormalize("Origin Energy") === "origin energy");
  // Distinct legal entities are NEVER merged (merging would corrupt per-biller apportionment).
  check("Ergon stays separate from Origin", billerNormalize("BPAY Ergon Energy") !== billerNormalize("BPAY Origin Energy"));
  check("single-word subscriptions survive", billerNormalize("NETFLIX.COM") === "netflix" && billerNormalize("SPOTIFY P0A1B2") === "spotify");
  check("pure channel/number noise → null", billerNormalize("OSKO Deposit 123456") === null && billerNormalize("") === null && billerNormalize(null) === null);
}

console.log("advisory.classifyBiller");
{
  check("origin energy → energy + essential", classifyBiller("origin energy").category === "energy" && classifyBiller("origin energy").essential);
  check("netflix → streaming + NOT essential", classifyBiller("netflix").category === "streaming" && !classifyBiller("netflix").essential);
  check("bupa → health + essential", classifyBiller("bupa").category === "health" && classifyBiller("bupa").essential);
  check("unknown merchant → other + not essential", classifyBiller("bob's bait shop").category === "other" && !classifyBiller("bob's bait shop").essential);
}

console.log("advisory.annualiseSpendCents");
{
  // Exactly half the FY elapsed → spend doubles. (2025-07-01 .. 2025-12-31 ≈ 184/365 days.)
  const half = annualiseSpendCents(100000, "2025-07-01", "2026-06-30", "2025-12-31");
  check("~half-year $1,000 annualises to ~$1,980–$2,000", half >= 198000 && half <= 200000);
  check("never extrapolates BELOW actual spent", annualiseSpendCents(50000, "2025-07-01", "2026-06-30", "2025-07-02") >= 50000);
  check("full FY elapsed → returns the actual figure (no inflation)", annualiseSpendCents(73000, "2025-07-01", "2026-06-30", "2026-06-30") === 73000);
  check("daysBetween counts whole days", daysBetween("2025-07-01", "2025-07-31") === 30 && daysBetween("2025-07-01", "2025-07-01") === 0);
  check("malformed date → 0 (no NaN leak)", daysBetween("nope", "2025-07-01") === 0);
}

console.log("advisory.detectRecurrence");
{
  const mk = (date: string, c: number) => ({ date, amount_cents: c });
  // Fixed monthly streaming sub → confirmed subscription, ~12/yr.
  const netflix = detectRecurrence([mk("2025-07-03", 1899), mk("2025-08-03", 1899), mk("2025-09-03", 1899), mk("2025-10-03", 1899)])!;
  check("monthly fixed → confirmed monthly subscription", netflix.cadence === "monthly" && netflix.status === "confirmed" && netflix.is_subscription);
  check("subscription typical amount + zero-ish variance", netflix.typical_amount_cents === 1899 && netflix.amount_variance_cents === 0);
  check("next_expected rolls forward one cadence", netflix.next_expected === "2025-11-02");
  // Variable quarterly energy bill → confirmed bill (NOT a subscription — usage varies).
  const energy = detectRecurrence([mk("2025-07-15", 42000), mk("2025-10-14", 51000), mk("2026-01-13", 38000), mk("2026-04-14", 47000)])!;
  check("quarterly variable → confirmed quarterly BILL (not subscription)", energy.cadence === "quarterly" && energy.status === "confirmed" && !energy.is_subscription);
  // Two occurrences only → early detection (Plaid pattern).
  const early = detectRecurrence([mk("2025-07-01", 1500), mk("2025-08-01", 1500)])!;
  check("2 occurrences → early (not confirmed)", early.occurrences === 2 && early.status === "early");
  // A single occurrence / same-day dupes → not a recurrence.
  check("1 occurrence → null", detectRecurrence([mk("2025-07-01", 1500)]) === null);
  check("same-day duplicates → null (gap 0)", detectRecurrence([mk("2025-07-01", 100), mk("2025-07-01", 100)]) === null);
  // Cadence classifier bands.
  check("7d→weekly, 14d→fortnightly, 30d→monthly, 91d→quarterly, 365d→annual",
    classifyCadence(7) === "weekly" && classifyCadence(14) === "fortnightly" && classifyCadence(30) === "monthly" && classifyCadence(91) === "quarterly" && classifyCadence(365) === "annual");
  check("an off-band gap → irregular", classifyCadence(50) === "irregular");
  check("paymentsPerYear maps cadence", paymentsPerYear("monthly") === 12 && paymentsPerYear("weekly") === 52 && paymentsPerYear("irregular") === 0);
}

console.log("advisory.copy is FACTUAL (no advice/projection/comparison tokens)");
{
  // The compliance contract: every user-facing advisory string must pass assertFactual.
  check("the disclaimer is factual", assertFactual(ADVISORY_DISCLAIMER));
  const rr = runRateCopy(92000, 184000, 41);
  check("run-rate copy renders the figures and is factual", rr.includes("$920") && rr.includes("$1,840") && assertFactual(rr));
  const sub = recurringCopy("Netflix", detectRecurrence([{ date: "2025-07-03", amount_cents: 1899 }, { date: "2025-08-03", amount_cents: 1899 }, { date: "2025-09-03", amount_cents: 1899 }])!);
  check("recurring copy renders cadence + annual + is factual", /per month/.test(sub) && /a year/.test(sub) && assertFactual(sub));
  // The guardrail itself must REJECT advice-shaped copy (so the test has teeth).
  check("guardrail catches a recommendation", !assertFactual("You should switch to the cheapest plan and save up to $200"));
  check("guardrail catches an investment steer", !assertFactual("Invest your surplus for a projected return"));
  // Energy is signposted to the government comparator (whole-of-market, no commission); streaming isn't.
  check("energy → Energy Made Easy signpost; streaming → none", signpostFor("energy")!.url.includes("energymadeeasy") && signpostFor("streaming") === null);
}

console.log("advisory.savingsProjection (factual SAVING calculator — no product, no projection token)");
{
  // r=0 → just the contributions, no interest.
  const flat = savingsProjection(92000, 5, 0);
  check("0% → contributed only, zero interest", flat.contributed_cents === 460000 && flat.total_cents === 460000 && flat.interest_cents === 0);
  // $920/yr for 5 years at 5% end-of-year annuity = 920 * ((1.05^5 - 1)/0.05) = $5,083.58.
  const grow = savingsProjection(92000, 5, 5);
  check("$920/yr × 5y @5% ≈ $5,083.58", grow.total_cents === 508358 && grow.contributed_cents === 460000 && grow.interest_cents === 48358);
  check("0 years → all zero (no divide/NaN)", savingsProjection(92000, 0, 5).total_cents === 0);
  check("interest never negative", savingsProjection(50000, 3, 0).interest_cents === 0);
  // The copy is factual + carries the figures, and the guardrail would catch advice-shaped variants.
  const copy = savingsProjectionCopy(92000, 5, 5, grow);
  check("calculator copy renders figures and is factual", copy.includes("$920") && copy.includes("$5,084") && copy.includes("$4,600") && assertFactual(copy));
}

console.log("jurisdiction — the tax-period seam (AU byte-identical; UK = 6 Apr – 5 Apr)");
{
  // resolveJurisdiction: case-insensitive, unknown/blank ⇒ AU.
  check("resolveJurisdiction('AU')→AU, ('uk')→UK, (undefined)→AU, ('ZZ')→AU",
    resolveJurisdiction("AU").code === "AU" && resolveJurisdiction("uk").code === "UK" &&
    resolveJurisdiction(undefined).code === "AU" && resolveJurisdiction("ZZ").code === "AU");

  // fyBoundsFor AU must reproduce the legacy hardcoded bounds EXACTLY (byte-identical guarantee).
  const au = fyBoundsFor(AU_DESCRIPTOR, 2025);
  check("AU bounds(2025) = 2025-07-01 .. 2026-06-30 (byte-identical to legacy)", au.start === "2025-07-01" && au.end === "2026-06-30");
  check("ledger-totals.fyBounds default == AU descriptor (no caller change drifts AU)",
    JSON.stringify(fyBounds(2025)) === JSON.stringify(au));

  // UK = 6 Apr → 5 Apr next year (the day-before-next-start), incl. across a leap year.
  const uk = fyBoundsFor(UK_DESCRIPTOR, 2025);
  check("UK bounds(2025) = 2025-04-06 .. 2026-04-05", uk.start === "2025-04-06" && uk.end === "2026-04-05");
  check("UK bounds(2023) end = 2024-04-05 (leap-year Feb 29 inside the FY, no off-by-one)", fyBoundsFor(UK_DESCRIPTOR, 2023).end === "2024-04-05");

  // fyStartYearForDate — the boundary-day test a naive month-only gate gets wrong.
  check("AU date gate: 30 Jun → prior FY (2024), 1 Jul → new FY (2025)",
    fyStartYearForDate(AU_DESCRIPTOR, "2025-06-30") === 2024 && fyStartYearForDate(AU_DESCRIPTOR, "2025-07-01") === 2025);
  check("UK date gate: 5 Apr → prior FY (2024), 6 Apr → new FY (2025) [boundary day]",
    fyStartYearForDate(UK_DESCRIPTOR, "2025-04-05") === 2024 && fyStartYearForDate(UK_DESCRIPTOR, "2025-04-06") === 2025);
  check("UK date gate: 1 May 2025 → UK FY2025, but the SAME date is AU FY2024 (the discriminator)",
    fyStartYearForDate(UK_DESCRIPTOR, "2025-05-01") === 2025 && fyStartYearForDate(AU_DESCRIPTOR, "2025-05-01") === 2024);
  check("date gate: missing/garbage ⇒ NaN", Number.isNaN(fyStartYearForDate(AU_DESCRIPTOR, null)) && Number.isNaN(fyStartYearForDate(UK_DESCRIPTOR, "nope")));

  // The SQL FY-start expression: AU reproduces the legacy month-only gate byte-for-byte; UK is day-aware.
  const auSql = fyStartYearSqlExpr(AU_DESCRIPTOR, "created_at");
  check("AU SQL gate reproduces the legacy month-only expression",
    auSql === "CAST(substr(created_at,1,4) AS INTEGER) - (CASE WHEN CAST(substr(created_at,6,2) AS INTEGER) >= 7 THEN 0 ELSE 1 END)");
  check("UK SQL gate is day-aware on the boundary month (incl. day >= 6)",
    fyStartYearSqlExpr(UK_DESCRIPTOR, "created_at").includes("CAST(substr(created_at,9,2) AS INTEGER) >= 6"));
}

// ── UK epic stop 2: currency de-anchoring — toBaseCurrency + baseCurrencyOf + the currency symbol map.
//    No network: passthrough never fetches; the USD→GBP conversion is served from a SEEDED KV cache hit.
console.log("currency de-anchoring (toBaseCurrency / baseCurrencyOf / currencySymbol)");
{
  // A fake RULES KV: get reads a seeded Map, put writes to it. fetch is never reached in these tests.
  const store = new Map<string, string>();
  const fakeEnv = {
    FEATURES: "currency_base",
    RULES: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v); },
    },
  } as unknown as import("../src/env").Env;

  // baseCurrencyOf chokepoint: flag ON ⇒ descriptor base; flag OFF ⇒ always 'AUD' (the byte-identical gate).
  check("baseCurrencyOf: flag ON ⇒ AU 'AUD', UK 'GBP'",
    baseCurrencyOf(fakeEnv, AU_DESCRIPTOR) === "AUD" && baseCurrencyOf(fakeEnv, UK_DESCRIPTOR) === "GBP");
  const offEnv = { FEATURES: "" } as unknown as import("../src/env").Env;
  check("baseCurrencyOf: flag OFF ⇒ 'AUD' even for a UK descriptor (byte-identical gate)",
    baseCurrencyOf(offEnv, UK_DESCRIPTOR) === "AUD" && baseCurrencyOf(offEnv, AU_DESCRIPTOR) === "AUD");

  // AUD-base passthrough is byte-identical to the legacy toAud: rate 1, no fetch, no cache write.
  const audPass = await toBaseCurrency(fakeEnv, 12345, "AUD", "AUD", "2025-09-01");
  check("AUD→AUD passthrough: rate 1, amount unchanged, no cache write",
    audPass.amount_aud_cents === 12345 && audPass.fx_rate === 1 && audPass.fx_date === null && store.size === 0);
  // A lowercase/whitespace currency normalises to the base ⇒ still passthrough.
  const audNorm = await toBaseCurrency(fakeEnv, 500, " aud ", "AUD", null);
  check("AUD passthrough normalises currency case/whitespace ⇒ rate 1", audNorm.amount_aud_cents === 500 && audNorm.fx_rate === 1);
  // null amount ⇒ null result (no fetch, no throw).
  const audNull = await toBaseCurrency(fakeEnv, null, "USD", "AUD", "2025-09-01");
  check("null amount ⇒ null base cents (no conversion attempted)", audNull.amount_aud_cents === null && audNull.fx_rate === null);

  // GBP-base passthrough (UK tenant, a GBP amount): rate 1, no fetch.
  const gbpPass = await toBaseCurrency(fakeEnv, 9900, "GBP", "GBP", "2025-09-01");
  check("GBP→GBP passthrough: rate 1, amount unchanged, no fetch", gbpPass.amount_aud_cents === 9900 && gbpPass.fx_rate === 1 && store.size === 0);

  // USD→GBP via a SEEDED KV cache hit — the cache key MUST be base-aware (fx:USD:GBP:day), and the URL
  // would be ?from=USD&to=GBP (asserted indirectly: a hit on the GBP-keyed entry means no network).
  store.set("fx:USD:GBP:2025-09-01", JSON.stringify({ rate: 0.75, date: "2025-09-01" }));
  const usdGbp = await toBaseCurrency(fakeEnv, 10000, "USD", "GBP", "2025-09-01");
  check("USD→GBP via KV-cached rate: $100 × 0.75 = £75 (base cents), no network",
    usdGbp.amount_aud_cents === 7500 && usdGbp.fx_rate === 0.75 && usdGbp.fx_date === "2025-09-01");
  // The same currency under a DIFFERENT base uses a DIFFERENT cache key (proves the key carries the base).
  check("cache key is base-scoped: fx:USD:GBP:… exists, fx:USD:AUD:… does not", store.has("fx:USD:GBP:2025-09-01") && !store.has("fx:USD:AUD:2025-09-01"));

  // currencySymbol / currencyLocale map: AUD→$/en-AU is the AU byte-identical default; unknown ⇒ code+space.
  check("currencySymbol: AUD→$, GBP→£, USD→US$, EUR→€, NZD→NZ$",
    currencySymbol("AUD") === "$" && currencySymbol("GBP") === "£" && currencySymbol("USD") === "US$" && currencySymbol("EUR") === "€" && currencySymbol("NZD") === "NZ$");
  check("currencySymbol: unknown ⇒ 'CODE ', absent ⇒ '$' (AU default)", currencySymbol("CAD") === "CAD " && currencySymbol(null) === "$" && currencySymbol(undefined) === "$");
  check("currencyLocale: AUD/absent ⇒ 'en-AU' (byte-identical default), GBP ⇒ 'en-GB', unknown ⇒ 'en-AU'",
    currencyLocale("AUD") === "en-AU" && currencyLocale(null) === "en-AU" && currencyLocale("GBP") === "en-GB" && currencyLocale("ZZ") === "en-AU");
}

console.log(`\n=== units: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
