import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useFeatures } from "../lib/features";
import { Card, Spinner, money, BucketPill } from "../components/ui";
import { useActiveFy, fyLabel } from "../lib/activeFy";
import type { Txn } from "../types";
import { toast } from "sonner";

// Manual receipt ↔ bank-line matching: pick a receipt on the left, then click "Link" on the matching
// bank line. (Statement / feed import also auto-links confident pairs — TaxAgent.matchReceipt; the A8
// proposer, GET /api/reconcile/proposals, suggests the rest for one-tap confirm — never auto-applied.)
// #490: the server now takes fy/limit and returns TRUE totals, with lines pre-ordered by best match
// score — the limit lives in the query key so "Load more" fetches from the server, never a local slice
// masquerading as the whole queue. #589: this is also the Check step's fallback picker
// (/review/match?receipt=ID preselects that receipt); a picked receipt re-fetches with for_receipt so the
// SERVER orders the lines for it (the client-side scorer mirror is gone), and with reconcile_proposals ON
// credit lines are listed too, so a receipt for money coming back has a manual path.
export function Reconcile() {
  const qc = useQueryClient();
  const { fy: activeFy } = useActiveFy();
  const [fy, setFy] = useState<number | undefined>(undefined); // undefined = all years (no behaviour change beyond the caps)
  const [limit, setLimit] = useState(200);
  // keepPreviousData: Load-more / FY changes swap the key — keep the current list on screen instead of
  // blanking the page to a spinner while the bigger page arrives.
  const [params] = useSearchParams();
  const [pickedId, setPickedId] = useState<string | null>(() => params.get("receipt"));
  // reconcile_proposals ON: a picked receipt re-fetches with for_receipt (server ordering). OFF: today's
  // behaviour — one fetch, and the loaded page is re-sorted locally for the picked receipt.
  const { has } = useFeatures();
  const serverOrder = has("reconcile_proposals");
  const forReceipt = serverOrder ? pickedId : null;
  const { data, isLoading, error } = useQuery({
    queryKey: ["reconcile", fy ?? "all", limit, forReceipt],
    queryFn: () => api.reconcilePairs({ fy, limit, forReceipt: forReceipt ?? undefined }),
    placeholderData: keepPreviousData,
  });

  const link = useMutation({
    mutationFn: ({ receiptId, line }: { receiptId: string; line: Txn }) => api.matchLink(receiptId, line.id),
    onSuccess: () => {
      setPickedId(null);
      qc.invalidateQueries({ queryKey: ["reconcile"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    // The server now refuses a link to a line that's gone (ignored / duplicated elsewhere) — say so and
    // refresh the lists instead of silently doing nothing.
    onError: () => {
      toast.error("Couldn't link that pair — the line may have changed. The lists have been refreshed.");
      qc.invalidateQueries({ queryKey: ["reconcile"] });
    },
  });

  if (isLoading) return <Spinner />;
  if (error) return <Card className="p-6 text-sm text-muted">Couldn't load: {(error as Error).message}</Card>;
  const { receipts, lines, total_receipts, total_lines, lines_available } = data!;

  // The server orders the lines: by best score across the loaded receipts, or — with a receipt picked —
  // for THAT receipt (same scorer, src/lib/reconcile-proposer.ts).
  const picked = pickedId ? receipts.find((r) => r.id === pickedId) ?? null : null;
  const candidates = picked && !serverOrder ? [...lines].sort((a, b) => score(picked, b) - score(picked, a)) : lines;
  const countOf = (shown: number, total: number) => (total > shown ? `${shown} of ${total}` : `${total}`);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reconcile</h1>
          <p className="mt-1 text-sm text-muted">
            Attach a receipt to its bank line so it counts once (the line keeps the authoritative amount; the receipt adds GST + the “why”).
          </p>
        </div>
        <label className="text-sm text-muted">
          Bank lines from{" "}
          <select
            className="ml-1 rounded-lg border border-line bg-card px-2 py-1.5 text-sm"
            value={fy ?? ""}
            onChange={(e) => { setFy(e.target.value ? Number(e.target.value) : undefined); setLimit(200); }}
          >
            <option value="">All years</option>
            {[activeFy, activeFy - 1, activeFy - 2].map((y) => <option key={y} value={y}>FY {fyLabel(y)}</option>)}
          </select>
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="overflow-hidden">
          <Th>Unmatched receipts ({countOf(receipts.length, total_receipts)})</Th>
          {receipts.length === 0 ? (
            <Empty>All receipts are matched or standalone.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {receipts.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => setPickedId(picked?.id === r.id ? null : r.id)}
                    className={`flex w-full items-center justify-between px-4 py-2.5 text-left text-sm ${picked?.id === r.id ? "bg-surface" : "hover:bg-surface"}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{r.merchant ?? "Unknown"}</span>
                      <span className="text-muted">{r.txn_date ?? "undated"} · <BucketPill bucket={r.bucket} />{r.direction === "credit" ? " · Money in" : ""}</span>
                    </span>
                    <span className="tabular-nums">{money(r.amount_aud_cents ?? r.amount_cents)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden">
          <Th>{picked ? `Link “${picked.merchant ?? "receipt"}” to…` : `Unmatched bank lines (${countOf(lines.length, total_lines)})`}</Th>
          {candidates.length === 0 ? (
            <Empty>No unmatched bank lines{fy ? " in this year — try All years" : ""}. Import a statement from Accounts.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {candidates.map((l) => (
                <li key={l.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate">{l.merchant ?? l.raw_description}</span>
                    <span className="text-muted">{l.txn_date ?? "—"}{l.direction === "credit" ? " · Money in" : ""}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="tabular-nums">{money(l.amount_aud_cents ?? l.amount_cents)}</span>
                    {picked && (
                      <button
                        onClick={() => link.mutate({ receiptId: picked.id, line: l })}
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
          {lines.length < lines_available && (
            <button
              onClick={() => setLimit((n) => n + 200)}
              className="w-full border-t border-line px-4 py-2.5 text-center text-sm font-medium text-muted hover:text-ink"
            >
              Load more ({lines_available - lines.length} more on the server)
            </button>
          )}
          {lines.length >= lines_available && total_lines > lines_available && (
            <p className="border-t border-line px-4 py-2.5 text-center text-xs text-muted">
              Showing the {lines_available.toLocaleString()} most recent of {total_lines.toLocaleString()} — pick a year above to reach the older lines.
            </p>
          )}
        </Card>
      </div>
      {picked && <p className="text-sm text-muted">Pick the matching bank line on the right, or tap the receipt again to deselect.</p>}
    </div>
  );
}

// Flag-OFF only: kept in sync with reconcileScore() in src/lib/reconcile-proposer.ts (with
// reconcile_proposals ON the server orders the lines per receipt and this isn't used).
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
