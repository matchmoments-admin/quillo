import type { Env } from "../env";
import { COUNTABLE, COUNTABLE_INCOME } from "./queries";
import { incomeTotals, depreciationTotals, type IncomeTotals } from "./ledger-totals";
import { featureOn } from "./features";

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
  deductibility?: string | null; // set on deduction_breakdown rows; absent on collapsed by_bucket/income rows
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
): DeductionGroup {
  if (bucket === "company") return "company";
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
  refunds_cents: number;               // refund/reimbursement credits this FY (0 unless refund_netting is on)
  resolved_deductible_cents: number;   // spend a year-end review has CONFIRMED deductible (~0 until review)
  taxable_position_cents: number;      // total_income − total_deductions − depreciation (indicative)
}

export async function buildReport(env: Env, userId: string, startYear: number): Promise<Report> {
  const { start, end } = fyBounds(startYear);

  // AUD totals (fall back to original when already AUD / pre-migration). Exclude duplicates.
  // Grouped by (bucket, ato_label, deductibility) so the deductibility-aware position can filter per
  // row; the legacy `by_bucket` shape is rebuilt by collapsing the deductibility dimension below.
  const byBucket = await env.DB.prepare(
    `SELECT bucket, ato_label, COALESCE(deductibility,'undetermined') AS deductibility, COUNT(*) AS n,
            COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total_cents,
            COALESCE(SUM(gst_cents),0) AS gst_cents
       FROM transactions
      WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND bucket IS NOT NULL AND ${COUNTABLE}
      GROUP BY bucket, ato_label, deductibility ORDER BY bucket, total_cents DESC`,
  )
    .bind(userId, start, end)
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
    `SELECT t.property_id, p.label, COALESCE(t.deductibility,'undetermined') AS deductibility, COUNT(*) AS n,
            COALESCE(SUM(COALESCE(t.amount_aud_cents, t.amount_cents)),0) AS total_cents
       FROM transactions t LEFT JOIN properties p ON p.id = t.property_id
      WHERE t.user_id = ? AND t.txn_date >= ? AND t.txn_date <= ? AND t.property_id IS NOT NULL AND ${COUNTABLE.replace(/\b(status|kind|matched_txn_id|direction)\b/g, "t.$1")}
      GROUP BY t.property_id, deductibility`,
  )
    .bind(userId, start, end)
    .all<{ property_id: string; label: string | null; deductibility: string; n: number; total_cents: number }>();

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
  const income = await incomeTotals(env, userId, { startYear });
  const dep = await depreciationTotals(env, userId, startYear);
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
    const counts = !excludeNonDeductible || !(r.deductibility === "likely_not" || r.deductibility === "confirmed_not" || r.deductibility === "needs_apportionment");
    if (counts) expDeductMap.set(r.property_id, (expDeductMap.get(r.property_id) ?? 0) + r.total_cents);
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
  const propIds = new Set<string>([...expMap.keys(), ...rentByProp.keys(), ...depByProp.keys()].filter((id) => !tenantPropIds.has(id)));
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
  const company_tracked_cents = rows
    .filter((b) => b.bucket === "company")
    .reduce((s, b) => s + (b.total_cents ?? 0), 0);
  // Deny-by-default deductions: only rows the shared classifier puts in the "deduction" group count.
  // The breakdown carries deductibility; the same classifier drives the readiness display lines so
  // the headline == the sum of the "Deductions" lines (asserted by the reconciliation golden).
  const gross_deductions_cents = breakdown
    .filter((b) => deductionGroupForRow(b.bucket, b.deductibility, excludeNonDeductible) === "deduction")
    .reduce((s, b) => s + (b.total_cents ?? 0), 0);

  // Refund netting (flag `refund_netting`): a refund/reimbursement is a CREDIT, so it's already
  // excluded from the debit-only deduction sum above — but it reduces real spend (e.g. a $200
  // refund on a $500 purchase = $300 net deductible). v1 nets globally: subtract total refund
  // credits from total deductions (floored at 0). Per-expense pairing is a later refinement.
  // When the flag is off, refunds_cents stays 0 and deductions are byte-identical to before.
  let refunds_cents = 0;
  if (featureOn(env, "refund_netting")) {
    const refundRow = await env.DB.prepare(
      `SELECT COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total
         FROM transactions
        WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND bucket = 'refund' AND ${COUNTABLE_INCOME}`,
    )
      .bind(userId, start, end)
      .first<{ total: number }>();
    refunds_cents = refundRow?.total ?? 0;
  }
  const total_deductions_cents = Math.max(0, gross_deductions_cents - refunds_cents);
  const taxable_position_cents = income.gross_cents - total_deductions_cents - dep.total_cents;

  // Resolved-deductible: only spend a year-end review has CONFIRMED deductible (deductibility set
  // to a resolved state, with the apportioned amount when present). ~$0 until a review runs — by
  // design: mid-year we capture, we don't claim.
  const resolved = await env.DB.prepare(
    `SELECT COALESCE(SUM(COALESCE(deductible_amount_cents, amount_aud_cents, amount_cents)),0) AS total
       FROM transactions
      WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND ${COUNTABLE}
        AND deductibility IN ('likely_deductible','confirmed_deductible')`,
  )
    .bind(userId, start, end)
    .first<{ total: number }>();
  const resolved_deductible_cents = resolved?.total ?? 0;

  return {
    fy: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    start,
    end,
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
    resolved_deductible_cents,
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
    ...(r.refunds_cents > 0 ? [`Refunds/reimbursements (netted against deductions),${d(r.refunds_cents)}`] : []),
    `Total deductions${r.refunds_cents > 0 ? " (net of refunds)" : ""},${d(r.total_deductions_cents)}`,
    `Decline in value (depreciation),${d(r.depreciation_cents)}`,
    `Indicative taxable position (individual),${d(r.taxable_position_cents)}`,
    ...(r.company_tracked_cents > 0 ? [`Business/company spend (tracked separately — not in the individual position),${d(r.company_tracked_cents)}`] : []),
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
