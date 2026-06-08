import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Card, money } from "./ui";
import type { MovementCandidate, LoanProperty, Property } from "../types";

/**
 * Phase 5 — guided mortgage interest/principal split. The movement sweep flags loan/mortgage lines
 * tied to a rental as "review" (never one-tap excluded — they may carry deductible interest, s8-1).
 *
 * Lines are GROUPED BY LOAN (account_id) — a year of monthly "LN REPAY" lines is ONE row, not twelve
 * identical ones. The user picks the investment property + deductible-interest % once and taps "Apply
 * to all N": the % (pre-filled from the loan→property link in Settings) is applied to every line in the
 * group, each computing its interest from its own gross (so varying repayments stay correct). Each line
 * keeps its gross amount (reconciliation untouched); only the interest is recorded as a deduction and
 * the principal is excluded. Confirm-each-pattern — nothing auto-applies. General info only.
 *
 * Flag-gated by the caller (`loan_split`): the position only counts the interest when that flag is on.
 */
export function LoanSplitCard() {
  const sweep = useQuery({ queryKey: ["movements-sweep"], queryFn: api.sweepMovements });
  const sit = useQuery({ queryKey: ["situation"], queryFn: api.situation });
  const review = sweep.data?.property_loan_review ?? [];
  if (review.length === 0) return null;

  const links = sit.data?.loans_properties ?? [];
  // Only income-producing properties can carry deductible loan interest — rented, or genuinely
  // available for rent (vacant). Own-home (owner_occupied), tenant rentals (renting_*) and sold
  // properties are excluded; the server enforces the same allowlist.
  const landlordProps = (sit.data?.properties ?? []).filter((p) => p.status === "rented" || p.status === "vacant");

  // One group per loan, keyed on account_id (the canonical loan identity). Lines with NO account_id
  // are deliberately NOT merged by description — two different loans can share a generic "LN REPAY"
  // text, and applying one property + % across both would mis-attribute interest. So a null-account
  // line keys on its own id (stays its own row); same-account lines collapse into one group.
  const groups = new Map<string, MovementCandidate[]>();
  for (const c of review) {
    const key = c.account_id ?? c.id;
    const g = groups.get(key) ?? [];
    g.push(c);
    groups.set(key, g);
  }

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="text-base font-semibold">Split loan interest</h2>
        <p className="text-xs text-muted">
          Only the <em>interest</em> on a loan used to earn income is deductible — the principal isn't. For
          each loan, pick the investment property and confirm the deductible-interest %, then apply it to
          every repayment at once.{" "}
          <span className="text-muted">General information only — confirm with a registered tax agent.</span>
        </p>
      </div>
      {landlordProps.length === 0 ? (
        <p className="text-xs text-warn">
          Add an investment property (Settings) before splitting loan interest — rent on your own home isn't deductible.
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {[...groups.values()].map((cands) => (
            <LoanSplitGroupRow key={cands[0].account_id ?? cands[0].id} cands={cands} links={links} properties={landlordProps} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function LoanSplitGroupRow({
  cands,
  links,
  properties,
}: {
  cands: MovementCandidate[];
  links: LoanProperty[];
  properties: Property[];
}) {
  const qc = useQueryClient();
  const total = cands.reduce((s, c) => s + (c.amount_aud_cents ?? c.amount_cents ?? 0), 0);
  const sample = cands[0].merchant || cands[0].raw_description || "(no description)";
  // Pre-fill from the loan→property link for this loan's account, if one exists.
  const link = links.find((l) => l.loan_account_id === cands[0].account_id);
  const [propId, setPropId] = useState(link?.property_id ?? properties[0]?.id ?? "");
  const [pct, setPct] = useState(link ? String(link.deductible_interest_pct) : "");

  const split = useMutation({
    mutationFn: () =>
      api.applyLoanSplitGroup({ txn_ids: cands.map((c) => c.id), property_id: propId, interest_pct: pct === "" ? 0 : Number(pct) }),
    onSuccess: () => {
      for (const k of ["movements-sweep", "transactions", "dashboard", "report"]) qc.invalidateQueries({ queryKey: [k] });
    },
  });

  const pctNum = pct === "" ? 0 : Number(pct);
  const interest = Math.round((total * pctNum) / 100);

  return (
    <li className="space-y-2 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">{sample}</span>
        <span className="shrink-0 text-xs text-muted">
          {cands.length}× · <span className="tabular-nums">{money(total)}</span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={propId}
          onChange={(e) => setPropId(e.target.value)}
          aria-label="Investment property"
          className="rounded-lg border border-line bg-card px-2 py-1 text-sm"
        >
          {properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={0}
          max={100}
          value={pct}
          onChange={(e) => setPct(e.target.value)}
          placeholder="% interest"
          aria-label="Deductible interest %"
          className="w-24 rounded-lg border border-line bg-card px-2 py-1 text-sm"
        />
        <span className="text-xs text-muted">
          ≈ {money(interest)} interest{pctNum > 0 ? ` · ${money(total - interest)} principal excluded` : ""}
        </span>
        <button
          onClick={() => split.mutate()}
          disabled={split.isPending || !propId || pct === ""}
          className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium hover:bg-surface disabled:opacity-50"
        >
          {split.isPending ? "…" : `Apply to all ${cands.length}`}
        </button>
      </div>
      {split.isError && <p className="text-xs text-danger">{(split.error as Error).message}</p>}
      {split.data && (
        <p className="text-xs text-muted">
          Split {split.data.applied} line{split.data.applied === 1 ? "" : "s"}
          {split.data.skipped > 0 ? ` · ${split.data.skipped} skipped (already split or not a loan line)` : ""}.
        </p>
      )}
    </li>
  );
}
