import { type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Card } from "./ui";
import { useFeatures } from "../lib/features";
import { MovementSweepCard } from "./MovementSweepCard";
import { LoanInterestCard } from "./LoanInterestCard";
import { ClarifyCard } from "./ClarifyCard";
import { SuggestedDeductions } from "./AccountantPassCard";

/**
 * "Finish these" — the small wrap-up cluster under the review list. Single-transaction work (the
 * list above + apply-to-siblings) is the primary flow; these are the few group actions that don't fit
 * a single row: exclude transfers/repayments, confirm the lender's loan interest, confirm suggested
 * deductions, and sort repeat merchants. Each card SELF-HIDES when it has no work, so this is a flat
 * stack (no stepper, no ordering machinery) that simply falls away when everything is clear.
 *
 * Counts are read from the SAME react-query keys the card bodies use (["movements-sweep"],
 * ["clarify", fy], ["accountant-suggestions", fy], ["loan-interest-review", fy]) — no extra fetches.
 * General information only.
 */
export function SortFlow({ fy, hasAccountantPass }: { fy: number; hasAccountantPass: boolean }) {
  const { has } = useFeatures();
  const hasLoanInterest = has("loan_interest_v2");

  const sweep = useQuery({ queryKey: ["movements-sweep"], queryFn: api.sweepMovements });
  const clarify = useQuery({
    queryKey: ["clarify", fy],
    queryFn: () => api.clarifyQuestions(fy),
    enabled: hasAccountantPass,
  });
  const suggestions = useQuery({
    queryKey: ["accountant-suggestions", fy],
    queryFn: () => api.accountantSuggestions(fy),
    enabled: hasAccountantPass,
  });
  // Loans tied to a rental property whose FY interest hasn't been confirmed yet (evidence-first model).
  const loanInterest = useQuery({
    queryKey: ["loan-interest-review", fy],
    queryFn: () => api.loanInterestReview(fy),
    enabled: hasLoanInterest,
  });

  // The loan-repayment "review" lines stay in MovementSweep's read-only box (the legacy per-line
  // "Split loan interest" UI was retired — evidence-first loan_interest_v2 owns the deductible figure),
  // so they count toward the movement sweep.
  const moveCount = (sweep.data?.ignorable.length ?? 0) + (sweep.data?.property_loan_review.length ?? 0);
  const clarifyCount = clarify.data?.length ?? 0;
  const suggCount = suggestions.data?.length ?? 0;
  const loanInterestCount = (loanInterest.data ?? []).filter((l) => l.recorded_cents == null).length;

  // Order = the order you work them: sort repeat merchants first (most lines cleared per tap), then
  // confirm loan interest, confirm suggested deductions, then the transfer clean-up.
  const cards: { key: string; node: ReactNode }[] = [];
  if (hasAccountantPass && clarifyCount > 0) cards.push({ key: "clarify", node: <ClarifyCard fy={fy} /> });
  if (hasLoanInterest && loanInterestCount > 0) cards.push({ key: "loanInterest", node: <LoanInterestCard fy={fy} /> });
  if (hasAccountantPass && suggCount > 0)
    cards.push({
      key: "suggestions",
      node: (
        <Card className="p-4">
          <SuggestedDeductions fy={fy} />
        </Card>
      ),
    });
  if (moveCount > 0) cards.push({ key: "movements", node: <MovementSweepCard /> });

  if (cards.length === 0) return null; // nothing to finish — keep the page quiet (the list is above)

  return (
    <div className="space-y-3">
      <h2 className="px-1 text-sm font-semibold text-muted">Finish these</h2>
      {cards.map((c) => (
        <div key={c.key}>{c.node}</div>
      ))}
    </div>
  );
}
