import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { BucketPill, Button, ConfidencePill, Card, Spinner, money, getBaseCurrency } from "./ui";
import { AccountantPassCard } from "./AccountantPassCard";
import { SortFlow } from "./SortFlow";
import { BulkBar, type BulkDone } from "./BulkBar";
import { UndoToast } from "./UndoToast";
import { useFeatures } from "../lib/features";
import { useActiveFy } from "../lib/activeFy";
import type { Txn } from "../types";

/**
 * ReviewView — the "Needs review" experience, rendered as a tab of the merged Transactions page when
 * `unified_transactions` is ON. This is the still-to-review backlog (review=true): single transactions
 * are the unit of work, confirmed inline. It is deliberately ALL-TIME (a cross-year backlog) and so
 * ignores the global FY switcher — matching the standalone Inbox it replaces. The Receipts / Bank-lines
 * filters that used to live alongside it now live in the "All" browse view as a kind filter.
 *
 * NOTE: this duplicates the needs-review portion of pages/Inbox.tsx. Inbox.tsx is retained intact for
 * the flag-OFF path (so OFF is byte-identical) and is slated for deletion in a later cleanup slice once
 * the flag is permanently ON. General information only.
 */
export function ReviewView() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<BulkDone | null>(null);
  const { has } = useFeatures();
  const hasAccountantPass = has("accountant_pass");
  const { fy: activeFy } = useActiveFy();
  const toggleSel = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // All-time, review-only — the same ["transactions", …] cache the rest of the app invalidates.
  const { data, isLoading, error } = useQuery({
    queryKey: ["transactions", "needs_review", limit],
    queryFn: () => api.transactions({ review: true, limit }),
  });

  const upload = useMutation({
    mutationFn: (files: File[]) => api.upload(files),
    onMutate: (files) =>
      setNote(files.length > 1 ? `Reading ${files.length} images as one receipt…` : "Reading your receipt with Claude…"),
    onSuccess: () => {
      setNote("Receipt added and categorised ✓");
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["transactions-all"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => setNote(`Upload failed: ${(e as Error).message}`),
  });

  const pickFile = () => fileRef.current?.click();

  if (isLoading) return <Spinner />;
  if (error) {
    const unauth = (error as Error).message === "unauthorized";
    return (
      <Card className="p-6 text-sm text-muted">
        {unauth
          ? "Not signed in. This app sits behind Cloudflare Access — open it through your Access URL."
          : `Couldn't load transactions: ${(error as Error).message}`}
      </Card>
    );
  }

  const txns = data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-3">
        {/* Review is a running, cross-year backlog — say so, since the global FY switcher has no effect here. */}
        <p className="px-1 text-xs text-muted">Showing all years — review is a running backlog.</p>
        <Button onClick={pickFile} disabled={upload.isPending}>
          {upload.isPending ? "Uploading…" : "+ Add receipt"}
        </Button>
      </div>

      {/* "Do my books" runs automatically on import — this is just a status strip with a manual Re-scan. */}
      {hasAccountantPass && <AccountantPassCard fy={activeFy} />}

      {/* Mobile camera: `capture` opens the rear camera; accept images + PDFs. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => {
          const fs = Array.from(e.target.files ?? []);
          if (fs.length) upload.mutate(fs);
          e.currentTarget.value = "";
        }}
      />
      {note && <p className="text-sm text-muted">{note}</p>}

      {txns.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">Nothing needs review — you're all caught up.</Card>
      ) : (
        <>
          <label className="flex items-center gap-2 px-1 text-xs text-muted">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={txns.length > 0 && txns.every((t) => selected.has(t.id))}
              onChange={(e) => setSelected(e.target.checked ? new Set(txns.map((t) => t.id)) : new Set())}
            />
            Select all on this page
          </label>
          <ul className="space-y-3">
            {txns.map((t) => (
              <li key={t.id}>
                <Row txn={t} selected={selected.has(t.id)} onToggle={() => toggleSel(t.id)} />
              </li>
            ))}
          </ul>
          {txns.length >= limit && (
            <button onClick={() => setLimit((l) => l + 50)} className="w-full rounded-lg border border-line py-2 text-sm text-muted hover:text-ink">
              Load more
            </button>
          )}
        </>
      )}

      {/* "Finish these" — group-action wrap-up (sort repeat merchants, confirm loan interest, exclude
          transfers). Self-hides when there's nothing left. */}
      <SortFlow fy={activeFy} hasAccountantPass={hasAccountantPass} />

      {selected.size > 0 && <BulkBar ids={[...selected]} onClear={() => setSelected(new Set())} onDone={setFlash} />}
      {flash && <UndoToast flash={flash} onClose={() => setFlash(null)} />}
    </div>
  );
}

