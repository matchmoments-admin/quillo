import type { Env } from "../env";
import { COUNTABLE, COUNTABLE_INCOME } from "./queries";
import { incomeTotals, depreciationTotals, type IncomeTotals } from "./ledger-totals";

// Australian FY is Jul–Jun. Given a start year Y, the FY runs Y-07-01 .. (Y+1)-06-30.
export function currentFyStartYear(now = new Date()): number {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? y : y - 1; // month 6 = July (0-indexed)
}

function fyBounds(startYear: number): { start: string; end: string } {
  return { start: `${startYear}-07-01`, end: `${startYear + 1}-06-30` };
}

export interface ReportRow {
  bucket: string;
  ato_label: string | null;
  n: number;
  total_cents: number;
  gst_cents: number;
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
  by_bucket: ReportRow[];
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
  total_deductions_cents: number;      // all countable deductions this FY
  taxable_position_cents: number;      // total_income − total_deductions − depreciation (indicative)
}

export async function buildReport(env: Env, userId: string, startYear: number): Promise<Report> {
  const { start, end } = fyBounds(startYear);

  // AUD totals (fall back to original when already AUD / pre-migration). Exclude duplicates.
  const byBucket = await env.DB.prepare(
    `SELECT bucket, ato_label, COUNT(*) AS n,
            COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total_cents,
            COALESCE(SUM(gst_cents),0) AS gst_cents
       FROM transactions
      WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND bucket IS NOT NULL AND ${COUNTABLE}
      GROUP BY bucket, ato_label ORDER BY bucket, total_cents DESC`,
  )
    .bind(userId, start, end)
    .all<ReportRow>();

  // Income captured from bank credits this FY, grouped by income bucket. Shown as its own
  // section — NOT folded into total_income_cents yet (it would double-count a salary that also
  // arrived via a payslip in the income table; de-dup is a later phase). 'refund' is excluded.
  const incomeByBucket = await env.DB.prepare(
    `SELECT bucket, ato_label, COUNT(*) AS n,
            COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total_cents,
            COALESCE(SUM(gst_cents),0) AS gst_cents
       FROM transactions
      WHERE user_id = ? AND txn_date >= ? AND txn_date <= ?
        AND bucket IN ('income_business','income_property','income_personal') AND ${COUNTABLE_INCOME}
      GROUP BY bucket, ato_label ORDER BY bucket, total_cents DESC`,
  )
    .bind(userId, start, end)
    .all<ReportRow>();

  const byProperty = await env.DB.prepare(
    `SELECT t.property_id, p.label, COUNT(*) AS n,
            COALESCE(SUM(COALESCE(t.amount_aud_cents, t.amount_cents)),0) AS total_cents
       FROM transactions t LEFT JOIN properties p ON p.id = t.property_id
      WHERE t.user_id = ? AND t.txn_date >= ? AND t.txn_date <= ? AND t.property_id IS NOT NULL AND ${COUNTABLE.replace(/\b(status|kind|matched_txn_id|direction)\b/g, "t.$1")}
      GROUP BY t.property_id`,
  )
    .bind(userId, start, end)
    .all<{ property_id: string; label: string | null; n: number; total_cents: number }>();

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

  const rows = byBucket.results ?? [];
  const gstCredits = rows.filter((b) => b.bucket === "company").reduce((s, b) => s + (b.gst_cents ?? 0), 0);

  // ── Tax position via the money seam: income − deductions − depreciation ──
  const income = await incomeTotals(env, userId, { startYear });
  const dep = await depreciationTotals(env, userId, startYear);
  const expenseByProp = byProperty.results ?? [];
  const expMap = new Map(expenseByProp.map((p) => [p.property_id, p]));
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
  const propIds = new Set<string>([...expMap.keys(), ...rentByProp.keys(), ...depByProp.keys()].filter((id) => !tenantPropIds.has(id)));
  const per_property: PropertyPosition[] = [...propIds].map((pid) => {
    const incomeC = rentByProp.get(pid) ?? 0;
    const deductionC = expMap.get(pid)?.total_cents ?? 0;
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
  const total_deductions_cents = rows.filter((b) => b.bucket !== "unknown").reduce((s, b) => s + (b.total_cents ?? 0), 0);
  const taxable_position_cents = income.gross_cents - total_deductions_cents - dep.total_cents;

  return {
    fy: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    start,
    end,
    by_bucket: rows,
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
    taxable_position_cents,
  };
}

/** AU financial-year label for a date, e.g. "2025-26". null when the date is missing/unparseable. */
export function fyForDate(txnDate: string | null): string | null {
  if (!txnDate || !/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) return null;
  const y = Number(txnDate.slice(0, 4));
  const mo = Number(txnDate.slice(5, 7));
  const startYear = mo >= 7 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

export function reportToCsv(r: Report): string {
  const d = (c: number) => (c / 100).toFixed(2);
  const lines: string[] = [
    `Quillo tax summary,FY ${r.fy},${r.start} to ${r.end}`,
    `ABN,${r.abn ?? "(not set)"}`,
    `GST credits (ITC) on company expenses,${d(r.gst_credits_cents)}`,
    "General information only — not tax advice. Confirm with a registered tax/BAS agent.",
    "",
    "Tax position (indicative),Amount (AUD)",
    `Total income (gross),${d(r.total_income_cents)}`,
    `Total deductions,${d(r.total_deductions_cents)}`,
    `Decline in value (depreciation),${d(r.depreciation_cents)}`,
    `Indicative taxable position,${d(r.taxable_position_cents)}`,
    "",
    "Income type,Count,Gross (AUD),Withholding,Franking credit,Foreign tax paid",
  ];
  for (const it of r.income.by_type) {
    lines.push(`${it.income_type},${it.n},${d(it.gross_cents)},${d(it.withholding_cents)},${d(it.franking_credit_cents)},${d(it.foreign_tax_paid_cents)}`);
  }
  lines.push("", "Bucket,ATO label,Count,Total (AUD),GST");
  for (const b of r.by_bucket) {
    lines.push(`${b.bucket},${b.ato_label ?? ""},${b.n},${d(b.total_cents)},${d(b.gst_cents)}`);
  }
  lines.push("", "Property,Rent income (AUD),Deductions,Depreciation,Net (negative gearing)");
  for (const p of r.per_property) {
    lines.push(`${(p.label ?? p.property_id).replace(/,/g, " ")},${d(p.income_cents)},${d(p.deduction_cents)},${d(p.depreciation_cents)},${d(p.net_cents)}`);
  }
  lines.push("", "Company BAS quarter,Total (AUD),GST");
  for (const q of r.company_quarters) lines.push(`${q.quarter},${d(q.total_cents)},${d(q.gst_cents)}`);
  if (r.undated_detail.length) {
    lines.push("", "Undated (assign a date so these land in an FY),Amount (AUD)");
    for (const u of r.undated_detail) lines.push(`${(u.merchant ?? "—").replace(/,/g, " ")},${d(u.total_cents)}`);
  }
  return lines.join("\n") + "\n";
}
