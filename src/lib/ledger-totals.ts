import type { Env } from "../env";
import { COUNTABLE } from "./queries";
import { classifyAttribution, splitAttribution } from "./attribution";
import { computeNetCapitalGain, cgtRulesForFy, type CgtPortfolioResult } from "./cgt";
import { essAssessable, type EssAssessable } from "./ess";
import auV1RulePack from "../rulepacks/au-v1.json";

// ── The single money-aggregation seam ─────────────────────────────────────────
// Income lives in its own table; deductions live in `transactions`; depreciation in
// `depreciation_schedule`. EVERY report/dashboard read goes through here so there is exactly
// one place that knows how to sum each, and the report is a real tax position (income −
// deductions − depreciation), not a deduction tally. AU FY is Jul–Jun.

/** FY label for a start year, e.g. 2025 -> '2025-26' (matches income.fy / depreciation_schedule.fy). */
export function fyLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
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
  opts: { startYear: number; personId?: string; propertyId?: string },
): Promise<IncomeTotals> {
  const fy = fyLabel(opts.startYear);
  const where: string[] = ["user_id = ?", "fy = ?"];
  const binds: unknown[] = [userId, fy];
  if (opts.personId) {
    where.push("person_id = ?");
    binds.push(opts.personId);
  }
  if (opts.propertyId) {
    where.push("property_id = ?");
    binds.push(opts.propertyId);
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
          AND ${COUNTABLE.replace(/\b(status|kind|matched_txn_id|direction)\b/g, "t.$1")}
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

/**
 * Phase C / G4: the per-company position. A Pty Ltd is a SEPARATE taxpayer — its costs don't reduce
 * the founder's salary; they net against company income and the excess becomes a carried-forward loss
 * (the founder's personally-paid costs reach the company via an attribution + shareholder loan). This
 * computes from source: company deductions = attributions routed to the company (+ raw company-bucket
 * spend when there is exactly one company) ; income = the income table scoped to the company; the
 * shareholder-loan balance = the person→company funding amount. R&D eligibility is a defer-to-agent
 * flag (never an auto-claim). Empty (no company / pre-0035) → []. Flag-gated by the caller.
 */
export async function companyPositions(env: Env, userId: string, startYear: number): Promise<CompanyPosition[]> {
  const fy = fyLabel(startYear);
  const { start, end } = fyBounds(startYear);
  try {
    const companies = (await env.DB.prepare(`SELECT id, name, COALESCE(base_rate_entity,0) AS base_rate_entity FROM entities WHERE user_id = ? AND (kind = 'company' OR entity_type = 'company')`).bind(userId).all<{ id: string; name: string | null; base_rate_entity: number }>()).results ?? [];
    if (!companies.length) return [];
    const tFilter = COUNTABLE.replace(/\b(status|kind|matched_txn_id|direction)\b/g, "t.$1");
    // Per-company attributed deductions THIS FY (the loss is a per-FY flow).
    const attrRows = (await env.DB.prepare(
      `SELECT ta.entity_id AS entity_id, COALESCE(SUM(ta.attributed_amount_cents),0) AS ded
         FROM transaction_attributions ta
         JOIN transactions t ON t.id = ta.transaction_id AND t.user_id = ta.user_id
        WHERE ta.user_id = ? AND t.txn_date >= ? AND t.txn_date <= ? AND COALESCE(t.reimbursed,0) = 0 AND ${tFilter}
        GROUP BY ta.entity_id`,
    ).bind(userId, start, end).all<{ entity_id: string; ded: number }>()).results ?? [];
    const attrBy = new Map(attrRows.map((r) => [r.entity_id, r]));
    // Shareholder-loan balance is a CUMULATIVE stock (across all FYs), so it's computed all-time — the
    // SAME filter syncShareholderLoans persists with (countable, reimbursed-excluded), so the on-screen
    // figure and the persisted hand-off agree.
    const loanRows = (await env.DB.prepare(
      `SELECT ta.entity_id AS entity_id, COALESCE(SUM(ta.attributed_amount_cents),0) AS loan
         FROM transaction_attributions ta
         JOIN transactions t ON t.id = ta.transaction_id AND t.user_id = ta.user_id
        WHERE ta.user_id = ? AND ta.creates_shareholder_loan = 1 AND COALESCE(t.reimbursed,0) = 0 AND ${tFilter}
        GROUP BY ta.entity_id`,
    ).bind(userId).all<{ entity_id: string; loan: number }>()).results ?? [];
    const loanBy = new Map(loanRows.map((r) => [r.entity_id, r.loan]));
    // Raw company-bucket spend (paid from the company's own account) — only unambiguous with one company.
    // Excludes attributed txns (already in `ded`) AND reimbursed spend (the 0030 invariant) — no double
    // count, no over-claim.
    const rawCompany = companies.length === 1
      ? (await env.DB.prepare(`SELECT COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total FROM transactions WHERE user_id = ? AND bucket = 'company' AND txn_date >= ? AND txn_date <= ? AND COALESCE(reimbursed,0) = 0 AND ${COUNTABLE} AND NOT EXISTS (SELECT 1 FROM transaction_attributions ta WHERE ta.transaction_id = transactions.id)`).bind(userId, start, end).first<{ total: number }>())?.total ?? 0
      : 0;
    const incomeRows = (await env.DB.prepare(`SELECT entity_id, COALESCE(SUM(COALESCE(amount_aud_cents, gross_cents)),0) AS inc FROM income WHERE user_id = ? AND fy = ? AND entity_id IS NOT NULL GROUP BY entity_id`).bind(userId, fy).all<{ entity_id: string; inc: number }>()).results ?? [];
    const incomeBy = new Map(incomeRows.map((r) => [r.entity_id, r.inc]));
    const rdRows = (await env.DB.prepare(`SELECT entity_id, eligible_expenditure_cents, aggregated_turnover_cents, registered_with_ausindustry FROM rd_claims WHERE user_id = ? AND fy = ?`).bind(userId, fy).all<{ entity_id: string; eligible_expenditure_cents: number; aggregated_turnover_cents: number; registered_with_ausindustry: number }>()).results ?? [];
    const rdBy = new Map(rdRows.map((r) => [r.entity_id, r]));
    const rdCap = (auV1Thresholds(fy)?.rd_refundable_turnover_cap_cents) ?? Number.MAX_SAFE_INTEGER;
    // Prior-year carried-forward losses already persisted (sum, gated by COT). 0 until a sign-off snapshots them.
    const priorRows = (await env.DB.prepare(`SELECT entity_id, COALESCE(SUM(current_year_loss_cents),0) AS prior FROM company_tax_positions WHERE user_id = ? AND fy < ? AND cot_satisfied = 1 GROUP BY entity_id`).bind(userId, fy).all<{ entity_id: string; prior: number }>()).results ?? [];
    const priorBy = new Map(priorRows.map((r) => [r.entity_id, r.prior]));

    return companies.map((c, i) => {
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
  } catch (e) {
    if (/no such table/i.test((e as Error).message)) return [];
    throw e;
  }
}

// Per-FY thresholds from the bundled rule pack (company/R&D params live here, never in SQL).
function auV1Thresholds(fy: string): Record<string, number> | undefined {
  return (auV1RulePack as unknown as { thresholds_by_fy?: Record<string, Record<string, number>> }).thresholds_by_fy?.[fy];
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
