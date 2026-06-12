import type { Env } from "../env";
import { COUNTABLE } from "./queries";
import {
  buildReport,
  claimExpr,
  useStatusDeniedExpr,
  notAttributedExpr,
  excludeSplitInterestExpr,
  loanInterestV2Context,
  deductionGroupForRow,
  propertyRowCounts,
  type Report,
} from "./report";
import { fyLabel, fyBounds, separateTaxpayerEntityIds, NON_ASSESSABLE_INCOME_TYPES } from "./ledger-totals";
import { resolveJurisdictionForUser } from "./jurisdiction";
import { classifyAttribution, splitAttribution } from "./attribution";
import { exclusionReason } from "./readiness";
import { featureOn } from "./features";

// ── The itemised accountant deliverable (#179 + #181, EPIC #178) ─────────────
// A persona-aware, multi-section schedule an accountant can audit: per-transaction lines with
// date / merchant / amount / work-use % / substantiation, the engine schedules (CGT, ESS, trust,
// SMSF, GST/BAS, depreciation, logbook), an explicit NOT-CLAIMED section with reasons, and a
// substantiation-gaps chase list. PRESENTATION ONLY — every section's total ties back to the
// Report (buildReport stays the single source of truth; tieBackChecks asserts it per persona).
// GENERAL INFORMATION ONLY — never tax advice, never a refund prediction.

export type Cell = string | number | null;

export interface TieBack {
  label: string;
  report_cents: number; // the buildReport figure this section must equal
  actual_cents: number; // what the section's rows sum to
  ok: boolean;
}

export interface ScheduleSection {
  key: string;
  title: string;
  columns: string[];
  rows: Cell[][];
  subtotal_cents?: number;
  tie_back?: TieBack;
  notes?: string[];
}

export interface AccountantSchedule {
  fy: string;
  start: string;
  end: string;
  abn: string | null;
  disclaimer: string;
  sections: ScheduleSection[];
}

export const SCHEDULE_DISCLAIMER =
  "General information only — not tax advice. Every figure is an indicative, captured position for discussion with a registered tax/BAS agent; nothing here is a claim, a refund estimate or a lodgement.";

// Defensive cap so a pathological tenant can't blow the Worker response; the trailer row says
// exactly how many rows were dropped (no silent truncation).
export const MAX_SECTION_ROWS = 5000;

// ── Pure helpers (unit-tested in scripts/check-units.ts) ──────────────────────

/**
 * RFC-4180 CSV escaping + formula-injection neutralisation. Merchant / raw_description strings come
 * from uploaded statements (attacker-influenceable), so a leading = + - @ is prefixed with ' to stop
 * spreadsheet formula execution. Numbers pass through untouched; null → empty.
 */
