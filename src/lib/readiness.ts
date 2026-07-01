// The filing-readiness engine — PURE (no I/O), deterministic, unit-testable. Mirrors the design of
// claimability.ts / depreciation.ts: the Durable Object does all the impure work (buildReport, D1
// counts, rule matching) and hands plain values to assessReadiness(), which classifies them into a
// FilingReadiness object.
//
// HARD INVARIANTS (this is a tax-evidence product, not a tax agent):
//  - GENERAL-INFO only, never tax advice. Judgement calls defer to a registered tax agent.
//  - NEVER tax payable / refund / rates. We surface only the INDICATIVE taxable position that the
//    report already computes (income − deductions − depreciation). No bracket maths anywhere.
//  - Rules-first: findings derive from the computed Report + matched claimability rules + the
//    deterministic checks below. Nothing here invents a deduction.
// `assessReadiness` is the only export that produces user-facing text; check-units.ts asserts none of
// it trips the tax-advice denylist.

import type { Report } from "./report";
import { deductionGroupForRow } from "./report";
import type { Situation } from "./db";
import { suggestionText, type ClaimRule } from "./claimability";

export const READINESS_DISCLAIMER =
  "General information only — not tax advice. Quillo is not a registered tax or BAS agent. Confirm everything with a registered tax agent before lodging.";

export type FindingSeverity = "blocker" | "review" | "info";
export type FindingCategory = "completeness" | "evidence" | "classification" | "depreciation" | "income" | "threshold" | "judgement";

export interface EvidenceRef {
  kind: "transaction" | "income" | "asset" | "property" | "document";
  id?: string;
  label?: string;
  count?: number;
}

export interface ReadinessFinding {
  id: string;                 // stable key, e.g. "unknown_bucket"
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  general_info_note: string;  // always GENERAL-INFO framing
  defer_to_agent: boolean;    // true ⇒ note already carries the "confirm with a registered tax agent" suffix
  evidence_refs: EvidenceRef[];
}

// One explained line of the indicative position. `why` is template/rulepack-sourced, never a freely
// authored per-number assertion.
export interface PositionLine {
  // "excluded" = captured but NOT in the indicative position (private/non-deductible, capital, or
  // unresolved); "company" = a separate taxpayer's spend, tracked apart from the individual position.
  group: "income" | "deduction" | "depreciation" | "property" | "excluded" | "company";
  label: string;
  amount_cents: number;
  basis: string;
  why: string;
}

export interface FilingReadinessSignals {
  unknownBucketCents: number;
  unknownBucketN: number;
  lowConfidenceN: number;
  needsReviewIncomeN: number;
  needsReviewAssetsN: number;
  hasDividendStatementDoc: boolean;
  rentalPropsMissingSummary: { property_id: string; label: string | null }[];
  disposedAssetsN: number;
  instantAssetWriteOffCentsThisFy: number | null;
  instantAssetWriteOffCentsPrevFy: number | null;
  capitalLossCarryinCents: number; // prior-year capital losses captured at Set-up (0 if none)
  fxUnconvertedN?: number; // foreign-currency rows we couldn't convert to AUD (excluded from the position)
  div293ThresholdCents?: number | null; // pack reference-only Div 293 income threshold (null if no rate block for the FY); drives a defer nudge only — NEVER a computed liability
  gstRegistrationThresholdCents?: number | null; // pack GST/consumption-tax registration threshold for the FY (jurisdiction-neutral; null if absent); drives the turnover nudge
  isGstRegistered?: boolean; // tenant default profiles.gst_registered OR any entity flag (mirrors gstTotals); suppresses the registration nudge
  psiAppliesDeclared?: boolean; // S2: the user marked psi_status='psi_applies' on a business activity → sharpened PSI nudge
  psiAllAssessed?: boolean; // S2: every business activity has a recorded psi_status → stop prompting them to assess
  mainResidenceDisposalN?: number; // F: disposed properties flagged as a main residence this FY → defer nudge (we never auto-apply the exemption)
  mfCostBaseAdjustmentCents?: number; // B: net AMIT cost-base amount across managed-fund distributions → defer nudge (not assessable; adjusts the units' cost base for a future CGT calc)
  // integrity_nudges (audit wave 1) — the caller populates these ONLY when the flag is on, so OFF ⇒
  // findings byte-identical. All four are pack REFERENCE values / booleans that drive defer nudges;
  // holding periods, offset limits and cap breaches are NEVER computed as $ outcomes.
  frankingHoldingThresholdCents?: number | null; // $5,000 small-shareholder boundary for the 45-day holding rule
  fitoDeMinimisCents?: number | null; // $1,000 FITO de-minimis (above it the offset-limit calc is required)
  rideshareGstLikely?: boolean; // occupation/activity looks like taxi/ride-sourcing → GST from the first dollar (Div 144)
  superNonConcessionalCapCents?: number | null; // reference NCC cap for the FY
  nonConcessionalContributedCents?: number; // total type='non_concessional' super contributions this FY
  nonCashIncomeEnabled?: boolean; // non_cash_income flag (audit wave 4) — gates the non_cash_benefit nudge's copy fork so OFF keeps the legacy wording verbatim
}

export interface FilingReadiness {
  fy: string;
  generated_at: string; // stamped by the caller (Date is unavailable in some runtimes/tests)
  position: {
    indicative_taxable_position_cents: number; // NEVER tax payable
    caption: string;
    lines: PositionLine[];
    credits: {
      withholding_cents: number;
      franking_credit_cents: number;
      foreign_tax_paid_cents: number;
      gst_credits_cents: number;
    };
    per_property: Report["per_property"];
  };
  findings: ReadinessFinding[];
  handoff: {
    abn: string | null;
    situation_summary: string;
  };
  readiness_score: { blockers: number; review: number; info: number; ready: boolean };
  narrative: { position_plain_english: string; accountant_notes: string[] } | null; // v2; null in v1
  disclaimer: string;
}

function incomeTypeWhy(incomeType: string): string {
  switch (incomeType) {
    case "salary_payg": return "Salary/wages you recorded (generally item 1). PAYG withheld is shown as a credit, not a deduction.";
    case "business": return "Net income of your sole-trader / ABN business (generally item 15). Your business expenses are captured separately and reduce your individual position.";
    case "foreign_business": return "Business income from foreign sources (e.g. overseas platform/ad revenue or overseas clients). Assessable like your other business income; any foreign tax paid is shown as a credit and may support a foreign income tax offset.";
    case "rent": return "Rent received on a let property (generally item 13). Agent-deducted expenses are captured separately as deductions.";
    case "foreign_rent": return "Rent received on a foreign property (generally item 20). Foreign tax paid is shown as a credit.";
    case "dividend": return "Dividends you recorded (generally item 11). Franking credits are shown as a credit.";
    case "interest": return "Interest you recorded (generally item 10).";
    case "managed_fund_distribution": return "Managed-fund distribution components you recorded (generally item 13U/20).";
    case "foreign_pension": return "Foreign pension income you recorded (generally item 20).";
    case "non_cash_business": return "Non-cash business income (gifted products / barter received in the course of your business) included at market value — keep evidence of how you valued it.";
    default: return "Income you recorded for this year.";
  }
}

