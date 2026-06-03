#!/usr/bin/env tsx
// Offline unit tests for the pure invariants that underpin statement import + async
// categorisation. No worker runtime / D1 / Claude — these are the fast, deterministic
// regression guards for the rules we keep re-learning. Run: npm run test:units
import { reconcileStatement, deriveBalances, isTransferLike, signedCents, lineFingerprint, type StatementLine } from "../src/lib/statements";
import { batchStatementStatus, isStaleBatch, BATCH_MAX_AGE_MS } from "../src/lib/batch";
import { extractSituationDraft } from "../src/extract";
import type { LLM } from "../src/llm";
import { isValidAbn, normaliseAbn } from "../web/src/lib/abn";
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

console.log(`\n=== units: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
