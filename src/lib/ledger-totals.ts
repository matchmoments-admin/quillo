import type { Env } from "../env";
import { COUNTABLE } from "./queries";
import { classifyAttribution, splitAttribution } from "./attribution";

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
