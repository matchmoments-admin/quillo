/**
 * The ONE FY-representation module (I/O-free, so the pure engines can import it). Everything that produces or
 * parses a stored `fy` goes through here; check-units fails on an open-coded `% 100).padStart(2, "0")` label.
 */
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
