import type { Env } from "../env";
import { COUNTABLE } from "./queries";

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
