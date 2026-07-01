import type { Env } from "../env";
import { COUNTABLE, COUNTABLE_INCOME } from "./queries";
import { incomeTotals, depreciationTotals, attributionTotals, companyPositions, cgtTotals, carriedTaxLossCents, essTotals, gstTotals, paygInstalmentsTotal, carLogbookPosition, carWorkKmFor, trustTotals, partnershipTotals, smsfFundPositions, separateTaxpayerEntityIds, superConcessionalDeduction, fyStartYearStr, type IncomeTotals, type AttributionTotals, type CompanyPosition, type GstPosition, type CarLogbookPosition, type SmsfFundPosition, type RulePackThresholds, type SuperDeduction } from "./ledger-totals";
import type { TrustTotals } from "./trust";
import type { CgtPortfolioResult } from "./cgt";
import type { EssAssessable } from "./ess";
import { featureOn } from "./features";
import { resolveLoanInterest, deductibleInterestCents, type LoanInterestSource } from "./loan-interest";
import auV1RulePack from "../rulepacks/au-v1.json";
import { computeWorkMethodDeductions, workUseRatesForFy, type WorkMethodDeductions, type WorkUseInputs } from "./work-use";
import { fyBounds, fyLabel as fyLabelOf } from "./ledger-totals";
import { resolveJurisdictionForUser, currentFyStartYearFor, fyStartYearForDate, baseCurrencyOf, AU_DESCRIPTOR, type JurisdictionDescriptor } from "./jurisdiction";

// Tax period is jurisdiction-driven (jurisdiction.ts). The optional descriptor defaults to AU so every
// existing caller stays byte-identical (AU = Jul 1 .. Jun 30); pass a resolved descriptor for a UK tenant.
export function currentFyStartYear(now = new Date(), descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): number {
  return currentFyStartYearFor(descriptor, now);
}

export interface ReportRow {
  bucket: string;
  ato_label: string | null;
  n: number;
  total_cents: number;
  gst_cents: number;
  deductibility?: string | null; // set on deduction_breakdown rows; absent on collapsed by_bucket/income rows
  reimbursed?: number | null;    // 0030: set on deduction_breakdown rows; reimbursed spend is excluded from the headline
  use_status_denied?: number | null; // 0031: 1 when the row's property is rent-free/renovating (excluded from the headline, kept visible)
  property_undetermined?: number | null; // #254: 1 when a property-bucket row can't yet land in an income-producing property (no property_id, or use_status not rented/available). Excluded from the headline when the flag is on, kept visible. 0 when the flag is off ⇒ byte-identical.
}

/**
 * Which section of the indicative position a captured expense row belongs to. The SINGLE source of
 * truth for "does this reduce the headline" — used by both buildReport (to sum gross_deductions) and
 * readiness.ts (to render the matching breakdown line), so the number and its explanation can never
 * drift. See scripts/check-units.ts for the reconciliation golden.
 *
 *  - "company"  → a company is a SEPARATE taxpayer; its spend never nets against the individual.
 *  - "excluded" → not an immediate individual deduction: capital ('asset'), uncategorised ('unknown'),
 *                 private/non-deductible (likely_not/confirmed_not), or pending apportionment. When
 *                 excludeNonDeductible is on, unresolved payg ('undetermined') is excluded too
 *                 (deny-by-default, s8-1).
 *  - "deduction" → counts toward the indicative position.
 *
 * When excludeNonDeductible is OFF the result is byte-identical to the legacy behaviour (only
 * company/asset/unknown were excluded; everything else counted).
 */
export type DeductionGroup = "deduction" | "excluded" | "company";
export function deductionGroupForRow(
  bucket: string,
  deductibility: string | null | undefined,
  excludeNonDeductible: boolean,
  reimbursed: number | null | undefined = 0,
  propertyDenied: number | null | undefined = 0,
  propertyUndetermined: number | null | undefined = 0,
): DeductionGroup {
  if (bucket === "company") return "company";
  // 0030: employer-reimbursed spend is never a deductible loss/outgoing (the employer bore the cost).
  // 0031: spend on a property held rent-free / off-market-renovating earns no income, so it's not a
  // deduction either (s8-1) — though CGT cost base still accrues elsewhere. Both stay VISIBLE as
  // excluded tracked-spend (not removed), so every surface that lists spend agrees; only the headline
  // drops them. Default 0 keeps legacy callers byte-identical.
  if (reimbursed) return "excluded";
  if (propertyDenied) return "excluded";
  // #254: a property-bucket expense that can't yet land in an income-producing property — no
  // property_id, or a property whose use_status isn't rented/genuinely-available — earns no assessable
  // rent yet, so deny-by-default (mirrors payg 'undetermined'). The caller passes a flag-gated 0/1
  // marker (0 when the flag is off), so this is byte-identical until the flag flips. Kept visible.
  if (propertyUndetermined) return "excluded";
  if (bucket === "asset" || bucket === "unknown") return "excluded";
  // A positive SUGGESTION is NEVER counted until the user confirms it → confirmed_deductible (B1).
  // Excluded regardless of the flag — a suggestion must not move the headline.
  if ((deductibility ?? "") === "suggested_deductible") return "excluded";
  if (!excludeNonDeductible) return "deduction"; // legacy: payg + property_* all counted
  const d = deductibility ?? "undetermined";
  if (d === "likely_not" || d === "confirmed_not" || d === "needs_apportionment") return "excluded";
  if (bucket === "payg" && d === "undetermined") return "excluded"; // deny-by-default for unresolved payg
  return "deduction";
}

/**
 * Whether a property-scoped row counts toward that property's negative-gearing deduction. The
 * per-property counterpart of deductionGroupForRow (NOTE the deliberate difference: a property
 * row left 'undetermined' still counts — deny-by-default applies to payg, not to a let property).
 * Shared with the accountant schedule so its per-property itemised rows tie back exactly.
 */
export function propertyRowCounts(
  r: { deductibility?: string | null; reimbursed?: number | null; use_status_denied?: number | null; property_undetermined?: number | null },
  excludeNonDeductible: boolean,
): boolean {
  const d = r.deductibility ?? "undetermined";
  // property_undetermined (#254) is a flag-gated 0/1 marker (0 when the flag is off), so adding it here
  // is byte-identical until the flag flips — at which point a property left undetermined stops counting.
  return !r.reimbursed && !r.use_status_denied && !r.property_undetermined && (!excludeNonDeductible || !(d === "likely_not" || d === "confirmed_not" || d === "needs_apportionment"));
}

// Per-property tax position (the negative-gearing figure): rent income − rental deductions −
// decline in value. net_cents < 0 = a rental loss that offsets other income.
export interface PropertyPosition {
  property_id: string;
  label: string | null;
  income_cents: number;
  deduction_cents: number;
  depreciation_cents: number;
  net_cents: number;
}

