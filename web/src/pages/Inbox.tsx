import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { BucketPill, Button, ConfidencePill, Card, Spinner, money } from "../components/ui";
import type { Txn } from "../types";

const TABS = [
  { key: "receipts", label: "Receipts", opts: { kind: "receipt" } },
  { key: "bank_lines", label: "Bank lines", opts: { kind: "bank_line" } },
  { key: "needs_review", label: "Needs review", opts: { review: true } },
] as const;

export function Inbox() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("receipts");
  const [limit, setLimit] = useState(50);
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
        <h1 className="text-2xl font-semibold tracking-tight">Review</h1>
        <div className="flex items-center gap-3">
          <Button onClick={pickFile} disabled={upload.isPending}>
            {upload.isPending ? "Uploading…" : "+ Add receipt"}
          </Button>
        </div>
      </div>

      {/* Filter tabs — separates receipts from imported bank lines so a statement import
          doesn't flood the receipt review. */}
      <div className="flex gap-1 text-sm">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              setLimit(50);
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
          <ul className="space-y-3">
            {txns.map((t) => (
              <li key={t.id}>
                <Row txn={t} />
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
    </div>
  );
}

function Row({ txn }: { txn: Txn }) {
  const isLine = txn.kind === "bank_line";
  return (
    <Link to={`/txn/${txn.id}`}>
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
  );
}
