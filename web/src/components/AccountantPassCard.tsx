import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { money } from "./ui";

/**
 * "Do my books" — now invisible plumbing. The deterministic accountant pass (clean up transfers,
 * re-stamp deductibility + suggestions, group recurring patterns, sweep claims) runs AUTOMATICALLY
 * after every import, so the ordered "Sort" flow below is already populated. This is just a quiet
 * status strip with a manual "Re-scan" for when the user adds rules or wants to re-check a prior year.
 * General information only.
 */
export function AccountantPassCard({ fy }: { fy: number }) {
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => api.runAccountantPass(fy),
    onSuccess: () => {
      for (const k of ["movements-sweep", "clarify", "claims", "transactions", "dashboard", "accountant-suggestions"]) qc.invalidateQueries({ queryKey: [k] });
    },
  });
  const s = run.data;
  // What a manual re-scan surfaced across every queue (per-queue counts live in the Sort stepper below).
  const found = s ? s.movement_candidates + s.property_loan_review + s.clarify_questions + s.suggestions + s.claim_items : 0;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-muted">
      <span>
        Transfers, deductibility and recurring patterns are sorted automatically when you import.{" "}
        {run.isError ? (
          <span className="text-warn">{(run.error as Error).message}</span>
        ) : s ? (
          <span>{found === 0 ? "All tidy ✓" : `Re-scan found ${found} to check below.`}</span>
        ) : (
          <span>General information only — not tax advice.</span>
        )}
      </span>
      <button
        onClick={() => run.mutate()}
        disabled={run.isPending}
        className="flex-none rounded-lg border border-line px-2.5 py-1 font-medium text-ink transition hover:bg-surface disabled:opacity-50"
      >
        {run.isPending ? "Scanning…" : "↻ Re-scan"}
      </button>
    </div>
  );
}

export function SuggestedDeductions({ fy }: { fy: number }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["accountant-suggestions", fy], queryFn: () => api.accountantSuggestions(fy) });
  const confirm = useMutation({
    mutationFn: (txnId: string) => api.confirmDeduction(txnId),
    onSuccess: () => {
      for (const k of ["accountant-suggestions", "dashboard", "report", "transactions"]) qc.invalidateQueries({ queryKey: [k] });
    },
  });
  const rows = data ?? [];
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-line p-3">
      <p className="mb-1 text-sm font-medium">Possible deductions — confirm each to include it</p>
      <p className="mb-2 text-xs text-muted">
        These categories (union/professional fees, tax-agent fees, DGR donations, income protection)
        <em>might</em> apply to you — nothing is claimed yet, and each stays out of your position until you
        confirm it relates to earning your income. For donations, check the organisation is a DGR and you
        received nothing in return. General information only — confirming doesn't predict a refund.
      </p>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {r.merchant || r.ato_label || "(no merchant)"} · {money(r.amount_aud_cents ?? r.amount_cents ?? 0)}
            </span>
            <button
              onClick={() => confirm.mutate(r.id)}
              disabled={confirm.isPending}
              className="flex-none rounded border border-line px-2 py-0.5 text-xs hover:opacity-80 disabled:opacity-50"
            >
              Add to my deductions
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
