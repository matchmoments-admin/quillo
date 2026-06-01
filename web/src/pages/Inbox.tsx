import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { BucketPill, Button, ConfidencePill, Card, Spinner, money } from "../components/ui";
import type { Txn } from "../types";

export function Inbox() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({ queryKey: ["transactions"], queryFn: () => api.transactions() });

  const upload = useMutation({
    mutationFn: (file: File) => api.upload(file),
    onMutate: () => setNote("Reading your receipt with Claude…"),
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
  const needsReview = txns.filter((t) => t.confidence == null || t.confidence < 0.85 || t.bucket === "unknown");

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Review</h1>
        <div className="flex items-center gap-3">
          <p className="hidden text-sm text-muted sm:block">
            {needsReview.length} need a look · {txns.length} total
          </p>
          <Button onClick={pickFile} disabled={upload.isPending}>
            {upload.isPending ? "Uploading…" : "+ Add receipt"}
          </Button>
        </div>
      </div>

      {/* Mobile camera: `capture` opens the rear camera; accept images + PDFs. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload.mutate(f);
          e.currentTarget.value = "";
        }}
      />
      {note && <p className="text-sm text-muted">{note}</p>}

      {txns.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">
          No receipts yet. Tap <span className="font-medium text-ink">+ Add receipt</span> to snap one with your camera.
        </Card>
      ) : (
        <ul className="space-y-3">
          {txns.map((t) => (
            <li key={t.id}>
              <Row txn={t} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ txn }: { txn: Txn }) {
  return (
    <Link to={`/txn/${txn.id}`}>
      <Card className="flex items-center gap-4 p-3 transition hover:shadow-md">
        <img
          src={api.receiptUrl(txn.id)}
          alt=""
          className="h-14 w-14 flex-none rounded-lg border border-line bg-surface object-cover"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
          }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{txn.merchant ?? "Unknown merchant"}</span>
            <ConfidencePill value={txn.confidence} />
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
