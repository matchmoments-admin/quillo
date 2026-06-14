import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Button, BUCKET_LABEL } from "./ui";
import { BUCKETS } from "../types";

// Income/refund are credits — re-categorising them here would double-count income (they must route
// through an income answer in Clarify). "unknown" isn't a real target. The server rejects these too.
const CREDIT_OR_UNKNOWN = new Set(["income_business", "income_property", "income_personal", "refund", "unknown"]);
const PICKABLE = BUCKETS.filter((b) => !CREDIT_OR_UNKNOWN.has(b));
// Rental-expense buckets need a property — a bulk re-bucket to one without a property_id would land
// the rows unattributed (same defect #240 fixed in Clarify). Mirror that here: reveal a selector and
// block Apply until a property is chosen.
const PROPERTY_PICK = new Set(["property_rented", "property_vacant"]);

export interface BulkDone {
  message: string;
  batchId: string | null; // present (and undoable) for a re-categorise; null for a delete
}

/**
 * Sticky bulk-action bar shown when one or more transactions are selected. Re-categorise the whole
 * selection in one audited, undoable action (applyCorrectionBatch) — optionally learning a user_rule
 * so future imports of those merchants auto-apply (parity with edit-one → apply-to-siblings) — or
 * bulk-delete. Reports the outcome UP to the parent via onDone — the success note + Undo affordance
 * live there, because this bar unmounts the moment the selection clears.
 */
export function BulkBar({ ids, onClear, onDone }: { ids: string[]; onClear: () => void; onDone: (d: BulkDone) => void }) {
  const qc = useQueryClient();
  const [bucket, setBucket] = useState<string>("");
  const [propertyId, setPropertyId] = useState<string>("");
  const [learnRule, setLearnRule] = useState(false);
  const { data: situation } = useQuery({ queryKey: ["situation"], queryFn: api.situation });
  const properties = situation?.properties ?? [];
  const needsProperty = PROPERTY_PICK.has(bucket);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["transactions"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const apply = useMutation({
    mutationFn: () =>
      api.correctBatch(
        ids,
        [{ field: "bucket", value: bucket }, ...(needsProperty && propertyId ? [{ field: "property_id", value: propertyId }] : [])],
        learnRule,
      ),
    onSuccess: (r) => {
      const failed = r.failures.length ? `, ${r.failures.length} skipped` : "";
      const rule = r.rules_created ? ` · ${r.rules_created} rule${r.rules_created === 1 ? "" : "s"} remembered` : "";
      invalidate();
      onDone({ message: `Re-categorised ${r.updated} to ${BUCKET_LABEL[bucket] ?? bucket}${failed}${rule}.`, batchId: r.batch_id || null });
      onClear();
    },
    onError: (e) => onDone({ message: `Couldn't apply: ${(e as Error).message}`, batchId: null }),
  });

  const del = useMutation({
    mutationFn: () => api.deleteTxnBatch(ids),
    onSuccess: (r) => {
      invalidate();
      onDone({ message: `Deleted ${r.deleted}.`, batchId: null });
      onClear();
    },
    onError: (e) => onDone({ message: `Couldn't delete: ${(e as Error).message}`, batchId: null }),
  });

  const busy = apply.isPending || del.isPending;

  return (
    <div className="sticky bottom-3 z-10 mx-auto flex w-full max-w-2xl flex-wrap items-center gap-2 rounded-xl border border-line bg-ink px-3 py-2 text-white shadow-lg">
      <span className="text-sm font-medium">{ids.length} selected</span>
      <select
        value={bucket}
        onChange={(e) => {
          setBucket(e.target.value);
          if (!PROPERTY_PICK.has(e.target.value)) setPropertyId(""); // leaving a property bucket clears the pick
        }}
        disabled={busy}
        className="rounded-lg border border-white/20 bg-ink px-2 py-1 text-sm"
      >
        <option value="">Change category to…</option>
        {PICKABLE.map((b) => (
          <option key={b} value={b}>
            {BUCKET_LABEL[b] ?? b}
          </option>
        ))}
      </select>
      {needsProperty &&
        (properties.length > 0 ? (
          <select
            value={propertyId}
            onChange={(e) => setPropertyId(e.target.value)}
            disabled={busy}
            aria-label="Property"
            className="rounded-lg border border-white/20 bg-ink px-2 py-1 text-sm"
          >
            <option value="">Which property?</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-white/70">Add a property first (Settings)</span>
        ))}
      <label className="flex items-center gap-1.5 text-xs text-white/80" title="Also create a rule so future imports of these merchants are categorised automatically">
        <input type="checkbox" checked={learnRule} onChange={(e) => setLearnRule(e.target.checked)} disabled={busy} className="h-3.5 w-3.5" />
        Remember as a rule
      </label>
      <Button onClick={() => apply.mutate()} disabled={busy || !bucket || (needsProperty && !propertyId)}>
        {apply.isPending ? "Applying…" : "Apply"}
      </Button>
      <button
        onClick={() => {
          if (confirm(`Delete ${ids.length} transaction(s)? This can't be undone.`)) del.mutate();
        }}
        disabled={busy}
        className="rounded-lg px-2 py-1 text-sm text-white/80 hover:text-white"
      >
        Delete
      </button>
      <button onClick={onClear} disabled={busy} className="rounded-lg px-2 py-1 text-sm text-white/60 hover:text-white">
        Clear
      </button>
    </div>
  );
}
