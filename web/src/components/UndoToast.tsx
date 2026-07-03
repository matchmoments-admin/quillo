import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { BulkDone } from "./BulkBar";

// Outcome note + ~10s Undo for a bulk action. Lives at PAGE level (not inside BulkBar, which unmounts
// the moment the selection clears on success). Shared by Inbox and Transactions — both surface the same
// re-categorise/delete results, so the toast + Undo affordance is one component. Invalidates every list
// query key in use (["transactions"] = Inbox/dashboard, ["transactions-all"] = the Transactions browse
// page) so whichever page is showing refreshes after an Undo.
export function UndoToast({ flash, onClose }: { flash: BulkDone; onClose: () => void }) {
  const qc = useQueryClient();
  const [remembered, setRemembered] = useState(false);
  const undo = useMutation({
    mutationFn: (batchId: string) => api.undoBatch(batchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["transactions-all"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      onClose();
    },
  });
  // rule_from_action: "Always file <merchant> here" — learn a rule (+ apply to any look-alikes) through the
  // existing applyToSiblings seam. Rule creation is going-forward; the sibling update is undoable via its
  // own batch, but we keep the toast simple and just confirm success in place.
  const remember = useMutation({
    mutationFn: (r: NonNullable<BulkDone["remember"]>) =>
      api.applyToSiblings(r.txnId, { bucket: r.bucket, ...(r.propertyId ? { property_id: r.propertyId } : {}) }, true),
    onSuccess: () => {
      setRemembered(true);
      for (const k of ["transactions", "transactions-all", "review-groups", "clarify", "dashboard"]) qc.invalidateQueries({ queryKey: [k] });
    },
  });
  // Auto-dismiss after 10s (re-armed whenever a new outcome arrives). Reset the remembered flag per flash.
  useEffect(() => {
    setRemembered(false);
    const t = setTimeout(onClose, 10_000);
    return () => clearTimeout(t);
  }, [flash, onClose]);
  const offer = flash.remember;
  return (
    <div className="sticky bottom-3 z-10 mx-auto flex w-full max-w-2xl items-center justify-between gap-3 rounded-xl border border-line bg-ink px-3 py-2 text-sm text-white shadow-lg">
      <span>
        {undo.isPending
          ? "Undoing…"
          : remembered
            ? `Remembered ✓ — future ${offer?.label} will file here.`
            : flash.message}
      </span>
      <div className="flex items-center gap-2">
        {flash.batchId && !undo.isPending && !remembered && (
          <button onClick={() => undo.mutate(flash.batchId!)} className="font-medium underline">
            Undo
          </button>
        )}
        {offer && !remembered && !undo.isPending && (
          <button
            onClick={() => remember.mutate(offer)}
            disabled={remember.isPending}
            className="font-medium underline disabled:opacity-60"
            title={`Create a rule so future ${offer.label} auto-file here${offer.n > 0 ? `, and update ${offer.n} look-alike${offer.n === 1 ? "" : "s"} now` : ""}`}
          >
            {remember.isPending ? "Remembering…" : offer.n > 0 ? `Always do this (+${offer.n})` : "Always do this"}
          </button>
        )}
        <button onClick={onClose} className="text-white/60 hover:text-white" aria-label="Dismiss">
          ✕
        </button>
      </div>
    </div>
  );
}
