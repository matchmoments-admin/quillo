import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { BucketPill, ConfidencePill, Card, Spinner, money } from "../components/ui";
import type { Txn } from "../types";

export function Inbox() {
  const { data, isLoading, error } = useQuery({ queryKey: ["transactions"], queryFn: () => api.transactions() });

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
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Review</h1>
        <p className="text-sm text-muted">
          {needsReview.length} need a look · {txns.length} total
        </p>
      </div>

      {txns.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">
          No receipts yet. Forward one to your receipts mailbox or snap it in the app.
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
            <span>{txn.txn_date ?? "no date"}</span>
            <span>·</span>
            <span className="capitalize">{txn.source}</span>
          </div>
        </div>
        <div className="flex-none text-right">
          <div className="font-semibold tabular-nums">{money(txn.amount_cents)}</div>
          {txn.gst_cents != null && <div className="text-xs text-muted">GST {money(txn.gst_cents)}</div>}
        </div>
      </Card>
    </Link>
  );
}
