import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Button, Card, QueryError, money } from "./ui";
import type { MovementCandidate } from "../types";

const KLASS_LABEL: Record<string, string> = {
  internal_transfer: "Transfer",
  card_payment: "Card payment",
  loan_repayment: "Loan repayment",
  investment_deposit: "Investment deposit",
  none: "",
};

/**
 * Stage A — "Clean up transfers & repayments". Deterministic, free, no AI/consent. Shows a
 * PRE-CHECKED list of detected non-spend movements the user signs off in one tap (→ excluded as
 * 'ignored'), plus a separate read-only review list for loan lines that may carry a DEDUCTIBLE
 * investment-loan interest component (never offered for one-tap exclusion). Renders nothing when
 * there's nothing to clean up.
 */
export function MovementSweepCard() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["movements-sweep"], queryFn: api.sweepMovements });
  const ignorable = data?.ignorable ?? [];
  // Selection defaults to ALL candidates (pre-checked); recomputed when the candidate id set changes.
  const allIds = useMemo(() => ignorable.map((c) => c.id), [ignorable]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);

  const apply = useMutation({
    mutationFn: (ids: string[]) => api.applyMovementSweep(ids),
    onSuccess: (r) => {
      // Surface server-side skips too — a skip means the line re-classified as a loan/income line
      // and was deliberately protected (B3), so the count can legitimately differ from the request.
      const skip = r.skipped > 0 ? ` (${r.skipped} kept for review)` : "";
      setNote(`Excluded ${r.ignored} non-spend ${r.ignored === 1 ? "line" : "lines"}${skip}.`);
      setExcluded(new Set()); // reset selection so the refetched list is pre-checked afresh
      qc.invalidateQueries({ queryKey: ["movements-sweep"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => setNote(`Couldn't apply: ${(e as Error).message}`),
  });

  if (isLoading) return null;
  if (error) return <QueryError what="transfers to exclude" error={error} onRetry={() => refetch()} />;
  if (!data) return null;
  // Loan-repayment lines that may carry deductible investment-loan interest — read-only review box.
  // (The legacy per-line "Split loan interest" UI was retired; loan_interest_v2 captures the deductible
  // figure against the loan account, so these just route the user to categorise each line.)
  const review = data.property_loan_review ?? [];
  if (ignorable.length === 0 && review.length === 0) return null;

  const selected = allIds.filter((id) => !excluded.has(id));
  const selectedTotal = ignorable
    .filter((c) => !excluded.has(c.id))
    .reduce((s, c) => s + (c.amount_aud_cents ?? c.amount_cents ?? 0), 0);
  const toggle = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Clean up transfers &amp; repayments</h2>
          <p className="text-xs text-muted">
            These look like money moving between accounts — not spend. Excluding them keeps your position
            accurate. <span className="text-muted">General information only — review before confirming.</span>
          </p>
        </div>
        {ignorable.length > 0 && (
          <Button onClick={() => apply.mutate(selected)} disabled={apply.isPending || selected.length === 0}>
            {apply.isPending ? "Excluding…" : `Exclude ${selected.length} (${money(selectedTotal)})`}
          </Button>
        )}
      </div>

      {ignorable.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {ignorable.map((c) => (
            <CandidateRow key={c.id} c={c} checked={!excluded.has(c.id)} onToggle={() => toggle(c.id)} disabled={apply.isPending} />
          ))}
        </ul>
      )}

      {review.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs font-medium text-amber-900">
            Review separately — {review.length} loan {review.length === 1 ? "line" : "lines"} may include deductible
            investment-loan interest
          </p>
          <p className="mb-2 text-xs text-amber-800">
            We won't auto-exclude these: if any part is interest on a loan used to earn income (a rental,
            share or investment loan), it may be deductible. Open each to categorise.
          </p>
          <ul className="space-y-1">
            {review.map((c) => (
              <li key={c.id} className="text-xs">
                <Link to={`/txn/${c.id}`} className="text-amber-900 underline">
                  {c.merchant || c.raw_description || "(no description)"} · {money(c.amount_aud_cents ?? c.amount_cents ?? 0)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {note && <p className="text-xs text-muted">{note}</p>}
    </Card>
  );
}

function CandidateRow({ c, checked, onToggle, disabled }: { c: MovementCandidate; checked: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <li className="flex items-center gap-3 p-2.5">
      <input type="checkbox" checked={checked} onChange={onToggle} disabled={disabled} className="h-4 w-4 shrink-0" aria-label="Exclude this line" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{c.merchant || c.raw_description || "(no description)"}</p>
        <p className="truncate text-xs text-muted">{c.reason}</p>
      </div>
      <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
        {KLASS_LABEL[c.klass]}
      </span>
      <span className="shrink-0 text-sm tabular-nums">{money(c.amount_aud_cents ?? c.amount_cents ?? 0)}</span>
    </li>
  );
}