// S4/D: captured-but-excluded (non-assessable) income types — each gets its own label + explainer so a
// pension is never rendered as a non-cash benefit. Keep in lockstep with NON_ASSESSABLE_INCOME_TYPES.
function excludedIncomeLabel(incomeType: string): string {
  switch (incomeType) {
    case "non_cash_benefit": return "Non-cash benefits (captured, not in position)";
    case "super_pension": return "Super pension (captured, not in position)";
    default: return incomeType;
  }
}
function excludedIncomeWhy(incomeType: string): string {
  switch (incomeType) {
    case "non_cash_benefit": return "Gifted products / barter you recorded at market value. Captured as evidence but NOT counted in your indicative position — assessability depends on whether you're carrying on a business.";
    case "super_pension": return "Super pension income you recorded. Captured as evidence but NOT counted in your indicative position — an account-based pension from a taxed fund paid to someone aged 60 or over is generally tax-free.";
    default: return "Income captured as evidence but not counted in your indicative position.";
  }
}

function bucketWhy(bucket: string): string {
  switch (bucket) {
    case "payg": return "Work-related deductions you recorded (the D-labels). Each still needs to satisfy its own deductibility test.";
    case "company": return "Business expenses recorded against your company's books.";
    case "property_rented": return "Expenses on a currently-let property — generally deductible while it's genuinely available for rent.";
    case "property_vacant": return "Holding costs on a property not currently let — often NOT deductible; confirm it was genuinely available for rent.";
    default: return "Categorised spend for this year.";
  }
}

// Why a captured row is EXCLUDED from the indicative position (or tracked as company). GENERAL-INFO.
// Exported for the accountant schedule's NOT-CLAIMED section (#181) — one source for the reason text.
export function excludedWhy(bucket: string, deductibility: string | null | undefined): string {
  if (bucket === "asset") return "Capital purchase — claimed over time as decline in value (Div 40 / Div 43), not as an immediate deduction, so it isn't counted here.";
  switch (deductibility) {
    case "likely_not":
    case "confirmed_not":
      return "Private or non-deductible spend (e.g. groceries, personal living costs, entertainment) — generally not deductible under s8-1(2)(b), so it's excluded from your position.";
    case "needs_apportionment":
      return "Work-related but needs an apportionment (e.g. work-use %, or your hours for working-from-home) before any amount can be claimed — excluded until you resolve it.";
    case "suggested_deductible":
      return "Looks like a deductible work/charity expense (e.g. union fees, tax-agent fees, a DGR donation) — suggested only, and excluded until you confirm it. General information, not tax advice.";
    default:
      return "Not yet confirmed as work-related — excluded by default until you confirm it relates to earning your income. Review it in the Inbox.";
  }
}

/**
 * The full exclusion reason for a row, covering the two gates that fire BEFORE deductibility
 * (employer-reimbursed 0030, rent-free/renovating property 0031) and then the deductibility-state
 * reasons. Used by the accountant schedule's NOT-CLAIMED section (#181) so every excluded item
 * carries the same GENERAL-INFO explanation the readiness lines show. assessReadiness keeps calling
 * excludedWhy directly (its breakdown rows render reimbursed/use-status lines separately).
 */
export function exclusionReason(
  bucket: string,
  deductibility: string | null | undefined,
  reimbursed?: number | null,
  useStatusDenied?: number | null,
  propertyUndetermined?: number | null,
): string {
  if (reimbursed) return "Employer-reimbursed — the employer bore the cost, so it isn't a deductible loss or outgoing (s8-1).";
  if (useStatusDenied) return "Property held rent-free / off-market while renovating — it earns no assessable income, so holding costs aren't deductible (s8-1); CGT cost base may still accrue.";
  if (propertyUndetermined) return "Property expense not yet attributed to an income-producing property — it has no property assigned, or the property's rental status isn't set to rented / genuinely available for rent. It can't be claimed until you confirm the property and that it earns (or is genuinely available to earn) assessable rent. General information only — confirm with a registered tax agent.";
  return excludedWhy(bucket, deductibility);
}

/**
 * Classify a computed Report + matched rules + pre-counted D1 signals into a FilingReadiness object.
 * Pure: same inputs → same output. The caller stamps `generated_at` and persists/audits.
 */
