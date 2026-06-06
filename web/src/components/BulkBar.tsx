import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Button } from "./ui";
import { BUCKETS } from "../types";

export interface BulkDone {
  message: string;
  batchId: string | null; // present (and undoable) for a re-bucket; null for a delete
}

/**
 * Sticky bulk-action bar shown when one or more transactions are selected. Re-bucket the whole
 * selection in one audited, undoable action (applyCorrectionBatch) or bulk-delete. Reports the
 * outcome UP to the parent via onDone — the success note + Undo affordance live there, because this
 * bar unmounts the moment the selection clears.
 */
export function BulkBar({ ids, onClear, onDone }: { ids: string[]; onClear: () => void; onDone: (d: BulkDone) => void }) {
  const qc = useQueryClient();
  const [bucket, setBucket] = useState<string>("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["transactions"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const apply = useMutation({
    mutationFn: () => api.correctBatch(ids, [{ field: "bucket", value: bucket }]),
    onSuccess: (r) => {
      const failed = r.failures.length ? `, ${r.failures.length} skipped` : "";
      invalidate();
      onDone({ message: `Re-bucketed ${r.updated} to ${bucket}${failed}.`, batchId: r.batch_id || null });
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
        onChange={(e) => setBucket(e.target.value)}
        disabled={busy}
        className="rounded-lg border border-white/20 bg-ink px-2 py-1 text-sm"
      >
        <option value="">Re-bucket to…</option>
        {BUCKETS.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
      <Button onClick={() => apply.mutate()} disabled={busy || !bucket}>
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
