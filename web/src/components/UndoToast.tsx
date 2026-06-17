import { useEffect } from "react";
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
  const undo = useMutation({
    mutationFn: (batchId: string) => api.undoBatch(batchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["transactions-all"] });
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
