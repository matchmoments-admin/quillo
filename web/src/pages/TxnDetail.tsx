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
  const [dirty, setDirty] = useState(false);

  const txn = txnQ.data;
  // Seed local state once the txn loads.
  if (txn && !dirty && bucket === "" && txn.bucket) {
    setBucket(txn.bucket);
    setLabel(txn.ato_label ?? "");
    setPropertyId(txn.property_id ?? "");
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!txn) return;
      const ops: Promise<unknown>[] = [];
      if (bucket && bucket !== txn.bucket) ops.push(api.correct(id, "bucket", bucket));
      if (label !== (txn.ato_label ?? "")) ops.push(api.correct(id, "ato_label", label));
      if (propertyId !== (txn.property_id ?? "")) ops.push(api.correct(id, "property_id", propertyId));
      // "Confirm as-is" when nothing changed: record acceptance of the current bucket.
      if (ops.length === 0 && txn.bucket) ops.push(api.correct(id, "bucket", txn.bucket));
      await Promise.all(ops);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["txn", id] });
      navigate("/");
    },
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
            <h1 className="truncate text-xl font-semibold tracking-tight">{txn.merchant ?? "Unknown merchant"}</h1>
            <ConfidencePill value={txn.confidence} />
          </div>

          <Card className="divide-y divide-line text-sm">
            <Field k="Amount" v={money(txn.amount_cents)} />
            <Field k="GST" v={money(txn.gst_cents)} />
            <Field k="Date" v={txn.txn_date ?? "—"} />
            <Field k="Source" v={txn.source} />
            <Field k="Status" v={txn.status} />
          </Card>

          <Card className="space-y-4 p-4">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">Bucket</span>
              <select
                value={bucket}
                onChange={(e) => {
                  setBucket(e.target.value);
                  setDirty(true);
                }}
                className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2"
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
                className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2"
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
                  className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2"
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

            <button
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className="w-full rounded-lg bg-ink py-2.5 font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : dirty ? "Save correction" : "Confirm as-is"}
            </button>
            {save.isError && <p className="text-sm text-danger">Couldn't save: {(save.error as Error).message}</p>}
          </Card>

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

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span className="text-muted">{k}</span>
      <span className="font-medium tabular-nums">{v}</span>
    </div>
  );
}
