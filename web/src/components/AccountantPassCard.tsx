import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Button, Card, money } from "./ui";
import type { AccountantSummary } from "../types";

/**
 * Phase 4 — "Do my books". One button runs the deterministic accountant pass for the active FY
 * (clean up transfers, re-stamp deductibility + suggestions, group recurring patterns, sweep claims)
 * and hands back a sign-off pack of counts. The interactive cards below (movement sweep, clarify,
 * claims) and the suggested-deductions list let the user act on it. General information only.
 */
export function AccountantPassCard({ fy }: { fy: number }) {
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => api.runAccountantPass(fy),
    onSuccess: () => {
      for (const k of ["movements-sweep", "clarify", "claims", "transactions", "dashboard", "accountant-suggestions"]) qc.invalidateQueries({ queryKey: [k] });
    },
  });
  const summary = run.data;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Do my books</h2>
          <p className="text-xs text-muted">
            One pass: tidy transfers, work out what's claimable, and surface questions — you sign off
            below. <span className="text-muted">General information only — not tax advice.</span>
          </p>
        </div>
        <Button onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? "Working…" : "Do my books"}
        </Button>
      </div>
      {run.isError && <p className="text-xs text-warn">{(run.error as Error).message}</p>}
      {summary && <SignOffSummary s={summary} />}
      <SuggestedDeductions fy={fy} />
    </Card>
  );
}

function SignOffSummary({ s }: { s: AccountantSummary }) {
  const items: [string, number][] = [
    ["Transfers to confirm", s.movement_candidates],
    ["Loan lines to review", s.property_loan_review],
    ["Deductions suggested", s.suggestions],
    ["Questions to answer", s.clarify_questions],
    ["Claims to check", s.claim_items],
  ];
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <p className="mb-2 text-xs font-medium">Here's what I found — review and sign off:</p>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        {items.map(([label, n]) => (
          <li key={label} className="flex items-baseline justify-between gap-2">
            <span className="text-muted">{label}</span>
            <span className="font-semibold tabular-nums">{n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SuggestedDeductions({ fy }: { fy: number }) {
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
      <p className="mb-1 text-sm font-medium">Suggested deductions — confirm to include in your position</p>
      <p className="mb-2 text-xs text-muted">
        These look claimable (union/professional fees, tax-agent fees, DGR donations, income protection).
        They're excluded until you confirm. Confirming doesn't predict a refund.
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
