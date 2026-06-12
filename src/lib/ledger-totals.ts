import type { Env } from "../env";
import { COUNTABLE, FX_CONVERTED } from "./queries";
import { classifyAttribution, splitAttribution } from "./attribution";
import { computeNetCapitalGain, cgtRulesForFy, type CgtPortfolioResult } from "./cgt";
import { essAssessable, type EssAssessable } from "./ess";
import { computeBasNet, type BasNet } from "./gst";
import { businessUsePct, logbookDeductionCents, chooseCarMethod } from "./car-logbook";
import { summariseTrustDistributions, type TrustTotals } from "./trust";
import { ecpiExemptFraction, computeSmsfPosition, type SmsfPosition } from "./smsf";
import auV1RulePack from "../rulepacks/au-v1.json";

// ── The single money-aggregation seam ─────────────────────────────────────────
// Income lives in its own table; deductions live in `transactions`; depreciation in
// `depreciation_schedule`. EVERY report/dashboard read goes through here so there is exactly
// one place that knows how to sum each, and the report is a real tax position (income −
// deductions − depreciation), not a deduction tally. AU FY is Jul–Jun.

// ── FY representation seam ─────────────────────────────────────────────────────
// `fy` is stored in three internally-consistent forms across the schema, and these helpers are the
// ONLY sanctioned way to produce/parse each — never open-code String(startYear) / Number(row.fy):
//   • LABEL  '2025-26'  → fyLabel()        : income, depreciation_schedule, cgt_events, super_contributions,
//                                             fy_checklist, company_tax_positions, rd_claims, trust_distributions,
//                                             vehicle_logbooks, payg_instalments, documents, opportunities, income_activities
//   • STARTSTR '2025'   → fyStartYearStr() : loan_interest_summaries, clarify_questions, accountant_runs
//   • INTEGER  2025     → (raw number)     : fy_signoff, work_use_inputs, chat_sessions, capital_loss_carryins(prior_fy), depreciation_opening_balances
// parseFyStartYear() reads ANY stored form back to the start-year number; normaliseFyLabel() coerces any
// caller input (number, '2025', '2025-26') to the canonical LABEL. A golden in check-units locks the per-table format.

/** FY label for a start year, e.g. 2025 -> '2025-26' (matches income.fy / depreciation_schedule.fy). */
export function fyLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** FY start year as a STRING ('2025') — the form stored by loan_interest_summaries.fy / clarify_questions.fy. */
export function fyStartYearStr(startYear: number): string {
  return String(startYear);
}

/** Parse ANY stored fy form ('2025' | '2025-26' | 2025) back to its start-year number; NaN if unparseable. */
export function parseFyStartYear(fy: string | number | null | undefined): number {
  if (fy == null || fy === "") return NaN;
  return typeof fy === "number" ? fy : parseInt(String(fy).slice(0, 4), 10);
}

/** Coerce any caller fy input to the canonical '2025-26' LABEL, or null if blank/unparseable. */
export function normaliseFyLabel(fy: string | number | null | undefined): string | null {
  if (fy == null || fy === "") return null;
  const s = String(fy);
  if (/^\d{4}-\d{2}$/.test(s)) return s; // already a label
  const y = parseFyStartYear(s);
  return Number.isNaN(y) ? null : fyLabel(y);
}

/** Calendar bounds of an AU FY start year. */
export function fyBounds(startYear: number): { start: string; end: string } {
  return { start: `${startYear}-07-01`, end: `${startYear + 1}-06-30` };
}

export interface IncomeTypeRow {
  income_type: string;
  n: number;
  gross_cents: number;
  net_cents: number;
  withholding_cents: number;
  franking_credit_cents: number;
  foreign_tax_paid_cents: number;
}

export interface IncomeTotals {
  by_type: IncomeTypeRow[];
  gross_cents: number;
  withholding_cents: number;
  franking_credit_cents: number;
  foreign_tax_paid_cents: number;
}

