import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Button, Card, money } from "./ui";

/**
 * Phase 4 — "Do my books". One button runs the deterministic accountant pass for the active FY
 * (clean up transfers, re-stamp deductibility + suggestions, group recurring patterns, sweep claims).
 * This card is just the DRIVER: it runs the pass and reports how much it surfaced. The actual work is
 * done in the ordered "Sort" flow below (movement sweep, clarify, suggested deductions), which this
 * pass populates. General information only.
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
  // What the pass surfaced across every queue — drives the one-line result (the per-queue counts live
  // in the Sort flow's stepper below, so we don't repeat the grid here).
  const found = s ? s.movement_candidates + s.property_loan_review + s.clarify_questions + s.suggestions + s.claim_items : 0;

  return (
    <Card className="space-y-2 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Do my books</h2>
          <p className="text-xs text-muted">
            One pass: tidy transfers, work out what's claimable, and surface questions to sort below.{" "}
            <span className="text-muted">General information only — not tax advice.</span>
          </p>
        </div>
        <Button onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? "Working…" : "Do my books"}
        </Button>
      </div>
      {run.isError && <p className="text-xs text-warn">{(run.error as Error).message}</p>}
      {s && (
        <p className="text-xs text-muted">
          {found === 0
            ? "All tidy — nothing to sort right now ✓"
            : `Sorted what I could — ${found} ${found === 1 ? "item" : "items"} for you to check below.`}
        </p>
      )}
    </Card>
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
              confirm
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
