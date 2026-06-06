import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { money } from "./ui";
import type { ScoredTxn } from "../types";

/**
 * Phase 3 — "Find & attach evidence". For a claim suggestion, auto-scores the tenant's transactions
 * as candidate evidence and lets the user attach/detach in one tap. Attaching moves the claim to
 * 'capturing'. Never shows or implies a dollar deduction — it only links evidence. General info only.
 */
export function FindAndAttachSheet({ claimId }: { claimId: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["claim-match", claimId], queryFn: () => api.matchClaim(claimId) });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["claim-match", claimId] });
    qc.invalidateQueries({ queryKey: ["claims"] });
  };
  const attach = useMutation({ mutationFn: (txnId: string) => api.attachClaim(claimId, txnId), onSuccess: refresh });
  const detach = useMutation({ mutationFn: (txnId: string) => api.detachClaim(claimId, txnId), onSuccess: refresh });

  if (isLoading) return <p className="py-2 text-xs text-muted">Finding matching transactions…</p>;
  const candidates = data?.candidates ?? [];
  const linked = data?.linked ?? [];

  return (
    <div className="mt-2 rounded-lg border border-line bg-surface p-2 text-xs">
      {linked.length > 0 && (
        <div className="mb-2">
          <p className="mb-1 font-medium">Attached evidence</p>
          <ul className="space-y-1">
            {linked.map((id) => (
              <li key={id} className="flex items-center justify-between gap-2">
                <span className="truncate text-muted">txn {id.slice(0, 8)}…</span>
                <button onClick={() => detach.mutate(id)} disabled={detach.isPending} className="text-muted hover:text-ink">
                  remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mb-1 font-medium">Suggested matches</p>
      {candidates.length === 0 ? (
        <p className="text-muted">
          No automatic matches found. You can still attach a receipt or bank line from the transaction itself.
        </p>
      ) : (
        <ul className="space-y-1">
          {candidates.map((c) => (
            <CandidateRow key={c.id} c={c} onAttach={() => attach.mutate(c.id)} pending={attach.isPending} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CandidateRow({ c, onAttach, pending }: { c: ScoredTxn; onAttach: () => void; pending: boolean }) {
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="min-w-0 flex-1 truncate">
        {c.merchant || "(no merchant)"} · {money(c.amount_aud_cents ?? c.amount_cents ?? 0)}
        <span className="ml-1 text-muted">({c.reasons.join("+")})</span>
      </span>
      <button onClick={onAttach} disabled={pending} className="flex-none rounded border border-line px-2 py-0.5 hover:opacity-80 disabled:opacity-50">
        attach
      </button>
    </li>
  );
}
