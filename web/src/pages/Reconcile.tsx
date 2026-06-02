import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Card, Spinner, money, BucketPill } from "../components/ui";
import type { Txn } from "../types";

// Manual receipt ↔ bank-line matching. Auto-matching runs server-side; this is the fallback
// for the misses: pick a receipt on the left, then click "Link" on the matching bank line.
export function Reconcile() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["reconcile"], queryFn: () => api.reconcilePairs() });
  const [picked, setPicked] = useState<Txn | null>(null);

  const link = useMutation({
    mutationFn: (line: Txn) => api.matchLink(picked!.id, line.id),
    onSuccess: () => {
      setPicked(null);
      qc.invalidateQueries({ queryKey: ["reconcile"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  if (isLoading) return <Spinner />;
  if (error) return <Card className="p-6 text-sm text-muted">Couldn't load: {(error as Error).message}</Card>;
  const { receipts, lines } = data!;

  // Surface the likeliest lines first when a receipt is picked (amount within $1, date ±4d).
  const candidates = picked
    ? [...lines].sort((a, b) => score(picked, b) - score(picked, a))
    : lines;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reconcile</h1>
        <p className="mt-1 text-sm text-muted">
          Attach a receipt to its bank line so it counts once (the line keeps the authoritative amount; the receipt adds GST + the “why”).
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="overflow-hidden">
          <Th>Unmatched receipts ({receipts.length})</Th>
          {receipts.length === 0 ? (
            <Empty>All receipts are matched or standalone.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {receipts.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => setPicked(picked?.id === r.id ? null : r)}
                    className={`flex w-full items-center justify-between px-4 py-2.5 text-left text-sm ${picked?.id === r.id ? "bg-surface" : "hover:bg-surface"}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{r.merchant ?? "Unknown"}</span>
                      <span className="text-muted">{r.txn_date ?? "undated"} · <BucketPill bucket={r.bucket} /></span>
                    </span>
                    <span className="tabular-nums">{money(r.amount_aud_cents ?? r.amount_cents)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden">
          <Th>{picked ? `Link “${picked.merchant ?? "receipt"}” to…` : `Unmatched bank lines (${lines.length})`}</Th>
          {candidates.length === 0 ? (
            <Empty>No unmatched bank lines. Import a statement from Accounts.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {candidates.slice(0, 60).map((l) => (
                <li key={l.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate">{l.merchant ?? l.raw_description}</span>
                    <span className="text-muted">{l.txn_date ?? "—"}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="tabular-nums">{money(l.amount_aud_cents ?? l.amount_cents)}</span>
                    {picked && (
                      <button
                        onClick={() => link.mutate(l)}
                        disabled={link.isPending}
                        className="rounded-lg bg-ink px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                      >
                        Link
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {picked && <p className="text-sm text-muted">Pick the matching bank line on the right, or tap the receipt again to deselect.</p>}
    </div>
  );
}

function score(receipt: Txn, line: Txn): number {
  const ra = receipt.amount_aud_cents ?? receipt.amount_cents ?? 0;
  const la = line.amount_aud_cents ?? line.amount_cents ?? 0;
  const amt = 1 - Math.min(Math.abs(ra - la) / Math.max(50, ra * 0.01), 1);
  let date = 0;
  if (receipt.txn_date && line.txn_date) {
    const d = Math.abs((Date.parse(receipt.txn_date) - Date.parse(line.txn_date)) / 86_400_000);
    date = 1 - Math.min(d, 7) / 7;
  }
  return amt * 0.7 + date * 0.3;
}

function Th({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted">{children}</div>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-sm text-muted">{children}</div>;
}