export function csvCell(v: Cell): string {
  if (v == null) return "";
  if (typeof v === "number") return String(v);
  let s = v;
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export type Substantiation = "receipt" | "document" | "receipt_linked" | "bank_line_only";

/** What backs an itemised claim: its own receipt/document, a receipt matched to the bank line, or nothing. */
export function substantiationStatus(r: {
  kind: string;
  receipt_key?: string | null;
  document_id?: string | null;
  linked_receipts?: number | null;
}): Substantiation {
  if (r.kind === "receipt" && r.receipt_key) return "receipt";
  if (r.document_id) return "document";
  if ((r.linked_receipts ?? 0) > 0) return "receipt_linked";
  return "bank_line_only";
}

const SUBSTANTIATION_LABEL: Record<Substantiation, string> = {
  receipt: "Receipt on file",
  document: "Document on file",
  receipt_linked: "Receipt linked to bank line",
  bank_line_only: "Bank line only",
};

/** Implied work-use % when a confirmed row carries an apportioned amount; null = claimed in full. */
export function impliedWorkUsePct(r: {
  deductibility?: string | null;
  deductible_amount_cents?: number | null;
  gross_cents?: number | null;
}): number | null {
  if (r.deductibility === "confirmed_deductible" && r.deductible_amount_cents != null && (r.gross_cents ?? 0) > 0) {
    return Math.round((100 * r.deductible_amount_cents) / (r.gross_cents as number));
  }
  return null;
}

const d = (c: number) => (c / 100).toFixed(2);

/** Every section's tie-back, for the per-persona "schedule == report" assertions. */
export function tieBackChecks(s: AccountantSchedule): TieBack[] {
  return s.sections.flatMap((sec) => (sec.tie_back ? [sec.tie_back] : []));
}

// ── Row shapes from the itemised queries ──────────────────────────────────────

interface ItemRow {
  id: string;
  txn_date: string | null;
  merchant: string | null;
  bucket: string;
  ato_label: string | null;
  deductibility: string;
  reimbursed: number;
  use_status_denied: number;
  gross_cents: number;
  counted_cents: number; // the amount the engine's SUM expressions count (claimExpr when loan_split on)
  deductible_amount_cents: number | null;
  gst_cents: number | null;
  property_id: string | null;
  kind: string;
  receipt_key: string | null;
  document_id: string | null;
  linked_receipts: number;
}

async function safeAll<T>(p: Promise<{ results?: T[] }>): Promise<T[]> {
  try {
    return (await p).results ?? [];
  } catch (e) {
    // Tolerate ONLY the pre-migration "table doesn't exist" case, like every reader in ledger-totals.
    if (/no such table|no such column/i.test((e as Error).message)) return [];
    throw e;
  }
}

// ── The builder ───────────────────────────────────────────────────────────────

export async function buildAccountantSchedule(
  env: Env,
  userId: string,
  startYear: number,
  opts?: { report?: Report },
): Promise<AccountantSchedule> {
  const report = opts?.report ?? (await buildReport(env, userId, startYear));
  const { start, end } = fyBounds(startYear, await resolveJurisdictionForUser(env, userId));
  const fy = fyLabel(startYear);

  // The SAME flag context buildReport ran under — the shared clause builders guarantee the itemised
  // rows are the engine's own rows, never a re-implementation.
  const honorApportion = featureOn(env, "loan_split");
  const excludeNonDeductible = featureOn(env, "position_excludes_nondeductible");
  const useAttributions = featureOn(env, "attribution_engine");
  // These two gate the itemised queries' WHERE clauses, so they resolve first; everything after is
  // independent and runs concurrently (D1 pipelines the reads — same pattern as queries.ts dashboard).
  const [loanCtx, separateIds] = await Promise.all([
    loanInterestV2Context(env, userId, startYear),
    separateTaxpayerEntityIds(env, userId),
  ]);

  const amtExpr = honorApportion ? claimExpr("") : "COALESCE(amount_aud_cents, amount_cents)";

  // (1) Itemised spend — byBucket (report.ts) ungrouped, identical WHERE + amount expression.
  const itemsP = safeAll<ItemRow>(
    env.DB.prepare(
      `SELECT id, txn_date, merchant, bucket, ato_label,
              COALESCE(deductibility,'undetermined') AS deductibility,
              COALESCE(reimbursed,0) AS reimbursed,
              ${useStatusDeniedExpr("transactions.property_id")} AS use_status_denied,
              COALESCE(amount_aud_cents, amount_cents) AS gross_cents,
              ${amtExpr} AS counted_cents,
              deductible_amount_cents, gst_cents, property_id, kind, receipt_key, document_id,
              (SELECT COUNT(*) FROM transactions r
                WHERE r.user_id = transactions.user_id AND r.matched_txn_id = transactions.id AND r.kind = 'receipt') AS linked_receipts
         FROM transactions
        WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND bucket IS NOT NULL AND ${COUNTABLE}${notAttributedExpr("transactions.id", useAttributions)}${excludeSplitInterestExpr("", loanCtx.supersededLoanIds)}
        ORDER BY bucket, txn_date, created_at`,
    )
      .bind(userId, start, end, ...loanCtx.supersededLoanIds)
      .all<ItemRow>(),
  );

  // (2) Itemised income — same separate-taxpayer exclusion as incomeTotals (entity income belongs to
  // the company/SMSF section, never the personal headline).
  const entityClause = separateIds.length ? ` AND (entity_id IS NULL OR entity_id NOT IN (${separateIds.map(() => "?").join(",")}))` : "";
  const incomeRowsP = safeAll<{
    txn_date: string | null;
    income_type: string;
    ato_label: string | null;
    property_id: string | null;
    gross_cents: number;
    withholding_cents: number;
    franking_credit_cents: number;
    foreign_tax_paid_cents: number;
    source_doc_id: string | null;
  }>(
    env.DB.prepare(
      `SELECT txn_date, income_type, ato_label, property_id,
              COALESCE(amount_aud_cents, gross_cents) AS gross_cents,
              COALESCE(withholding_cents,0) AS withholding_cents,
              COALESCE(franking_credit_cents,0) AS franking_credit_cents,
              COALESCE(foreign_tax_paid_cents,0) AS foreign_tax_paid_cents,
              source_doc_id
         FROM income WHERE user_id = ? AND fy = ?${entityClause}
        ORDER BY income_type, txn_date, created_at`,
    )
      .bind(userId, fy, ...separateIds)
      .all(),
  );

  // (3) Per-asset depreciation — counted rows use the SAME filters as depreciationTotals; denied
  // rows (employer-owned / reimbursed / rent-free property) feed NOT-CLAIMED instead.
  const rentFreeAsset = `EXISTS (SELECT 1 FROM properties pp WHERE pp.id = a.property_id AND pp.use_status IN ('private_use_rent_free','under_renovation_not_available'))`;
  const depCols = `a.label, a.asset_class, a.cost_cents, a.acquired_date, a.ownership_pct, a.business_use_pct,
              d.opening_adjustable_value_cents, d.days_held, d.deduction_cents, d.closing_adjustable_value_cents, d.method_applied,
              p.label AS property_label, COALESCE(a.owned_by,'self') AS owned_by, COALESCE(a.reimbursed,0) AS reimbursed`;
  interface DepRow {
    label: string;
    asset_class: string;
    cost_cents: number;
    acquired_date: string;
    ownership_pct: number | null;
    business_use_pct: number | null;
    opening_adjustable_value_cents: number;
    days_held: number;
    deduction_cents: number;
    closing_adjustable_value_cents: number;
    method_applied: string;
    property_label: string | null;
    owned_by: string;
    reimbursed: number;
  }
  const depRowsP = safeAll<DepRow>(
    env.DB.prepare(
      `SELECT ${depCols}
         FROM depreciation_schedule d JOIN assets a ON a.id = d.asset_id LEFT JOIN properties p ON p.id = a.property_id
        WHERE d.user_id = ? AND d.fy = ?
          AND COALESCE(a.owned_by,'self') <> 'employer' AND COALESCE(a.reimbursed,0) = 0 AND NOT ${rentFreeAsset}
        ORDER BY a.created_at`,
    )
      .bind(userId, fy)
      .all<DepRow>(),
  );
  const depDeniedP = safeAll<DepRow & { use_status_denied: number }>(
    env.DB.prepare(
      `SELECT ${depCols}, (CASE WHEN ${rentFreeAsset} THEN 1 ELSE 0 END) AS use_status_denied
         FROM depreciation_schedule d JOIN assets a ON a.id = d.asset_id LEFT JOIN properties p ON p.id = a.property_id
        WHERE d.user_id = ? AND d.fy = ?
          AND (COALESCE(a.owned_by,'self') = 'employer' OR COALESCE(a.reimbursed,0) = 1 OR ${rentFreeAsset})
        ORDER BY a.created_at`,
    )
      .bind(userId, fy)
      .all<DepRow & { use_status_denied: number }>(),
  );

  // (4) Itemised attributions — attributionTotals' query + display columns, routed by the same
  // classifyAttribution / splitAttribution helpers the reader uses.
  interface AttrRow {
    txn_date: string | null;
    merchant: string | null;
    attributed_amount_cents: number | null;
    attributed_pct: number | null;
    work_use_pct: number | null;
    txn_amount: number | null;
    entity_type: string | null;
    entity_name: string | null;
    activity_type: string | null;
    property_id: string | null;
    deduction_provision: string | null;
  }
  const tFilter = COUNTABLE.replace(/\b(status|kind|matched_txn_id|direction|currency|amount_aud_cents)\b/g, "t.$1");
  const attrRowsP = useAttributions
    ? safeAll<AttrRow>(
        env.DB.prepare(
          `SELECT t.txn_date AS txn_date, t.merchant AS merchant,
                  ta.attributed_amount_cents AS attributed_amount_cents, ta.attributed_pct AS attributed_pct,
                  ta.work_use_pct AS work_use_pct, COALESCE(t.amount_aud_cents, t.amount_cents) AS txn_amount,
                  COALESCE(e.entity_type, e.kind) AS entity_type, e.name AS entity_name,
                  ia.activity_type AS activity_type, ia.property_id AS property_id,
                  ta.deduction_provision AS deduction_provision
             FROM transaction_attributions ta
             JOIN transactions t ON t.id = ta.transaction_id AND t.user_id = ta.user_id
             LEFT JOIN entities e ON e.id = ta.entity_id
             LEFT JOIN income_activities ia ON ia.id = ta.income_activity_id
            WHERE ta.user_id = ? AND t.txn_date >= ? AND t.txn_date <= ?
              AND COALESCE(t.reimbursed,0) = 0 AND ${tFilter}
              AND NOT EXISTS (SELECT 1 FROM properties pp WHERE pp.id = ia.property_id
                                AND pp.use_status IN ('private_use_rent_free','under_renovation_not_available'))
            ORDER BY t.txn_date, t.created_at`,
        )
          .bind(userId, start, end)
          .all<AttrRow>(),
      )
    : Promise.resolve([] as AttrRow[]);

  // (5) Engine source rows — only fetched when the report carries that engine's output.
  const cgtEventsP = report.capital_gains
    ? safeAll<{
        event_date: string | null;
        code: string | null;
        label: string | null;
        asset_kind: string;
        units_disposed: number | null;
        acquired_date: string | null;
        proceeds_cents: number;
        cost_base_used_cents: number;
      }>(
        env.DB.prepare(
          `SELECT ev.event_date, a.code, a.label, a.asset_kind, ev.units_disposed, a.acquired_date,
                  ev.proceeds_cents, ev.cost_base_used_cents
             FROM cgt_events ev JOIN cgt_assets a ON a.id = ev.cgt_asset_id AND a.user_id = ev.user_id
            WHERE ev.user_id = ? AND ev.fy = ? ORDER BY ev.event_date`,
        )
          .bind(userId, fy)
          .all(),
      )
    : Promise.resolve([]);
  const essGrantsP = report.ess
    ? safeAll<{
        scheme_type: string;
        grant_date: string | null;
        taxing_point_date: string | null;
        shares_or_options: string | null;
        units: number | null;
        discount_cents: number;
        ownership_gt_10pct: number;
      }>(
        env.DB.prepare(
          `SELECT scheme_type, grant_date, taxing_point_date, shares_or_options, units, discount_cents, ownership_gt_10pct
             FROM ess_grants
            WHERE user_id = ? AND COALESCE(taxing_point_date, grant_date) >= ? AND COALESCE(taxing_point_date, grant_date) <= ?
            ORDER BY COALESCE(taxing_point_date, grant_date)`,
        )
          .bind(userId, start, end)
          .all(),
      )
    : Promise.resolve([]);
  const trustRowsP = report.trust
    ? safeAll<{ trust_name: string | null; character: string; share_pct: number | null; amount_cents: number; franking_credit_cents: number }>(
        env.DB.prepare(
          `SELECT e.name AS trust_name, td.character, td.share_pct, td.amount_cents, td.franking_credit_cents
             FROM trust_distributions td LEFT JOIN entities e ON e.id = td.trust_entity_id
            WHERE td.user_id = ? AND td.fy = ? AND td.beneficiary_person_id IS NOT NULL ORDER BY td.created_at`,
        )
          .bind(userId, fy)
          .all(),
      )
    : Promise.resolve([]);
  const basRowsP = report.gst
    ? safeAll<{ period_start: string; period_end: string; output_gst_cents: number; input_gst_cents: number; payg_instalment_cents: number; status: string }>(
        env.DB.prepare(
          `SELECT period_start, period_end, output_gst_cents, input_gst_cents, payg_instalment_cents, status
             FROM bas_periods WHERE user_id = ? AND period_start >= ? AND period_end <= ? ORDER BY period_start`,
        )
          .bind(userId, start, end)
          .all(),
      )
    : Promise.resolve([]);
  const paygRowsP = report.payg_instalments_cents
    ? safeAll<{ quarter: number | null; instalment_cents: number; basis: string | null }>(
        env.DB.prepare(`SELECT quarter, instalment_cents, basis FROM payg_instalments WHERE user_id = ? AND fy = ? ORDER BY quarter`).bind(userId, fy).all(),
      )
    : Promise.resolve([]);

  // All ten reads are independent of one another — resolve them concurrently.
  const [items, incomeRows, depRows, depDenied, attrRows, cgtEvents, essGrants, trustRows, basRows, paygRows] =
    await Promise.all([itemsP, incomeRowsP, depRowsP, depDeniedP, attrRowsP, cgtEventsP, essGrantsP, trustRowsP, basRowsP, paygRowsP]);

  // Property labels for section titles / loan lines.
  const propLabels = new Map(report.per_property.map((p) => [p.property_id, p.label ?? p.property_id]));

  // ── Route every itemised txn row to its section ─────────────────────────────
  const propSet = new Set(report.per_property.map((p) => p.property_id));
  const workRelated: ItemRow[] = [];
  const companyItems: ItemRow[] = [];
  const byPropertyItems = new Map<string, ItemRow[]>();
  const notClaimed: { row: ItemRow; reason: string }[] = [];
  let rawDeductionItemised = 0; // every classifier-"deduction" row, wherever it renders

  for (const r of items) {
    const group = deductionGroupForRow(r.bucket, r.deductibility, excludeNonDeductible, r.reimbursed, r.use_status_denied);
    if (group === "deduction") rawDeductionItemised += r.counted_cents;
    if (r.bucket === "company") {
      companyItems.push(r);
      continue;
    }
    if (r.property_id && propSet.has(r.property_id)) {
      if (propertyRowCounts(r, excludeNonDeductible)) {
        const list = byPropertyItems.get(r.property_id) ?? [];
        list.push(r);
        byPropertyItems.set(r.property_id, list);
      } else {
        notClaimed.push({ row: r, reason: exclusionReason(r.bucket, r.deductibility, r.reimbursed, r.use_status_denied) });
      }
      continue;
    }
    if (group === "deduction") workRelated.push(r);
    else notClaimed.push({ row: r, reason: exclusionReason(r.bucket, r.deductibility, r.reimbursed, r.use_status_denied) });
  }

  // Attribution routing (same classifier as attributionTotals).
  const attrItem = (r: AttrRow) => r.attributed_amount_cents ?? splitAttribution({ amount_cents: r.txn_amount ?? 0, owner_share_pct: r.attributed_pct, work_use_pct: r.work_use_pct });
  const attrPersonal: AttrRow[] = [];
  const attrCompany: AttrRow[] = [];
  const attrByProp = new Map<string, number>();
  for (const r of attrRows) {
    const track = classifyAttribution(r);
    if (track === "excluded") continue;
    if (track === "company") attrCompany.push(r);
    else {
      attrPersonal.push(r);
      if (track === "property" && r.property_id) attrByProp.set(r.property_id, (attrByProp.get(r.property_id) ?? 0) + attrItem(r));
    }
  }

  // ── Build the sections ───────────────────────────────────────────────────────
  const sections: ScheduleSection[] = [];
  const gaps: { section: string; n: number; total_cents: number }[] = [];
  const trackGap = (section: string, rows: ItemRow[]) => {
    const bad = rows.filter((r) => substantiationStatus(r) === "bank_line_only");
    if (bad.length) gaps.push({ section, n: bad.length, total_cents: bad.reduce((s, r) => s + r.counted_cents, 0) });
  };
  const capped = <T>(rows: T[], notes: string[]): T[] => {
    if (rows.length <= MAX_SECTION_ROWS) return rows;
    notes.push(`Truncated — ${rows.length - MAX_SECTION_ROWS} more row(s) not shown (cap ${MAX_SECTION_ROWS}).`);
    return rows.slice(0, MAX_SECTION_ROWS);
  };
  const itemCells = (r: ItemRow): Cell[] => [
    r.txn_date,
    r.merchant ?? "—",
    r.ato_label ? `${r.bucket} · ${r.ato_label}` : r.bucket,
    d(r.gross_cents),
    impliedWorkUsePct(r) ?? (r.deductibility === "confirmed_deductible" ? 100 : null),
    d(r.counted_cents),
    r.deductibility,
    SUBSTANTIATION_LABEL[substantiationStatus(r)],
  ];
  const ITEM_COLS = ["Date", "Merchant", "Category", "Gross (AUD)", "Work-use %", "Counted (AUD)", "Deductibility", "Substantiation"];

  // 1. Summary — every line verbatim from the Report; tie-back recomputes total deductions from
  // the schedule's own components (raw itemised + attributed + loan v2 + work methods − refunds).
  {
    const wm = report.work_method;
    const rows: Cell[][] = [
      ["Total income (gross)", d(report.total_income_cents)],
      ...(report.refunds_cents > 0 ? [["Refunds/reimbursements (netted against deductions)", d(report.refunds_cents)] as Cell[]] : []),
      ...(wm && wm.wfh_cents > 0 ? [[`Working from home (fixed rate: ${wm.wfh_hours} hrs × ${wm.rates.wfh_cents_per_hour}c/hr)`, d(wm.wfh_cents)] as Cell[]] : []),
      ...(wm && wm.car_cents > 0 ? [[`Car (cents per km: ${Math.min(wm.car_work_km, wm.rates.car_km_cap)} km × ${wm.rates.car_cents_per_km}c/km)`, d(wm.car_cents)] as Cell[]] : []),
      [`Total deductions${report.refunds_cents > 0 ? " (net of refunds)" : ""}`, d(report.total_deductions_cents)],
      ["Decline in value (depreciation)", d(report.depreciation_cents)],
      ["Indicative taxable position (individual)", d(report.taxable_position_cents)],
      ...(report.company_tracked_cents > 0 ? [["Business/company spend (tracked separately — not in the individual position)", d(report.company_tracked_cents)] as Cell[]] : []),
      ...(report.gst_credits_cents > 0 ? [["GST credits (ITC) on company expenses", d(report.gst_credits_cents)] as Cell[]] : []),
      ["EXPLICITLY NOT CLAIMED (see section below)", d(notClaimed.reduce((s, x) => s + x.row.counted_cents, 0) + depDenied.reduce((s, r) => s + r.deduction_cents, 0))],
    ];
    const attrIndividual = attrPersonal.reduce((s, r) => s + attrItem(r), 0);
    const recomputedDeductions = Math.max(0, rawDeductionItemised + attrIndividual + loanCtx.total_cents - report.refunds_cents) + (wm?.total_cents ?? 0);
    sections.push({
      key: "summary",
      title: "Summary — indicative position",
      columns: ["Line", "Amount (AUD)"],
      rows,
      tie_back: { label: "total deductions (recomputed from itemised sections)", report_cents: report.total_deductions_cents, actual_cents: recomputedDeductions, ok: recomputedDeductions === report.total_deductions_cents },
    });
  }

  // 2. Income (documented) — itemised; ties to total_income_cents. S4/D: capture-only income (non-cash
  // benefits, super pension) is EXCLUDED from the assessable income that the report headline
  // (total_income_cents) counts — so exclude it here too or the tie-back breaks. It's surfaced as a per-type
  // note (and stays visible via the report's excluded line), never silently dropped.
  const assessableIncomeRows = incomeRows.filter((r) => !NON_ASSESSABLE_INCOME_TYPES.has(r.income_type));
  const excludedRows = incomeRows.filter((r) => NON_ASSESSABLE_INCOME_TYPES.has(r.income_type));
  const excludedNoteFor = (income_type: string, n: number, cents: number): string => {
    if (income_type === "non_cash_benefit") return `${n} non-cash benefit(s) totalling ${d(cents)} are captured but EXCLUDED from assessable income (may be assessable at market value — confirm with a registered tax agent).`;
    if (income_type === "super_pension") return `${n} super pension record(s) totalling ${d(cents)} are captured but EXCLUDED from assessable income (an over-60 account-based pension from a taxed fund is generally tax-free — confirm with a registered tax agent).`;
    return `${n} ${income_type.replace(/_/g, " ")} record(s) totalling ${d(cents)} are captured but EXCLUDED from assessable income (confirm the treatment with a registered tax agent).`;
  };
  if (assessableIncomeRows.length) {
    const notes: string[] = [];
    const total = assessableIncomeRows.reduce((s, r) => s + r.gross_cents, 0);
    for (const t of [...new Set(excludedRows.map((r) => r.income_type))]) {
      const rs = excludedRows.filter((r) => r.income_type === t);
      notes.push(excludedNoteFor(t, rs.length, rs.reduce((s, r) => s + r.gross_cents, 0)));
    }
    const noDoc = assessableIncomeRows.filter((r) => !r.source_doc_id);
    if (noDoc.length) gaps.push({ section: "income", n: noDoc.length, total_cents: noDoc.reduce((s, r) => s + r.gross_cents, 0) });
    sections.push({
      key: "income",
      title: "Income (documented)",
      columns: ["Date", "Type", "ATO label", "Property", "Gross (AUD)", "Withholding", "Franking credit", "Foreign tax paid", "Substantiation"],
      rows: capped(assessableIncomeRows, notes).map((r) => [
        r.txn_date,
        r.income_type,
        r.ato_label,
        r.property_id ? (propLabels.get(r.property_id) ?? r.property_id) : null,
        d(r.gross_cents),
        d(r.withholding_cents),
        d(r.franking_credit_cents),
        d(r.foreign_tax_paid_cents),
        r.source_doc_id ? "Document on file" : "No document",
      ]),
      subtotal_cents: total,
      tie_back: { label: "total income", report_cents: report.total_income_cents, actual_cents: total, ok: total === report.total_income_cents },
      notes,
    });
  }

  // 3. Income from bank credits (informational — kept separate from documented income, see report).
  if (report.income_by_bucket.length) {
    const total = report.income_by_bucket.reduce((s, r) => s + r.total_cents, 0);
    sections.push({
      key: "income_bank_credits",
      title: "Income seen as bank credits (informational — not added to the income total above)",
      columns: ["Bucket", "ATO label", "Count", "Total (AUD)"],
      rows: report.income_by_bucket.map((r) => [r.bucket, r.ato_label, r.n, d(r.total_cents)]),
      subtotal_cents: total,
      notes: ["Shown separately so a salary that also arrived via a payslip is never double-counted."],
    });
  }

  // 4. Work-related & other deductions (itemised, non-property, non-company).
  if (workRelated.length) {
    const notes: string[] = [];
    const total = workRelated.reduce((s, r) => s + r.counted_cents, 0);
    trackGap("work_related", workRelated);
    sections.push({
      key: "work_related",
      title: "Work-related & other deductions (itemised)",
      columns: ITEM_COLS,
      rows: capped(workRelated, notes).map(itemCells),
      subtotal_cents: total,
      notes,
    });
  }

  // 5. Work-method deductions (WFH fixed rate + car cents/km, with the logbook comparison).
  if (report.work_method || report.car_logbook) {
    const wm = report.work_method;
    const lb = report.car_logbook;
    const rows: Cell[][] = [];
    if (wm && wm.wfh_cents > 0) rows.push(["Working from home — fixed rate", `${wm.wfh_hours} hrs × ${wm.rates.wfh_cents_per_hour}c/hr`, d(wm.wfh_cents)]);
    if (wm && wm.car_cents > 0) rows.push(["Car — cents per km", `${Math.min(wm.car_work_km, wm.rates.car_km_cap)} km × ${wm.rates.car_cents_per_km}c/km (cap ${wm.rates.car_km_cap} km)`, d(wm.car_cents)]);
    if (lb) {
      rows.push(["Car — logbook method (comparison)", `${lb.business_use_pct}% business use × (running ${d(lb.running_costs_cents)} + decline ${d(lb.car_dep_cents)})`, d(lb.logbook_deduction_cents)]);
      rows.push([`Recommended method: ${lb.recommended_method === "logbook" ? "logbook" : "cents per km"}`, "informational — confirm with a registered tax agent", d(lb.recommended_cents)]);
    }
    sections.push({
      key: "work_methods",
      title: "Work-use method deductions",
      columns: ["Method", "Basis", "Amount (AUD)"],
      rows,
      // No subtotal when only the informational logbook comparison renders — a "Subtotal 0.00" under
      // a logbook figure would read as a claimed-zero, which it isn't (nothing is claimed via methods).
      subtotal_cents: wm ? wm.total_cents : undefined,
      tie_back: wm ? { label: "work-method deductions", report_cents: wm.total_cents, actual_cents: (wm.wfh_cents ?? 0) + (wm.car_cents ?? 0), ok: (wm.wfh_cents ?? 0) + (wm.car_cents ?? 0) === wm.total_cents } : undefined,
      notes: ["The fixed-rate / cents-per-km methods already cover the running costs they replace — those receipts stay in NOT CLAIMED, so nothing is claimed twice."],
    });
  }

  // 6. One section per property: itemised expenses + loan-interest evidence + the position lines.
  for (const p of report.per_property) {
    const notes: string[] = [];
    const rows: Cell[][] = [];
    const expRows = byPropertyItems.get(p.property_id) ?? [];
    trackGap(`property:${p.property_id}`, expRows);
    for (const r of capped(expRows, notes)) rows.push(itemCells(r));
    let evidenced = expRows.reduce((s, r) => s + r.counted_cents, 0);
    for (const loan of loanCtx.loans.filter((l) => l.property_id === p.property_id)) {
      rows.push([null, `Loan interest (${loan.source === "estimate" ? "rate × balance estimate" : loan.source.replace(/_/g, " ")})`, "rental:interest", d(loan.deductible_cents), null, d(loan.deductible_cents), "evidence-first (loan model)", loan.source === "estimate" ? "No document — estimate" : "Lender/statement on file"]);
      evidenced += loan.deductible_cents;
    }
    const attrC = attrByProp.get(p.property_id) ?? 0;
    if (attrC > 0) {
      rows.push([null, "Attributed deductions (ownership share — see Attributed section)", null, d(attrC), null, d(attrC), "attributed", null]);
      evidenced += attrC;
    }
    rows.push(["", "Rent income", null, null, null, d(p.income_cents), null, null]);
    rows.push(["", "Decline in value (depreciation)", null, null, null, d(p.depreciation_cents), null, null]);
    rows.push(["", "Net position (negative gearing)", null, null, null, d(p.net_cents), null, null]);
    sections.push({
      key: `property:${p.property_id}`,
      title: `Property — ${p.label ?? p.property_id}`,
      columns: ITEM_COLS,
      rows,
      subtotal_cents: p.deduction_cents,
      tie_back: { label: `property ${p.label ?? p.property_id} deductions`, report_cents: p.deduction_cents, actual_cents: evidenced, ok: evidenced === p.deduction_cents },
      notes,
    });
  }

  // 7. Depreciation schedule (per asset, this FY).
  if (depRows.length) {
    const notes: string[] = [];
    const total = depRows.reduce((s, r) => s + r.deduction_cents, 0);
    sections.push({
      key: "depreciation",
      title: "Decline in value (per-asset schedule, this FY)",
      columns: ["Asset", "Class", "Cost (AUD)", "Acquired", "Method", "Opening value", "Days held", "Deduction (AUD)", "Closing value", "Ownership %", "Business use %", "Property"],
      rows: capped(depRows, notes).map((r) => [
        r.label, r.asset_class, d(r.cost_cents), r.acquired_date, r.method_applied,
        d(r.opening_adjustable_value_cents), r.days_held, d(r.deduction_cents), d(r.closing_adjustable_value_cents),
        r.ownership_pct, r.business_use_pct, r.property_label,
      ]),
      subtotal_cents: total,
      tie_back: { label: "depreciation", report_cents: report.depreciation_cents, actual_cents: total, ok: total === report.depreciation_cents },
      notes,
    });
  }

  // 8. Attributed deductions (payer ≠ claimant) — personal + company tracks itemised.
  if (attrPersonal.length || attrCompany.length) {
    const notes: string[] = [];
    const all = [...attrPersonal.map((r) => ({ r, track: classifyAttribution(r) })), ...attrCompany.map((r) => ({ r, track: "company" as const }))];
    const total = all.reduce((s, x) => s + attrItem(x.r), 0);
    const target = report.attribution ? report.attribution.individual_cents + report.attribution.property_cents + report.attribution.company_cents : 0;
    sections.push({
      key: "attributed",
      title: "Attributed deductions (who claims what — ownership share × work use)",
      columns: ["Date", "Merchant", "Claimed by", "Track", "Owner share %", "Work use %", "Attributed (AUD)"],
      rows: capped(all, notes).map(({ r, track }) => [
        r.txn_date, r.merchant ?? "—",
        track === "company" ? (r.entity_name ?? "company") : track === "property" ? `property (${r.property_id ? (propLabels.get(r.property_id) ?? r.property_id) : "—"})` : "you",
        track, r.attributed_pct, r.work_use_pct, d(attrItem(r)),
      ]),
      subtotal_cents: total,
      tie_back: { label: "attributed deductions", report_cents: target, actual_cents: total, ok: total === target },
      notes,
    });
  }

  // 9. CGT events.
  if (report.capital_gains) {
    const cg = report.capital_gains;
    const notes: string[] = [];
    const rows: Cell[][] = capped(cgtEvents, notes).map((e) => [
      e.event_date, e.code ?? e.label ?? "—", e.asset_kind, e.units_disposed, e.acquired_date,
      d(e.proceeds_cents), d(e.cost_base_used_cents), d(e.proceeds_cents - e.cost_base_used_cents),
    ]);
    rows.push(["", "Gross capital gains", null, null, null, null, null, d(cg.gross_capital_gains_cents)]);
    rows.push(["", "Capital losses applied", null, null, null, null, null, d(cg.capital_losses_cents)]);
    rows.push(["", "50% discount applied", null, null, null, null, null, d(cg.discount_applied_cents)]);
    if (cg.loss_carried_forward_cents > 0) rows.push(["", "Loss carried forward", null, null, null, null, null, d(cg.loss_carried_forward_cents)]);
    rows.push(["", "NET CAPITAL GAIN (assessable)", null, null, null, null, null, d(cg.net_capital_gain_cents)]);
    const grossFromEvents = cgtEvents.reduce((s, e) => s + Math.max(0, e.proceeds_cents - e.cost_base_used_cents), 0);
    sections.push({
      key: "cgt",
      title: "Capital gains (per disposal)",
      columns: ["Date", "Asset", "Kind", "Units", "Acquired", "Proceeds (AUD)", "Cost base (AUD)", "Gain/loss (AUD)"],
      rows,
      subtotal_cents: cg.net_capital_gain_cents,
      tie_back: { label: "gross capital gains", report_cents: cg.gross_capital_gains_cents, actual_cents: grossFromEvents, ok: grossFromEvents === cg.gross_capital_gains_cents },
      notes: [...notes, "CGT is fact-specific (cost-base elements, dates, exemptions) — confirm with a registered tax agent."],
    });
  }

  // 10. ESS grants.
  if (report.ess) {
    const e = report.ess;
    const notes: string[] = [];
    const rows: Cell[][] = capped(essGrants, notes).map((g) => [
      g.taxing_point_date ?? g.grant_date, g.scheme_type, g.shares_or_options, g.units, d(g.discount_cents),
      g.scheme_type === "startup" && g.ownership_gt_10pct !== 1 ? "deferred to CGT (startup concession)" : "assessable this year",
    ]);
    rows.push(["", "Assessable ESS discount", null, null, d(e.assessable_discount_cents), ""]);
    if (e.startup_deferred_to_cgt_cents > 0) rows.push(["", "Startup concession — deferred to CGT on sale", null, null, d(e.startup_deferred_to_cgt_cents), ""]);
    const totalGrants = essGrants.reduce((s, g) => s + Math.max(0, g.discount_cents), 0);
    sections.push({
      key: "ess",
      title: "Employee share scheme (per grant)",
      columns: ["Taxing point", "Scheme", "Shares/options", "Units", "Discount (AUD)", "Treatment"],
      rows,
      subtotal_cents: e.assessable_discount_cents,
      tie_back: { label: "ESS discounts (assessable + deferred)", report_cents: e.assessable_discount_cents + e.startup_deferred_to_cgt_cents, actual_cents: totalGrants, ok: totalGrants === e.assessable_discount_cents + e.startup_deferred_to_cgt_cents },
      notes: [...notes, ...(e.ineligible_startup_flag ? ["A startup-concession grant looks ineligible (>10% ownership) — confirm with a registered tax agent."] : [])],
    });
  }

  // 11. Trust distributions.
  if (report.trust) {
    const t = report.trust;
    const notes: string[] = [];
    const total = trustRows.reduce((s, r) => s + Math.max(0, r.amount_cents), 0);
    sections.push({
      key: "trust",
      title: "Trust distributions (to you)",
      columns: ["Trust", "Character", "Share %", "Amount (AUD)", "Franking credit (AUD)"],
      rows: capped(trustRows, notes).map((r) => [r.trust_name ?? "—", r.character, r.share_pct, d(r.amount_cents), d(r.franking_credit_cents)]),
      subtotal_cents: t.assessable_cents,
      tie_back: { label: "assessable trust distributions", report_cents: t.assessable_cents, actual_cents: total, ok: total === t.assessable_cents },
      notes: [...notes, "Trust streaming, s100A and Division 7A are specialist areas — confirm with a registered tax agent."],
    });
  }

  // 12. Company (a separate taxpayer): itemised company-bucket spend + attributed + quarters + positions.
  if (companyItems.length || attrCompany.length || report.company_positions?.length || report.company_quarters.some((q) => q.total_cents > 0)) {
    const notes: string[] = [];
    const rows: Cell[][] = capped(companyItems, notes).map(itemCells);
    trackGap("company", companyItems);
    const itemisedTotal = companyItems.reduce((s, r) => s + r.counted_cents, 0);
    const attrCompanyTotal = attrCompany.reduce((s, r) => s + attrItem(r), 0);
    if (attrCompanyTotal > 0) rows.push([null, "Attributed to the company (see Attributed section)", null, d(attrCompanyTotal), null, d(attrCompanyTotal), "attributed", null]);
    for (const q of report.company_quarters) if (q.total_cents > 0) rows.push(["", `BAS quarter ${q.quarter}`, null, null, null, d(q.total_cents), `GST ${d(q.gst_cents)}`, null]);
    for (const cp of report.company_positions ?? []) {
      rows.push(["", `${cp.name ?? "Company"} — assessable income`, null, null, null, d(cp.assessable_income_cents), null, null]);
      rows.push(["", `${cp.name ?? "Company"} — deductions`, null, null, null, d(cp.deductions_cents), null, null]);
      if (cp.total_carry_forward_cents > 0) rows.push(["", `${cp.name ?? "Company"} — carried-forward loss (incl. prior years)`, null, null, null, d(cp.total_carry_forward_cents), null, null]);
      if (cp.shareholder_loan_balance_cents > 0) rows.push(["", `${cp.name ?? "Company"} — shareholder loan balance (you → company)`, null, null, null, d(cp.shareholder_loan_balance_cents), null, null]);
    }
    const actual = itemisedTotal + attrCompanyTotal;
    sections.push({
      key: "company",
      title: "Company spend (a separate taxpayer — NOT in your individual position)",
      columns: ITEM_COLS,
      rows,
      subtotal_cents: report.company_tracked_cents,
      tie_back: { label: "company tracked spend", report_cents: report.company_tracked_cents, actual_cents: actual, ok: actual === report.company_tracked_cents },
      notes,
    });
  }

  // 13. GST / BAS + PAYG instalments (never part of the income-tax position).
  if (report.gst || report.payg_instalments_cents) {
    const rows: Cell[][] = [];
    if (report.gst) {
      rows.push(["Output GST (on sales)", d(report.gst.output_gst_cents), report.gst.source ?? ""]);
      rows.push(["Input GST credits (on purchases)", d(report.gst.input_gst_cents), report.gst.source ?? ""]);
      rows.push(["Net GST (indicative BAS)", d(report.gst.net_gst_cents), report.gst.source === "recorded" ? "from your recorded BAS periods" : "derived from the ledger"]);
      for (const b of basRows) rows.push([`BAS period ${b.period_start} – ${b.period_end} (${b.status})`, d(b.output_gst_cents - b.input_gst_cents), `output ${d(b.output_gst_cents)} / input ${d(b.input_gst_cents)}`]);
    }
    let paygTie: TieBack | undefined;
    if (report.payg_instalments_cents) {
      for (const p of paygRows) rows.push([`PAYG instalment${p.quarter ? ` Q${p.quarter}` : ""}${p.basis ? ` (${p.basis})` : ""}`, d(p.instalment_cents), "pre-payment toward income tax"]);
      const paygTotal = paygRows.reduce((s, p) => s + p.instalment_cents, 0);
      rows.push(["PAYG instalments total", d(report.payg_instalments_cents), ""]);
      paygTie = { label: "PAYG instalments", report_cents: report.payg_instalments_cents, actual_cents: paygTotal, ok: paygTotal === report.payg_instalments_cents };
    }
    sections.push({
      key: "gst_bas",
      title: "GST / BAS (separate from income tax)",
      columns: ["Line", "Amount (AUD)", "Source"],
      rows,
      tie_back: paygTie,
      notes: ["GST is never added to the income-tax position. Quillo never lodges — confirm BAS figures with a registered BAS agent."],
    });
  }

  // 14. SMSF funds (separate taxpayers).
  if (report.smsf_funds?.length) {
    sections.push({
      key: "smsf",
      title: "SMSF funds (separate taxpayers — never in your personal position)",
      columns: ["Fund", "Assessable income (AUD)", "ECPI exempt %", "Exempt (AUD)", "Fund taxable income (AUD)"],
      rows: report.smsf_funds.map((f) => [f.name ?? f.entity_id, d(f.assessable_income_cents), Math.round(f.ecpi_exempt_fraction * 100), d(f.ecpi_exempt_cents), d(f.fund_taxable_income_cents)]),
      notes: ["SMSF compliance (ECPI, actuarial certificates, pension standards) is specialist — confirm with the fund's accountant/auditor."],
    });
  }

  // 15. EXPLICITLY NOT CLAIMED — every excluded item with its reason (#181).
  if (notClaimed.length || depDenied.length) {
    const notes: string[] = [];
    const rows: Cell[][] = capped(notClaimed, notes).map(({ row: r, reason }) => [
      r.txn_date, r.merchant ?? "—", r.ato_label ? `${r.bucket} · ${r.ato_label}` : r.bucket, d(r.counted_cents), reason, SUBSTANTIATION_LABEL[substantiationStatus(r)],
    ]);
    for (const a of depDenied) {
      rows.push([a.acquired_date, a.label, `asset · ${a.asset_class}`, d(a.deduction_cents),
        a.owned_by === "employer"
          ? "Employer-owned asset — no decline in value to you (Div 40 needs you to own and bear the cost)."
          : exclusionReason("asset", null, a.reimbursed, a.use_status_denied),
        null]);
    }
    const total = notClaimed.reduce((s, x) => s + x.row.counted_cents, 0) + depDenied.reduce((s, r) => s + r.deduction_cents, 0);
    sections.push({
      key: "not_claimed",
      title: "EXPLICITLY NOT CLAIMED — considered and excluded, with reasons",
      columns: ["Date", "Item", "Category", "Amount (AUD)", "Why it isn't claimed", "Substantiation"],
      rows,
      subtotal_cents: total,
      notes: [...notes, "Shown so your accountant can see what was considered. If any item IS work-related, confirm it in the app and the position updates."],
    });
  }

  // 16. Substantiation gaps — the chase list (claims backed only by a bank line).
  if (gaps.length) {
    sections.push({
      key: "substantiation_gaps",
      title: "Substantiation gaps — claims backed only by a bank line (a bank line alone is not substantiation)",
      columns: ["Section", "Items", "Total (AUD)"],
      rows: gaps.map((g) => [g.section, g.n, d(g.total_cents)]),
      subtotal_cents: gaps.reduce((s, g) => s + g.total_cents, 0),
      notes: ["Attach the tax invoice / receipt / annual statement for these in the app, or note for your agent why none exists."],
    });
  }

  // 17. Undated rows (belong to no FY).
  if (report.undated.n > 0) {
    sections.push({
      key: "undated",
      title: "Undated items (assign a date so these land in a financial year)",
      columns: ["Merchant", "Amount (AUD)"],
      rows: report.undated_detail.map((u) => [u.merchant ?? "—", d(u.total_cents)]),
      subtotal_cents: report.undated.total_cents,
    });
  }

  return { fy: report.fy, start: report.start, end: report.end, abn: report.abn, disclaimer: SCHEDULE_DISCLAIMER, sections };
}

// ── CSV emission ──────────────────────────────────────────────────────────────

export function scheduleToCsv(s: AccountantSchedule): string {
  const lines: string[] = [
    `Quillo accountant schedule,FY ${s.fy},${s.start} to ${s.end}`,
    `ABN,${s.abn ?? "(not set)"}`,
    csvCell(s.disclaimer),
  ];
  for (const sec of s.sections) {
    lines.push("", csvCell(sec.title.toUpperCase()));
    lines.push(sec.columns.map(csvCell).join(","));
    for (const row of sec.rows) lines.push(row.map(csvCell).join(","));
    if (sec.subtotal_cents != null) lines.push(`Subtotal,${d(sec.subtotal_cents)}`);
    if (sec.tie_back && !sec.tie_back.ok) {
      lines.push(csvCell(`NOTE: this section does not tie to the report ${sec.tie_back.label} (section ${d(sec.tie_back.actual_cents)} vs report ${d(sec.tie_back.report_cents)}) — review in the app.`));
    }
    for (const n of sec.notes ?? []) lines.push(csvCell(`Note: ${n}`));
  }
  return lines.join("\n") + "\n";
}
