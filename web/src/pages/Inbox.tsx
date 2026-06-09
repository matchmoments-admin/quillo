import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { BucketPill, Button, ConfidencePill, Card, Spinner, money } from "../components/ui";
import { AccountantPassCard } from "../components/AccountantPassCard";
import { SortFlow } from "../components/SortFlow";
import { BulkBar, type BulkDone } from "../components/BulkBar";
import { useFeatures } from "../lib/features";
import { useActiveFy } from "../lib/activeFy";
import type { Txn } from "../types";

// One exceptions list: the review backlog leads (the thing to actually clear), with Receipts / Bank
// lines as filters of the same underlying queue rather than separate destinations.
const TABS = [
  { key: "needs_review", label: "Needs review", opts: { review: true } },
  { key: "receipts", label: "Receipts", opts: { kind: "receipt" } },
  { key: "bank_lines", label: "Bank lines", opts: { kind: "bank_line" } },
] as const;

export function Inbox() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("needs_review");
  const [limit, setLimit] = useState(50);
  // Multi-select for the bulk bar. Reset whenever the tab or page-size changes so a stale id from a
  // no-longer-visible row can't be acted on.
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
  const tabOpts = TABS.find((t) => t.key === tab)!.opts;
  const { data, isLoading, error } = useQuery({
    queryKey: ["transactions", tab, limit],
    queryFn: () => api.transactions({ ...tabOpts, limit }),
  });

  const upload = useMutation({
    mutationFn: (files: File[]) => api.upload(files),
    onMutate: (files) =>
      setNote(files.length > 1 ? `Reading ${files.length} images as one receipt…` : "Reading your receipt with Claude…"),
    onSuccess: () => {
      setNote("Receipt added and categorised ✓");
      qc.invalidateQueries({ queryKey: ["transactions"] });
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
        <h1 className="text-2xl font-semibold tracking-tight">Sort</h1>
        <div className="flex items-center gap-3">
          <Button onClick={pickFile} disabled={upload.isPending}>
            {upload.isPending ? "Uploading…" : "+ Add receipt"}
          </Button>
        </div>
      </div>

      {/* "Do my books" runs automatically on import now — this is just a quiet status strip with a
          manual Re-scan (accountant_pass-gated). */}
      {hasAccountantPass && <AccountantPassCard fy={activeFy} />}

      {/* One "still to review" list LEADS — single transactions are the primary unit of work. Receipts
          / Bank lines just filter the same queue so a statement import doesn't flood the receipt review. */}
      <h2 className="px-1 text-sm font-semibold text-muted">Still to review</h2>
      <div className="flex gap-1 text-sm">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              setLimit(50);
              setSelected(new Set());
            }}
            className={`rounded-lg px-3 py-1.5 ${tab === t.key ? "bg-ink text-white" : "text-muted hover:text-ink"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

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
        <Card className="p-8 text-center text-sm text-muted">
          {tab === "receipts"
            ? "No receipts yet. Tap + Add receipt to snap one, or import a statement from Accounts."
            : tab === "bank_lines"
              ? "No bank lines. Import a statement from the Accounts page."
              : "Nothing needs review — you're all caught up."}
        </Card>
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
                <Row txn={t} selected={selected.has(t.id)} onToggle={() => toggleSel(t.id)} showConfirm={tab === "needs_review"} />
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

      {/* "Finish these" — the small group-action wrap-up cluster (sort repeat merchants, confirm loan
          interest / suggested deductions, exclude transfers). Sits BELOW the list and self-hides when
          there's nothing left to finish. */}
      <SortFlow fy={activeFy} hasAccountantPass={hasAccountantPass} />

      {selected.size > 0 && (
        <BulkBar ids={[...selected]} onClear={() => setSelected(new Set())} onDone={setFlash} />
      )}
      {/* Outcome note + ~10s Undo — lives at page level so it survives the BulkBar unmounting when
          the selection clears on a successful action. */}
      {flash && <UndoToast flash={flash} onClose={() => setFlash(null)} />}
    </div>
  );
}

function UndoToast({ flash, onClose }: { flash: BulkDone; onClose: () => void }) {
  const qc = useQueryClient();
  const undo = useMutation({
    mutationFn: (batchId: string) => api.undoBatch(batchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      onClose();
    },
  });
  // Auto-dismiss after 10s (re-armed whenever a new outcome arrives).
  useEffect(() => {
    const t = setTimeout(onClose, 10_000);
    return () => clearTimeout(t);
  }, [flash, onClose]);
  return (
    <div className="sticky bottom-3 z-10 mx-auto flex w-full max-w-2xl items-center justify-between gap-3 rounded-xl border border-line bg-ink px-3 py-2 text-sm text-white shadow-lg">
      <span>{undo.isPending ? "Undoing…" : flash.message}</span>
      <div className="flex items-center gap-2">
        {flash.batchId && !undo.isPending && (
          <button onClick={() => undo.mutate(flash.batchId!)} className="font-medium underline">
            Undo
          </button>
        )}
        <button onClick={onClose} className="text-white/60 hover:text-white" aria-label="Dismiss">
          ✕
        </button>
      </div>
    </div>
  );
}

function Row({ txn, selected, onToggle, showConfirm = false }: { txn: Txn; selected: boolean; onToggle: () => void; showConfirm?: boolean }) {
  const qc = useQueryClient();
  const isLine = txn.kind === "bank_line";
  // Inline "Confirm as-is" for the Needs-review tab: accept the current bucket and drop the row from
  // the queue WITHOUT opening the detail page and bouncing back to "/" each time (#73). Mirrors
  // TxnDetail's confirm — re-applying the same bucket records acceptance and clears needs_review.
  const confirm = useMutation({
    mutationFn: () => api.correct(txn.id, "bucket", txn.bucket!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  return (
    // The checkbox + confirm button sit OUTSIDE the <Link> — interactive controls nested inside an <a>
    // are invalid HTML and swallow the navigation click.
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
            {txn.currency && txn.currency !== "AUD" && <span className="ml-1 text-xs text-muted">{txn.currency}</span>}
          </div>
          {txn.currency && txn.currency !== "AUD" ? (
            <div className="text-xs text-muted">≈ {money(txn.amount_aud_cents)} AUD</div>
          ) : (
            txn.gst_cents != null && <div className="text-xs text-muted">GST {money(txn.gst_cents)}</div>
          )}
          </div>
        </Card>
      </Link>
      {showConfirm && (
        <div className="flex-none">
          <button
            onClick={() => confirm.mutate()}
            disabled={confirm.isPending || !txn.bucket}
            title={txn.bucket ? "Accept the current category and clear it from review" : "Open it to choose a category first"}
            className="rounded-lg border border-line px-3 py-2 text-sm font-medium transition hover:bg-surface disabled:opacity-50"
          >
            {confirm.isPending ? "…" : "Confirm ✓"}
          </button>
          {confirm.isError && <p className="mt-1 max-w-[7rem] text-right text-xs text-danger">{(confirm.error as Error).message}</p>}
        </div>
      )}
    </div>
  );
}
