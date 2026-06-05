#!/usr/bin/env tsx
// Offline unit tests for the pure invariants that underpin statement import + async
// categorisation. No worker runtime / D1 / Claude — these are the fast, deterministic
// regression guards for the rules we keep re-learning. Run: npm run test:units
import { reconcileStatement, deriveBalances, isTransferLike, signedCents, lineFingerprint, type StatementLine } from "../src/lib/statements";
import { batchStatementStatus, isStaleBatch, BATCH_MAX_AGE_MS } from "../src/lib/batch";
import { extractSituationDraft } from "../src/extract";
import type { LLM } from "../src/llm";
import { isValidAbn, normaliseAbn } from "../web/src/lib/abn";
import { billableCents } from "../src/lib/billing";
import { costCents } from "../src/lib/usage";
import { BUCKETS } from "../src/lib/taxonomy";
import { applyUserRules } from "../src/lib/rules";
import type { UserRule } from "../src/lib/db";
import { parseRoles, hasRole, isAdmin, normaliseRoles, ROLES } from "../src/lib/roles";
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
import { computeFyDeduction, rollSchedule, daysInFy, daysHeldInFy, balancingAdjustment, type DepAsset } from "../src/lib/depreciation";

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

console.log("depreciation: balancing adjustment on disposal");
{
  check("termination > adjustable → assessable (+)", balancingAdjustment(4_800_000, 5_000_000) === 200_000);
  check("termination < adjustable → deductible (−)", balancingAdjustment(4_800_000, 3_000_000) === -1_800_000);
}

// ── Claimability matcher: rules-first, defer gating ───────────────────────────
import { matchClaimRules, suggestionText, type ClaimRule } from "../src/lib/claimability";
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
    by_bucket: [], by_property: [], company_quarters: [],
    undated: { n: 0, total_cents: 0 }, undated_detail: [], abn: null, gst_credits_cents: 0,
    income: { by_type: [], gross_cents: 0, withholding_cents: 0, franking_credit_cents: 0, foreign_tax_paid_cents: 0 },
    depreciation_cents: 0, per_property: [], total_income_cents: 0, total_deductions_cents: 0, taxable_position_cents: 0,
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

  // Unknown-bucket spend → review finding.
  const unknown = run(mkReport({ by_bucket: [{ bucket: "unknown", ato_label: null, n: 3, total_cents: 50_000, gst_cents: 0 }] }), noSignals({ unknownBucketN: 3, unknownBucketCents: 50_000 }));
  check("unknown bucket → review finding", unknown.findings.some((f) => f.id === "unknown_bucket" && f.severity === "review"));

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
import { PURGE_TABLES } from "../src/lib/retention";

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

console.log(`\n=== units: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
