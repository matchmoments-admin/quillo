import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Button, Card, Spinner, money } from "./ui";

/**
 * "Confirm loan interest" — the Sort step that REPLACES the retired manual loan-interest/principal
 * split (flag loan_interest_v2). For each loan tied to a rental property, the user confirms the
 * lender's ACTUAL interest for the year (from the annual summary / statements) — that figure is the
 * property's deductible interest. A rate×balance figure from the account is offered as a labelled
 * ESTIMATE prefill only. General information only — not tax advice.
 */
export function LoanInterestCard({ fy }: { fy: number }) {
  const q = useQuery({ queryKey: ["loan-interest-review", fy], queryFn: () => api.loanInterestReview(fy) });
  if (q.isLoading) return <Spinner />;
  const loans = q.data ?? [];
  if (loans.length === 0) return null;
  const fyLabel = `${fy}–${String((fy + 1) % 100).padStart(2, "0")}`;

  return (
    <Card className="space-y-3 p-4">
      <div>
        <div className="text-sm font-semibold">Confirm loan interest · FY {fyLabel}</div>
        <p className="text-xs text-muted">
          Enter the actual interest your lender charged this year (from their annual summary or your statements) — that's the deductible interest for the property. General information only — not tax advice.
        </p>
      </div>
      {loans.map((l) => (
        <LoanInterestRow key={l.loan_account_id} fy={fy} loan={l} />
      ))}
    </Card>
  );
}

function LoanInterestRow({
  fy,
  loan,
}: {
  fy: number;
  loan: { loan_account_id: string; loan_name: string; properties: { id: string; label: string | null }[]; recorded_cents: number | null; source: string | null; estimate_cents: number | null };
}) {
  const qc = useQueryClient();
  // Prefill with the recorded figure, else the rate×balance estimate (in dollars). Empty otherwise.
  const seed = loan.recorded_cents != null ? loan.recorded_cents : loan.estimate_cents;
  const [value, setValue] = useState(seed != null ? String(seed / 100) : "");
  const save = useMutation({
    mutationFn: () => api.setLoanInterest(loan.loan_account_id, { fy, interest_cents: Math.round(Number(value) * 100), source: "lender_summary" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["loan-interest-review", fy] });
      qc.invalidateQueries({ queryKey: ["loan-interest", fy] });
      qc.invalidateQueries({ queryKey: ["report"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["filing-readiness"] });
    },
  });
  const props = loan.properties.map((p) => p.label ?? "—").join(", ");
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{loan.loan_name}</div>
          <div className="truncate text-xs text-muted">{props || "Linked rental property"}</div>
        </div>
        <div className="flex items-end gap-2">
          <label className="w-32">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Interest $</span>
            <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder="12000" className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2" />
          </label>
          <Button onClick={() => save.mutate()} disabled={save.isPending || value.trim() === ""}>
            {save.isPending ? "Saving…" : loan.recorded_cents != null ? "Update" : "Confirm"}
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted">
        {loan.recorded_cents != null
          ? `Recorded: ${money(loan.recorded_cents)}${loan.source === "estimate" ? " · estimate" : ""}.`
          : loan.estimate_cents != null
            ? `≈ ${money(loan.estimate_cents)} estimate from the account rate × balance — replace with the actual figure from your lender.`
            : "Enter the actual interest from your lender's annual summary or statements."}
      </p>
      {save.isError && <p className="mt-1 text-xs text-danger">Couldn't save: {(save.error as Error).message}</p>}
    </div>
  );
}
