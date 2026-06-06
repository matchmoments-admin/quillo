import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Card } from "./ui";
import { useFeatures } from "../lib/features";
import { MovementSweepCard } from "./MovementSweepCard";
import { LoanSplitCard } from "./LoanSplitCard";
import { ClarifyCard } from "./ClarifyCard";
import { SuggestedDeductions } from "./AccountantPassCard";

/**
 * Phase 2 — the "Sort" flow as PRIORITY, not gate. "Do my books" populates several work queues
 * (clean transfers, clarify recurring patterns, confirm suggested deductions). Rather than stacking
 * them as co-equal cards, we expand ONE step at a time — the highest-priority queue that still has
 * work — and collapse the rest to one-line summaries the user can jump to. Nothing is gated: the
 * transaction tabs/table below stay reachable, every step is skippable, and cleared steps fall away.
 *
 * Counts are read from the SAME react-query keys the step bodies use (["movements-sweep"],
 * ["clarify", fy], ["accountant-suggestions", fy]), so this adds no extra fetches — it just reads the
 * cache the cards already populate. General information only.
 */

type StepKey = "movements" | "loanSplit" | "clarify" | "suggestions";

export function SortFlow({ fy, hasAccountantPass }: { fy: number; hasAccountantPass: boolean }) {
  const { has } = useFeatures();
  const hasLoanSplit = has("loan_split");
  // Which step the user manually expanded. Null = follow the derived priority order.
  const [override, setOverride] = useState<StepKey | null>(null);
  // Drop a manual expansion when the active FY changes — a step the user opened for one year's data
  // shouldn't stay forced open against another year's queues.
  useEffect(() => setOverride(null), [fy]);

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

  const ignorableCount = sweep.data?.ignorable.length ?? 0;
  const reviewCount = sweep.data?.property_loan_review.length ?? 0;
  // When loan_split is on, the loan-review lines get their own actionable step; otherwise they stay
  // in the movement sweep card's read-only review box, so they count toward the movements step.
  const moveCount = ignorableCount + (hasLoanSplit ? 0 : reviewCount);
  const clarifyCount = clarify.data?.length ?? 0;
  const suggCount = suggestions.data?.length ?? 0;

  // Step order = the order you work them. Movement sweep is always available; the loan split (flag
  // loan_split) and clarify + suggested deductions (flag accountant_pass) are gated.
  const steps: { key: StepKey; title: string; count: number; body: ReactNode }[] = [
    { key: "movements", title: "Clean up transfers & repayments", count: moveCount, body: <MovementSweepCard /> },
  ];
  if (hasLoanSplit) {
    steps.push({ key: "loanSplit", title: "Split loan interest", count: reviewCount, body: <LoanSplitCard /> });
  }
  if (hasAccountantPass) {
    steps.push({ key: "clarify", title: "Clarify recurring patterns", count: clarifyCount, body: <ClarifyCard fy={fy} /> });
    steps.push({
      key: "suggestions",
      title: "Confirm suggested deductions",
      count: suggCount,
      body: (
        <Card className="p-4">
          <SuggestedDeductions fy={fy} />
        </Card>
      ),
    });
  }

  const withWork = steps.filter((s) => s.count > 0);
  if (withWork.length === 0) return null; // nothing to sort — keep the page quiet (the table is below)

  // Active = the step the user expanded, else the first with outstanding work. If an override points
  // at a step that's since been cleared, fall back to the derived one.
  const active = override && withWork.some((s) => s.key === override) ? override : withWork[0].key;
  // "Skip for now" hands off to the next outstanding step (wrapping). Only shown when >1 step has
  // work, so there is always a different step to move to. Step numbers are STABLE — derived from the
  // full step order, not the filtered list — so a step keeps its number as others clear.
  const stepNo = (key: StepKey): number => steps.findIndex((s) => s.key === key) + 1;
  const skipTo = (key: StepKey): StepKey => {
    const idx = withWork.findIndex((s) => s.key === key);
    return withWork[(idx + 1) % withWork.length].key;
  };

  return (
    <div className="space-y-3">
      <h2 className="px-1 text-sm font-semibold text-muted">
        Sort — {withWork.length} {withWork.length === 1 ? "thing" : "things"} to do
      </h2>
      {withWork.map((s) =>
        s.key === active ? (
          <div key={s.key}>
            {s.body}
            {withWork.length > 1 && (
              <button onClick={() => setOverride(skipTo(s.key))} className="mt-1 px-1 text-xs text-muted hover:text-ink">
                Skip for now →
              </button>
            )}
          </div>
        ) : (
          <CollapsedRow key={s.key} n={stepNo(s.key)} title={s.title} count={s.count} onOpen={() => setOverride(s.key)} />
        ),
      )}
    </div>
  );
}

function CollapsedRow({ n, title, count, onOpen }: { n: number; title: string; count: number; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-xl border border-line bg-card px-4 py-3 text-left transition hover:shadow-card"
    >
      <span className="grid h-6 w-6 flex-none place-items-center rounded-full bg-surface text-xs font-semibold text-muted tabular-nums">
        {n}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      <span className="flex-none rounded-full bg-green/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-green">
        {count} to do
      </span>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="flex-none text-muted" aria-hidden>
        <path d="M6 3l5 5-5 5" />
      </svg>
    </button>
  );
}