export function assessReadiness(input: {
  report: Report;
  situation: Situation;
  claimMatches: ClaimRule[];
  signals: FilingReadinessSignals;
  generatedAt: string;
  excludeNonDeductible?: boolean; // mirrors the `position_excludes_nondeductible` flag (default off = legacy)
  excludePropertyUndetermined?: boolean; // mirrors the `position_excludes_property_undetermined` flag (#254; default off = legacy)
  auditFindingsV2?: boolean; // mission-audit #7/#8 safety findings (readiness_audit_v2); default off ⇒ byte-identical
}): FilingReadiness {
  const { report, situation, claimMatches, signals, generatedAt } = input;
  const excludeNonDeductible = input.excludeNonDeductible ?? false;
  const auditFindingsV2 = input.auditFindingsV2 ?? false;
  const excludePropertyUndetermined = input.excludePropertyUndetermined ?? false;
  const findings: ReadinessFinding[] = [];

  // ── (1) position with reasoning — straight from the report, no new maths ──
  const lines: PositionLine[] = [];
  for (const it of report.income.by_type) {
    lines.push({ group: "income", label: it.income_type, amount_cents: it.gross_cents, basis: `${it.n} income record(s)`, why: incomeTypeWhy(it.income_type) });
  }
  // S4/D: captured-but-excluded income (non-cash benefits, super pension) is recorded at face value but kept
  // OUT of the assessable headline (incomeTotals kept it out of gross/by_type). Render one "excluded" line
  // per type so the money stays visible without counting — preserves the lines-sum == taxable_position
  // invariant — and each type carries its own label/explainer (a pension is never shown as a gift).
  for (const ex of report.income.excluded_by_type ?? []) {
    if (ex.gross_cents <= 0) continue;
    lines.push({ group: "excluded", label: ex.income_type, amount_cents: ex.gross_cents,
      basis: `${ex.n} income record(s) — captured, not counted`, why: excludedIncomeWhy(ex.income_type) });
  }
  // Phase #138: net capital gain is assessable income — buildReport added it to taxable_position, so it
  // renders as an "income" line to keep the lines-sum == headline invariant. Present only when the
  // cgt_engine flag is on with CGT events, so the legacy reconciliation is intact.
  if (report.capital_gains && report.capital_gains.net_capital_gain_cents > 0) {
    const cg = report.capital_gains;
    lines.push({ group: "income", label: "net_capital_gain", amount_cents: cg.net_capital_gain_cents,
      basis: `gains ${money(cg.gross_capital_gains_cents)} − losses ${money(cg.capital_losses_cents)} − 50% discount ${money(cg.discount_applied_cents)}`,
      why: "Net capital gain on assets you disposed of this year (shares, crypto, property): total gains, less capital losses, less the 50% CGT discount on assets held 12+ months. This is assessable income — CGT is fact-specific, so confirm with a registered tax agent." });
  }
  // Phase #141: assessable ESS discount (taxed-upfront / deferral) is employment income — buildReport
  // added it to taxable_position, so it renders as an "income" line to keep lines-sum == headline.
  if (report.ess && report.ess.assessable_discount_cents > 0) {
    lines.push({ group: "income", label: "ess_discount", amount_cents: report.ess.assessable_discount_cents,
      basis: "ESS discount assessable at its taxing point",
      why: "The discount on shares/options from your employee share scheme is assessable employment income (taxed-upfront or at a deferred taxing point). A startup-concession grant is NOT taxed here — it's taxed as a capital gain when you sell. ESS treatment is error-prone; confirm with a registered tax agent." });
  }
  // Phase #139: assessable trust distributions to this person — buildReport added them to
  // taxable_position, so they render as an "income" line to keep lines-sum == headline.
  if (report.trust && report.trust.assessable_cents > 0) {
    lines.push({ group: "income", label: "trust_distribution", amount_cents: report.trust.assessable_cents,
      basis: report.trust.franking_credit_cents > 0 ? `incl. ${money(report.trust.franking_credit_cents)} franking credit` : "trust net income distributed to you",
      why: "Your share of a trust's net income, distributed to you with its character retained (e.g. a franked dividend stays franked, a discounted capital gain stays discounted). It's assessable to you. Trust streaming, s100A and Division 7A are specialist — confirm with a registered tax agent." });
  }
  // Slice E: a partner's share of partnership net income — buildReport added it to taxable_position, so it
  // renders as an "income" line too (lines-sum == headline).
  if (report.partnership && report.partnership.assessable_cents > 0) {
    lines.push({ group: "income", label: "partnership_distribution", amount_cents: report.partnership.assessable_cents,
      basis: report.partnership.franking_credit_cents > 0 ? `incl. ${money(report.partnership.franking_credit_cents)} franking credit` : "your share of partnership net income",
      why: "Your share of a partnership's net income, with its character retained (a franked dividend stays franked, a discounted capital gain stays discounted). It's assessable to you; the partnership lodges its own return. A partnership loss may instead be deductible — confirm the split and the partnership's lodgment with a registered tax agent." });
  }
  // Audit wave 4 (trading_stock): buildReport added the s 70-35 adjustment to taxable_position, so it
  // renders as a line too (lines-sum == headline). An increase is an "income" line; a decrease renders
  // as a deduction line with the deducted amount.
  if (report.trading_stock && report.trading_stock.adjustment_cents !== 0) {
    const ts = report.trading_stock;
    lines.push({
      group: ts.adjustment_cents > 0 ? "income" : "deduction",
      label: "trading_stock_adjustment",
      amount_cents: Math.abs(ts.adjustment_cents),
      basis: `closing ${money(ts.closing_cents)} − opening ${money(ts.opening_cents)}`,
      why: ts.adjustment_cents > 0
        ? "Your trading stock grew over the year — the increase counts as business income (s 70-35). Valuation basis and the small-business movement election are confirmed with your registered tax agent."
        : "Your trading stock shrank over the year — the decrease is deductible (s 70-35). Valuation basis and the small-business movement election are confirmed with your registered tax agent.",
    });
  }
  // Deduction lines come from the deductibility-split breakdown so the SAME classifier that computed
  // the headline routes each row to its section ("deduction" sums to the headline; "excluded"/"company"
  // are shown apart). This both fixes the number AND explains what dropped out and why.
  let paygUnresolvedCents = 0;
  let paygUnresolvedN = 0;
  for (const b of report.deduction_breakdown) {
    if (b.bucket === "unknown") continue; // surfaced via the unknown_bucket blocker, not as a line
    const group = deductionGroupForRow(b.bucket, b.deductibility, excludeNonDeductible, b.reimbursed, b.use_status_denied, b.property_undetermined);
    const label = b.ato_label ? `${b.bucket} · ${b.ato_label}` : b.bucket;
    // A property-undetermined row (#254) is excluded for a SPECIFIC reason — explain it via exclusionReason
    // rather than the generic excludedWhy (which keys off deductibility and would mislead, e.g. printing a
    // "likely deductible" rationale for a row the position is actually dropping). Only fires when the flag
    // is on (b.property_undetermined is 0 otherwise), so the legacy excluded `why` is byte-identical.
    const why = group === "deduction" ? bucketWhy(b.bucket) : group === "company" ? bucketWhy("company")
      : b.property_undetermined ? exclusionReason(b.bucket, b.deductibility, b.reimbursed, b.use_status_denied, b.property_undetermined)
      : excludedWhy(b.bucket, b.deductibility);
    lines.push({ group, label, amount_cents: b.total_cents, basis: `${b.n} countable transaction(s)`, why });
    if (excludeNonDeductible && b.bucket === "payg" && (b.deductibility ?? "undetermined") === "undetermined") {
      paygUnresolvedCents += b.total_cents;
      paygUnresolvedN += b.n;
    }
  }
  // Computed work-use deductions (WFH fixed-rate + car cents-per-km). These count toward the headline
  // (buildReport added them to total_deductions), so they render as "deduction" lines and keep the
  // lines-sum == headline invariant. The itemised running costs they cover stay in "excluded"
  // (needs_apportionment) — the `why` says so — so nothing is double-claimed. Absent unless the
  // wfh_car_methods flag is on and the user supplied hours/km, so the legacy reconciliation is intact.
  const wm = report.work_method;
  if (wm && wm.wfh_cents > 0) {
    lines.push({ group: "deduction", label: "Working from home (fixed rate)", amount_cents: wm.wfh_cents,
      basis: `${wm.wfh_hours} hrs × ${wm.rates.wfh_cents_per_hour}c/hr`,
      why: "Home-office running costs claimed using the ATO fixed-rate method for the hours you worked from home. This method already covers electricity, internet, phone and stationery, so those individual receipts are not also claimed (they stay excluded below)." });
  }
  if (wm && wm.car_cents > 0) {
    lines.push({ group: "deduction", label: "Car (cents per km)", amount_cents: wm.car_cents,
      basis: `${Math.min(wm.car_work_km, wm.rates.car_km_cap)} km × ${wm.rates.car_cents_per_km}c/km (max ${wm.rates.car_km_cap} km)`,
      why: "Work-related car expenses claimed using the cents-per-kilometre method, capped at the ATO kilometre limit. This method already covers running costs (fuel, servicing, rego, insurance), so actual car receipts are not also claimed." });
  }
  // Phase B / G2: attribution deductions (payer≠claimant). buildReport added the individual + rental-
  // property amounts to gross_deductions, so they render as "deduction" lines to keep lines-sum ==
  // headline; the company amount sits in the company track (its own group). Present only when the
  // attribution_engine flag is on with attribution rows, so the legacy reconciliation is intact.
  const at = report.attribution;
  if (at && at.individual_cents + at.property_cents > 0) {
    lines.push({ group: "deduction", label: "Attributed deductions", amount_cents: at.individual_cents + at.property_cents,
      basis: "your share of costs you paid but split by entitlement (e.g. a co-owned property)",
      why: "Where you paid a cost but only part of it is yours to claim — for example a co-owned rental where the deduction follows legal ownership share, regardless of who paid the bill." });
  }
  if (at && at.company_cents > 0) {
    lines.push({ group: "company", label: "Attributed (company)", amount_cents: at.company_cents,
      basis: "costs you paid personally that belong to your company",
      why: "Costs you paid personally that are the company's expense (e.g. its cloud subscriptions). These reduce the company's position, not your salary, and are typically recorded as a loan from you to the company." });
  }
  if (report.depreciation_cents > 0) {
    lines.push({ group: "depreciation", label: "Decline in value", amount_cents: report.depreciation_cents, basis: "from your depreciation schedule (Div 40 / Div 43)", why: "Capital allowances carried forward from your asset schedule for this year." });
  }
  for (const p of report.per_property) {
    lines.push({ group: "property", label: p.label ?? p.property_id, amount_cents: p.net_cents, basis: `rent ${money(p.income_cents)} − deductions ${money(p.deduction_cents)} − depreciation ${money(p.depreciation_cents)}`, why: "Per-property position. A net loss generally offsets your other income (negative gearing)." });
  }
  // Phase C / G4: the company position is a SEPARATE taxpayer — render it in its own group so it never
  // reads as reducing the individual's salary. A pre-revenue company nets to a carried-forward loss.
  for (const cp of report.company_positions ?? []) {
    lines.push({ group: "company", label: `${cp.name ?? "Company"} — position`, amount_cents: -cp.current_year_loss_cents,
      basis: `income ${money(cp.assessable_income_cents)} − deductions ${money(cp.deductions_cents)} = ${cp.current_year_loss_cents > 0 ? "loss " + money(cp.current_year_loss_cents) : money(cp.assessable_income_cents - cp.deductions_cents)}`,
      why: "Your company is a separate taxpayer — its costs don't reduce your salary. A pre-revenue company's costs carry forward as a tax loss it can use against future company income (subject to the continuity-of-ownership / same-business tests — confirm with a registered tax agent)." });
    if (cp.shareholder_loan_balance_cents > 0) {
      lines.push({ group: "company", label: `${cp.name ?? "Company"} — shareholder loan`, amount_cents: cp.shareholder_loan_balance_cents,
        basis: "costs you paid personally on the company's behalf", why: "Money you put into the company (paying its costs personally) is a loan from you TO the company. This direction is not a Division 7A deemed dividend (that risk runs the other way — company lending to you). Keep a loan agreement and confirm with a registered tax agent." });
    }
    if (cp.rd_eligible) {
      lines.push({ group: "company", label: `${cp.name ?? "Company"} — R&D offset (check eligibility)`, amount_cents: 0,
        basis: "turnover under the R&D offset cap", why: "If the company conducts eligible, registered R&D activities it may access the R&D tax incentive offset. This is specialist territory — flagged for a registered tax agent, never auto-claimed." });
    }
  }

  // ── (2) deterministic "things to double-check" findings ──
  // Nothing captured at all → the page must say "start here", NOT present an empty $0 return as
  // "ready". A brand-new user (or an empty FY) otherwise saw a green "Nothing flagged" banner over a
  // $0.00 position, reading as "your return is done" when they'd captured nothing (#74). A blocker so
  // `ready` is false; Filing renders a dedicated start-capturing card for this finding.
  const hasAnyData =
    report.income.gross_cents > 0 ||
    report.income.by_type.length > 0 ||
    (report.income.excluded_by_type?.length ?? 0) > 0 || // S4/D: a captured-but-excluded type still means the FY isn't blank
    report.deduction_breakdown.length > 0 ||
    report.depreciation_cents > 0 ||
    report.per_property.length > 0 ||
    report.undated.n > 0 ||
    !!report.work_method ||
    // any captured activity (even if it only surfaced as a signal/claim) means the FY isn't blank
    signals.unknownBucketN > 0 ||
    signals.lowConfidenceN > 0 ||
    signals.needsReviewIncomeN > 0 ||
    signals.needsReviewAssetsN > 0 ||
    signals.disposedAssetsN > 0 ||
    claimMatches.length > 0;
  if (!hasAnyData) {
    findings.push(f("nothing_captured", "completeness", "blocker", `Nothing captured for FY ${report.fy} yet`,
      `Your return for this year is empty, so there's nothing to hand off. Import a bank statement or snap a receipt to get started, then come back here.`, false, []));
  }
  // BLOCKERS: these materially distort the indicative position (money silently left out), so they
  // must drop `ready` to false — the old engine only ever emitted review/info, so a user with
  // uncategorised + undated spend was told they were ready (review Medium). Severity is now "blocker".
  if (signals.unknownBucketN > 0) {
    findings.push(f("unknown_bucket", "completeness", "blocker", `${signals.unknownBucketN} transaction(s) aren't categorised yet`,
      `These total ${money(signals.unknownBucketCents)} and are excluded from the indicative position until you categorise them — so the position is incomplete. Categorise them in the Inbox before relying on the numbers.`, false,
      [{ kind: "transaction", count: signals.unknownBucketN }]));
  }
  // Deny-by-default: payg spend we couldn't positively classify is excluded from the position until
  // the user confirms it's work-related. Surface it with a clear path so the headline isn't silently
  // understated. Only meaningful (and only emitted) when the exclusion is actually in effect.
  if (excludeNonDeductible && paygUnresolvedN > 0) {
    findings.push(f("payg_unresolved", "classification", "review", `${paygUnresolvedN} personal/work transaction(s) need a deductibility decision`,
      `These total ${money(paygUnresolvedCents)} and are excluded from the indicative position by default until you confirm they relate to earning your income (work-related). Private spend stays excluded; mark the work-related ones in the Inbox.`, false,
      [{ kind: "transaction", count: paygUnresolvedN }]));
  }
  if (report.undated.n > 0) {
    findings.push(f("undated_receipts", "completeness", "blocker", `${report.undated.n} receipt(s) have no usable date`,
      `Without a date these can't be placed in a financial year, so they're left out of this year's totals — the position is incomplete. Add a date so they land in the right year.`, false,
      [{ kind: "transaction", count: report.undated.n }]));
  }
  if (signals.needsReviewIncomeN > 0) {
    findings.push(f("income_needs_review", "income", "review", `${signals.needsReviewIncomeN} income record(s) flagged for review`,
      `Some income was captured with low confidence or didn't reconcile. Check the amounts before relying on the position.`, false,
      [{ kind: "income", count: signals.needsReviewIncomeN }]));
  }
  if ((signals.fxUnconvertedN ?? 0) > 0) {
    findings.push(f("fx_unconverted", "income", "review", `${signals.fxUnconvertedN} foreign-currency item(s) couldn't be converted to AUD`,
      `We couldn't fetch an exchange rate for these (unsupported currency, or a date with no published rate), so they're EXCLUDED from the indicative position rather than counted at the wrong value. Check the date/currency, or enter the AUD amount manually.`, false,
      [{ kind: "transaction", count: signals.fxUnconvertedN }]));
  }
  // Mission-audit #7/#8 safety + completeness findings. Gated ⇒ OFF adds none ⇒ byte-identical.
  if (auditFindingsV2) {
    for (const p of report.per_property) {
      if (p.deduction_cents > 0 && p.income_cents === 0) {
        findings.push(f("rental_zero_income", "income", "review", `${p.label ?? p.property_id}: deductions claimed but no rent recorded`,
          `You're claiming ${money(p.deduction_cents)} of deductions on this property but recorded $0 rent this year. Holding costs are only deductible while a property is rented or GENUINELY AVAILABLE for rent at a market rate — confirm it was available (and why there's no rent).${DEFER}`, true,
          [{ kind: "property", id: p.property_id, label: p.label ?? p.property_id }]));
      }
    }
    const self = situation.persons.find((p) => p.role === "self");
    if (self && !self.occupation) {
      findings.push(f("occupation_missing", "completeness", "review", "Your occupation isn't set",
        "Your occupation tailors which work-related deductions apply — without it, Quillo can't suggest the deductions specific to your job, and your agent lacks context. Add it in Settings before you hand off.", false, []));
    }
    if (report.ess && report.ess.assessable_discount_cents > 0) {
      findings.push(f("ess_taxing_point", "income", "info", "Confirm your ESS discount and its taxing point",
        `An employee-share-scheme discount of ${money(report.ess.assessable_discount_cents)} is in your assessable income. ESS valuation and the taxing point (taxed-upfront vs deferral) are fact-specific — confirm the market-value discount and timing.${DEFER}`, true, []));
    }
  }
  if ((report.company_unattributed_n ?? 0) > 0) {
    findings.push(f("company_unattributed", "classification", "review", `${report.company_unattributed_n} company transaction(s) aren't assigned to a specific company`,
      `These total ${money(report.company_unattributed_cents ?? 0)}. With more than one company, a plain "company" expense can't be auto-assigned, so it's EXCLUDED from every company's position. Assign each to the company that incurred it (set its attribution) so it's counted.`, false,
      [{ kind: "transaction", count: report.company_unattributed_n }]));
  }
  if ((report.property_unattributed_n ?? 0) > 0) {
    // #254: when the deny-by-default flag is on, an unassigned rental-property expense is NOT counted at all
    // (it can't land in an income-producing property), so the nudge must say "not counted until you assign
    // it" — not the legacy "still reduces your deductions" (which is only true with the flag off).
    const propUnattribWhy = excludePropertyUndetermined
      ? `These total ${money(report.property_unattributed_cents ?? 0)}. They are NOT being counted toward your deductions yet — a rental expense can only be claimed once it's tied to a property that earns (or is genuinely available to earn) rent. Open each line and set which property it belongs to so it counts.`
      : `These total ${money(report.property_unattributed_cents ?? 0)}. They still reduce your overall deductions, but without a property they're absent from each property's per-property schedule — so a property's negative-gearing position reads short. Open each line and set which property it belongs to.`;
    findings.push(f("property_unattributed", "classification", "review", `${report.property_unattributed_n} rental-property expense(s) aren't assigned to a property`,
      propUnattribWhy, false,
      [{ kind: "transaction", count: report.property_unattributed_n }]));
  }
  if ((report.refunds_unmatched_n ?? 0) > 0) {
    // #258: under refund-netting v2 a refund only reduces deductions when it's linked to the specific
    // deductible expense it reverses. Unlinked refunds (or ones tied to personal spend) are NOT reducing
    // the position — which is correct for a flatmate reimbursement or a personal return, but if any
    // genuinely refunds a work/property cost the user should link it. 0 when v2 is off ⇒ no nudge.
    findings.push(f("refunds_unmatched", "classification", "review", `${report.refunds_unmatched_n} refund(s) aren't linked to an expense`,
      `These total ${money(report.refunds_unmatched_cents ?? 0)} and are NOT reducing your deductions. That's right for a personal reimbursement (e.g. a flatmate paying you back) or a return on a personal purchase. But if a refund reverses a work or rental expense you claimed, open it and link it to that expense so the deduction is netted correctly. General information only.`, false,
      [{ kind: "transaction", count: report.refunds_unmatched_n }]));
  }
  if (signals.needsReviewAssetsN > 0) {
    findings.push(f("assets_needs_review", "depreciation", "review", `${signals.needsReviewAssetsN} asset(s) flagged for review`,
      `Some depreciating assets need confirmation (cost, date or effective life) before their decline-in-value is reliable.`, false,
      [{ kind: "asset", count: signals.needsReviewAssetsN }]));
  }
  if (signals.lowConfidenceN > 0) {
    findings.push(f("low_confidence_txns", "classification", "info", `${signals.lowConfidenceN} transaction(s) were categorised with low confidence`,
      `Worth a quick scan to confirm the category is right before lodging.`, false,
      [{ kind: "transaction", count: signals.lowConfidenceN }]));
  }
  if (report.income.franking_credit_cents > 0 && !signals.hasDividendStatementDoc) {
    findings.push(f("franking_no_doc", "evidence", "review", "Franking credits recorded, but no dividend statement on file",
      `You've recorded ${money(report.income.franking_credit_cents)} of franking credits. Upload the dividend/distribution statement so the claim is substantiated.`, false,
      [{ kind: "document", label: "dividend_statement" }]));
  }
  // integrity_nudges: the 45-day holding rule / $5,000 small-shareholder exemption. The $5k test is on
  // the TOTAL franking-credit entitlement (direct + trust + partnership shares). We never compute
  // holding periods — above the boundary the whole question is agent territory (fail the rule above
  // $5k and the credits are denied entirely, not capped).
  if (signals.frankingHoldingThresholdCents != null) {
    const totalFrankingCents = report.income.franking_credit_cents
      + (report.trust?.franking_credit_cents ?? 0)
      + (report.partnership?.franking_credit_cents ?? 0);
    if (totalFrankingCents > signals.frankingHoldingThresholdCents) {
      findings.push(f("franking_45day", "judgement", "review", "Franking credits are above the small-shareholder boundary — check the 45-day holding rule",
        `Your total franking credits (${money(totalFrankingCents)}) are above ${money(signals.frankingHoldingThresholdCents)}, so the small-shareholder exemption doesn't cover them. The 45-day holding rule (90 days for preference shares, and the related-payments rule) can deny franking credits on shares not held at risk long enough. Quillo does not track holding periods — confirm each parcel's holding with a registered tax agent.${DEFER}`, true,
        [{ kind: "income", label: "franking credits" }]));
    } else if (totalFrankingCents > 0) {
      findings.push(f("franking_small_shareholder", "judgement", "info", "Franking credits are within the small-shareholder exemption",
        `Your total franking credits (${money(totalFrankingCents)}) are under ${money(signals.frankingHoldingThresholdCents)}, so the small-shareholder exemption generally means the 45-day holding rule doesn't apply to you. General information only.`, false,
        [{ kind: "income", label: "franking credits" }]));
    }
  }
  for (const rp of signals.rentalPropsMissingSummary) {
    findings.push(f(`rental_no_summary:${rp.property_id}`, "evidence", "review", `Rental income recorded for "${rp.label ?? rp.property_id}" but no agent summary on file`,
      `Upload the agent's EOFY rental summary so the rent and agent-deducted expenses are substantiated and split correctly.`, false,
      [{ kind: "property", id: rp.property_id, label: rp.label ?? undefined }]));
  }
  if (report.income.foreign_tax_paid_cents > 0) {
    // integrity_nudges: branch on the $1,000 FITO de-minimis when the caller supplied it. Above it the
    // full offset-limit calculation is required (agent territory, escalate to review); at/below it the
    // offset is generally claimable without that calculation. Signal absent (flag off) ⇒ legacy wording.
    if (signals.fitoDeMinimisCents != null && report.income.foreign_tax_paid_cents > signals.fitoDeMinimisCents) {
      findings.push(f("foreign_tax_fito", "income", "review", "Foreign tax paid is above the FITO de-minimis — the offset limit applies",
        `You've recorded ${money(report.income.foreign_tax_paid_cents)} of foreign tax paid. Above ${money(signals.fitoDeMinimisCents)}, the Foreign Income Tax Offset is capped at an offset limit that must be worked out (it compares your position with and without the foreign income); any excess is not carried forward. Your registered tax agent will calculate the limit.${DEFER}`, true,
        [{ kind: "income", label: "foreign tax paid" }]));
    } else if (signals.fitoDeMinimisCents != null) {
      findings.push(f("foreign_tax_fito", "income", "info", "Foreign tax paid recorded",
        `You've recorded ${money(report.income.foreign_tax_paid_cents)} of foreign tax paid, which may give rise to a Foreign Income Tax Offset. At or under ${money(signals.fitoDeMinimisCents)}, the offset can generally be claimed without the full offset-limit calculation — confirm the claim with your registered tax agent.${DEFER}`, true,
        [{ kind: "income", label: "foreign tax paid" }]));
    } else {
      findings.push(f("foreign_tax_fito", "income", "info", "Foreign tax paid recorded",
        `You've recorded ${money(report.income.foreign_tax_paid_cents)} of foreign tax paid, which may give rise to a Foreign Income Tax Offset. The offset limit is worked out by your registered tax agent.${DEFER}`, true,
        [{ kind: "income", label: "foreign tax paid" }]));
    }
  }
  // S4/D: captured-but-excluded income types — surface one defer nudge per type so the user knows it may be
  // assessable (we never assert it). Each type keeps its own wording; a pension is never called a gift.
  for (const ex of report.income.excluded_by_type ?? []) {
    if (ex.gross_cents <= 0) continue;
    if (ex.income_type === "non_cash_benefit") {
      // Copy fork gated on the non_cash_income flag: pointing users at the "non-cash business income"
      // type is only actionable (and only rendered in the form) when the flag is on — OFF keeps the
      // legacy wording verbatim (byte-identical).
      const ncCopy = signals.nonCashIncomeEnabled
        ? `You've recorded ${money(ex.gross_cents)} of non-cash benefits (e.g. gifted products received for promotion). These are EXCLUDED from your indicative position. If you're carrying on a business, benefits like these can be assessable at their market value — record them as "non-cash business income" instead so they count, keep evidence of how you valued them, and confirm the treatment with a registered tax agent.${DEFER}`
        : `You've recorded ${money(ex.gross_cents)} of non-cash benefits (e.g. gifted products received for promotion). These are EXCLUDED from your indicative position. If you're carrying on a business, benefits like these can be assessable at their market value — keep evidence of how you valued them and confirm the treatment with a registered tax agent.${DEFER}`;
      findings.push(f("non_cash_benefit", "income", "review", "Non-cash benefits recorded (gifted products / barter)",
        ncCopy, true,
        [{ kind: "income", label: "non-cash benefits" }]));
    } else if (ex.income_type === "super_pension") {
      findings.push(f("super_pension", "income", "review", "Super pension income recorded (account-based / retirement pension)",
        `You've recorded ${money(ex.gross_cents)} of super pension income. It's EXCLUDED from your indicative position. An account-based pension paid from a taxed fund to someone aged 60 or over is generally tax-free, so it isn't counted here. If you're under 60, or the pension includes an untaxed element (e.g. an untaxed government-fund component), part of it may be assessable and a tax offset may apply — confirm the treatment with a registered tax agent.${DEFER}`, true,
        [{ kind: "income", label: "super pension" }]));
    } else {
      findings.push(f(`excluded_${ex.income_type}`, "income", "review", `${excludedIncomeLabel(ex.income_type)} recorded`,
        `You've recorded ${money(ex.gross_cents)} of ${ex.income_type.replace(/_/g, " ")} income. It's EXCLUDED from your indicative position — confirm the treatment with a registered tax agent.${DEFER}`, true,
        [{ kind: "income", label: ex.income_type.replace(/_/g, " ") }]));
    }
  }
  // B: AMMA managed-fund distributions can include an AMIT cost-base net amount — not assessable now, but it
  // adjusts the cost base of the units for the CGT calc on a future sale. Surface it as a defer nudge.
  if ((signals.mfCostBaseAdjustmentCents ?? 0) !== 0) {
    findings.push(f("mf_cost_base", "judgement", "info", "Managed-fund cost-base adjustment recorded",
      `Your managed-fund distributions include ${money(Math.abs(signals.mfCostBaseAdjustmentCents ?? 0))} of AMIT cost-base adjustment. It isn't assessable this year, but it changes the cost base of your units for the CGT calculation when you eventually sell — keep a record and confirm the treatment with a registered tax agent.${DEFER}`, true,
      [{ kind: "income", label: "managed-fund cost base" }]));
  }
  if (signals.disposedAssetsN > 0) {
    findings.push(f("disposed_assets", "depreciation", "review", `${signals.disposedAssetsN} asset(s) were disposed this year`,
      `A disposal can trigger a balancing adjustment and/or a capital gain. Your registered tax agent will confirm the treatment.${DEFER}`, true,
      [{ kind: "asset", count: signals.disposedAssetsN }]));
  }
  // F: a disposed property flagged as a main residence is kept OUT of the computed capital gain (we never
  // auto-apply the exemption — the main-residence exemption, the 6-year rule and partial exemption are
  // fact-specific). Surface it as a defer nudge so the gain isn't silently treated as either fully exempt
  // or fully taxable.
  if ((signals.mainResidenceDisposalN ?? 0) > 0) {
    findings.push(f("main_residence_disposal", "judgement", "review", `${signals.mainResidenceDisposalN} disposed property flagged as a main residence`,
      `A property you disposed of is flagged as a main residence, so its capital gain is NOT included in your indicative position. Whether the main-residence exemption applies in full or part — and the 6-year absence rule — are fact-specific. Confirm the CGT treatment with a registered tax agent.${DEFER}`, true,
      [{ kind: "property" }]));
  }
  // Rental property earning income but with nothing depreciating → likely a missed QS schedule.
  for (const p of report.per_property) {
    if (p.income_cents > 0 && p.depreciation_cents === 0) {
      findings.push(f(`no_depreciation:${p.property_id}`, "depreciation", "info", `No decline-in-value captured for "${p.label ?? p.property_id}"`,
        `A quantity-surveyor depreciation schedule may unlock Div 40 / Div 43 deductions on a let property. Upload one from Documents if you have it.`, false,
        [{ kind: "property", id: p.property_id, label: p.label ?? undefined }]));
    }
  }
  // FY policy drift: the instant-asset-write-off threshold changing between years is an easy miss.
  if (
    signals.instantAssetWriteOffCentsThisFy != null &&
    signals.instantAssetWriteOffCentsPrevFy != null &&
    signals.instantAssetWriteOffCentsThisFy !== signals.instantAssetWriteOffCentsPrevFy
  ) {
    findings.push(f("iawo_threshold_changed", "threshold", "info", "The instant asset write-off threshold changed this year",
      `This year's threshold (${money(signals.instantAssetWriteOffCentsThisFy)}) differs from last year (${money(signals.instantAssetWriteOffCentsPrevFy)}). Check which assets qualify before writing any off.${DEFER}`, true,
      []));
  }

  // PSI (Personal Services Income, Div 86) trap — a sole trader whose ABN income is really reward for
  // their personal skill/labour (a contractor/freelancer) may be caught by the PSI rules, which can
  // strip otherwise-ordinary business deductions (rent, super for associates, etc.). We do NOT run the
  // PSI tests (results test / 80% / unrelated-clients) — that's a judgement call — so when business
  // income is present we surface a defer-to-agent nudge rather than silently treating every expense as
  // deductible. No engine branch yet (capture flag + Div 86 split is a later persona slice).
  // S2: three variants keyed off the self-declared psi_status on the business activity. We never remove
  // deductions (deny-by-default already excludes unconfirmed payg spend) — the value is sharper guidance.
  // non_cash_business rows can only exist when the non_cash_income flag is on (creation-gated), so
  // including them keeps flag-OFF byte-identical while barter-only businesses still get PSI/GST nudges.
  const BUSINESS_INCOME_TYPES = new Set(["business", "foreign_business", "non_cash_business"]);
  const hasBusinessIncome = report.income.by_type.some((it) => BUSINESS_INCOME_TYPES.has(it.income_type));
  if (hasBusinessIncome && signals.psiAppliesDeclared) {
    // Declared "PSI applies" → name the specific Div 86 restrictions so the user/agent can act on them.
    findings.push(f("psi_check", "judgement", "review", "PSI applies — some business deductions are restricted under Div 86",
      `You've indicated the Personal Services Income (PSI) rules apply to your business income. Where you're not running a personal services business, Division 86 generally denies deductions that would otherwise be allowable — rent, mortgage interest, rates and land tax on your home; payments to associates for non-principal work; and some superannuation for associates. Quillo does not remove these automatically; your registered tax agent will confirm exactly what stays deductible.${DEFER}`, true, []));
  } else if (hasBusinessIncome && !signals.psiAllAssessed) {
    // Not yet assessed → prompt them to assess and record it (the original general nudge + where to set it).
    findings.push(f("psi_check", "judgement", "review", "Sole-trader income — check whether the PSI rules apply",
      `Some of your income is sole-trader/ABN business income. If it's mainly a reward for your personal skills or labour (typical for contractors and freelancers), the Personal Services Income (PSI) rules in Division 86 can limit which expenses you're able to claim. The PSI tests are fact-specific — confirm with a registered tax agent, then record the outcome against the business activity in Settings.${DEFER}`, true, []));
  }
  // hasBusinessIncome && psiAllAssessed && not "applies" (i.e. assessed as not_psi) → no nudge: they've decided.
  // GST/consumption-tax registration threshold — a self-employed taxpayer whose business turnover
  // reaches the registration threshold is generally required to register. We never assert they MUST
  // (the turnover test has projection/grouping nuances we don't model) — a defer nudge when turnover is
  // at/above the pack threshold AND no registration is on file. Jurisdiction-neutral: the threshold comes
  // from the rule pack (AU GST $75k today; a UK VAT threshold swaps in via the pack), and "business"
  // turnover is the assessable business income types (incl. foreign-sourced business income).
  const businessTurnoverCents = report.income.by_type
    .filter((it) => BUSINESS_INCOME_TYPES.has(it.income_type)) // barter/non-cash consideration counts toward GST turnover
    .reduce((s, it) => s + it.gross_cents, 0);
  if (
    signals.gstRegistrationThresholdCents != null &&
    !signals.isGstRegistered &&
    businessTurnoverCents >= signals.gstRegistrationThresholdCents
  ) {
    findings.push(f("gst_registration_threshold", "threshold", "review", "Business turnover near the GST registration threshold",
      `Your recorded business turnover (${money(businessTurnoverCents)}) is at or above the GST registration threshold (${money(signals.gstRegistrationThresholdCents)}), and no GST registration is on file. A business that reaches the threshold is generally required to register for GST (and would then charge GST on its sales and claim credits on its purchases). Whether and from when you must register depends on the turnover test — confirm with a registered tax agent.${DEFER}`, true, []));
  }
  // integrity_nudges: taxi / ride-sourcing GST — Div 144 requires GST registration from the FIRST dollar
  // of fares, regardless of the turnover threshold. Fires only when the caller's heuristic says the
  // business looks like ride-sourcing AND business income exists AND no registration is on file. We
  // never assert they MUST register (food-delivery-only work follows the normal threshold) — the
  // distinction is fact-specific, so the nudge names the rule and defers.
  if (signals.rideshareGstLikely && hasBusinessIncome && !signals.isGstRegistered) {
    findings.push(f("rideshare_gst_first_dollar", "threshold", "review", "Ride-sourcing income — GST registration is required from the first dollar",
      `Your business income looks like taxi or ride-sourcing work (e.g. Uber, DiDi, Ola), and no GST registration is on file. Drivers providing taxi or ride-sourcing travel must be registered for GST from their first dollar of fares — the ${signals.gstRegistrationThresholdCents != null ? money(signals.gstRegistrationThresholdCents) : "usual"} turnover threshold does not apply to those fares (food-delivery-only work follows the normal threshold). Confirm your registration position with a registered tax agent.${DEFER}`, true, []));
  }
  // Div 293 — an extra 15% tax on concessional super contributions for higher-income earners. It's a
  // separate assessment the ATO/agent computes (NOT part of the indicative position), so this is a
  // pure defer nudge triggered off recorded income vs the pack's reference-only threshold. We never
  // compute the surcharge or assert it actually applies — "income for Div 293 purposes" includes items
  // we don't model (e.g. the contributions themselves, certain add-backs), so the agent does the maths.
  if (signals.div293ThresholdCents != null && report.income.gross_cents >= signals.div293ThresholdCents) {
    findings.push(f("div293_income", "threshold", "review", "Income is around the Div 293 super threshold",
      `Your recorded income (${money(report.income.gross_cents)}) is near or above the Division 293 threshold (${money(signals.div293ThresholdCents)}). Higher earners can pay an extra 15% on their concessional (before-tax) super contributions. This is a separate ATO assessment, not part of the position shown here — your registered tax agent will work out whether it applies.${DEFER}`, true, []));
  }
  // Audit wave 4 (trading_stock): the report carries a trading-stock adjustment only when the flag is
  // on and a row exists — surface the s 70-45 valuation-basis choice + the small-business movement
  // election as a defer nudge (the adjustment itself is already in the position).
  if (report.trading_stock) {
    const ts = report.trading_stock;
    findings.push(f("trading_stock_basis", "judgement", "review", "Trading stock recorded — confirm the valuation basis",
      `Opening stock ${money(ts.opening_cents)} and closing stock ${money(ts.closing_cents)}: the ${money(Math.abs(ts.adjustment_cents))} difference is ${ts.adjustment_cents >= 0 ? "added to" : "deducted from"} your business position. Each item can be valued at cost, market selling value or replacement value${ts.valuation_basis ? ` (you chose ${ts.valuation_basis.replace(/_/g, " ")})` : " — you haven't recorded which basis you used"}, and a small business whose stock moved by $5,000 or less can choose not to account for the change. Confirm the basis and the election with a registered tax agent.${DEFER}`, true, []));
  }
  // integrity_nudges: non-concessional (after-tax) super contributions above the reference cap. The cap
  // interacts with the 3-year bring-forward and the total-super-balance test, so we NEVER assert a
  // breach — the nudge names the cap and defers. (The NCC cap is a reference-only pack value.)
  if (signals.superNonConcessionalCapCents != null && (signals.nonConcessionalContributedCents ?? 0) > signals.superNonConcessionalCapCents) {
    findings.push(f("super_ncc_cap", "threshold", "review", "After-tax super contributions are above the annual non-concessional cap",
      `You've recorded ${money(signals.nonConcessionalContributedCents ?? 0)} of non-concessional (after-tax) super contributions, above the ${money(signals.superNonConcessionalCapCents)} annual cap. That can be fine — the bring-forward rule lets you use up to three years of caps at once — but it depends on your total super balance and prior-year contributions, which Quillo doesn't model. Confirm the position with a registered tax agent before lodging.${DEFER}`, true, []));
  }

  // Trust entities lodge their own return and must resolve distributions before 30 June — surfaced
  // for the agent (no trust position is modelled in the personal headline, so this is the one place
  // a trust is flagged at hand-off).
  for (const e of situation.entities) {
    if (e.kind === "trust") {
      findings.push(f(`trust_resolution:${e.id}`, "judgement", "review", `Trust "${e.name ?? "trust"}" — resolve distributions before 30 June`,
        `A trust generally must resolve how its income is distributed to beneficiaries before 30 June; an unresolved distribution can leave the trustee assessed at the highest rate of tax. This isn't reflected in your personal position — confirm the trust's distribution resolution and its own lodgment with a registered tax agent.${DEFER}`, true, []));
    }
  }
  // Prior-year capital loss captured at Set-up → a defer finding. CAPTURE-ONLY: it is NOT applied to
  // the indicative position (capital losses offset capital GAINS only — never ordinary income — and
  // there is no CGT-gain line in this position to net against). The agent applies it on the CGT schedule.
  if (signals.capitalLossCarryinCents > 0) {
    findings.push(f("capital_loss_carryin", "judgement", "info", `Prior-year capital loss carried forward (${money(signals.capitalLossCarryinCents)})`,
      `You've recorded a carried-forward capital loss. It is NOT applied to the position shown here — a capital loss can only offset a capital gain (never your salary, rental or other income), and is applied on the CGT schedule. Hand this figure to your registered tax agent to apply against any capital gains.${DEFER}`, true, []));
  }

  // (Super Notice-of-intent is surfaced via the year-end checklist (generateChecklist), not here, to
  // keep a clean PAYG-only return finding-free. PAYG-balance / Div 35 non-commercial-loss prompts are
  // deferred until sole-trader P&L is modelled — flagging them now would be noise or guesswork.)

  // ── (3) judgement passthrough — matched defer-to-agent rules for this situation ──
  for (const r of claimMatches) {
    if (!r.defer_to_agent) continue;
    findings.push(f(`rule:${r.id ?? `${r.scope_type}:${r.scope_value}`}`, "judgement", "review", noteTitle(r),
      suggestionText(r), true, []));
  }

  const blockers = findings.filter((x) => x.severity === "blocker").length;
  const review = findings.filter((x) => x.severity === "review").length;
  const info = findings.filter((x) => x.severity === "info").length;

  return {
    fy: report.fy,
    generated_at: generatedAt,
    position: {
      indicative_taxable_position_cents: report.taxable_position_cents,
      caption: "Indicative taxable position (income − deductions − depreciation). This is NOT your tax payable or refund.",
      lines,
      credits: {
        withholding_cents: report.income.withholding_cents,
        franking_credit_cents: report.income.franking_credit_cents,
        foreign_tax_paid_cents: report.income.foreign_tax_paid_cents,
        gst_credits_cents: report.gst_credits_cents,
      },
      per_property: report.per_property,
    },
    findings,
    handoff: { abn: report.abn, situation_summary: situationSummary(situation) },
    readiness_score: { blockers, review, info, ready: blockers === 0 },
    narrative: null,
    disclaimer: READINESS_DISCLAIMER,
  };
}

