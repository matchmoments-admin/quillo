/**
 * Situation module: reportable amounts — RFBA (reportable fringe benefits, e.g. a novated lease) and
 * RESC (reportable employer super) captured off payslips / income statements into `income.detail_json`.
 *
 * INFORMATION ONLY (no `contributes`): the figures are reportable, NOT assessable — never in
 * taxable_position. They feed income tests (Medicare levy surcharge, Div 293, study-loan repayment
 * income, family assistance) that this app never computes, so they must reach the agent instead of
 * dying in detail_json. The per-employer MAX fold lives in ../reportable-amounts.ts.
 *
 * ADR-0004 step 1: the first module on the registry, moved out of buildReport + the accountant pack
 * with byte-identical output.
 */
import { reportableAmountsByEmployer, reportableAmountsTotal, type ReportableByEmployer } from "../reportable-amounts";
import { defineSituation } from "./types";
import { personClause } from "../self-person";

export interface ReportableAmounts {
  /** One entry per employer at its MAX, in first-seen order (the pack's rows). */
  by_employer: [employer: string, amounts: ReportableByEmployer][];
  /** Summed across employers (the payload field). */
  total: ReportableByEmployer;
}

const d = (c: number) => (c / 100).toFixed(2);

export const REPORTABLE_AMOUNTS_NOTES = [
  "Reportable fringe benefits (e.g. a novated lease) and reportable employer super are NOT assessable income and are NOT in any figure above — but they count toward government income tests (e.g. Medicare levy surcharge, study-loan repayments, family assistance).",
  "One row per employer at the highest amount reported — a per-period payslip repeats the same annual figure.",
  "General information only — confirm the treatment with a registered tax agent.",
];

export const reportableAmountsModule = defineSituation<ReportableAmounts, "reportable_amounts">({
  key: "reportable_amounts",
  flag: "reportable_amounts",
  async load(ctx) {
    // Separate-taxpayer entity rows are excluded, matching the headline's own exclusion, so payload and
    // pack read the same rows. Both write paths land on the same keys (payslip: rfba_cents may be null;
    // income statement: rfb_cents renamed to rfba_cents, 0-defaulted, resc_cents alongside) — the fold
    // treats null and 0 identically and skips blobs that aren't ours. ORDER BY is the pack's income-row
    // order, so the per-employer rows keep their historical first-seen order (the total is order-free).
    const { env, scope, fy, separateIds } = ctx;
    const entityClause = separateIds.length ? ` AND (entity_id IS NULL OR entity_id NOT IN (${separateIds.map(() => "?").join(",")}))` : "";
    // #722: a person-scoped report reads only that person's employers (null personId ⇒ the whole tenant).
    const person = personClause(scope.userId, scope.personId);
    const rows = await env.DB.prepare(
      `SELECT detail_json FROM income WHERE user_id = ? AND fy = ? AND detail_json IS NOT NULL${entityClause}${person.sql}
        ORDER BY income_type, txn_date, created_at`,
    )
      .bind(scope.userId, fy, ...separateIds, ...person.binds)
      .all<{ detail_json: string }>();
    const byEmployer = reportableAmountsByEmployer((rows.results ?? []).map((r) => r.detail_json));
    const total = reportableAmountsTotal(byEmployer);
    return total ? { by_employer: [...byEmployer.entries()], total } : null;
  },
  field: (r) => r.total,
  // Reportable, NOT assessable — deliberately NO tie_back (they contribute to no report figure; the C3
  // informational precedent).
  schedule: (r, ctx) => [
    {
      key: "reportable_amounts",
      title: "Reportable amounts (informational — not income, not in any total)",
      columns: ["Employer", `Reportable fringe benefits — RFBA (${ctx.currency})`, `Reportable employer super — RESC (${ctx.currency})`],
      rows: r.by_employer.map(([emp, v]) => [emp, d(v.rfba_cents), d(v.resc_cents)]),
      notes: [...REPORTABLE_AMOUNTS_NOTES],
    },
  ],
});