/** Income for an FY, optionally scoped to a person/property. Reads the AUD value for reporting. */
export async function incomeTotals(
  env: Env,
  userId: string,
  opts: { startYear: number; personId?: string; propertyId?: string; excludeEntityIds?: string[] },
): Promise<IncomeTotals> {
  const fy = fyLabel(opts.startYear);
  // Exclude foreign income we couldn't convert to AUD (flagged needs_review) from the headline —
  // never sum un-converted foreign cents as AUD. It's surfaced separately as a review item.
  const where: string[] = ["user_id = ?", "fy = ?", FX_CONVERTED];
  const binds: unknown[] = [userId, fy];
  if (opts.personId) {
    where.push("person_id = ?");
    binds.push(opts.personId);
  }
  if (opts.propertyId) {
    where.push("property_id = ?");
    binds.push(opts.propertyId);
  }
  // #140: keep a separate taxpayer's income (e.g. an SMSF fund) OUT of the individual's headline. Income
  // with NULL entity_id (personal) always stays. Empty/omitted ⇒ byte-identical legacy behaviour.
  if (opts.excludeEntityIds && opts.excludeEntityIds.length) {
    where.push(`(entity_id IS NULL OR entity_id NOT IN (${opts.excludeEntityIds.map(() => "?").join(",")}))`);
    binds.push(...opts.excludeEntityIds);
  }
  const res = await env.DB.prepare(
    `SELECT income_type, COUNT(*) AS n,
            COALESCE(SUM(COALESCE(amount_aud_cents, gross_cents)),0) AS gross_cents,
            COALESCE(SUM(COALESCE(net_cents, amount_aud_cents, gross_cents)),0) AS net_cents,
            COALESCE(SUM(withholding_cents),0) AS withholding_cents,
            COALESCE(SUM(franking_credit_cents),0) AS franking_credit_cents,
            COALESCE(SUM(foreign_tax_paid_cents),0) AS foreign_tax_paid_cents
       FROM income WHERE ${where.join(" AND ")}
      GROUP BY income_type ORDER BY gross_cents DESC`,
  )
    .bind(...binds)
    .all<IncomeTypeRow>();
  const rows = res.results ?? [];
  return {
    by_type: rows,
    gross_cents: rows.reduce((s, r) => s + r.gross_cents, 0),
    withholding_cents: rows.reduce((s, r) => s + r.withholding_cents, 0),
    franking_credit_cents: rows.reduce((s, r) => s + r.franking_credit_cents, 0),
    foreign_tax_paid_cents: rows.reduce((s, r) => s + r.foreign_tax_paid_cents, 0),
  };
}

