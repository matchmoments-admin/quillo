// First-timer income READINESS SIGNALS (#550, flag `first_timer_income`) — the D1 reads behind the
// income-completeness / two-payer / Div 35 findings in assessReadiness (src/lib/readiness.ts).
//
// Same shape and reason as capital-signals.ts: the Durable Object calls this, and so do the persona goldens
// (scripts/check-personas.ts pft1–pft6), so there is ONE definition of each query to be right or wrong
// about — never a re-typed copy inside the test harness.
//
// Flag OFF ⇒ returns {} ⇒ assessReadiness sees no first-timer signal ⇒ findings byte-identical. Nothing here
// touches the money path: every value is a COUNT, a type list or an already-computed total used only to decide
// whether a GENERAL-INFO nudge renders. Quillo never computes tax, rates, offsets or a deferred loss.

import type { Env } from "../env";
import { featureOn } from "./features";
import { attributionTotals, fyLabel } from "./ledger-totals";
import { FX_CONVERTED } from "./queries";
import { AU_DESCRIPTOR, type JurisdictionDescriptor } from "./jurisdiction";
import type { FilingReadinessSignals } from "./readiness";

export type FirstTimerIncomeSignals = Pick<
  FilingReadinessSignals,
  "firstTimerIncomeEnabled" | "salaryPayerCount" | "individualBusinessExpenseCents" | "entityIncomeTypes"
>;

/** Normalise a payer name so LLM/hand-keyed variants of one employer match ("Big Retail Pty. Ltd." ≡ "big retail"). */
export function payerKey(employer: unknown): string {
  if (typeof employer !== "string") return "";
  return employer
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(pty|ltd|limited|proprietary|inc|co|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The MOST payers any ONE person has on this FY's personal salary rows. Payer identity is detail_json.employer
 * (payslip / income-statement rows) via payerKey — 12 monthly payslips from one employer are ONE payer. Scoped
 * like the position: personal rows only (entity_id IS NULL) and FX-converted only. Per person, because a
 * couple with one job each is not "two payers". A hand-keyed row with no employer can't be matched, so each one
 * counts as its own payer: the nudge is a conditional info note, so an over-count costs one unnecessary
 * sentence, while an under-count would hide the case entirely.
 */
export async function salaryPayerCount(env: Env, userId: string, fy: string): Promise<number> {
  const rows = (await env.DB.prepare(
    `SELECT COALESCE(person_id, 'self') AS person, detail_json FROM income
      WHERE user_id = ? AND fy = ? AND income_type = 'salary_payg' AND entity_id IS NULL AND ${FX_CONVERTED}`,
  ).bind(userId, fy).all<{ person: string; detail_json: string | null }>()).results ?? [];
  const byPerson = new Map<string, { named: Set<string>; unnamed: number }>();
  for (const r of rows) {
    // person_self_<uid> and a NULL person are the same taxpayer.
    const person = r.person === `person_self_${userId}` ? "self" : r.person;
    const acc = byPerson.get(person) ?? { named: new Set<string>(), unnamed: 0 };
    let key = "";
    try {
      key = payerKey(r.detail_json ? (JSON.parse(r.detail_json) as { employer?: unknown }).employer : "");
    } catch {
      /* malformed detail ⇒ treat as unnamed */
    }
    if (key) acc.named.add(key);
    else acc.unnamed++;
    byPerson.set(person, acc);
  }
  let max = 0;
  for (const p of byPerson.values()) max = Math.max(max, p.named.size + p.unnamed);
  return max;
}

/**
 * The checklist's "upload your income statement" gate — pure so check-units can pin it (generateChecklist
 * itself lives in the Durable Object). An employee with no wage-type income recorded gets it; anyone else
 * only when the bank shows personal-income credits AND no income at all is recorded (a retiree whose
 * dividends are recorded must not be told to chase an employer income statement).
 */
export function wantsIncomeStatementItem(x: { hasEmployment: boolean; wageRows: number; anyIncomeRows: number; personalCredits: number }): boolean {
  if (x.wageRows > 0) return false;
  if (x.hasEmployment) return true;
  return x.personalCredits > 0 && x.anyIncomeRows === 0;
}

export async function firstTimerIncomeSignals(
  env: Env,
  userId: string,
  startYear: number,
  descriptor: JurisdictionDescriptor = AU_DESCRIPTOR,
): Promise<FirstTimerIncomeSignals> {
  if (!featureOn(env, "first_timer_income")) return {};
  const fy = fyLabel(startYear);
  const payers = await salaryPayerCount(env, userId, fy);
  // Separate-taxpayer income types: income_by_bucket isn't entity-scoped, so a company's recorded sales must
  // count as covering its income_business credits (see the readiness completeness block).
  const entityTypes = ((await env.DB.prepare(
    `SELECT DISTINCT income_type FROM income WHERE user_id = ? AND fy = ? AND entity_id IS NOT NULL
        AND entity_id IN (SELECT id FROM entities WHERE user_id = ? AND COALESCE(entity_type, kind) <> 'individual')`,
  ).bind(userId, fy, userId).all<{ income_type: string }>()).results ?? []).map((r) => r.income_type);
  // Sole-trader expenses reach the individual position only through the attribution engine (an individual
  // 'business' income activity). Engine off ⇒ none are counted ⇒ 0 ⇒ the Div 35 nudge can't fire on a loss
  // the position isn't actually showing.
  const businessExpense = featureOn(env, "attribution_engine")
    ? (await attributionTotals(env, userId, startYear, descriptor)).individual_business_deduction_cents ?? 0
    : 0;
  return { firstTimerIncomeEnabled: true, salaryPayerCount: payers, individualBusinessExpenseCents: businessExpense, entityIncomeTypes: entityTypes };
}