const DEFER = " Confirm with a registered tax agent.";

function f(id: string, category: FindingCategory, severity: FindingSeverity, title: string, note: string, defer: boolean, evidence: EvidenceRef[]): ReadinessFinding {
  return { id, category, severity, title, general_info_note: note, defer_to_agent: defer, evidence_refs: evidence };
}

function noteTitle(r: ClaimRule): string {
  if (r.scope_type === "property_status") return `Property treatment to confirm (${r.scope_value})`;
  if (r.scope_type === "entity_kind") return `Entity treatment to confirm (${r.scope_value})`;
  if (r.scope_type === "occupation") return `Occupation deduction to confirm (${r.scope_value})`;
  return "Treatment to confirm";
}

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function situationSummary(s: Situation): string {
  const bits: string[] = [];
  const self = s.persons.find((p) => p.role === "self") ?? s.persons[0];
  if (self?.occupation) bits.push(`Occupation: ${self.occupation}`);
  if (self && self.tax_residency !== "AU") bits.push(`Tax residency: ${self.tax_residency}`);
  if (s.entities.length) bits.push(`Entities: ${s.entities.map((e) => e.kind).join(", ")}`);
  if (s.properties.length) bits.push(`Properties: ${s.properties.map((p) => `${p.label} (${p.status})`).join("; ")}`);
  return bits.join(" · ") || "No additional situation details recorded.";
}
