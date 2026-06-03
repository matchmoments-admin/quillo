import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { BUCKETS } from "../types";
import { BUCKET_LABEL, Card, Spinner, money, ConfidencePill } from "../components/ui";

export function TxnDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const txnQ = useQuery({ queryKey: ["txn", id], queryFn: () => api.transaction(id) });
  const sitQ = useQuery({ queryKey: ["situation"], queryFn: () => api.situation() });

  const [bucket, setBucket] = useState<string>("");
  const [label, setLabel] = useState<string>("");
  const [propertyId, setPropertyId] = useState<string>("");
  const [date, setDate] = useState<string>("");
  const [seeded, setSeeded] = useState(false);
  const [dirty, setDirty] = useState(false);

  const txn = txnQ.data;
  // Seed local state once the txn loads.
  if (txn && !seeded) {
    setBucket(txn.bucket ?? "");
    setLabel(txn.ato_label ?? "");
    setPropertyId(txn.property_id ?? "");
    setDate(txn.txn_date ?? "");
    setSeeded(true);
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!txn) return;
      const ops: Promise<unknown>[] = [];
      if (bucket && bucket !== txn.bucket) ops.push(api.correct(id, "bucket", bucket));
      if (label !== (txn.ato_label ?? "")) ops.push(api.correct(id, "ato_label", label));
      if (propertyId !== (txn.property_id ?? "")) ops.push(api.correct(id, "property_id", propertyId));
      if (date !== (txn.txn_date ?? "")) ops.push(api.correct(id, "txn_date", date));
      // "Confirm as-is" when nothing changed: record acceptance of the current bucket.
      if (ops.length === 0 && txn.bucket) ops.push(api.correct(id, "bucket", txn.bucket));
      await Promise.all(ops);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["txn", id] });
      navigate("/");
    },
  });

  const del = useMutation({
    mutationFn: () => api.deleteTxn(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      navigate("/");
    },
  });

  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const push = useMutation({
    mutationFn: () => api.qboPush(id),
    onSuccess: (r) => {
      setPushMsg(r.ok ? `Pushed to QuickBooks ✓ (${r.ledgerRef})` : (r.error ?? "Push failed"));
      if (r.ok) qc.invalidateQueries({ queryKey: ["txn", id] });
    },
    onError: (e) => setPushMsg((e as Error).message),
  });

  if (txnQ.isLoading) return <Spinner />;
  if (!txn) return <Card className="p-6 text-sm text-muted">Transaction not found.</Card>;

  const isPdf = (txn.receipt_key ?? "").toLowerCase().endsWith(".pdf");
  const props = sitQ.data?.properties ?? [];

  return (
    <div className="space-y-6">
      <div className="grid gap-6 sm:grid-cols-[1fr_1.2fr]">
        {/* Receipt preview */}
        <Card className="overflow-hidden">
          {isPdf ? (
            <div className="grid h-64 place-items-center bg-surface text-sm text-muted">PDF receipt</div>
          ) : (
            <img src={api.receiptUrl(id)} alt="receipt" className="max-h-[28rem] w-full object-contain bg-surface" />
          )}
        </Card>

        {/* Extracted fields + correction form */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            {/* Not an <h1>: the global heading rule forces Anton-uppercase, which would distort
                a user-supplied merchant name. Keep merchant data in mixed-case sans. */}
            <div className="truncate text-xl font-semibold tracking-tight">{txn.merchant ?? "Unknown merchant"}</div>
            <ConfidencePill value={txn.confidence} />
          </div>

          {txn.duplicate_of && (
            <Card className="border-warn/40 bg-warn/5 p-3 text-sm text-warn">
              Possible duplicate of an earlier receipt. Delete it below if it's the same expense.
            </Card>
          )}

          <Card className="divide-y divide-line text-sm">
            <Field
              k="Amount"
              v={`${money(txn.amount_cents)}${txn.currency && txn.currency !== "AUD" ? ` ${txn.currency}` : ""}`}
            />
            {txn.currency && txn.currency !== "AUD" && (
              <Field
                k="AUD (est.)"
                v={`${money(txn.amount_aud_cents)}${txn.fx_rate ? ` @ ${txn.fx_rate.toFixed(4)}` : " — set manually"}`}
              />
            )}
            <Field k="GST" v={txn.currency && txn.currency !== "AUD" ? "n/a (overseas)" : money(txn.gst_cents)} />
            <Field k="Date" v={`${txn.txn_date ?? "— undated —"}${fyLabel(txn.txn_date) ? `  ·  FY ${fyLabel(txn.txn_date)}` : ""}`} />
            {txn.paid_account && <Field k="Paid via" v={txn.paid_account} />}
            <Field k="Source" v={txn.source} />
            <Field k="Status" v={txn.status} />
          </Card>

          {txn.reasoning && (
            <Card className="space-y-1 bg-surface p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-ink-3">Why this bucket?</div>
              <p className="text-sm text-ink">{txn.reasoning}</p>
              <p className="text-xs text-muted">General information only — not tax advice. Confirm with a registered tax/BAS agent.</p>
            </Card>
          )}

          <Card className="space-y-4 p-4">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">Bucket</span>
              <select
                value={bucket}
                onChange={(e) => {
                  setBucket(e.target.value);
                  setDirty(true);
                }}
                className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2"
              >
                <option value="">— choose —</option>
                {BUCKETS.map((b) => (
                  <option key={b} value={b}>
                    {BUCKET_LABEL[b]}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">ATO label</span>
              <input
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                  setDirty(true);
                }}
                placeholder="e.g. company:office-supplies"
                className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2"
              />
            </label>

            {(bucket === "property_rented" || bucket === "property_vacant") && (
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">Property</span>
                <select
                  value={propertyId}
                  onChange={(e) => {
                    setPropertyId(e.target.value);
                    setDirty(true);
                  }}
                  className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2"
                >
                  <option value="">— choose —</option>
                  {props.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} ({p.status})
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Date {date ? `· FY ${fyLabel(date) ?? "?"}` : "· undated — set one so it lands in a tax year"}
              </span>
              <input
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setDirty(true);
                }}
                className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2"
              />
            </label>

            <button
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className="w-full rounded-lg bg-ink py-2.5 font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : dirty ? "Save correction" : "Confirm as-is"}
            </button>
            {save.isError && <p className="text-sm text-danger">Couldn't save: {(save.error as Error).message}</p>}
          </Card>

          {/* QuickBooks: reconcile-vs-push. Fed accounts reconcile (don't push); use this
              only for a NON-FEED company expense (cash / a card not connected to QBO). */}
          {txn.bucket === "company" && (
            <Card className="space-y-2 p-4 text-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-muted">QuickBooks</div>
              {txn.ledger_ref ? (
                <p className="text-safe">Posted to QuickBooks · {txn.ledger_ref}</p>
              ) : (
                <>
                  <p className="text-muted">
                    If this is on a <span className="font-medium text-ink">connected</span> account, leave it — your bank
                    feed posts it and you reconcile. Only push if it's <span className="font-medium text-ink">not</span>{" "}
                    in your QuickBooks feed (cash, a separate Amex).
                  </p>
                  <button
                    onClick={() => push.mutate()}
                    disabled={push.isPending}
                    className="rounded-lg border border-line px-3 py-2 font-medium transition hover:bg-surface disabled:opacity-50"
                  >
                    {push.isPending ? "Pushing…" : "Push to QuickBooks (non-feed)"}
                  </button>
                  {pushMsg && <p className="text-muted">{pushMsg}</p>}
                </>
              )}
            </Card>
          )}

          <button
            onClick={() => {
              if (confirm("Delete this receipt permanently? This removes the image and can't be undone.")) del.mutate();
            }}
            disabled={del.isPending}
            className="w-full rounded-lg border border-danger/30 py-2 text-sm font-medium text-danger transition hover:bg-danger/5 disabled:opacity-50"
          >
            {del.isPending ? "Deleting…" : "Delete receipt"}
          </button>
          {del.isError && <p className="text-sm text-danger">Couldn't delete: {(del.error as Error).message}</p>}

          {txn.corrections.length > 0 && (
            <Card className="p-4 text-sm">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Correction history</div>
              <ul className="space-y-1 text-muted">
                {txn.corrections.map((c, i) => (
                  <li key={i}>
                    <span className="text-ink">{c.field}</span>: {c.old_value ?? "∅"} → {c.new_value ?? "∅"}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// AU financial year (Jul–Jun) label for a YYYY-MM-DD date, or null if missing/unparseable.
function fyLabel(d: string | null): string | null {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const y = Number(d.slice(0, 4));
  const mo = Number(d.slice(5, 7));
  const startYear = mo >= 7 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span className="text-muted">{k}</span>
      <span className="font-medium tabular-nums">{v}</span>
    </div>
  );
}
