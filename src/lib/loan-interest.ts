// Evidence-first loan-interest resolution (#157). Quillo is an evidence app: the bank statement
// itemises the ACTUAL interest charged, so the deductible figure comes from an evidenced FY summary
// (the lender's annual figure, or the parsed statement total) when one exists, and only falls back to
// a clearly-labelled rate × balance ESTIMATE otherwise. Pure — the DO does the D1 reads/writes around
// it; report.ts (S5) consumes it to attribute deductible interest to a property. No I/O here.

export type LoanInterestSource = "lender_summary" | "statement_parsed" | "estimate";

export interface LoanInterestSummary {
  interest_cents: number;
  source: LoanInterestSource;
}

export interface LoanAccountFacts {
  interest_rate_pct?: number | null; // annual rate %, e.g. 6.25 (0044)
  balance_cents?: number | null; // current/average loan balance (0044)
}

/**
 * Resolve a loan's FY interest, EVIDENCE FIRST:
 *  1. a recorded summary (lender_summary / statement_parsed / a stored estimate) — used as-is, its
 *     source carried through so the UI can label provenance;
 *  2. else a derived rate × balance ESTIMATE when both are known — always labelled 'estimate';
 *  3. else null (nothing to attribute).
 * Never combines sources, and never invents a figure: the estimate needs BOTH a rate and a balance.
 */
export function resolveLoanInterest(
  summary: LoanInterestSummary | null | undefined,
  acct: LoanAccountFacts,
): LoanInterestSummary | null {
  if (summary && Number.isFinite(summary.interest_cents) && summary.interest_cents > 0) {
    return { interest_cents: Math.round(summary.interest_cents), source: summary.source };
  }
  const rate = acct.interest_rate_pct;
  const bal = acct.balance_cents;
  if (rate != null && bal != null && Number.isFinite(rate) && Number.isFinite(bal) && rate > 0 && bal > 0) {
    return { interest_cents: Math.round((bal * rate) / 100), source: "estimate" };
  }
  return null;
}

/** The DEDUCTIBLE portion of resolved interest, given the loan→property deductible share (0–100). */
export function deductibleInterestCents(interestCents: number, deductiblePct: number): number {
  const pct = Math.max(0, Math.min(100, Number.isFinite(deductiblePct) ? deductiblePct : 0));
  return Math.max(0, Math.round((interestCents * pct) / 100));
}

/** Whether a resolved figure is only an indicative estimate (drives the "confirm with an agent" copy). */
export function isEstimate(resolved: LoanInterestSummary | null): boolean {
  return resolved?.source === "estimate";
}
