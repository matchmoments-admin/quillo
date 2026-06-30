import { type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Card, QueryError } from "./ui";
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
  // "To confirm" = every loan whose FY interest isn't a user-confirmed lender_summary yet — including
  // ones auto-prefilled from a parsed statement (source='statement_parsed', #165), which the user still
  // confirms. A confirmed lender_summary drops out.
  const loanInterestCount = (loanInterest.data ?? []).filter((l) => l.source !== "lender_summary").length;

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

  // A failed query here would otherwise read as count=0 ⇒ the card silently doesn't render ⇒ the user
  // thinks they have nothing to finish. Surface which group couldn't load instead. (Only enabled
  // queries can error; the disabled ones stay idle.)
  const failed = [
    sweep.isError && "transfers to exclude",
    clarify.isError && "repeat merchants",
    suggestions.isError && "suggested deductions",
    loanInterest.isError && "loan interest",
  ].filter(Boolean) as string[];

  if (cards.length === 0 && failed.length === 0) return null; // nothing to finish — keep the page quiet

  return (
    <div className="space-y-3">
      <h2 className="px-1 text-sm font-semibold text-muted">Finish these</h2>
      {failed.length > 0 && (
        <QueryError
          what={`your ${failed.join(", ")}`}
          onRetry={() => {
            if (sweep.isError) sweep.refetch();
            if (clarify.isError) clarify.refetch();
            if (suggestions.isError) suggestions.refetch();
            if (loanInterest.isError) loanInterest.refetch();
          }}
        />
      )}
      {cards.map((c) => (
        <div key={c.key}>{c.node}</div>
      ))}
    </div>
  );
}
