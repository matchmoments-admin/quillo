// Pure mapping of an extracted ATO income statement (the myGov "Income statements" page — one block per
// employer for the FY) into recordIncome-shaped rows. Kept PURE + dependency-free so it is unit-assertable
// (scripts/check-units.ts) without the LLM/DO — the extractor (src/extract.ts extractIncomeStatement) and
// the DO writer (agent.ts decomposeIncomeStatement) both feed/consume this. Feature A1 increment 2, gated
// by `income_statement_multi`. Tax-correctness lives here; get it wrong and the position over/under-states.

export interface IncomeStatementEmployer {
  employer: string;
  employer_abn: string | null;
  tax_ready: boolean;                                   // only a FINALISED block is recorded as assessable
  period_start: string | null;
  period_end: string | null;                            // → income.txn_date (partial-year safe)
  bms_id: string | null;
  total_gross_cents: number;                            // the PRINTED total — already includes every leave line
  paygw_cents: number;
  leave_detail: { type: string; cents: number }[];      // evidence only — NEVER re-added (already in gross)
  lump_sums: { type: "A" | "B" | "D" | "E" | "W"; cents: number }[];
  allowances: { label: string; cents: number }[];       // captured reference-only (varied treatment → defer)
  resc_cents: number;                                   // reportable employer super — NON-assessable
  rfb_cents: number;                                    // reportable fringe benefits — NON-assessable
  sg_cents: number;                                     // ordinary SG liability — NOT income (reference only)
  confidence: number;
}
export interface ExtractedIncomeStatementShape {
  employers: IncomeStatementEmployer[];
}

/** A recordIncome-shaped row the DO writer will persist (it adds user/source_doc/fy). */
export interface MappedIncomeRow {
  income_type: string;
  ato_label: string;
  gross_cents: number;
  withholding_cents: number;
  txn_date: string | null;
  needs_review: 0 | 1;
  detail: Record<string, unknown>; // → JSON.stringify into income.detail_json
}
export interface MappedIncomeStatement {
  rows: MappedIncomeRow[];          // to record (finalised employers only)
  skipped_employers: string[];      // not-"Tax ready" — surfaced to the user, NOT recorded as assessable
}

// Matches the existing payslip path's CONFIDENCE_THRESHOLD (agent.ts) so behaviour is consistent.
const CONFIDENCE_THRESHOLD = 0.85;

/**
 * Map an extracted income statement → income rows, tax-correctly:
 * - ONE assessable salary row per FINALISED employer at the PRINTED Total gross (leave already inside it —
 *   never re-added); PAYGW → withholding. Not-"Tax ready" employers are SKIPPED (captured/surfaced, not
 *   counted) because a preliminary figure must never silently reach the position.
 * - Each non-zero lump sum → a capture-only `employment_lump_sum` row (∈ NON_ASSESSABLE) — so tax-free
 *   Lump D (genuine redundancy) is never taxed and A/E/W offsets we don't compute never inflate the headline.
 * - Ordinary SG, RESC, RFB, leave breakdown, allowances → reference-only in `detail` (never in gross_cents).
 * - Salary rows flag needs_review on low confidence OR when allowances are present (not auto-summed).
 */
export function mapIncomeStatementToRows(stmt: ExtractedIncomeStatementShape): MappedIncomeStatement {
  const rows: MappedIncomeRow[] = [];
  const skipped_employers: string[] = [];

  for (const e of stmt.employers) {
    if (!e.tax_ready) {
      skipped_employers.push(e.employer); // preliminary — never counted; the user re-uploads once finalised
      continue;
    }
    const meta = {
      employer: e.employer,              // back-compat key with today's payslip reader/notify
      employer_abn: e.employer_abn,
      tax_ready: e.tax_ready,
      period: [e.period_start, e.period_end],
      bms_id: e.bms_id,
    };

    // Assessable salary — Total gross AS PRINTED (a 0-gross block, e.g. redundancy-only, records no salary row).
    if (e.total_gross_cents > 0) {
      rows.push({
        income_type: "salary_payg",
        ato_label: "1-salary",
        gross_cents: e.total_gross_cents,
        withholding_cents: e.paygw_cents,
        txn_date: e.period_end,
        needs_review: e.confidence < CONFIDENCE_THRESHOLD || e.allowances.length > 0 ? 1 : 0,
        detail: {
          ...meta,
          rfba_cents: e.rfb_cents, // preserve the existing payslip detail_json key
          resc_cents: e.resc_cents,
          sg_cents: e.sg_cents,    // reference only — SG is NOT income
          leave_detail: e.leave_detail,
          allowances: e.allowances,
        },
      });
    }

    // Lump sums → capture-only (non-assessable) rows, one per non-zero type. Neutral lump_sum:X labels
    // (grouping tokens, NOT return-item labels) + always needs_review (special/varied treatment).
    for (const ls of e.lump_sums) {
      if (!ls.cents) continue;
      rows.push({
        income_type: "employment_lump_sum",
        ato_label: `lump_sum:${ls.type}`,
        gross_cents: ls.cents,
        withholding_cents: 0,
        txn_date: e.period_end,
        needs_review: 1,
        detail: { ...meta, lump_sum_type: ls.type },
      });
    }
  }

  return { rows, skipped_employers };
}