export interface Report {
  fy: string;
  start: string;
  end: string;
  // UK epic stop 2: the tenant's BASE currency (UK 'GBP', etc.), via baseCurrencyOf. All money figures
  // (amount_aud_cents) are in this currency. The SPA/CSV use it to render the right symbol/label.
  // OMITTED when the base is the legacy 'AUD' default (AU tenant, or the currency_base flag OFF) so the
  // AU report payload is BYTE-IDENTICAL (no new key) — every consumer defaults absent ⇒ 'AUD'/'$'/'en-AU'.
  // This is what keeps the AU report-snapshot fixture green and the owner's real AU return unperturbed.
  base_currency?: string;
  by_bucket: ReportRow[];               // expense buckets collapsed by (bucket, ato_label) — legacy display/CSV shape
  deduction_breakdown: ReportRow[];     // same rows split by deductibility (carries `deductibility`) — drives the position lines
  income_by_bucket: ReportRow[];        // money-in (bank credits) grouped by income bucket — informational, see note
  by_property: { property_id: string; label: string | null; n: number; total_cents: number }[];
  company_quarters: { quarter: string; total_cents: number; gst_cents: number }[];
  undated: { n: number; total_cents: number };
  undated_detail: { merchant: string | null; total_cents: number }[];
  abn: string | null;                  // company ABN (for the accountant header)
  gst_credits_cents: number;           // total GST/ITC captured on company expenses this FY
  // ── tax position (income − deductions − depreciation) ──
  income: IncomeTotals;
  depreciation_cents: number;
  per_property: PropertyPosition[];
  total_income_cents: number;
  total_deductions_cents: number;      // CAPTURED tracked spend this FY (pending review — NOT claimable yet)
  company_tracked_cents: number;       // BUSINESS/'company'-bucket spend this FY — tracked, NOT in the individual position
  refunds_cents: number;               // refund/reimbursement credits this FY netted against deductions (0 unless refund_netting is on; v2: only matched-deductible refunds)
  refunds_unmatched_cents?: number;    // #258: refund credits NOT netted (unlinked, or matched to a non-deductible/personal expense). Set only when refund_netting_v2 is on; drives the "link your refunds" nudge.
  refunds_unmatched_n?: number;
  resolved_deductible_cents: number;   // spend a year-end review has CONFIRMED deductible (~0 until review)
  // Computed WFH (fixed-rate) + car (cents-per-km) deductions from the per-FY work_use_inputs. Present
  // only when the `wfh_car_methods` flag is on AND the user supplied hours/km. Included in
  // total_deductions_cents. The itemised running costs these methods cover stay excluded (deny-by-
  // default needs_apportionment), so there's no double-claim. undefined ⇒ byte-identical legacy totals.
  work_method?: WorkMethodDeductions;
  // Phase 3b: true when the user supplied WFH/car inputs but THIS FY has no configured rate in the pack
  // (a prior year the active-FY switcher allowed) — so the deduction is intentionally NOT computed (would
  // over-claim at the current rate). The UI/readiness should prompt the user to enter it manually.
  work_method_rates_unavailable?: boolean;
  // Phase B / G2: deductions counted from explicit attributions (payer≠claimant) rather than the raw
  // transaction. Present only when the attribution_engine flag is on AND there are attribution rows.
  // individual_cents + property_cents are already inside gross_deductions/total_deductions (they reduce
  // the personal headline); company_cents is inside company_tracked_cents (a separate taxpayer). The
  // display layer renders matching lines so the position still equals the sum of its lines.
  attribution?: { individual_cents: number; company_cents: number; property_cents: number };
  // Phase C / G4: per-company position (a separate taxpayer). Present only when the attribution_engine
  // flag is on and the tenant has a company entity. The company's costs don't reduce the personal
  // headline — they sit here, netting to a carried-forward loss when pre-revenue.
  company_positions?: CompanyPosition[];
  // Raw company-bucket spend that couldn't be assigned to a specific company (2+ companies only).
  // Excluded from every company position and surfaced as a review item — never silently dropped.
  company_unattributed_cents?: number;
  company_unattributed_n?: number;
  // Rental-bucketed spend (property_rented/property_vacant) with property_id IS NULL: deducts at the
  // headline but is absent from every per-property schedule, so a property's position is silently short.
  // Surfaced as a readiness review item (set the property on those lines). Mirrors company_unattributed.
  property_unattributed_cents?: number;
  property_unattributed_n?: number;
  // Phase #138: net capital gain (shares/crypto/property disposals; 50% discount; loss offset/carry).
  // Present only when the cgt_engine flag is on AND there are CGT events. net_capital_gain_cents is
  // ADDED to taxable_position_cents (it's assessable income). undefined ⇒ byte-identical legacy totals.
  capital_gains?: CgtPortfolioResult;
  // Phase #141: assessable ESS discount (taxed-upfront / deferral). ADDED to taxable_position_cents
  // (employment income). The startup-concession portion is deferred to CGT, not counted here. Present
  // only when the ess_engine flag is on AND there are grants. undefined ⇒ byte-identical legacy totals.
  ess?: EssAssessable;
  // Phase #137: indicative BAS position (output GST − input credits). GST is NOT income tax — it is
  // NEVER added to taxable_position_cents. Present only when the gst_bas flag is on AND a business is
  // GST-registered. undefined ⇒ byte-identical legacy totals.
  gst?: GstPosition;
  // #174: total PAYG instalments recorded for the FY (pre-payments toward income tax). Informational —
  // NEVER in taxable_position. Present only when gst_bas is on AND a non-zero amount is recorded.
  payg_instalments_cents?: number;
  // Phase #142: logbook-method car deduction vs cents-per-km (informational — not yet swapped into the
  // position). Present only when the car_logbook flag is on AND a vehicle_logbook exists for the FY.
  car_logbook?: CarLogbookPosition;
  // Phase #139: assessable trust distributions to this person (character retained). ADDED to
  // taxable_position_cents. Present only when the trust_distributions flag is on AND there are rows.
  trust?: TrustTotals;
  // Slice E: a partner's share of partnership net income (character retained, ITAA36 Div 5). ADDED to
  // taxable_position_cents like a trust distribution. Present only when partnership_distributions is on AND rows exist.
  partnership?: TrustTotals;
  // Phase #140: per-SMSF fund position (a SEPARATE taxpayer, like a company). Fund taxable income after
  // ECPI. NEVER added to the member's personal taxable_position (the member's pension is tax-free, and
  // the fund's income is excluded from the personal headline). Present only when smsf_engine is on and
  // the tenant has an SMSF.
  smsf_funds?: SmsfFundPosition[];
  // Phase 3a: franking credits grossed up into assessable income (ITAA97 s207-20) — ADDED to the position.
  // The credit is also a refundable tax offset (out of scope: Quillo computes a position, not tax payable).
  // Present only when franking_gross_up is on AND there are franking credits. undefined ⇒ legacy totals.
  franking_gross_up_cents?: number;
  // Phase 3a: personal-deductible super contributions reduce assessable income (s290-150), capped at the
  // concessional cap. SUBTRACTED from the position. Employer SG / salary-sacrifice are pre-tax → never here.
  // Present only when super_deduction is on AND there are personal_deductible contributions.
  super_deduction?: { claimed_cents: number; contributed_cents: number; cap_cents: number; over_cap: boolean };
  taxable_position_cents: number;      // total_income + net capital gain + ESS discount + trust distributions + franking gross-up − deductions − depreciation − super (indicative)
  taxable_position_confirmed_cents?: number; // #255: CONFIRMED end of the range — as above but discretionary tracked spend swapped for resolved_deductible_cents (method-based deductions stay). ≥ taxable_position_cents. Present only when position_confirmed_range is on ⇒ byte-identical off.
}

/**
 * The amount a captured expense row contributes to the indicative position. When `honorApportion`
 * is on (flag `loan_split`), the CLAIMABLE (apportioned) portion wins — `deductible_amount_cents`,
 * set e.g. by the guided loan interest/principal split — so only the deductible interest of a
 * mortgage line counts, never the principal. This MUST stay in lockstep with the SUM(COALESCE(...))
 * expressions in buildReport's byBucket + byPropertyRaw queries (golden: check-units.ts). A row with
 * no apportioned amount falls back to gross, so flag-off (and every un-split row) is byte-identical.
 */
export function positionAmountCents(
  row: { deductibility?: string | null; deductible_amount_cents?: number | null; amount_aud_cents?: number | null; amount_cents?: number | null },
  honorApportion: boolean,
): number {
  // Honour the apportioned amount ONLY for rows the user has explicitly CONFIRMED deductible — the
  // state the guided loan-split (and a year-end review) writes. Every other state keeps gross. This is
  // critical: the 0021 backfill set deductible_amount_cents=0 on likely_not (private) rows, and those
  // must still DISPLAY their gross in the excluded section (they're filtered out of the headline
  // anyway by deductionGroupForRow). Scoping to confirmed_deductible also makes enabling the flag a
  // no-op for all existing data — only freshly-split/confirmed rows ever diverge from gross.
  if (honorApportion && row.deductibility === "confirmed_deductible" && row.deductible_amount_cents != null) {
    return row.deductible_amount_cents;
  }
  return row.amount_aud_cents ?? row.amount_cents ?? 0;
}

// ── Shared per-row SQL context ────────────────────────────────────────────────
// These clause builders are the SINGLE source of the WHERE/SUM fragments that decide which
// transaction rows count and for how much. buildReport AND buildAccountantSchedule (the itemised
// accountant export) both use them, so the itemised lines can never diverge from the engine totals
// (tie-back by construction — asserted per persona in scripts/check-personas.ts).

// Mirrors positionAmountCents EXACTLY: only confirmed_deductible rows count their apportioned amount;
// everything else (incl. likely_not rows the 0021 backfill stamped with deductible_amount_cents=0)
// keeps gross. `p` is the table-alias prefix ("" for byBucket, "t." for the property join).
export const claimExpr = (p: string) =>
  `CASE WHEN ${p}deductibility = 'confirmed_deductible' AND ${p}deductible_amount_cents IS NOT NULL THEN ${p}deductible_amount_cents ELSE COALESCE(${p}amount_aud_cents, ${p}amount_cents) END`;

// 0031: a property held rent-free for a relative, or off-market while renovating, earns no income
// => its expenses are NOT deductions (s8-1), though CGT cost base still accrues. We MARK such rows
// (a 0/1 flag) rather than removing them, so they stay visible as excluded tracked-spend and every
// surface that lists spend agrees; only the headline classifier drops them. Static string, no extra
// binds; only the genuinely-new use_status values deny and no existing row carries them, so the
// position is byte-identical until a user marks a property. `col` is the txn's property_id column.
export const useStatusDeniedExpr = (col: string) =>
  `(CASE WHEN EXISTS (SELECT 1 FROM properties pp WHERE pp.id = ${col} AND pp.use_status IN ('private_use_rent_free','under_renovation_not_available')) THEN 1 ELSE 0 END)`;

