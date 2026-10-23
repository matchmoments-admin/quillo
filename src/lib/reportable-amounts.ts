/**
 * Reportable amounts — RFBA (reportable fringe benefits, e.g. a novated lease) and RESC (reportable
 * employer super) — folded out of `income.detail_json`.
 *
 * They are REPORTABLE, not assessable: never in the position, never summed into income. They matter
 * because government income tests (MLS, study-loan repayments, Div 293, family assistance) add them.
 *
 * The fold is the one place that knows the rules. Its only caller is the situation module
 * (situations/reportable-amounts.ts, ADR-0004), which feeds both the report payload and the accountant
 * pack, so the two can never disagree:
 *   - RFBA/RESC are ANNUAL figures. A per-period payslip repeats the same annual/YTD number, so take
 *     the MAX per employer and never a sum (12 monthly payslips are not 12× the RFBA).
 *   - Both write paths land on the same keys (payslip: rfba_cents may be null; income statement:
 *     rfb_cents renamed to rfba_cents, 0-defaulted, resc_cents alongside), so null and 0 are the same.
 *   - Negative or fractional values are clamped to ≥0 and rounded.
 *   - Two employers that both omit a name merge under one fallback key — under-stating beats
 *     N×-overstating for a defer-to-agent figure.
 *   - detail_json is free-form (AMMA components, employer meta): unparseable or unrelated blobs are skipped.
 *
 * Pure: the caller owns the query (and therefore the separate-taxpayer scope).
 */

export interface ReportableByEmployer {
  rfba_cents: number;
  resc_cents: number;
}

/** The key two unnamed employers share. */
export const EMPLOYER_NOT_STATED = "(employer not stated)";

/**
 * Per-employer MAX of RFBA/RESC, in first-seen order. Employers with neither amount are absent.
 * @param detailJsons the `income.detail_json` values for the FY, in the caller's row order (nulls skipped)
 */
export function reportableAmountsByEmployer(detailJsons: Iterable<string | null | undefined>): Map<string, ReportableByEmployer> {
  const byEmployer = new Map<string, ReportableByEmployer>();
  for (const raw of detailJsons) {
    if (!raw) continue;
    try {
      const d = JSON.parse(raw) as { employer?: string | null; rfba_cents?: number | null; resc_cents?: number | null };
      const rfba = Math.max(0, Math.round(d.rfba_cents ?? 0));
      const resc = Math.max(0, Math.round(d.resc_cents ?? 0));
      if (rfba === 0 && resc === 0) continue;
      const key = d.employer ?? EMPLOYER_NOT_STATED;
      const cur = byEmployer.get(key) ?? { rfba_cents: 0, resc_cents: 0 };
      byEmployer.set(key, { rfba_cents: Math.max(cur.rfba_cents, rfba), resc_cents: Math.max(cur.resc_cents, resc) });
    } catch {
      /* not JSON — not a payslip/income-statement detail blob */
    }
  }
  return byEmployer;
}

/** Totals across employers (each employer already at its MAX). null when there is nothing to report. */
export function reportableAmountsTotal(byEmployer: Map<string, ReportableByEmployer>): ReportableByEmployer | null {
  let rfba_cents = 0;
  let resc_cents = 0;
  for (const v of byEmployer.values()) {
    rfba_cents += v.rfba_cents;
    resc_cents += v.resc_cents;
  }
  return rfba_cents > 0 || resc_cents > 0 ? { rfba_cents, resc_cents } : null;
}