function Row({ txn, selected, onToggle }: { txn: Txn; selected: boolean; onToggle: () => void }) {
  const qc = useQueryClient();
  const isLine = txn.kind === "bank_line";
  // Inline "Confirm as-is": accept the current bucket and drop the row from the queue without bouncing
  // through the detail page. Mirrors TxnDetail's confirm — re-applying the same bucket records
  // acceptance and clears needs_review.
  const confirm = useMutation({
    mutationFn: () => api.correct(txn.id, "bucket", txn.bucket!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["transactions-all"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["report"] });
      qc.invalidateQueries({ queryKey: ["filing-readiness"] });
    },
  });
  // You can't "confirm as-is" an unknown row — that would re-write bucket='unknown' and it would never
  // leave the queue. Force such rows into the detail page to pick a real category.
  const canConfirm = !!txn.bucket && txn.bucket !== "unknown";
  return (
    <div className="flex items-center gap-2">
      <input type="checkbox" checked={selected} onChange={onToggle} className="h-4 w-4 flex-none" aria-label="Select transaction" />
      <Link to={`/txn/${txn.id}`} className="min-w-0 flex-1">
        <Card className="flex items-center gap-4 p-3 transition hover:shadow-md">
          {isLine ? (
            <div className="grid h-14 w-14 flex-none place-items-center rounded-lg border border-line bg-surface text-[10px] font-medium uppercase text-muted">
              line
            </div>
          ) : (
            <img
              src={api.receiptUrl(txn.id)}
              alt=""
              className="h-14 w-14 flex-none rounded-lg border border-line bg-surface object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
              }}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{txn.merchant ?? txn.raw_description ?? "Unknown"}</span>
              {!isLine && <ConfidencePill value={txn.confidence} />}
            </div>
            <div className="mt-1 flex items-center gap-2 text-sm text-muted">
              <BucketPill bucket={txn.bucket} />
              <span>·</span>
              <span className={txn.txn_date ? "" : "text-warn"}>{txn.txn_date ?? "undated"}</span>
              {txn.duplicate_of && <span className="rounded-full bg-warn/10 px-2 py-0.5 text-xs font-medium text-warn">duplicate</span>}
              <span>·</span>
              <span className="capitalize">{txn.source}</span>
            </div>
          </div>
          <div className="flex-none text-right">
            <div className="font-semibold tabular-nums">
              {money(txn.amount_cents)}
              {txn.currency && txn.currency !== getBaseCurrency() && <span className="ml-1 text-xs text-muted">{txn.currency}</span>}
            </div>
            {txn.currency && txn.currency !== getBaseCurrency() ? (
              <div className="text-xs text-muted">≈ {money(txn.amount_aud_cents)} {getBaseCurrency()}</div>
            ) : (
              txn.gst_cents != null && <div className="text-xs text-muted">GST {money(txn.gst_cents)}</div>
            )}
          </div>
        </Card>
      </Link>
      <div className="flex-none">
        <button
          onClick={() => confirm.mutate()}
          disabled={confirm.isPending || !canConfirm}
          title={confirm.isPending ? "Confirming…" : canConfirm ? "Accept the current category and clear it from review" : "Open it to choose a category first"}
          className="rounded-lg border border-line px-3 py-2 text-sm font-medium transition hover:bg-surface disabled:opacity-50"
        >
          {confirm.isPending ? "…" : "Confirm ✓"}
        </button>
        {confirm.isError && <p className="mt-1 max-w-[7rem] text-right text-xs text-danger">{(confirm.error as Error).message}</p>}
      </div>
    </div>
  );
}