/** Total countable deductions for an FY, optionally scoped to one property. */
export async function deductionTotalForProperty(
  env: Env,
  userId: string,
  startYear: number,
  propertyId: string,
): Promise<number> {
  const { start, end } = fyBounds(startYear);
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total_cents
       FROM transactions
      WHERE user_id = ? AND property_id = ? AND txn_date >= ? AND txn_date <= ? AND ${COUNTABLE}`,
  )
    .bind(userId, propertyId, start, end)
    .first<{ total_cents: number }>();
  return row?.total_cents ?? 0;
}

/** Decline-in-value (Div40 + Div43) for an FY, per property (and the grand total). */
export async function depreciationTotals(
  env: Env,
  userId: string,
  startYear: number,
): Promise<{ total_cents: number; by_property: { property_id: string | null; deduction_cents: number }[] }> {
  const fy = fyLabel(startYear);
  try {
    const res = await env.DB.prepare(
      `SELECT a.property_id AS property_id, COALESCE(SUM(d.deduction_cents),0) AS deduction_cents
         FROM depreciation_schedule d JOIN assets a ON a.id = d.asset_id
        WHERE d.user_id = ? AND d.fy = ?
          -- 0030: employer-owned / reimbursed assets earn the taxpayer no decline-in-value.
          AND COALESCE(a.owned_by,'self') <> 'employer' AND COALESCE(a.reimbursed,0) = 0
          -- 0031: plant in a rent-free / off-market-renovating property produces no deduction.
          AND NOT EXISTS (SELECT 1 FROM properties pp WHERE pp.id = a.property_id
                            AND pp.use_status IN ('private_use_rent_free','under_renovation_not_available'))
        GROUP BY a.property_id`,
    )
      .bind(userId, fy)
      .all<{ property_id: string | null; deduction_cents: number }>();
    const rows = res.results ?? [];
    return { total_cents: rows.reduce((s, r) => s + r.deduction_cents, 0), by_property: rows };
  } catch (e) {
    // Tolerate ONLY the pre-0008 "table doesn't exist yet" case — report zero rather than 500.
    // Any other error (D1 fault, future schema drift) must surface, not silently zero the report.
    if (/no such table/i.test((e as Error).message)) return { total_cents: 0, by_property: [] };
    throw e;
  }
}

export interface AttributionTotals {
  individual_deduction_cents: number; // adds to the personal headline deductions
  company_deduction_cents: number;    // adds to the company track (a separate taxpayer)
  by_property: { property_id: string; deduction_cents: number }[]; // adds to per-property negative gearing
}

/**
 * Phase B / G2: the deduction the position should count from transaction_attributions instead of the
 * raw transaction, when the attribution_engine flag is on. Sums the SNAPSHOTTED attributed_amount_cents
 * (owner-share × work-use already frozen by the writer) and routes each row by classifyAttribution:
 * individual → headline, company → company track, rental-property activity → the per-property position.
 * The caller excludes attributed transactions from the raw byBucket/byPropertyRaw sums so nothing is
 * double-counted. Reimbursed (0030) and rent-free/renovating-property (0031) spend is still gated out
 * here, mirroring the raw path. Empty table / zero rows → all zeros (legacy report unchanged).
 */
export async function attributionTotals(
  env: Env,
  userId: string,
  startYear: number,
): Promise<AttributionTotals> {
  const { start, end } = fyBounds(startYear);
  const empty: AttributionTotals = { individual_deduction_cents: 0, company_deduction_cents: 0, by_property: [] };
  try {
    const res = await env.DB.prepare(
      `SELECT ta.attributed_amount_cents AS attributed_amount_cents, ta.attributed_pct AS attributed_pct,
              ta.work_use_pct AS work_use_pct, COALESCE(t.amount_aud_cents, t.amount_cents) AS txn_amount,
              -- entity_type is set by 0032's backfill, but a NEW entity (situation-write) may not set it;
              -- fall back to kind so a freshly-created company still routes to the company track.
              COALESCE(e.entity_type, e.kind) AS entity_type,
              ia.activity_type AS activity_type, ia.property_id AS property_id,
              ta.deduction_provision AS deduction_provision
         FROM transaction_attributions ta
         JOIN transactions t ON t.id = ta.transaction_id AND t.user_id = ta.user_id
         LEFT JOIN entities e ON e.id = ta.entity_id
         LEFT JOIN income_activities ia ON ia.id = ta.income_activity_id
        WHERE ta.user_id = ? AND t.txn_date >= ? AND t.txn_date <= ?
          AND COALESCE(t.reimbursed,0) = 0
          AND ${COUNTABLE.replace(/\b(status|kind|matched_txn_id|direction|currency|amount_aud_cents)\b/g, "t.$1")}
          -- a rent-free / off-market-renovating property's costs are never deductible (0031)
          AND NOT EXISTS (SELECT 1 FROM properties pp WHERE pp.id = ia.property_id
                            AND pp.use_status IN ('private_use_rent_free','under_renovation_not_available'))`,
    )
      .bind(userId, start, end)
      .all<{ attributed_amount_cents: number | null; attributed_pct: number | null; work_use_pct: number | null; txn_amount: number | null; entity_type: string | null; activity_type: string | null; property_id: string | null; deduction_provision: string | null }>();
    let individual = 0;
    let company = 0;
    const byProp = new Map<string, number>();
    for (const r of res.results ?? []) {
      const track = classifyAttribution(r);
      if (track === "excluded") continue;
      // Prefer the snapshot; if a row stored only attributed_pct (the schema's XOR alternative), derive
      // the amount from the txn via the SAME pure helper the writer uses, so nothing silently drops.
      const amt = r.attributed_amount_cents ?? splitAttribution({ amount_cents: r.txn_amount ?? 0, owner_share_pct: r.attributed_pct, work_use_pct: r.work_use_pct });
      if (track === "property" && r.property_id) byProp.set(r.property_id, (byProp.get(r.property_id) ?? 0) + amt);
      else if (track === "company") company += amt;
      else individual += amt; // 'individual', or a property track with no property_id, lands in the headline
    }
    return {
      individual_deduction_cents: individual,
      company_deduction_cents: company,
      by_property: [...byProp].map(([property_id, deduction_cents]) => ({ property_id, deduction_cents })),
    };
  } catch (e) {
    // Tolerate ONLY "table doesn't exist yet" (pre-0034) — report zero rather than 500.
    if (/no such table/i.test((e as Error).message)) return empty;
    throw e;
  }
}

export interface CompanyPosition {
  entity_id: string;
  name: string | null;
  base_rate_entity: number;
  assessable_income_cents: number;
  deductions_cents: number;
  current_year_loss_cents: number;       // max(0, deductions − income) this FY
  carried_forward_losses_cents: number;  // prior-year losses brought in (subject to COT)
  total_carry_forward_cents: number;     // carried_forward + this year's loss
  shareholder_loan_balance_cents: number;// person→company funding (NOT Div 7A)
  rd_eligible: boolean;                  // turnover < cap AND registered (defer-to-agent)
}

export interface CompanyPositionsResult {
  positions: CompanyPosition[];
  // Raw bucket='company' spend that couldn't be assigned to a specific company (only happens with 2+
  // companies — a bare company-bucket row carries no entity_id). Surfaced as a review item so it's
  // never silently dropped from every company's position.
  unattributed_cents: number;
  unattributed_n: number;
}

/**
 * Phase C / G4: the per-company position. A Pty Ltd is a SEPARATE taxpayer — its costs don't reduce
 * the founder's salary; they net against company income and the excess becomes a carried-forward loss
 * (the founder's personally-paid costs reach the company via an attribution + shareholder loan). This
 * computes from source: company deductions = attributions routed to the company (+ raw company-bucket
 * spend when there is exactly one company) ; income = the income table scoped to the company; the
 * shareholder-loan balance = the person→company funding amount. R&D eligibility is a defer-to-agent
 * flag (never an auto-claim). Empty (no company / pre-0035) → []. Flag-gated by the caller.
 */
export async function companyPositions(env: Env, userId: string, startYear: number): Promise<CompanyPositionsResult> {
  const fy = fyLabel(startYear);
  const { start, end } = fyBounds(startYear);
  const empty: CompanyPositionsResult = { positions: [], unattributed_cents: 0, unattributed_n: 0 };
  try {
    const companies = (await env.DB.prepare(`SELECT id, name, COALESCE(base_rate_entity,0) AS base_rate_entity FROM entities WHERE user_id = ? AND (kind = 'company' OR entity_type = 'company')`).bind(userId).all<{ id: string; name: string | null; base_rate_entity: number }>()).results ?? [];
    if (!companies.length) return empty;
    const tFilter = COUNTABLE.replace(/\b(status|kind|matched_txn_id|direction|currency|amount_aud_cents)\b/g, "t.$1");
    // Per-company attributed deductions THIS FY (the loss is a per-FY flow).
    const attrRows = (await env.DB.prepare(
      `SELECT ta.entity_id AS entity_id, COALESCE(SUM(ta.attributed_amount_cents),0) AS ded
         FROM transaction_attributions ta
         JOIN transactions t ON t.id = ta.transaction_id AND t.user_id = ta.user_id
        WHERE ta.user_id = ? AND t.txn_date >= ? AND t.txn_date <= ? AND COALESCE(t.reimbursed,0) = 0 AND ${tFilter}
        GROUP BY ta.entity_id`,
    ).bind(userId, start, end).all<{ entity_id: string; ded: number }>()).results ?? [];
    const attrBy = new Map(attrRows.map((r) => [r.entity_id, r]));
    // Shareholder-loan balance is a CUMULATIVE stock (across all FYs), so it's computed all-time from
    // the attribution rows here (countable, reimbursed-excluded). This is the SOLE source — the old
    // shareholder_loans persistence was dark and was dropped in 0052.
    const loanRows = (await env.DB.prepare(
      `SELECT ta.entity_id AS entity_id, COALESCE(SUM(ta.attributed_amount_cents),0) AS loan
         FROM transaction_attributions ta
         JOIN transactions t ON t.id = ta.transaction_id AND t.user_id = ta.user_id
        WHERE ta.user_id = ? AND ta.creates_shareholder_loan = 1 AND COALESCE(t.reimbursed,0) = 0 AND ${tFilter}
        GROUP BY ta.entity_id`,
    ).bind(userId).all<{ entity_id: string; loan: number }>()).results ?? [];
    const loanBy = new Map(loanRows.map((r) => [r.entity_id, r.loan]));
    // Raw company-bucket spend (paid from the company's own account), excluding attributed txns
    // (already in `ded`) and reimbursed spend (0030). With ONE company it unambiguously belongs to it.
    // With 2+ companies a bare bucket='company' row carries no entity_id, so we CANNOT pin it to one
    // company — previously it was silently dropped (every multi-company position under-stated). Now we
    // surface it as a review item (unattributed_*) instead of dropping it or guessing companies[0].
    const single = companies.length === 1;
    const rawAgg = await env.DB.prepare(`SELECT COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total, COUNT(*) AS n FROM transactions WHERE user_id = ? AND bucket = 'company' AND txn_date >= ? AND txn_date <= ? AND COALESCE(reimbursed,0) = 0 AND ${COUNTABLE} AND NOT EXISTS (SELECT 1 FROM transaction_attributions ta WHERE ta.transaction_id = transactions.id)`).bind(userId, start, end).first<{ total: number; n: number }>();
    const rawTotal = rawAgg?.total ?? 0;
    const rawN = rawAgg?.n ?? 0;
    const rawCompany = single ? rawTotal : 0;
    const incomeRows = (await env.DB.prepare(`SELECT entity_id, COALESCE(SUM(COALESCE(amount_aud_cents, gross_cents)),0) AS inc FROM income WHERE user_id = ? AND fy = ? AND entity_id IS NOT NULL AND ${FX_CONVERTED} GROUP BY entity_id`).bind(userId, fy).all<{ entity_id: string; inc: number }>()).results ?? [];
    const incomeBy = new Map(incomeRows.map((r) => [r.entity_id, r.inc]));
    const rdRows = (await env.DB.prepare(`SELECT entity_id, eligible_expenditure_cents, aggregated_turnover_cents, registered_with_ausindustry FROM rd_claims WHERE user_id = ? AND fy = ?`).bind(userId, fy).all<{ entity_id: string; eligible_expenditure_cents: number; aggregated_turnover_cents: number; registered_with_ausindustry: number }>()).results ?? [];
    const rdBy = new Map(rdRows.map((r) => [r.entity_id, r]));
    const rdCap = (auV1Thresholds(fy)?.rd_refundable_turnover_cap_cents) ?? Number.MAX_SAFE_INTEGER;
    // Prior-year carried-forward losses already persisted (sum, gated by COT). 0 until a sign-off snapshots them.
    const priorRows = (await env.DB.prepare(`SELECT entity_id, COALESCE(SUM(current_year_loss_cents),0) AS prior FROM company_tax_positions WHERE user_id = ? AND fy < ? AND cot_satisfied = 1 GROUP BY entity_id`).bind(userId, fy).all<{ entity_id: string; prior: number }>()).results ?? [];
    const priorBy = new Map(priorRows.map((r) => [r.entity_id, r.prior]));

    const positions = companies.map((c, i) => {
      const a = attrBy.get(c.id);
      const deductions = (a?.ded ?? 0) + (i === 0 ? rawCompany : 0);
      const income = incomeBy.get(c.id) ?? 0;
      const loss = Math.max(0, deductions - income);
      const carried = priorBy.get(c.id) ?? 0;
      const rd = rdBy.get(c.id);
      return {
        entity_id: c.id,
        name: c.name,
        base_rate_entity: c.base_rate_entity,
        assessable_income_cents: income,
        deductions_cents: deductions,
        current_year_loss_cents: loss,
        carried_forward_losses_cents: carried,
        total_carry_forward_cents: carried + loss,
        shareholder_loan_balance_cents: loanBy.get(c.id) ?? 0,
        rd_eligible: !!rd && rd.registered_with_ausindustry === 1 && rd.aggregated_turnover_cents < rdCap,
      };
    });
    // With one company the raw spend is consumed into its position; with many it stays unassigned.
    return { positions, unattributed_cents: single ? 0 : rawTotal, unattributed_n: single ? 0 : rawN };
  } catch (e) {
    if (/no such table/i.test((e as Error).message)) return empty;
    throw e;
  }
}

// Per-FY thresholds from the bundled rule pack (company/R&D params live here, never in SQL).
function auV1Thresholds(fy: string): Record<string, number> | undefined {
  return (auV1RulePack as unknown as { thresholds_by_fy?: Record<string, Record<string, number>> }).thresholds_by_fy?.[fy];
}

export interface GstPosition extends BasNet {
  registered: boolean;
  source?: "recorded" | "ledger"; // "recorded" = summed from user-entered bas_periods; "ledger" = derived from income/gst_cents
}

/**
 * Choose the indicative BAS figures: a user's recorded bas_periods for the FY WIN over the ledger-
 * derived estimate (they're the actual lodged/draft numbers); fall back to the ledger when none. Pure
 * + unit-tested so the override precedence can't silently regress.
 */
export function basPositionFrom(recorded: { n: number; output_gst_cents: number; input_gst_cents: number } | null, ledger: BasNet): BasNet & { source: "recorded" | "ledger" } {
  if (recorded && recorded.n > 0) {
    return { output_gst_cents: recorded.output_gst_cents, input_gst_cents: recorded.input_gst_cents, net_gst_cents: recorded.output_gst_cents - recorded.input_gst_cents, source: "recorded" };
  }
  return { ...ledger, source: "ledger" };
}

/**
 * Phase #139: an individual beneficiary's assessable trust distributions for an FY, character retained.
 * Reads trust_distributions to a person in this tenant. Distributions to a corporate beneficiary feed
 * the company position (a later step), so they're excluded here. Flag-gated by trust_distributions.
 * Pre-0041 / no rows → all-zero (report byte-identical).
 */
export async function trustTotals(env: Env, userId: string, startYear: number): Promise<TrustTotals> {
  const fy = fyLabel(startYear);
  const zero: TrustTotals = { assessable_cents: 0, franking_credit_cents: 0, by_character: {} };
  try {
    const rows = (await env.DB.prepare(
      `SELECT character, amount_cents, franking_credit_cents
         FROM trust_distributions
        WHERE user_id = ? AND fy = ? AND beneficiary_person_id IS NOT NULL`,
    ).bind(userId, fy).all<{ character: string; amount_cents: number; franking_credit_cents: number }>()).results ?? [];
    if (!rows.length) return zero;
    return summariseTrustDistributions(rows);
  } catch (e) {
    if (/no such table/i.test((e as Error).message)) return zero;
    throw e;
  }
}

export interface SmsfFundPosition extends SmsfPosition {
  entity_id: string;
  name: string | null;
}

/**
 * Phase #140: per-SMSF fund position (a separate taxpayer) for an FY. Fund assessable income = the
 * income table scoped to the SMSF entity; ECPI exempt fraction = pension balance / total balance across
 * its members; fund taxable income = assessable × (1 − ECPI). The member's tax-free pension does NOT
 * touch the personal position — the caller excludes the SMSF entity's income from the individual
 * headline (incomeTotals excludeEntityIds). Flag-gated smsf_engine. No SMSF / pre-0042 → [].
 */
export async function smsfFundPositions(env: Env, userId: string, startYear: number): Promise<SmsfFundPosition[]> {
  const fy = fyLabel(startYear);
  try {
    const funds = (await env.DB.prepare(`SELECT id, name FROM entities WHERE user_id = ? AND entity_type = 'smsf'`).bind(userId).all<{ id: string; name: string | null }>()).results ?? [];
    if (!funds.length) return [];
    const out: SmsfFundPosition[] = [];
    for (const f of funds) {
      const members = (await env.DB.prepare(`SELECT pension_balance_cents, accumulation_balance_cents FROM smsf_members WHERE user_id = ? AND smsf_entity_id = ?`).bind(userId, f.id).all<{ pension_balance_cents: number; accumulation_balance_cents: number }>()).results ?? [];
      const assessable = (await env.DB.prepare(`SELECT COALESCE(SUM(COALESCE(amount_aud_cents, gross_cents)),0) AS inc FROM income WHERE user_id = ? AND fy = ? AND entity_id = ? AND ${FX_CONVERTED}`).bind(userId, fy, f.id).first<{ inc: number }>())?.inc ?? 0;
      const pos = computeSmsfPosition(assessable, ecpiExemptFraction(members));
      out.push({ entity_id: f.id, name: f.name, ...pos });
    }
    return out;
  } catch (e) {
    if (/no such table|no such column/i.test((e as Error).message)) return [];
    throw e;
  }
}

/** SMSF entity ids for a tenant (to exclude fund income from the personal headline). [] when none/pre-0032. */
export async function smsfEntityIds(env: Env, userId: string): Promise<string[]> {
  try {
    const rows = (await env.DB.prepare(`SELECT id FROM entities WHERE user_id = ? AND entity_type = 'smsf'`).bind(userId).all<{ id: string }>()).results ?? [];
    return rows.map((r) => r.id);
  } catch (e) {
    if (/no such table|no such column/i.test((e as Error).message)) return [];
    throw e;
  }
}

/**
 * Entity ids of every SEPARATE TAXPAYER a tenant holds — a company, trust, SMSF or partnership. Income
 * scoped to one of these belongs to THAT taxpayer (it shows in the company/SMSF position), never in the
 * individual's headline. The personal incomeTotals excludes these so a company/trust income row can't be
 * double-counted into the founder's position (H1). Personal income (entity_id NULL, or an 'individual'
 * entity) is never excluded. [] when none / pre-0032 — so the exclusion is a no-op for personal-only data.
 */
export async function separateTaxpayerEntityIds(env: Env, userId: string): Promise<string[]> {
  try {
    const rows = (await env.DB.prepare(
      `SELECT id FROM entities WHERE user_id = ?
         AND (entity_type IN ('company','trust','smsf','partnership','property_partnership') OR kind IN ('company','trust'))`,
    ).bind(userId).all<{ id: string }>()).results ?? [];
    return rows.map((r) => r.id);
  } catch (e) {
    if (/no such table|no such column/i.test((e as Error).message)) return [];
    throw e;
  }
}

export interface CarLogbookPosition {
  business_use_pct: number;
  running_costs_cents: number;
  car_dep_cents: number;
  logbook_deduction_cents: number;
  cents_per_km_cents: number;          // the cents-per-km figure being compared against
  recommended_method: "logbook" | "cents_per_km";
  recommended_cents: number;
}

/**
 * Phase #142: the logbook-method car deduction for an FY, compared to cents-per-km. business-use % ×
 * (running costs + the car asset's decline-in-value). INFORMATIONAL — surfaced so a high-km driver sees
 * that the logbook beats the capped cents-per-km; the position-swap (and excluding the overlapping car
 * depreciation/running costs) is a careful follow-up. Flag-gated by car_logbook. No logbook row → null.
 */
export async function carLogbookPosition(env: Env, userId: string, startYear: number, centsPerKmCents: number): Promise<CarLogbookPosition | null> {
  const fy = fyLabel(startYear);
  try {
    const lb = await env.DB.prepare(`SELECT asset_id, business_km, total_km, running_costs_cents, business_use_pct FROM vehicle_logbooks WHERE user_id = ? AND fy = ? LIMIT 1`)
      .bind(userId, fy)
      .first<{ asset_id: string | null; business_km: number | null; total_km: number | null; running_costs_cents: number; business_use_pct: number | null }>();
    if (!lb) return null;
    const pct = lb.business_use_pct != null ? lb.business_use_pct : businessUsePct(lb.business_km, lb.total_km);
    const carDep = lb.asset_id
      ? (await env.DB.prepare(`SELECT COALESCE(SUM(deduction_cents),0) AS d FROM depreciation_schedule WHERE user_id = ? AND fy = ? AND asset_id = ?`).bind(userId, fy, lb.asset_id).first<{ d: number }>())?.d ?? 0
      : 0;
    const logbookCents = logbookDeductionCents(lb.running_costs_cents, carDep, pct);
    const choice = chooseCarMethod(logbookCents, centsPerKmCents);
    return {
      business_use_pct: pct,
      running_costs_cents: lb.running_costs_cents,
      car_dep_cents: carDep,
      logbook_deduction_cents: logbookCents,
      cents_per_km_cents: centsPerKmCents,
      recommended_method: choice.method,
      recommended_cents: choice.deduction_cents,
    };
  } catch (e) {
    if (/no such table|no such column/i.test((e as Error).message)) return null;
    throw e;
  }
}

/**
 * Phase #137: an INDICATIVE BAS position for an FY. Output GST = 1/11th of taxable-supply business
 * income; input GST credits = gst_cents captured on countable business inputs. Only meaningful when a
 * business is GST-registered (per-entity entities.gst_registered, or the tenant default
 * profiles.gst_registered). GST is NOT income tax — the caller keeps this OUT of taxable_position.
 * Flag-gated by gst_bas. Pre-0039 / not registered → registered:false with zeros. Quillo never lodges.
 */
export async function gstTotals(env: Env, userId: string, startYear: number): Promise<GstPosition> {
  const fy = fyLabel(startYear);
  const { start, end } = fyBounds(startYear);
  const notRegistered: GstPosition = { registered: false, output_gst_cents: 0, input_gst_cents: 0, net_gst_cents: 0 };
  try {
    // Registered if any entity is flagged, or the tenant default profile flag is set.
    const entReg = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM entities WHERE user_id = ? AND COALESCE(gst_registered,0) = 1`).bind(userId).first<{ n: number }>())?.n ?? 0;
    const profReg = (await env.DB.prepare(`SELECT COALESCE(gst_registered,0) AS g FROM profiles WHERE user_id = ?`).bind(userId).first<{ g: number }>())?.g ?? 0;
    if (entReg === 0 && profReg === 0) return notRegistered;
    // Taxable supplies: sole-trader / business income for the FY (GST-inclusive).
    const sales = (await env.DB.prepare(`SELECT COALESCE(SUM(COALESCE(amount_aud_cents, gross_cents)),0) AS s FROM income WHERE user_id = ? AND fy = ? AND income_type = 'business' AND ${FX_CONVERTED}`).bind(userId, fy).first<{ s: number }>())?.s ?? 0;
    // Input credits: GST captured on countable business inputs this FY.
    const inputs = (await env.DB.prepare(`SELECT COALESCE(SUM(gst_cents),0) AS g FROM transactions WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND bucket IN ('company','payg') AND ${COUNTABLE}`).bind(userId, start, end).first<{ g: number }>())?.g ?? 0;
    // User-entered BAS periods for the FY WIN over the ledger estimate (the actual lodged/draft figures).
    const recorded = await env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(output_gst_cents),0) AS output_gst_cents, COALESCE(SUM(input_gst_cents),0) AS input_gst_cents
         FROM bas_periods WHERE user_id = ? AND period_start >= ? AND period_end <= ?`,
    ).bind(userId, start, end).first<{ n: number; output_gst_cents: number; input_gst_cents: number }>();
    return { registered: true, ...basPositionFrom(recorded, computeBasNet(sales, inputs)) };
  } catch (e) {
    if (/no such table|no such column/i.test((e as Error).message)) return notRegistered;
    throw e;
  }
}

/**
 * #174: total PAYG instalments the user recorded for the FY (pre-payments of income tax toward their
 * own return). Informational only — NEVER added to taxable_position (it's a payment, not income/a
 * deduction). Pre-table / none → 0 (report byte-identical). Flag-gated by the caller (gst_bas).
 */
export async function paygInstalmentsTotal(env: Env, userId: string, startYear: number): Promise<number> {
  const fy = fyLabel(startYear);
  try {
    return (await env.DB.prepare(`SELECT COALESCE(SUM(instalment_cents),0) AS c FROM payg_instalments WHERE user_id = ? AND fy = ?`).bind(userId, fy).first<{ c: number }>())?.c ?? 0;
  } catch (e) {
    if (/no such table|no such column/i.test((e as Error).message)) return 0;
    throw e;
  }
}

/**
 * Phase #141: assessable ESS discount for an FY. Sums ess_grants whose taxing point falls in the FY,
 * classifying upfront/deferral as assessable income now and the startup concession as deferred-to-CGT.
 * Flag-gated by the caller (ess_engine). Empty / pre-0038 → all-zero (report byte-identical).
 */
export async function essTotals(env: Env, userId: string, startYear: number): Promise<EssAssessable> {
  const { start, end } = fyBounds(startYear);
  const zero: EssAssessable = { assessable_discount_cents: 0, startup_deferred_to_cgt_cents: 0, ineligible_startup_flag: false };
  try {
    const grants = (await env.DB.prepare(
      `SELECT scheme_type, discount_cents, ownership_gt_10pct
         FROM ess_grants
        WHERE user_id = ? AND COALESCE(taxing_point_date, grant_date) >= ? AND COALESCE(taxing_point_date, grant_date) <= ?`,
    ).bind(userId, start, end).all<{ scheme_type: string; discount_cents: number; ownership_gt_10pct: number }>()).results ?? [];
    if (!grants.length) return zero;
    return essAssessable(grants.map((g) => ({ scheme_type: g.scheme_type, discount_cents: g.discount_cents, ownership_gt_10pct: g.ownership_gt_10pct === 1 })));
  } catch (e) {
    if (/no such table/i.test((e as Error).message)) return zero;
    throw e;
  }
}

/**
 * Phase #138: the net capital gain for an FY — the single assessable CGT line that feeds taxable
 * income. Sums cgt_events of the FY (joined to their asset for the acquisition date / discount clock),
 * offsets carried-forward capital losses (capital_loss_carryins), and applies the 50% discount via the
 * pure computeNetCapitalGain. Flag-gated by the caller (cgt_engine). Empty / pre-0037 → a zero result
 * (report byte-identical to today). Net capital gain feeds TAXABLE INCOME — never tax payable.
 */
export async function cgtTotals(env: Env, userId: string, startYear: number): Promise<CgtPortfolioResult> {
  const fy = fyLabel(startYear);
  const zero: CgtPortfolioResult = { gross_capital_gains_cents: 0, capital_losses_cents: 0, discount_applied_cents: 0, net_capital_gain_cents: 0, loss_carried_forward_cents: 0 };
  try {
    const events = (await env.DB.prepare(
      `SELECT ev.proceeds_cents AS proceeds_cents, ev.cost_base_used_cents AS cost_base_used_cents,
              ev.discount_eligible AS discount_eligible, ev.event_date AS event_date,
              a.acquired_date AS acquired_date
         FROM cgt_events ev JOIN cgt_assets a ON a.id = ev.cgt_asset_id AND a.user_id = ev.user_id
        WHERE ev.user_id = ? AND ev.fy = ?`,
    ).bind(userId, fy).all<{ proceeds_cents: number; cost_base_used_cents: number; discount_eligible: number | null; event_date: string | null; acquired_date: string | null }>()).results ?? [];
    if (!events.length) return zero;
    // Carried-forward capital losses from prior FYs (capital_loss_carryins is capture-only set-up data).
    const priorFy = startYear; // carry-ins use the prior FY *start year* (integer)
    const prior = (await env.DB.prepare(`SELECT COALESCE(SUM(loss_cents),0) AS loss FROM capital_loss_carryins WHERE user_id = ? AND prior_fy < ?`).bind(userId, priorFy).first<{ loss: number }>())?.loss ?? 0;
    const rules = cgtRulesForFy(auV1Thresholds(fy) as { cgt_discount_keep_fraction?: number } | undefined);
    return computeNetCapitalGain(
      events.map((e) => ({
        proceeds_cents: e.proceeds_cents,
        cost_base_used_cents: e.cost_base_used_cents,
        discount_eligible: e.discount_eligible == null ? null : e.discount_eligible === 1,
        acquired_date: e.acquired_date,
        event_date: e.event_date,
      })),
      rules,
      prior,
    );
  } catch (e) {
    if (/no such table/i.test((e as Error).message)) return zero;
    throw e;
  }
}
