// Statement coverage (#472): do an account's uploaded statements cover the whole financial year?
//
// Each statement reconciles on its own (opening + lines = closing), so a missing month passes every check:
// upload Jul–Feb and Apr–Jun and March's spending and income are simply absent, the totals are understated
// and nothing says so. This finds those gaps so readiness can name them before the year is handed off.
//
// A statement's period is the one printed on it (statements.period_start/end, 0093). A statement without
// one (a CSV, or a PDF read before 0093) falls back to its first and last line dates, which can under-state
// its period by a quiet week at either end; GAP_TOLERANCE_DAYS absorbs that, and the bank's own cycle gaps.
// Only statement-sourced accounts are checked: a bank feed has no statement periods.
//
// unlinkedLoanSignals (flag loan_purpose_prompt) lives here too: the other "your uploads leave a hole" read.

import type { Env } from "../env";
import { tenantDb } from "./tenant-db";
import { isLoanInterestLine } from "./statements";

/** A gap shorter than this is a quiet week or a cycle boundary, not a missing statement. */
export const GAP_TOLERANCE_DAYS = 7;

export interface StatementPeriod { start: string; end: string; opening_cents?: number | null } // ISO dates, inclusive
export interface CoverageGap { from: string; to: string; days: number } // inclusive

const DAY = 86_400_000;
const toMs = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The stretches of [fyStart, fyEnd] no statement covers, in date order. Periods outside the FY are clipped;
 * overlapping periods merge. Gaps of GAP_TOLERANCE_DAYS or less are ignored. No periods at all ⇒ no gaps (the
 * account isn't in this FY; that's a different question). When the earliest statement opens on a $0 balance the
 * account started then (a new account, a new loan before its drawdown), so the FY before it is not a gap.
 */
export function coverageGaps(periods: StatementPeriod[], fyStart: string, fyEnd: string, toleranceDays = GAP_TOLERANCE_DAYS): CoverageGap[] {
  const lo = toMs(fyStart), hi = toMs(fyEnd);
  const spans = periods
    .map((p) => [Math.max(toMs(p.start), lo), Math.min(toMs(p.end), hi)] as const)
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && s <= e)
    .sort((a, b) => a[0] - b[0]);
  if (spans.length === 0) return [];
  const gaps: CoverageGap[] = [];
  const push = (from: number, to: number) => {
    const days = Math.round((to - from) / DAY) + 1;
    if (days > toleranceDays) gaps.push({ from: toIso(from), to: toIso(to), days });
  };
  const first = periods.filter((p) => Number.isFinite(toMs(p.start))).sort((a, b) => toMs(a.start) - toMs(b.start))[0];
  let covered = first?.opening_cents === 0 ? Math.max(lo, toMs(first.start)) - DAY : lo - DAY; // last day covered so far
  for (const [s, e] of spans) {
    if (s > covered + DAY) push(covered + DAY, s - DAY);
    covered = Math.max(covered, e);
  }
  if (covered < hi) push(covered + DAY, hi);
  return gaps;
}

export interface AccountCoverage { account_id: string; label: string; gaps: CoverageGap[] }

/**
 * Per active statement account with an imported statement touching the FY: its uncovered stretches. Only
 * accounts with at least one gap are returned. Read-only.
 */
export async function statementCoverageSignals(env: Env, userId: string, fyStart: string, fyEnd: string): Promise<AccountCoverage[]> {
  const rows = (await tenantDb(env, userId).prepare(
    `SELECT s.account_id, a.name, a.last4, s.opening_cents,
            COALESCE(s.period_start, (SELECT MIN(t.txn_date) FROM transactions t WHERE t.user_id = s.user_id AND t.statement_id = s.id)) AS p_start,
            COALESCE(s.period_end,   (SELECT MAX(t.txn_date) FROM transactions t WHERE t.user_id = s.user_id AND t.statement_id = s.id)) AS p_end
       FROM statements s JOIN accounts a ON a.id = s.account_id AND a.user_id = s.user_id
      WHERE s.user_id = ? AND s.status = 'imported' AND a.source = 'statement' AND a.active = 1`,
  ).bind().all<{ account_id: string; name: string; last4: string | null; opening_cents: number | null; p_start: string | null; p_end: string | null }>()).results ?? [];
  const byAccount = new Map<string, { label: string; periods: StatementPeriod[] }>();
  for (const r of rows) {
    if (!r.p_start || !r.p_end || r.p_end < fyStart || r.p_start > fyEnd) continue;
    const label = r.last4 && !r.name.includes(r.last4) ? `${r.name} ··${r.last4}` : r.name;
    const entry = byAccount.get(r.account_id) ?? { label, periods: [] };
    entry.periods.push({ start: r.p_start, end: r.p_end, opening_cents: r.opening_cents });
    byAccount.set(r.account_id, entry);
  }
  const out: AccountCoverage[] = [];
  for (const [account_id, { label, periods }] of byAccount) {
    const gaps = coverageGaps(periods, fyStart, fyEnd);
    if (gaps.length) out.push({ account_id, label, gaps });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export interface UnlinkedLoan { account_id: string; label: string; interest_cents: number }

/**
 * Active loan accounts whose lines this FY include interest charged (a debit naming interest) but which no
 * loans_properties row links to a property. Their interest is in no figure until the user says what the loan is
 * for, and nothing else asks (the loan cards only list linked loans). Read-only.
 */
export async function unlinkedLoanSignals(env: Env, userId: string, fyStart: string, fyEnd: string): Promise<UnlinkedLoan[]> {
  const rows = (await tenantDb(env, userId).prepare(
    `SELECT a.id AS account_id, a.name, a.last4, COALESCE(t.raw_description, t.merchant, '') AS description,
            COALESCE(t.amount_aud_cents, t.amount_cents) AS cents
       FROM accounts a JOIN transactions t ON t.account_id = a.id AND t.user_id = a.user_id
      WHERE a.user_id = ? AND a.type = 'loan' AND a.active = 1
        AND t.direction = 'debit' AND t.status <> 'duplicate' AND t.txn_date >= ? AND t.txn_date <= ?
        AND NOT EXISTS (SELECT 1 FROM loans_properties lp WHERE lp.user_id = a.user_id AND lp.loan_account_id = a.id)`,
  ).bind(fyStart, fyEnd).all<{ account_id: string; name: string; last4: string | null; description: string; cents: number | null }>()).results ?? [];
  const byLoan = new Map<string, UnlinkedLoan>();
  for (const r of rows) {
    if (!isLoanInterestLine(r.description) || !r.cents) continue;
    const label = r.last4 && !r.name.includes(r.last4) ? `${r.name} ··${r.last4}` : r.name;
    const entry = byLoan.get(r.account_id) ?? { account_id: r.account_id, label, interest_cents: 0 };
    entry.interest_cents += r.cents;
    byLoan.set(r.account_id, entry);
  }
  return [...byLoan.values()].filter((l) => l.interest_cents > 0).sort((a, b) => a.label.localeCompare(b.label));
}