// #254 (Wave 1): a property-bucket expense (property_rented/property_vacant) that can't yet land in an
// income-producing property earns no assessable rent, so it's not a deduction yet (deny-by-default,
// mirroring payg 'undetermined'). It's "undetermined" when EITHER the row has no property_id (it can't
// land in any per-property schedule) OR its property's use_status isn't an income-producing one
// ('rented' / 'genuinely_available_for_rent') — i.e. NULL/undetermined/vacant_land/owner_occupied.
// MARKED 0/1 (kept visible as excluded tracked-spend, like 0030/0031); only the headline + per-property
// classifier drop it. UNLIKE useStatusDeniedExpr this MUST be flag-gated by the caller (return "0" when
// off) because existing data DOES trigger it (the unattributed property spend that over-states the
// position), so the change has to flip deliberately rather than the day the code ships. `bucketCol`/
// `idCol` are the surrounding query's bucket + property_id columns (alias-prefixed as needed).
export const propertyUndeterminedExpr = (bucketCol: string, idCol: string) =>
  `(CASE WHEN ${bucketCol} IN ('property_rented','property_vacant') AND (${idCol} IS NULL OR NOT EXISTS (SELECT 1 FROM properties pp WHERE pp.id = ${idCol} AND pp.use_status IN ('rented','genuinely_available_for_rent'))) THEN 1 ELSE 0 END)`;

// #254: the flag-GATED form — the literal "0" when the flag is off (⇒ byte-identical SQL/grouping),
// the real marker when on. Single source of truth for the gate so report.ts and accountant-schedule.ts
// can never disagree on the flag name or the off-value (mirrors how both share useStatusDeniedExpr).
export const propertyUndeterminedGatedExpr = (env: Env, bucketCol: string, idCol: string) =>
  featureOn(env, "position_excludes_property_undetermined") ? propertyUndeterminedExpr(bucketCol, idCol) : "0";

// Phase B / G2: when the attribution_engine flag is on, a transaction that has explicit
// transaction_attributions is counted via those (attributionTotals) instead of its raw amount — so
// it must be EXCLUDED from the raw byBucket/byPropertyRaw/company/resolved sums to avoid double
// counting. `on` false (or no attribution rows) ⇒ this clause is empty ⇒ byte-identical legacy path.
// `col` is the transaction's id column for the surrounding query's alias; no extra bind.
export const notAttributedExpr = (col: string, on: boolean) =>
  on ? ` AND NOT EXISTS (SELECT 1 FROM transaction_attributions ta WHERE ta.transaction_id = ${col})` : "";

// Exclude the legacy split rows ONLY for loans the v2 model supersedes (loanInterestV2Context).
// NULL-safe via COALESCE — `NOT (NULL = 'x')` is NULL (falsy) and would wrongly DROP every
// NULL-ato_label row. No superseded loans ⇒ empty clause ⇒ byte-identical legacy path. `p` is the
// alias; the bound `?`s are the loan ids, appended LAST in each query's bind list.
export const excludeSplitInterestExpr = (p: string, supersededLoanIds: string[]) =>
  supersededLoanIds.length
    ? ` AND NOT (COALESCE(${p}ato_label,'') = 'rental:interest' AND ${p}account_id IN (${supersededLoanIds.map(() => "?").join(",")}))`
    : "";

// Evidence-first loan interest (flag loan_interest_v2): the loan model is the source of a loan's
// deductible interest — resolved per property from loan_interest_summaries (the lender/statement
// actual) or a labelled rate×balance estimate, attributed by the loan→property deductible share.
// Computed UP FRONT so the set of loans it SUPERSEDES is known before the raw sums run (only those
// loans' legacy split rows get excluded — a loan with no v2 figure keeps its loan_split unchanged).
export interface LoanInterestV2Context {
  byProp: Map<string, number>;
  total_cents: number;
  // The loan ACCOUNT ids whose interest now comes from the v2 model — whose legacy per-line split rows
  // (ato_label='rental:interest') must be EXCLUDED from the raw sums to avoid double-counting. Exactly
  // one source per loan per FY; a loan with NO v2 figure (no summary, no rate+balance, no income-
  // producing property link) is NOT here, so its legacy split is untouched — no silent under-count.
  supersededLoanIds: string[];
  // Per-loan resolution detail for the accountant schedule's evidence column. Presentation only.
  loans: { loan_account_id: string; property_id: string; deductible_cents: number; source: LoanInterestSource }[];
}

export async function loanInterestV2Context(env: Env, userId: string, startYear: number): Promise<LoanInterestV2Context> {
  const byProp = new Map<string, number>();
  let total_cents = 0;
  const supersededLoanIds: string[] = [];
  const loans: LoanInterestV2Context["loans"] = [];
  if (!featureOn(env, "loan_interest_v2")) return { byProp, total_cents, supersededLoanIds, loans };
  const links = await env.DB.prepare(
    `SELECT lp.loan_account_id, lp.property_id, lp.deductible_interest_pct, a.interest_rate_pct, a.balance_cents
       FROM loans_properties lp
       JOIN accounts a   ON a.id = lp.loan_account_id AND a.user_id = lp.user_id
       JOIN properties p ON p.id = lp.property_id     AND p.user_id = lp.user_id
      WHERE lp.user_id = ? AND p.status IN ('rented','vacant')`,
  )
    .bind(userId)
    .all<{ loan_account_id: string; property_id: string; deductible_interest_pct: number; interest_rate_pct: number | null; balance_cents: number | null }>();
  const sumsRes = await env.DB.prepare(
    `SELECT loan_account_id, interest_cents, source FROM loan_interest_summaries WHERE user_id = ? AND fy = ?`,
  )
    .bind(userId, fyStartYearStr(startYear))
    .all<{ loan_account_id: string; interest_cents: number; source: string }>();
  const sumByLoan = new Map((sumsRes.results ?? []).map((s) => [s.loan_account_id, { interest_cents: s.interest_cents, source: s.source as LoanInterestSource }]));
  for (const link of links.results ?? []) {
    const resolved = resolveLoanInterest(sumByLoan.get(link.loan_account_id) ?? null, { interest_rate_pct: link.interest_rate_pct, balance_cents: link.balance_cents });
    if (!resolved) continue;
    const ded = deductibleInterestCents(resolved.interest_cents, link.deductible_interest_pct);
    if (ded <= 0) continue;
    byProp.set(link.property_id, (byProp.get(link.property_id) ?? 0) + ded);
    total_cents += ded;
    if (!supersededLoanIds.includes(link.loan_account_id)) supersededLoanIds.push(link.loan_account_id);
    loans.push({ loan_account_id: link.loan_account_id, property_id: link.property_id, deductible_cents: ded, source: resolved.source });
  }
  return { byProp, total_cents, supersededLoanIds, loans };
}

// Resolve the tenant's rule pack for the REPORT engines from the JURISDICTION DESCRIPTOR — the single
// source of truth for "which pack". The pack id is `descriptor.rulePackId` (AU ⇒ 'au-v1', UK ⇒ 'uk-2025'),
// loaded from the KV override `rulepack:<id>` with the bundled au-v1 as the fallback.
// Previously this re-read `profiles.rule_pack_ver` INDEPENDENTLY of the descriptor, so the tax-period math
// (descriptor-driven) and the thresholds/claimability (column-driven) could silently disagree — e.g. a UK
// tenant getting UK period under the AU pack. Now period and pack move together off the same descriptor.
// AU is byte-identical: AU_DESCRIPTOR.rulePackId === 'au-v1' === the legacy `rule_pack_ver` default, so an
// AU profile loads the same `rulepack:au-v1` (or the bundled fallback) as before. (A UK descriptor points at
// `uk-2025`, which falls back to bundled au-v1 until that pack ships — the seam is wired, the content defers.)
// Guarded for the test harness (no env.RULES binding) → bundled au-v1.
async function resolveRulePack(env: Env, userId: string, descriptor: JurisdictionDescriptor): Promise<RulePackThresholds> {
  // The JURISDICTION default is the base pack id; an explicit per-tenant `rule_pack_ver` pin overrides it.
  // The generic 'au-v1' is the legacy NOT-NULL column default and is treated as "unset" (⇒ use the
  // jurisdiction's pack), so a UK tenant whose column was never updated still gets uk-2025, not au-v1.
  let ver = descriptor.rulePackId || "au-v1";
  try {
    const p = await env.DB.prepare(`SELECT rule_pack_ver FROM profiles WHERE user_id = ?`).bind(userId).first<{ rule_pack_ver: string | null }>();
    if (p?.rule_pack_ver && p.rule_pack_ver !== "au-v1") ver = p.rule_pack_ver;
  } catch { /* no profile (test env) → jurisdiction default */ }
  try {
    const override = env.RULES ? await env.RULES.get(`rulepack:${ver}`, "json") : null;
    if (override) return override as RulePackThresholds;
  } catch { /* KV unavailable (test env) → bundled default */ }
  return auV1RulePack as unknown as RulePackThresholds;
}

