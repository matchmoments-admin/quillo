import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

// The cross-tab "where am I / what's next" spine. Ambient (always visible, never modal), oriented
// to one goal: getting the year ready to hand off to your agent. Reads the shared ["progress"] query so it can't drift
// from the per-tab guides (and TabGuide reads the same key). It's an ALL-TIME cross-year backlog —
// deliberately not FY-scoped — so it matches the Inbox/Reconcile queues it routes to (those aren't
// FY-scoped either). Clicking the next action routes to it. Freshness after a write is handled
// globally (a MutationCache hook in main.tsx invalidates ["progress"] on any successful mutation),
// so the spine updates when the user confirms/dates an item, without a refetch storm on navigation.
export function NextActionBar() {
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ["progress"], queryFn: () => api.progress() });

  if (!data) return null;
  const { imported, categorised, needs_review, undated, done, next_action } = data;

  // Build the ambient summary: "412 transactions, all categorised · 6 to review · 2 to date".
  const parts: string[] = [];
  if (imported.transactions > 0) {
    parts.push(`${imported.transactions} ${imported.transactions === 1 ? "transaction" : "transactions"}`);
    parts.push(categorised >= imported.transactions ? "all categorised" : `${categorised} categorised`);
    if (needs_review > 0) parts.push(`${needs_review} to review`);
    if (undated > 0) parts.push(`${undated} to date`);
  } else {
    parts.push("Nothing imported yet");
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-line bg-card px-3 py-2 text-sm shadow-card">
      <span className="text-muted">{parts.join(" · ")}</span>
      <span className="text-ink-3">—</span>
      <button
        type="button"
        onClick={() => navigate(next_action.href)}
        className="inline-flex items-center gap-1.5 rounded-full bg-ink px-3 py-1 text-xs font-semibold text-cream transition hover:bg-green"
      >
        {done ? "You're ready — open File to hand off" : next_action.label}
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M6 3l5 5-5 5" />
        </svg>
      </button>
    </div>
  );
}
