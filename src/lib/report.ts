import type { Env } from "../env";
import { COUNTABLE, COUNTABLE_INCOME } from "./queries";
import { incomeTotals, depreciationTotals, attributionTotals, companyPositions, type IncomeTotals, type AttributionTotals, type CompanyPosition } from "./ledger-totals";
import { featureOn } from "./features";
import auV1RulePack from "../rulepacks/au-v1.json";
import { computeWorkMethodDeductions, workUseRatesForFy, type WorkMethodDeductions } from "./work-use";

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
  reimbursed?: number | null;    // 0030: set on deduction_breakdown rows; reimbursed spend is excluded from the headline
  use_status_denied?: number | null; // 0031: 1 when the row's property is rent-free/renovating (excluded from the headline, kept visible)
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
): DeductionGroup {
  if (bucket === "company") return "company";
  // 0030: employer-reimbursed spend is never a deductible loss/outgoing (the employer bore the cost).
  // 0031: spend on a property held rent-free / off-market-renovating earns no income, so it's not a
  // deduction either (s8-1) — though CGT cost base still accrues elsewhere. Both stay VISIBLE as
  // excluded tracked-spend (not removed), so every surface that lists spend agrees; only the headline
  // drops them. Default 0 keeps legacy callers byte-identical.
  if (reimbursed) return "excluded";
  if (propertyDenied) return "excluded";
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
  // Computed WFH (fixed-rate) + car (cents-per-km) deductions from the per-FY work_use_inputs. Present
  // only when the `wfh_car_methods` flag is on AND the user supplied hours/km. Included in
  // total_deductions_cents. The itemised running costs these methods cover stay excluded (deny-by-
  // default needs_apportionment), so there's no double-claim. undefined ⇒ byte-identical legacy totals.
  work_method?: WorkMethodDeductions;
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
  taxable_position_cents: number;      // total_income − total_deductions − depreciation (indicative)
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

export async function buildReport(env: Env, userId: string, startYear: number): Promise<Report> {
  const { start, end } = fyBounds(startYear);
  // Flag `loan_split`: when on, the position counts the claimable (apportioned) portion
  // (deductible_amount_cents) of a row instead of the gross — see positionAmountCents. The SUM
  // expressions below MUST mirror that helper exactly. Off ⇒ byte-identical legacy totals.
  const honorApportion = featureOn(env, "loan_split");
  // Mirrors positionAmountCents EXACTLY: only confirmed_deductible rows count their apportioned amount;
  // everything else (incl. likely_not rows the 0021 backfill stamped with deductible_amount_cents=0)
  // keeps gross. `p` is the table-alias prefix ("" for byBucket, "t." for the property join).
  const claim = (p: string) =>
    `CASE WHEN ${p}deductibility = 'confirmed_deductible' AND ${p}deductible_amount_cents IS NOT NULL THEN ${p}deductible_amount_cents ELSE COALESCE(${p}amount_aud_cents, ${p}amount_cents) END`;
  const amtExpr = honorApportion ? claim("") : "COALESCE(amount_aud_cents, amount_cents)";
  const amtExprT = honorApportion ? claim("t.") : "COALESCE(t.amount_aud_cents, t.amount_cents)";

  // 0031: a property held rent-free for a relative, or off-market while renovating, earns no income
  // => its expenses are NOT deductions (s8-1), though CGT cost base still accrues. We MARK such rows
  // (a 0/1 flag) rather than removing them, so they stay visible as excluded tracked-spend and every
  // surface that lists spend agrees; only the headline classifier drops them. Static string, no extra
  // binds; only the genuinely-new use_status values deny and no existing row carries them, so the
  // position is byte-identical until a user marks a property. `col` is the txn's property_id column.
  const useStatusDenied = (col: string) =>
    `(CASE WHEN EXISTS (SELECT 1 FROM properties pp WHERE pp.id = ${col} AND pp.use_status IN ('private_use_rent_free','under_renovation_not_available')) THEN 1 ELSE 0 END)`;

  // Phase B / G2: when the attribution_engine flag is on, a transaction that has explicit
  // transaction_attributions is counted via those (attributionTotals) instead of its raw amount — so
  // it must be EXCLUDED from the raw byBucket/byPropertyRaw/company/resolved sums to avoid double
  // counting. Flag off (or no attribution rows) ⇒ this clause is empty ⇒ byte-identical legacy path.
  // `col` is the transaction's id column for the surrounding query's alias; no extra bind.
  const useAttributions = featureOn(env, "attribution_engine");
  const notAttributed = (col: string) =>
    useAttributions ? ` AND NOT EXISTS (SELECT 1 FROM transaction_attributions ta WHERE ta.transaction_id = ${col})` : "";

  // AUD totals (fall back to original when already AUD / pre-migration). Exclude duplicates.
  // Grouped by (bucket, ato_label, deductibility) so the deductibility-aware position can filter per
  // row; the legacy `by_bucket` shape is rebuilt by collapsing the deductibility dimension below.
  const byBucket = await env.DB.prepare(
    `SELECT bucket, ato_label, COALESCE(deductibility,'undetermined') AS deductibility,
            COALESCE(reimbursed,0) AS reimbursed, ${useStatusDenied("transactions.property_id")} AS use_status_denied,
            COUNT(*) AS n,
            COALESCE(SUM(${amtExpr}),0) AS total_cents,
            COALESCE(SUM(gst_cents),0) AS gst_cents
       FROM transactions
      WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND bucket IS NOT NULL AND ${COUNTABLE}${notAttributed("transactions.id")}
      GROUP BY bucket, ato_label, deductibility, reimbursed, use_status_denied ORDER BY bucket, total_cents DESC`,
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
    `SELECT t.property_id, p.label, COALESCE(t.deductibility,'undetermined') AS deductibility,
            COALESCE(t.reimbursed,0) AS reimbursed, ${useStatusDenied("t.property_id")} AS use_status_denied,
            COUNT(*) AS n,
            COALESCE(SUM(${amtExprT}),0) AS total_cents
       FROM transactions t LEFT JOIN properties p ON p.id = t.property_id
      WHERE t.user_id = ? AND t.txn_date >= ? AND t.txn_date <= ? AND t.property_id IS NOT NULL AND ${COUNTABLE.replace(/\b(status|kind|matched_txn_id|direction)\b/g, "t.$1")}${notAttributed("t.id")}
      GROUP BY t.property_id, deductibility, reimbursed, use_status_denied`,
  )
    .bind(userId, start, end)
    .all<{ property_id: string; label: string | null; deductibility: string; reimbursed: number; use_status_denied: number; n: number; total_cents: number }>();

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
  // Phase B / G2: deductions that come from explicit attributions (payer≠claimant) rather than the
  // raw transaction. The attributed transactions were excluded from the raw sums above (notAttributed),
  // so these are added without double-counting. Flag off ⇒ all zeros ⇒ byte-identical. The attributed
  // amounts also feed the by_property DISPLAY (expenseByProp) and resolved_deductible_cents below, so
  // those secondary figures stay consistent with the headline (D.0).
  const attr: AttributionTotals = useAttributions
    ? await attributionTotals(env, userId, startYear)
    : { individual_deduction_cents: 0, company_deduction_cents: 0, by_property: [] };
  // Phase C / G4: per-company position (separate taxpayer). Same flag — it's the attribution-routed
  // company deductions that make it meaningful. Empty when there's no company.
  const company_positions: CompanyPosition[] = useAttributions ? await companyPositions(env, userId, startYear) : [];
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
    const counts = !r.reimbursed && !r.use_status_denied && (!excludeNonDeductible || !(r.deductibility === "likely_not" || r.deductibility === "confirmed_not" || r.deductibility === "needs_apportionment"));
    if (counts) expDeductMap.set(r.property_id, (expDeductMap.get(r.property_id) ?? 0) + r.total_cents);
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
      .filter((b) => deductionGroupForRow(b.bucket, b.deductibility, excludeNonDeductible, b.reimbursed, b.use_status_denied) === "deduction")
      .reduce((s, b) => s + (b.total_cents ?? 0), 0) +
    attr.individual_deduction_cents +
    attr_property_total_cents;

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
  // Computed work-use deductions (WFH fixed-rate + car cents-per-km), flag-gated. These are NOT a %
  // of tracked spend — they're calculated from the per-FY work_use_inputs and REPLACE the itemised
  // running costs they cover (those stay excluded as needs_apportionment, so no double-claim). Off by
  // default (flag) ⇒ work_method stays undefined and the totals below are byte-identical to before.
  const fyLabel = `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
  let work_method: WorkMethodDeductions | undefined;
  if (featureOn(env, "wfh_car_methods")) {
    const wu = await env.DB.prepare(`SELECT wfh_hours, car_work_km FROM work_use_inputs WHERE user_id = ? AND fy = ?`)
      .bind(userId, startYear)
      .first<{ wfh_hours: number | null; car_work_km: number | null }>();
    if (wu && ((wu.wfh_hours ?? 0) > 0 || (wu.car_work_km ?? 0) > 0)) {
      const thresholds = (auV1RulePack as { thresholds_by_fy?: Record<string, { wfh_fixed_rate_cents_per_hour?: number; car_cents_per_km?: number; car_km_cap?: number }> }).thresholds_by_fy?.[fyLabel];
      const computed = computeWorkMethodDeductions(wu, workUseRatesForFy(thresholds));
      if (computed.total_cents > 0) work_method = computed;
    }
  }

  const total_deductions_cents = Math.max(0, gross_deductions_cents - refunds_cents) + (work_method?.total_cents ?? 0);
  const taxable_position_cents = income.gross_cents - total_deductions_cents - dep.total_cents;

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
        AND ${useStatusDenied("transactions.property_id")} = 0${notAttributed("transactions.id")}`,
  )
    .bind(userId, start, end)
    .first<{ total: number }>();
  // Attributions are an explicit user decision (who claims what), so the attributed personal deductions
  // (individual + rental-property) count as resolved-deductible — keeping this figure in step with the
  // headline now that attributed txns are excluded from the raw resolved sum above (D.0).
  const resolved_deductible_cents = (resolved?.total ?? 0) + attr.individual_deduction_cents + attr_property_total_cents;

  return {
    fy: fyLabel,
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
    work_method,
    // Surface the attribution split so the display layer can render matching lines (keeping the
    // position == sum-of-lines invariant). Omitted entirely when there are no attributions.
    attribution:
      attr.individual_deduction_cents || attr.company_deduction_cents || attr_property_total_cents
        ? { individual_cents: attr.individual_deduction_cents, company_cents: attr.company_deduction_cents, property_cents: attr_property_total_cents }
        : undefined,
    company_positions: company_positions.length ? company_positions : undefined,
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
    ...(r.work_method && r.work_method.wfh_cents > 0 ? [`  • Working from home (fixed rate: ${r.work_method.wfh_hours} hrs × ${r.work_method.rates.wfh_cents_per_hour}c/hr),${d(r.work_method.wfh_cents)}`] : []),
    ...(r.work_method && r.work_method.car_cents > 0 ? [`  • Car (cents per km: ${Math.min(r.work_method.car_work_km, r.work_method.rates.car_km_cap)} km × ${r.work_method.rates.car_cents_per_km}c/km),${d(r.work_method.car_cents)}`] : []),
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
