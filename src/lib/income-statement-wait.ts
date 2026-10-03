// The Connect step's "waiting on your income statement" items (#586, first-timer spec §0 step 2 + ATO process
// row 8; flag ft_journey). READ-ONLY.
//
// An employee's income statement only becomes final when their employer marks it "Tax ready" in myGov
// (employers have until 14 July; ask the employer if it still isn't ready after 31 July). Quillo can't see
// myGov, so it never claims the statement IS ready: it lists each known employer as WAITING until a
// salary_payg row naming that employer is recorded, and says when it's worth asking the employer.
//
// Employers come from two places, deduplicated by payerKey: employment entities from About you (kind
// 'employment'), and employers marked from bank credits (#577 payrollEmployerSignals, flag wages_payer).
// Coverage uses the same matcher (employerMatches) and the same single-uncovered rule as the readiness
// finding and the myTax worksheet, so the three surfaces agree. Dates come from the rule pack (lodgement.*),
// with the bundled pack filling keys a KV pack pushed before #586 doesn't carry. Never a figure.

import auV1RulePack from "../rulepacks/au-v1.json";
import type { Env } from "../env";
import { fyBoundsFor, type JurisdictionDescriptor } from "./jurisdiction";
import { fyLabel } from "./ledger-totals";
import { FX_CONVERTED } from "./queries";
import { payerKey } from "./first-timer-signals";
import { employerMatches, payrollEmployerSignals } from "./noticed-signals";

export interface IncomeStatementTiming {
  /** Display: the date employers must finalise by (AU "14 July"). */
  finalise_by: string;
  /** Display: after this, ask the employer (AU "31 July"). */
  chase_after: string;
  /** Machine form of chase_after: the first {month, day} after the FY ends. */
  chase_after_fy_end: { month: number; day: number };
}

export interface IncomeStatementWait {
  fy: string;
  /** One row per known employer: covered = an income statement (salary row) naming it is recorded. */
  employers: { name: string; covered: boolean }[];
  /** Salary rows recorded for the FY (personal, FX-converted). Lets the page say "added" with no named employer. */
  wage_rows: number;
  finalise_by: string;
  chase_after: string;
  /** ISO day from which "ask your employer" applies (first chase_after after the FY ends). */
  chase_from: string;
  /** today >= chase_from. */
  chase_now: boolean;
}

type LodgementPack = { lodgement?: { employer_finalise_by?: unknown; tax_ready_chase_after?: unknown; tax_ready_chase_after_fy_end?: { month?: unknown; day?: unknown } } };

/** The pack's income-statement timing; the bundled pack fills any key the tenant's pack lacks. */
export function incomeStatementTiming(pack: unknown): IncomeStatementTiming {
  const p = (pack as LodgementPack | null)?.lodgement;
  const b = (auV1RulePack as unknown as LodgementPack).lodgement!;
  const str = (v: unknown, d: unknown) => (typeof v === "string" && v.trim() ? v : (d as string));
  const okDay = (d: { month?: unknown; day?: unknown } | undefined): d is { month: number; day: number } =>
    !!d && Number.isInteger(d.month) && Number.isInteger(d.day) && (d.month as number) >= 1 && (d.month as number) <= 12 && (d.day as number) >= 1 && (d.day as number) <= 31;
  const chase = okDay(p?.tax_ready_chase_after_fy_end) ? p!.tax_ready_chase_after_fy_end : b.tax_ready_chase_after_fy_end!;
  return {
    finalise_by: str(p?.employer_finalise_by, b.employer_finalise_by),
    chase_after: str(p?.tax_ready_chase_after, b.tax_ready_chase_after),
    chase_after_fy_end: { month: chase.month as number, day: chase.day as number },
  };
}

/** The first {month, day} strictly after the FY's last day (AU FY 2025 with 31 July → 2026-07-31). Pure. */
export function firstDayAfterFy(fyEnd: string, md: { month: number; day: number }): string {
  const endYear = Number(fyEnd.slice(0, 4));
  const p = (n: number) => String(n).padStart(2, "0");
  const same = `${endYear}-${p(md.month)}-${p(md.day)}`;
  return same > fyEnd ? same : `${endYear + 1}-${p(md.month)}-${p(md.day)}`;
}

/**
 * Fold employer names + recorded salary rows into the waiting list. Pure (check-units pins it).
 * `salaryEmployers` is each salary row's detail_json.employer (undefined for a hand-keyed row).
 */
export function foldEmployers(names: readonly string[], salaryEmployers: readonly unknown[]): { name: string; covered: boolean }[] {
  const seen = new Set<string>();
  const list: { name: string; covered: boolean }[] = [];
  for (const n of names) {
    const k = payerKey(n);
    if (!k || [...seen].some((s) => employerMatches(s, k))) continue;
    seen.add(k);
    list.push({ name: n.trim(), covered: salaryEmployers.some((e) => employerMatches(e, n)) });
  }
  // Same rule as the worksheet and the readiness finding: with exactly ONE employer still uncovered, an
  // unnamed (hand-keyed) salary row is that employer's.
  const unnamed = salaryEmployers.filter((e) => !payerKey(e)).length;
  const uncovered = list.filter((e) => !e.covered);
  if (uncovered.length === 1 && unnamed > 0) uncovered[0]!.covered = true;
  return list;
}

export async function incomeStatementWait(
  env: Env,
  userId: string,
  startYear: number,
  descriptor: JurisdictionDescriptor,
  pack: unknown,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<IncomeStatementWait> {
  const fy = fyLabel(startYear);
  const [entities, salary, payroll] = await Promise.all([
    env.DB.prepare(
      `SELECT name FROM entities WHERE user_id = ? AND (kind = 'employment' OR entity_type = 'payg_employment') AND name IS NOT NULL ORDER BY created_at`,
    ).bind(userId).all<{ name: string }>(),
    env.DB.prepare(
      `SELECT detail_json FROM income WHERE user_id = ? AND fy = ? AND income_type = 'salary_payg' AND entity_id IS NULL AND ${FX_CONVERTED}`,
    ).bind(userId, fy).all<{ detail_json: string | null }>(),
    payrollEmployerSignals(env, userId, startYear, descriptor), // {} with wages_payer OFF
  ]);
  const salaryEmployers = (salary.results ?? []).map((r) => {
    try { return (JSON.parse(r.detail_json ?? "{}") as { employer?: unknown }).employer; } catch { return undefined; }
  });
  const names = [...(entities.results ?? []).map((e) => e.name), ...(payroll.payrollEmployers ?? []).map((e) => e.name)];
  const timing = incomeStatementTiming(pack);
  const chaseFrom = firstDayAfterFy(fyBoundsFor(descriptor, startYear).end, timing.chase_after_fy_end);
  return {
    fy,
    employers: foldEmployers(names, salaryEmployers),
    wage_rows: salaryEmployers.length,
    finalise_by: timing.finalise_by,
    chase_after: timing.chase_after,
    chase_from: chaseFrom,
    chase_now: today >= chaseFrom,
  };
}