export async function buildReport(env: Env, userId: string, startYear: number): Promise<Report> {
  // Resolve the tenant's jurisdiction once and thread it into every date-range (fyBounds) path, exactly
  // like resolveRulePack below. AU (or flag OFF) ⇒ Jul–Jun ⇒ byte-identical. Label-keyed totals
  // (incomeTotals/depreciationTotals/cgt/trust/super) need no descriptor — they match on the fy LABEL,
  // which is jurisdiction-agnostic.
  const jurisdiction = await resolveJurisdictionForUser(env, userId);
  const { start, end } = fyBounds(startYear, jurisdiction);
  const rulePack = await resolveRulePack(env, userId, jurisdiction);
  // Flag `loan_split`: when on, the position counts the claimable (apportioned) portion
  // (deductible_amount_cents) of a row instead of the gross — see positionAmountCents. The SUM
  // expressions below MUST mirror that helper exactly. Off ⇒ byte-identical legacy totals.
  const honorApportion = featureOn(env, "loan_split");
  const amtExpr = honorApportion ? claimExpr("") : "COALESCE(amount_aud_cents, amount_cents)";
  const amtExprT = honorApportion ? claimExpr("t.") : "COALESCE(t.amount_aud_cents, t.amount_cents)";

  const useStatusDenied = (col: string) => useStatusDeniedExpr(col);
  // #254: flag-gated property deny-by-default marker (the literal "0" when off ⇒ byte-identical SQL).
  const propUndetermined = (bucketCol: string, idCol: string) => propertyUndeterminedGatedExpr(env, bucketCol, idCol);

  const useAttributions = featureOn(env, "attribution_engine");
  const notAttributed = (col: string) => notAttributedExpr(col, useAttributions);

  const loanCtx = await loanInterestV2Context(env, userId, startYear);
  const loanInterestByProp = loanCtx.byProp;
  const loan_interest_total_cents = loanCtx.total_cents;
  const supersededLoanIds = loanCtx.supersededLoanIds;
  const excludeSplitInterest = (p: string) => excludeSplitInterestExpr(p, supersededLoanIds);

  // AUD totals (fall back to original when already AUD / pre-migration). Exclude duplicates.
  // Grouped by (bucket, ato_label, deductibility) so the deductibility-aware position can filter per
  // row; the legacy `by_bucket` shape is rebuilt by collapsing the deductibility dimension below.
  const byBucket = await env.DB.prepare(
    `SELECT bucket, ato_label, COALESCE(deductibility,'undetermined') AS deductibility,
            COALESCE(reimbursed,0) AS reimbursed, ${useStatusDenied("transactions.property_id")} AS use_status_denied,
            ${propUndetermined("bucket", "transactions.property_id")} AS property_undetermined,
            COUNT(*) AS n,
            COALESCE(SUM(${amtExpr}),0) AS total_cents,
            COALESCE(SUM(gst_cents),0) AS gst_cents
       FROM transactions
      WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND bucket IS NOT NULL AND ${COUNTABLE}${notAttributed("transactions.id")}${excludeSplitInterest("")}
      GROUP BY bucket, ato_label, deductibility, reimbursed, use_status_denied, property_undetermined ORDER BY bucket, total_cents DESC`,
  )
    .bind(userId, start, end, ...supersededLoanIds)
    .all<ReportRow>();

  // Income captured from bank credits this FY, grouped by income bucket. Shown as its own
  // section — NOT folded into total_income_cents (it would double-count a salary that also
  // arrived via a payslip in the income table). 'refund' is excluded. When income_dedupe is on,
  // credits the user has confirmed duplicate a documented income row (matched_income_id set) are
  // excluded here so the pair is counted once (via the income table).
  const dedupeClause = featureOn(env, "income_dedupe") ? " AND matched_income_id IS NULL" : "";
  const incomeByBucket = await env.DB.prepare(
    `SELECT bucket, ato_label, COUNT(*) AS n,
            COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total_cents,
            COALESCE(SUM(gst_cents),0) AS gst_cents
       FROM transactions
      WHERE user_id = ? AND txn_date >= ? AND txn_date <= ?
        AND bucket IN ('income_business','income_property','income_personal') AND ${COUNTABLE_INCOME}${dedupeClause}
      GROUP BY bucket, ato_label ORDER BY bucket, total_cents DESC`,
  )
    .bind(userId, start, end)
    .all<ReportRow>();

  const byPropertyRaw = await env.DB.prepare(
    `SELECT t.property_id, p.label, COALESCE(t.deductibility,'undetermined') AS deductibility,
            COALESCE(t.reimbursed,0) AS reimbursed, ${useStatusDenied("t.property_id")} AS use_status_denied,
            ${propUndetermined("t.bucket", "t.property_id")} AS property_undetermined,
            COUNT(*) AS n,
            COALESCE(SUM(${amtExprT}),0) AS total_cents
       FROM transactions t LEFT JOIN properties p ON p.id = t.property_id
      WHERE t.user_id = ? AND t.txn_date >= ? AND t.txn_date <= ? AND t.property_id IS NOT NULL AND ${COUNTABLE.replace(/\b(status|kind|matched_txn_id|direction|currency|amount_aud_cents)\b/g, "t.$1")}${notAttributed("t.id")}${excludeSplitInterest("t.")}
      GROUP BY t.property_id, deductibility, reimbursed, use_status_denied, property_undetermined`,
  )
    .bind(userId, start, end, ...supersededLoanIds)
    .all<{ property_id: string; label: string | null; deductibility: string; reimbursed: number; use_status_denied: number; property_undetermined: number; n: number; total_cents: number }>();

  // Rental-bucketed spend with NO property: it counts at the headline (byBucket has no property filter)
  // but is absent from every per-property schedule (byPropertyRaw filters property_id IS NOT NULL), so a
  // property's negative-gearing position is silently short. Surfaced as a readiness 'review' nudge —
  // mirrors company_unattributed. Same filter set as byBucket so the count is exactly the headline rows.
  const propertyUnattributed = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(${amtExpr}),0) AS total_cents
       FROM transactions
      WHERE user_id = ? AND txn_date >= ? AND txn_date <= ?
        AND bucket IN ('property_rented','property_vacant') AND property_id IS NULL
        AND ${COUNTABLE}${notAttributed("transactions.id")}${excludeSplitInterest("")}`,
  )
    .bind(userId, start, end, ...supersededLoanIds)
    .first<{ n: number; total_cents: number }>();

  // Receipts with no (or unparseable) date can't be assigned to any FY — surface them
  // explicitly instead of letting the date filter silently drop them from every report.
  const undated = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total_cents
       FROM transactions
      WHERE user_id = ? AND ${COUNTABLE}
        AND (txn_date IS NULL OR txn_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')`,
  )
    .bind(userId)
    .first<{ n: number; total_cents: number }>();

  // BAS quarters for the company bucket.
  const quarters = [
    { quarter: "Q1 Jul–Sep", s: `${startYear}-07-01`, e: `${startYear}-09-30` },
    { quarter: "Q2 Oct–Dec", s: `${startYear}-10-01`, e: `${startYear}-12-31` },
    { quarter: "Q3 Jan–Mar", s: `${startYear + 1}-01-01`, e: `${startYear + 1}-03-31` },
    { quarter: "Q4 Apr–Jun", s: `${startYear + 1}-04-01`, e: `${startYear + 1}-06-30` },
  ];
  const company_quarters: Report["company_quarters"] = [];
  for (const q of quarters) {
    const row = await env.DB.prepare(
      `SELECT COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total_cents,
              COALESCE(SUM(gst_cents),0) AS gst_cents
         FROM transactions WHERE user_id = ? AND bucket = 'company' AND ${COUNTABLE}
           AND COALESCE(reimbursed,0) = 0
           AND txn_date >= ? AND txn_date <= ?`,
    )
      .bind(userId, q.s, q.e)
      .first<{ total_cents: number; gst_cents: number }>();
    company_quarters.push({ quarter: q.quarter, total_cents: row?.total_cents ?? 0, gst_cents: row?.gst_cents ?? 0 });
  }

  // Company ABN for the accountant header (from the company entity's detail_json).
  let abn: string | null = null;
  const companyEntity = await env.DB.prepare(
    `SELECT detail_json FROM entities WHERE user_id = ? AND kind = 'company' AND active = 1 LIMIT 1`,
  )
    .bind(userId)
    .first<{ detail_json: string }>();
  if (companyEntity) {
    try {
      const d = JSON.parse(companyEntity.detail_json) as { abn?: string };
      abn = d.abn ?? null;
    } catch {
      /* ignore */
    }
  }

  // The undated receipts themselves (so they can be dated, not just counted).
  const undatedDetail = await env.DB.prepare(
    `SELECT merchant, COALESCE(amount_aud_cents, amount_cents) AS total_cents FROM transactions
      WHERE user_id = ? AND ${COUNTABLE}
        AND (txn_date IS NULL OR txn_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
      ORDER BY created_at LIMIT 50`,
  )
    .bind(userId)
    .all<{ merchant: string | null; total_cents: number }>();

  const breakdown = byBucket.results ?? [];
  // Legacy by_bucket: collapse the deductibility split back to one row per (bucket, ato_label) so the
  // CSV/dashboard parity and any existing consumer see the same shape as before.
  const collapsed = new Map<string, ReportRow>();
  for (const b of breakdown) {
    const key = `${b.bucket} ${b.ato_label ?? ""}`;
    const prev = collapsed.get(key);
    if (prev) {
      prev.n += b.n;
      prev.total_cents += b.total_cents;
      prev.gst_cents += b.gst_cents;
    } else {
      collapsed.set(key, { bucket: b.bucket, ato_label: b.ato_label, n: b.n, total_cents: b.total_cents, gst_cents: b.gst_cents });
    }
  }
  const rows = [...collapsed.values()];
  const gstCredits = rows.filter((b) => b.bucket === "company").reduce((s, b) => s + (b.gst_cents ?? 0), 0);

  // Deny-by-default deductions: when ON, only the classifier's "deduction" rows reduce the position
  // (private/non-deductible payg, capital and company spend drop out). OFF = byte-identical to legacy.
  const excludeNonDeductible = featureOn(env, "position_excludes_nondeductible");

  // ── Tax position via the money seam: income − deductions − depreciation ──
  // H1 (#134 follow-up): a company / trust / SMSF / partnership is a SEPARATE taxpayer — its income
  // belongs to THAT taxpayer (shown in the company/SMSF position), never in the individual's headline.
  // Exclude it unconditionally so an entity income row can't be double-counted into the personal
  // position. Personal income (entity_id NULL / an 'individual' entity) always stays. [] for
  // personal-only data ⇒ no-op (byte-identical). This subsumes the earlier SMSF-only carve-out.
  const separateIds = await separateTaxpayerEntityIds(env, userId);
  const income = await incomeTotals(env, userId, { startYear, excludeEntityIds: separateIds });
  const dep = await depreciationTotals(env, userId, startYear);
  // Phase B / G2: deductions that come from explicit attributions (payer≠claimant) rather than the
  // raw transaction. The attributed transactions were excluded from the raw sums above (notAttributed),
  // so these are added without double-counting. Flag off ⇒ all zeros ⇒ byte-identical. The attributed
  // amounts also feed the by_property DISPLAY (expenseByProp) and resolved_deductible_cents below, so
  // those secondary figures stay consistent with the headline (D.0).
  const attr: AttributionTotals = useAttributions
    ? await attributionTotals(env, userId, startYear, jurisdiction)
    : { individual_deduction_cents: 0, company_deduction_cents: 0, by_property: [] };
  // Phase C / G4: per-company position (separate taxpayer). Same flag — it's the attribution-routed
  // company deductions that make it meaningful. Empty when there's no company.
  const companyResult = useAttributions ? await companyPositions(env, userId, startYear, rulePack, jurisdiction) : { positions: [], unattributed_cents: 0, unattributed_n: 0 };
  const company_positions: CompanyPosition[] = companyResult.positions;
  // Collapse the per-property deductibility split: `expenseByProp` keeps the legacy by_property shape
  // (all spend per property); `expMap` holds only the DEDUCTIBLE portion (used for the negative-
  // gearing net) — when excludeNonDeductible is on, likely_not/confirmed_not/needs_apportionment drop
  // out (property 'undetermined' still counts, so a let property is unaffected by deny-by-default).
  const expenseByProp: { property_id: string; label: string | null; n: number; total_cents: number }[] = [];
  const expSeen = new Map<string, { property_id: string; label: string | null; n: number; total_cents: number }>();
  const expDeductMap = new Map<string, number>();
  for (const r of byPropertyRaw.results ?? []) {
    const prev = expSeen.get(r.property_id);
    if (prev) {
      prev.n += r.n;
      prev.total_cents += r.total_cents;
    } else {
      const row = { property_id: r.property_id, label: r.label, n: r.n, total_cents: r.total_cents };
      expSeen.set(r.property_id, row);
      expenseByProp.push(row);
    }
    // Reimbursed (0030) and rent-free/renovating-property (0031) spend never counts toward the
    // negative-gearing deduction, though it stays in expenseByProp as visible tracked-spend above.
    if (propertyRowCounts(r, excludeNonDeductible)) expDeductMap.set(r.property_id, (expDeductMap.get(r.property_id) ?? 0) + r.total_cents);
  }
  // Attribution-derived per-property deductions (their txns were excluded from byPropertyRaw) add to
  // the negative-gearing deduction AND the tracked-spend display for that property — the attributed
  // (owner-share) amount is what feeds this owner's position, so both stay consistent (D.0).
  for (const a of attr.by_property) {
    expDeductMap.set(a.property_id, (expDeductMap.get(a.property_id) ?? 0) + a.deduction_cents);
    const prev = expSeen.get(a.property_id);
    if (prev) {
      prev.total_cents += a.deduction_cents;
      prev.n += 1;
    } else {
      const row = { property_id: a.property_id, label: null, n: 1, total_cents: a.deduction_cents };
      expSeen.set(a.property_id, row);
      expenseByProp.push(row);
    }
  }
  // Fold the evidence-first loan interest (resolved up front) into the per-property deduction AND the
  // tracked-spend display, EXACTLY like an attribution property deduction — and it's added to the
  // headline via loan_interest_total_cents below. The legacy split rows it supersedes were already
  // excluded from byBucket/byPropertyRaw (excludeSplitInterest, scoped to supersededLoanIds), so there's
  // no double count. Restricted (at resolution) to income-producing properties, mirroring applyLoanSplit
  // — interest is only deductible against a property held to earn assessable income (s8-1). Off ⇒ empty.
  for (const [pid, ded] of loanInterestByProp) {
    expDeductMap.set(pid, (expDeductMap.get(pid) ?? 0) + ded);
    const prev = expSeen.get(pid);
    if (prev) {
      prev.total_cents += ded;
      prev.n += 1;
    } else {
      const row = { property_id: pid, label: null, n: 1, total_cents: ded };
      expSeen.set(pid, row);
      expenseByProp.push(row);
    }
  }

  const expMap = expSeen;
  const depByProp = new Map(dep.by_property.filter((d) => d.property_id).map((d) => [d.property_id as string, d.deduction_cents]));
  const rentByProp = new Map<string, number>();
  // Rental income per property (rent + foreign_rent attributed to a property this FY).
  const rentRows = await env.DB.prepare(
    `SELECT property_id, COALESCE(SUM(COALESCE(amount_aud_cents, gross_cents)),0) AS gross_cents
       FROM income WHERE user_id = ? AND fy = ? AND property_id IS NOT NULL
        AND income_type IN ('rent','foreign_rent') GROUP BY property_id`,
  )
    .bind(userId, `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`)
    .all<{ property_id: string; gross_cents: number }>();
  for (const r of rentRows.results ?? []) rentByProp.set(r.property_id, r.gross_cents);

  // Property labels + status for ids that have income/depreciation but no expense transactions this FY.
  const labelRows = await env.DB.prepare(`SELECT id, label, status FROM properties WHERE user_id = ?`).bind(userId).all<{ id: string; label: string | null; status: string | null }>();
  const labelMap = new Map((labelRows.results ?? []).map((r) => [r.id, r.label]));
  // Tenant ("renting_*") properties don't own a negative-gearing position — the user rents them, so
  // they have no rent received, no cost base and no CGT. Any business-premises rent still counts in
  // the company-bucket totals; it just shouldn't render as a per-property landlord position.
  const tenantPropIds = new Set((labelRows.results ?? []).filter((r) => (r.status ?? "").startsWith("renting_")).map((r) => r.id));

  // Union of every property that has income, deductions OR depreciation — so an agent-managed
  // rental whose only deductions are depreciation still shows its negative-gearing position.
  const propIds = new Set<string>([...expMap.keys(), ...rentByProp.keys(), ...depByProp.keys(), ...attr.by_property.map((a) => a.property_id)].filter((id) => !tenantPropIds.has(id)));
  const per_property: PropertyPosition[] = [...propIds].map((pid) => {
    const incomeC = rentByProp.get(pid) ?? 0;
    const deductionC = expDeductMap.get(pid) ?? 0;
    const depreciationC = depByProp.get(pid) ?? 0;
    return {
      property_id: pid,
      label: labelMap.get(pid) ?? expMap.get(pid)?.label ?? null,
      income_cents: incomeC,
      deduction_cents: deductionC,
      depreciation_cents: depreciationC,
      net_cents: incomeC - deductionC - depreciationC,
    };
  });

  // 'unknown'-bucket spend is not a sanctioned deduction — exclude it from the indicative position.
  // NOTE: total_deductions_cents is CAPTURED tracked spend (pending review), not a claimable figure
  // — deductibility is resolved at year-end review (the UI labels it "tracked spend").
  // Exclude 'unknown' (unsanctioned) and 'asset' (capital — it depreciates via the assets table,
  // counting it as spend would double-count against decline-in-value).
  // 'company' is BUSINESS/entity spend — it must NOT reduce the INDIVIDUAL's indicative position
  // (business income isn't in the personal income total either, so subtracting business expenses
  // produced a wrong, misleadingly-low personal headline for business users — review High #3). Track
  // it separately so the figure is still visible; full per-entity position scoping is a roadmap item.
  const company_tracked_cents =
    rows.filter((b) => b.bucket === "company").reduce((s, b) => s + (b.total_cents ?? 0), 0) +
    attr.company_deduction_cents; // attributions routing to the company (e.g. personally-paid SaaS)
  // Deny-by-default deductions: only rows the shared classifier puts in the "deduction" group count.
  // The breakdown carries deductibility; the same classifier drives the readiness display lines so
  // the headline == the sum of the "Deductions" lines (asserted by the reconciliation golden).
  // Attribution deductions that reduce the personal headline: the individual track AND the
  // rental-property track (negative gearing offsets salary, exactly as raw property expenses do via
  // byBucket). The company track is NOT here — a company is a separate taxpayer (it sits in
  // company_tracked_cents). Property attributions also feed per_property above; that mirrors how a raw
  // property expense appears in BOTH byBucket (headline) and byPropertyRaw (per-property display).
  const attr_property_total_cents = attr.by_property.reduce((s, a) => s + a.deduction_cents, 0);
  const gross_deductions_cents =
    breakdown
      .filter((b) => deductionGroupForRow(b.bucket, b.deductibility, excludeNonDeductible, b.reimbursed, b.use_status_denied, b.property_undetermined) === "deduction")
      .reduce((s, b) => s + (b.total_cents ?? 0), 0) +
    attr.individual_deduction_cents +
    attr_property_total_cents +
    // Evidence-first loan interest reduces the personal headline exactly as a raw property expense does
    // (negative gearing offsets salary); the legacy split rows it replaces were excluded above, and it
    // also feeds per_property — so the headline and the per-property display stay consistent. 0 when off.
    loan_interest_total_cents;

  // Refund netting (flag `refund_netting`): a refund/reimbursement is a CREDIT, so it's already
  // excluded from the debit-only deduction sum above — but it reduces real spend (e.g. a $200
  // refund on a $500 purchase = $300 net deductible). v1 nets globally: subtract total refund
  // credits from total deductions (floored at 0). Per-expense pairing is a later refinement.
  // When the flag is off, refunds_cents stays 0 and deductions are byte-identical to before.
  let refunds_cents = 0;
  let refunds_unmatched_cents = 0; // #258: refunds NOT netted (unlinked, or linked to a non-deductible/personal expense) — the nudge signal
  let refunds_unmatched_n = 0;
  if (featureOn(env, "refund_netting")) {
    if (featureOn(env, "refund_netting_v2")) {
      // #258: net a refund ONLY against the specific DEDUCTIBLE expense it reverses (refund_for_txn_id),
      // capped at that expense's amount. A refund with no link, or one whose matched expense isn't a
      // deduction (personal/non-deductible), is POSITION-NEUTRAL — a flatmate reimbursement or a personal
      // return must not reduce unrelated work/property deductions. Reuses deductionGroupForRow (same
      // use_status/property gates, alias 'e') so "deductible" means EXACTLY what the headline counts.
      const refundRows = await env.DB.prepare(
        `SELECT COALESCE(r.amount_aud_cents, r.amount_cents) AS refund_cents,
                r.refund_for_txn_id AS matched_id,
                e.bucket AS e_bucket, COALESCE(e.deductibility,'undetermined') AS e_deductibility,
                COALESCE(e.reimbursed,0) AS e_reimbursed,
                ${useStatusDenied("e.property_id")} AS e_use_status_denied,
                ${propUndetermined("e.bucket", "e.property_id")} AS e_property_undetermined,
                ${honorApportion ? claimExpr("e.") : "COALESCE(e.amount_aud_cents, e.amount_cents)"} AS e_cents
           FROM transactions r
           LEFT JOIN transactions e ON e.id = r.refund_for_txn_id AND e.user_id = r.user_id
          WHERE r.user_id = ? AND r.txn_date >= ? AND r.txn_date <= ? AND r.bucket = 'refund'
            AND ${COUNTABLE_INCOME.replace(/\b(status|kind|matched_txn_id|direction|currency|amount_aud_cents)\b/g, "r.$1")}`,
      )
        .bind(userId, start, end)
        .all<{ refund_cents: number; matched_id: string | null; e_bucket: string | null; e_deductibility: string; e_reimbursed: number; e_use_status_denied: number; e_property_undetermined: number; e_cents: number | null }>();
      // Cap netting PER matched expense at the amount that expense actually contributed to deductions
      // (e_cents is the claim-aware amount — apportioned via claimExpr when loan_split is on — so a
      // partly-deductible cost can't be over-netted). Track cumulative netting per expense so several
      // refunds pointing at the SAME expense can't collectively net more than it gave (a $400 + $300
      // refund on one $500 cost nets $500, not $700).
      const nettedPerExpense = new Map<string, number>();
      for (const r of refundRows.results ?? []) {
        const matchedDeductible = !!r.matched_id && !!r.e_bucket &&
          deductionGroupForRow(r.e_bucket, r.e_deductibility, excludeNonDeductible, r.e_reimbursed, r.e_use_status_denied, r.e_property_undetermined) === "deduction";
        if (matchedDeductible) {
          const already = nettedPerExpense.get(r.matched_id as string) ?? 0;
          const toNet = Math.max(0, Math.min(r.refund_cents ?? 0, (r.e_cents ?? 0) - already));
          refunds_cents += toNet;
          nettedPerExpense.set(r.matched_id as string, already + toNet);
        } else {
          refunds_unmatched_n += 1;
          refunds_unmatched_cents += r.refund_cents ?? 0;
        }
      }
    } else {
      // v1 (legacy): net ALL refund credits globally against the deduction pool.
      const refundRow = await env.DB.prepare(
        `SELECT COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total
           FROM transactions
          WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND bucket = 'refund' AND ${COUNTABLE_INCOME}`,
      )
        .bind(userId, start, end)
        .first<{ total: number }>();
      refunds_cents = refundRow?.total ?? 0;
    }
  }
  // Computed work-use deductions (WFH fixed-rate + car cents-per-km), flag-gated. These are NOT a %
  // of tracked spend — they're calculated from the per-FY work_use_inputs and REPLACE the itemised
  // running costs they cover (those stay excluded as needs_apportionment, so no double-claim). Off by
  // default (flag) ⇒ work_method stays undefined and the totals below are byte-identical to before.
  const fyLabel = `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
  let work_method: WorkMethodDeductions | undefined;
  let work_method_rates_unavailable = false; // WFH/car inputs exist but the FY has no configured rate (prior year)
  if (featureOn(env, "wfh_car_methods")) {
    const wu = await env.DB.prepare(`SELECT wfh_hours, car_work_km FROM work_use_inputs WHERE user_id = ? AND fy = ?`)
      .bind(userId, startYear)
      .first<{ wfh_hours: number | null; car_work_km: number | null }>();
    // #245 Slice 1: car cents-per-km km now lives in its own car_inputs table. When car_methods is on,
    // source it there (falling back to the legacy work_use_inputs.car_work_km read above when there's no
    // car_inputs row — the 0061 backfill seeds existing data). Off ⇒ the legacy column only ⇒ byte-identical.
    const car_work_km = featureOn(env, "car_methods")
      ? await carWorkKmFor(env, userId, startYear, wu?.car_work_km ?? null)
      : (wu?.car_work_km ?? null);
    const inputs: WorkUseInputs = { wfh_hours: wu?.wfh_hours ?? null, car_work_km };
    if ((inputs.wfh_hours ?? 0) > 0 || (inputs.car_work_km ?? 0) > 0) {
      const thresholds = (rulePack as { thresholds_by_fy?: Record<string, { wfh_fixed_rate_cents_per_hour?: number; car_cents_per_km?: number; car_km_cap?: number }> }).thresholds_by_fy?.[fyLabel];
      // Only compute when THIS FY has configured rates. Otherwise the rate resolver would silently apply
      // the CURRENT-FY default (70c WFH / 88c km) to a prior year — over-claiming, since the active-FY
      // switcher lets users do prior-year work. No rates ⇒ skip + flag, never a wrong figure.
      const hasRates = !!thresholds && (thresholds.wfh_fixed_rate_cents_per_hour != null || thresholds.car_cents_per_km != null);
      if (hasRates) {
        const computed = computeWorkMethodDeductions(inputs, workUseRatesForFy(thresholds));
        if (computed.total_cents > 0) work_method = computed;
      } else {
        work_method_rates_unavailable = true;
      }
    }
  }

  const total_deductions_cents = Math.max(0, gross_deductions_cents - refunds_cents) + (work_method?.total_cents ?? 0);
  // Phase #138: net capital gain is assessable income — add it to the position. Flag-gated; only set
  // when there are CGT events (cgtTotals returns a zero result otherwise → no field, no change).
  let capital_gains: CgtPortfolioResult | undefined;
  if (featureOn(env, "cgt_engine")) {
    const cgt = await cgtTotals(env, userId, startYear, rulePack);
    if (cgt.gross_capital_gains_cents > 0 || cgt.capital_losses_cents > 0) capital_gains = cgt;
  }
  // Phase #141: assessable ESS discount is employment income — add it to the position. Flag-gated; only
  // set when there are grants with an assessable or startup-deferred amount.
  let ess: EssAssessable | undefined;
  if (featureOn(env, "ess_engine")) {
    const e = await essTotals(env, userId, startYear, jurisdiction);
    if (e.assessable_discount_cents > 0 || e.startup_deferred_to_cgt_cents > 0) ess = e;
  }
  // Phase #139: assessable trust distributions to this person — employment-independent income. Flag-gated.
  let trust: TrustTotals | undefined;
  if (featureOn(env, "trust_distributions")) {
    const t = await trustTotals(env, userId, startYear);
    if (t.assessable_cents > 0 || t.franking_credit_cents > 0) trust = t;
  }
  // Slice E: a partner's share of partnership net income — assessable like a trust distribution. Flag-gated.
  let partnership: TrustTotals | undefined;
  if (featureOn(env, "partnership_distributions")) {
    const p = await partnershipTotals(env, userId, startYear);
    // `!== 0` (not `> 0`) so a NET LOSS is carried too — but only partnership_losses ON ever yields a
    // negative here (OFF floors partnershipTotals to ≥0), so the OFF path stays byte-identical.
    if (p.assessable_cents !== 0 || p.franking_credit_cents > 0) partnership = p;
  }
  // Phase 3a: franking credits are assessable income (gross-up, s207-20). The credit (income.franking +
  // any trust/partnership franking) is ADDED to the position when the flag is on. Off ⇒ byte-identical.
  let franking_gross_up_cents: number | undefined;
  if (featureOn(env, "franking_gross_up")) {
    const fc = income.franking_credit_cents + (trust?.franking_credit_cents ?? 0) + (partnership?.franking_credit_cents ?? 0);
    if (fc > 0) franking_gross_up_cents = fc;
  }
  // Phase 3a: personal-deductible super contributions reduce assessable income (s290-150), capped. Only
  // type='personal_deductible' counts (employer SG is pre-tax). SUBTRACTED. Off ⇒ byte-identical.
  let super_deduction: SuperDeduction | undefined;
  if (featureOn(env, "super_deduction")) {
    const cap = (rulePack as { thresholds_by_fy?: Record<string, { super_concessional_cap_cents?: number }> }).thresholds_by_fy?.[fyLabel]?.super_concessional_cap_cents ?? Number.MAX_SAFE_INTEGER;
    const sd = await superConcessionalDeduction(env, userId, startYear, cap);
    if (sd.contributed_cents > 0) super_deduction = sd;
  }
  // B2 (#71): prior-year ordinary tax loss from a confirmed NOA. Fetched once and applied to BOTH the
  // tracked and the confirmed-range positions below (it's an ATO-confirmed reduction, so it belongs in
  // the conservative floor too — like depreciation/super). Off ⇒ 0 ⇒ byte-identical for both.
  const carried_tax_loss_cents = featureOn(env, "carryforward_position") ? await carriedTaxLossCents(env, userId, startYear) : 0;
  const preLossPosition =
    income.gross_cents + (capital_gains?.net_capital_gain_cents ?? 0) + (ess?.assessable_discount_cents ?? 0) + (trust?.assessable_cents ?? 0) + (partnership?.assessable_cents ?? 0)
    + (franking_gross_up_cents ?? 0) - total_deductions_cents - dep.total_cents - (super_deduction?.claimed_cents ?? 0);
  // The loss offsets ONLY positive income — it can't push the position below zero; the unused remainder
  // stays carried (not modelled further).
  const tax_losses_applied_cents = Math.min(carried_tax_loss_cents, Math.max(0, preLossPosition));
  const taxable_position_cents = preLossPosition - tax_losses_applied_cents;
  // Phase #137: indicative BAS position — SEPARATE from income tax (never added to taxable_position).
  // Flag-gated; only surfaced when a business is GST-registered.
  let gst: GstPosition | undefined;
  let payg_instalments_cents: number | undefined;
  if (featureOn(env, "gst_bas")) {
    const g = await gstTotals(env, userId, startYear, jurisdiction);
    if (g.registered) gst = g;
    const payg = await paygInstalmentsTotal(env, userId, startYear);
    if (payg > 0) payg_instalments_cents = payg;
  }
  // Phase #142: logbook vs cents-per-km comparison (informational). Uses the cents-per-km figure already
  // computed in work_method. Flag-gated; null when there's no logbook for the FY.
  let car_logbook: CarLogbookPosition | undefined;
  if (featureOn(env, "car_logbook")) {
    car_logbook = (await carLogbookPosition(env, userId, startYear, work_method?.car_cents ?? 0)) ?? undefined;
  }
  // Phase #140: per-SMSF fund position (separate taxpayer) — NOT added to the personal position. Its
  // income is already excluded from the personal headline above (separateIds). Flag-gated.
  let smsf_funds: SmsfFundPosition[] | undefined;
  if (featureOn(env, "smsf_engine")) {
    const funds = await smsfFundPositions(env, userId, startYear);
    if (funds.length) smsf_funds = funds;
  }

  // Resolved-deductible: only spend a year-end review has CONFIRMED deductible (deductibility set
  // to a resolved state, with the apportioned amount when present). ~$0 until a review runs — by
  // design: mid-year we capture, we don't claim.
  const resolved = await env.DB.prepare(
    `SELECT COALESCE(SUM(COALESCE(deductible_amount_cents, amount_aud_cents, amount_cents)),0) AS total
       FROM transactions
      WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND ${COUNTABLE}
        AND deductibility IN ('likely_deductible','confirmed_deductible')
        -- Stay in lockstep with the headline gates: reimbursed (0030) / rent-free property (0031) spend
        -- is never resolved-deductible, so this figure can't claim what the position excludes.
        AND COALESCE(reimbursed,0) = 0
        -- Same loan_interest_v2 supersession as byBucket/byPropertyRaw: a legacy rental:interest split
        -- row replaced by an evidenced v2 figure must NOT be summed here too, or resolved double-counts it.
        AND ${useStatusDenied("transactions.property_id")} = 0${notAttributed("transactions.id")}${excludeSplitInterest("")}`,
  )
    .bind(userId, start, end, ...supersededLoanIds)
    .first<{ total: number }>();
  // Attributions are an explicit user decision (who claims what), so the attributed personal deductions
  // (individual + rental-property) count as resolved-deductible — keeping this figure in step with the
  // headline now that attributed txns are excluded from the raw resolved sum above (D.0).
  const resolved_deductible_cents = (resolved?.total ?? 0) + attr.individual_deduction_cents + attr_property_total_cents;

  // #255 (Wave 3): the CONFIRMED end of the position range. taxable_position_cents above is the TRACKED
  // (optimistic) end — it subtracts total_deductions_cents (captured spend pending review). This mirrors
  // it but swaps that discretionary tracked spend for resolved_deductible_cents (only what a year-end
  // review has CONFIRMED). Method-based, evidence-backed deductions (work-from-home/car methods,
  // depreciation, personal-deductible super) stay in the confirmed floor — they're substantiated by
  // calculation, not pending line-review. The gap (confirmed − tracked position) is exactly the
  // unresolved discretionary spend, so the Reports page can render confirmed→tracked as a range with the
  // optimistic part flagged "pending review". ADDITIVE: taxable_position_cents is unchanged; the field is
  // only emitted when the flag is on ⇒ byte-identical off.
  //
  // Clamp note (refund asymmetry): total_deductions_cents NETS refunds (max(0, gross − refunds)) but
  // resolved_deductible_cents does NOT (a refund row is bucket='refund', outside the resolved set, and
  // nothing decrements the matched expense's deductible amount). A refund netted against a resolved
  // expense would otherwise make confirmed_deductions > tracked deductions ⇒ confirmed position BELOW
  // tracked ⇒ the range inverts on a money surface. Cap the confirmed discretionary deduction at the
  // refund-netted tracked spend: you can't confirm-claim more than what's tracked net of refunds. This
  // restores the confirmed ≥ taxable_position_cents invariant (fewer deductions ⇒ higher taxable
  // position, so confirmed is the conservative endpoint) without over-penalising refunds that landed on
  // UNRESOLVED spend (min, not subtract).
  let taxable_position_confirmed_cents: number | undefined;
  if (featureOn(env, "position_confirmed_range")) {
    const confirmed_deductions_cents = Math.min(resolved_deductible_cents, Math.max(0, gross_deductions_cents - refunds_cents)) + (work_method?.total_cents ?? 0);
    const confirmedPreLoss =
      income.gross_cents + (capital_gains?.net_capital_gain_cents ?? 0) + (ess?.assessable_discount_cents ?? 0) + (trust?.assessable_cents ?? 0) + (partnership?.assessable_cents ?? 0)
      + (franking_gross_up_cents ?? 0) - confirmed_deductions_cents - dep.total_cents - (super_deduction?.claimed_cents ?? 0);
    // B2: the carried tax loss is ATO-confirmed, so it reduces the confirmed floor too (capped at the
    // confirmed pre-loss position). Off ⇒ carried_tax_loss_cents=0 ⇒ byte-identical.
    taxable_position_confirmed_cents = confirmedPreLoss - Math.min(carried_tax_loss_cents, Math.max(0, confirmedPreLoss));
  }

  // Emit base_currency ONLY when it's not the legacy 'AUD' default — an AU report (or flag OFF) stays
  // byte-identical (no new key in the payload / snapshot); a UK tenant surfaces 'GBP' for display.
  const baseCurrency = baseCurrencyOf(env, jurisdiction);
  return {
    fy: fyLabel,
    start,
    end,
    ...(baseCurrency !== "AUD" ? { base_currency: baseCurrency } : {}),
    by_bucket: rows,
    deduction_breakdown: breakdown,
    income_by_bucket: incomeByBucket.results ?? [],
    by_property: expenseByProp,
    company_quarters,
    undated: { n: undated?.n ?? 0, total_cents: undated?.total_cents ?? 0 },
    undated_detail: undatedDetail.results ?? [],
    abn,
    gst_credits_cents: gstCredits,
    income,
    depreciation_cents: dep.total_cents,
    per_property,
    total_income_cents: income.gross_cents,
    total_deductions_cents,
    company_tracked_cents,
    refunds_cents,
    refunds_unmatched_cents: refunds_unmatched_cents || undefined,
    refunds_unmatched_n: refunds_unmatched_n || undefined,
    resolved_deductible_cents,
    work_method,
    work_method_rates_unavailable: work_method_rates_unavailable || undefined,
    // Surface the attribution split so the display layer can render matching lines (keeping the
    // position == sum-of-lines invariant). Omitted entirely when there are no attributions.
    attribution:
      attr.individual_deduction_cents || attr.company_deduction_cents || attr_property_total_cents
        ? { individual_cents: attr.individual_deduction_cents, company_cents: attr.company_deduction_cents, property_cents: attr_property_total_cents }
        : undefined,
    company_positions: company_positions.length ? company_positions : undefined,
    company_unattributed_cents: companyResult.unattributed_cents || undefined,
    company_unattributed_n: companyResult.unattributed_n || undefined,
    property_unattributed_cents: (propertyUnattributed?.total_cents || 0) || undefined,
    property_unattributed_n: (propertyUnattributed?.n || 0) || undefined,
    capital_gains,
    ess,
    gst,
    payg_instalments_cents,
    car_logbook,
    trust,
    partnership,
    smsf_funds,
    franking_gross_up_cents,
    super_deduction,
    taxable_position_cents,
    taxable_position_confirmed_cents,
    // B2: surface the applied carried tax loss so the display layer can show the line. Omitted when zero
    // (flag OFF or no loss) ⇒ no new key in the AU snapshot / OFF payload ⇒ byte-identical.
    ...(tax_losses_applied_cents > 0 ? { tax_losses_applied_cents } : {}),
  };
}

/**
 * Financial-year LABEL for a date, e.g. "2025-26". null when the date is missing/unparseable. The
 * optional descriptor defaults to AU (Jul–Jun) so existing callers are byte-identical; pass a resolved
 * descriptor at write-time so a UK tenant's row buckets into the UK FY (Apr 6 boundary).
 */
export function fyForDate(txnDate: string | null, descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): string | null {
  if (!txnDate || !/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) return null;
  const startYear = fyStartYearForDate(descriptor, txnDate);
  return Number.isNaN(startYear) ? null : fyLabelOf(startYear);
}

export function reportToCsv(r: Report): string {
  const d = (c: number) => (c / 100).toFixed(2);
  // Base-currency-aware column headers (stop 2). AU ⇒ base='AUD' ⇒ '(AUD)' ⇒ byte-identical. The
  // figures themselves are base-currency cents regardless; only the header label changes for UK.
  const cur = r.base_currency ?? "AUD";
  const lines: string[] = [
    `Quillo tax summary,FY ${r.fy},${r.start} to ${r.end}`,
    `ABN,${r.abn ?? "(not set)"}`,
    `GST credits (ITC) on company expenses,${d(r.gst_credits_cents)}`,
    "General information only — not tax advice. Confirm with a registered tax/BAS agent.",
    "",
    `Tax position (indicative),Amount (${cur})`,
    `Total income (gross),${d(r.total_income_cents)}`,
    ...(r.refunds_cents > 0 ? [`Refunds/reimbursements (netted against deductions),${d(r.refunds_cents)}`] : []),
    ...(r.work_method && r.work_method.wfh_cents > 0 ? [`  • Working from home (fixed rate: ${r.work_method.wfh_hours} hrs × ${r.work_method.rates.wfh_cents_per_hour}c/hr),${d(r.work_method.wfh_cents)}`] : []),
    ...(r.work_method && r.work_method.car_cents > 0 ? [`  • Car (cents per km: ${Math.min(r.work_method.car_work_km, r.work_method.rates.car_km_cap)} km × ${r.work_method.rates.car_cents_per_km}c/km),${d(r.work_method.car_cents)}`] : []),
    `Total deductions${r.refunds_cents > 0 ? " (net of refunds)" : ""},${d(r.total_deductions_cents)}`,
    `Decline in value (depreciation),${d(r.depreciation_cents)}`,
    `Indicative taxable position (individual),${d(r.taxable_position_cents)}`,
    ...(r.company_tracked_cents > 0 ? [`Business/company spend (tracked separately — not in the individual position),${d(r.company_tracked_cents)}`] : []),
    "",
    `Income type,Count,Gross (${cur}),Withholding,Franking credit,Foreign tax paid`,
  ];
  for (const it of r.income.by_type) {
    lines.push(`${it.income_type},${it.n},${d(it.gross_cents)},${d(it.withholding_cents)},${d(it.franking_credit_cents)},${d(it.foreign_tax_paid_cents)}`);
  }
  lines.push("", `Bucket,ATO label,Count,Total (${cur}),GST`);
  for (const b of r.by_bucket) {
    lines.push(`${b.bucket},${b.ato_label ?? ""},${b.n},${d(b.total_cents)},${d(b.gst_cents)}`);
  }
  lines.push("", `Property,Rent income (${cur}),Deductions,Depreciation,Net (negative gearing)`);
  for (const p of r.per_property) {
    lines.push(`${(p.label ?? p.property_id).replace(/,/g, " ")},${d(p.income_cents)},${d(p.deduction_cents)},${d(p.depreciation_cents)},${d(p.net_cents)}`);
  }
  lines.push("", `Company BAS quarter,Total (${cur}),GST`);
  for (const q of r.company_quarters) lines.push(`${q.quarter},${d(q.total_cents)},${d(q.gst_cents)}`);
  if (r.undated_detail.length) {
    lines.push("", `Undated (assign a date so these land in an FY),Amount (${cur})`);
    for (const u of r.undated_detail) lines.push(`${(u.merchant ?? "—").replace(/,/g, " ")},${d(u.total_cents)}`);
  }
  return lines.join("\n") + "\n";
}
