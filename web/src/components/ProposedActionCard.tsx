import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { BUCKET_LABEL, money } from "./ui";
import type { ProposedAction } from "../types";

// Human labels for the deductibility states a proposal can carry.
const STATE_LABEL: Record<string, string> = {
  confirmed_deductible: "confirmed deductible",
  confirmed_not: "confirmed NOT deductible",
  likely_not: "likely not deductible",
  needs_apportionment: "needs a work-use split",
};

/**
 * Ask Quillo C3 (flag ask_actions): a model-PROPOSED fix the user confirms with one click. The Apply
 * button calls the EXISTING audited write path for the action's kind — the model never writes:
 *  - set_deductibility → POST /api/deductibility (stub.setDeductibility)
 *  - recategorise      → POST /api/correct/batch (undoable as a unit)
 *  - add_rule          → POST /api/rules
 */
export function ProposedActionCard({ action }: { action: ProposedAction }) {
  const qc = useQueryClient();
  // Map a routed property_id → its label for the summary (cached situation query, shared app-wide).
  const { data: situation } = useQuery({ queryKey: ["situation"], queryFn: api.situation });
  const propertyId = action.kind === "recategorise" || action.kind === "add_rule" ? action.property_id : undefined;
  const propertyLabel = propertyId ? situation?.properties?.find((p) => p.id === propertyId)?.label : undefined;
  const apply = useMutation({
    mutationFn: async () => {
      if (action.kind === "set_deductibility") {
        return api.resolveDeductibility({ state: action.state, txnIds: action.txn_ids, deductibleAmountCents: action.deductible_amount_cents ?? null });
      }
      if (action.kind === "recategorise") {
        const edits = [
          { field: "bucket", value: action.bucket },
          ...(action.ato_label ? [{ field: "ato_label", value: action.ato_label }] : []),
          ...(action.property_id ? [{ field: "property_id", value: action.property_id }] : []),
        ];
        // learn_rule=true: also remember this merchant so future imports auto-apply (parity with the
        // Clarify / apply-to-siblings paths — chat was the only correction that didn't). Surfaced in the
        // card copy below so it's never silent. Server rejects credit buckets + dedupes the rule.
        return api.correctBatch(action.txn_ids, edits, true);
      }
      return api.addRule({ pattern: action.pattern, bucket: action.bucket, ato_label: action.ato_label ?? "", ...(action.property_id ? { property_id: action.property_id } : {}) });
    },
    onSuccess: () => {
      // The applied fix moves money figures — refresh every surface that shows them.
      for (const key of ["dashboard", "report", "transactions", "review", "rules"]) qc.invalidateQueries({ queryKey: [key] });
    },
  });
  const summary =
    action.kind === "set_deductibility"
      ? `${action.txn_ids.length} transaction(s) → ${STATE_LABEL[action.state] ?? action.state}${action.deductible_amount_cents != null ? ` (${money(action.deductible_amount_cents)} claimable)` : ""}`
      : action.kind === "recategorise"
        ? `${action.txn_ids.length} transaction(s) → ${BUCKET_LABEL[action.bucket] ?? action.bucket}${action.ato_label ? ` (${action.ato_label})` : ""}${propertyLabel ? ` · ${propertyLabel}` : ""} · and remember this merchant`
        : `“${action.pattern}” → ${BUCKET_LABEL[action.bucket] ?? action.bucket}${action.ato_label ? ` (${action.ato_label})` : ""}${propertyLabel ? ` · ${propertyLabel}` : ""} on future imports`;
  return (
    <div className="space-y-1 rounded-lg border border-dashed border-line bg-card p-2 text-xs">
      <p className="font-medium text-ink">{action.title}</p>
      <p className="text-muted">{action.rationale}</p>
      <div className="flex flex-wrap items-center gap-2">
        <span>{summary}</span>
        {apply.isSuccess ? (
          <span className="font-medium text-safe">Applied ✓</span>
        ) : (
          <button onClick={() => apply.mutate()} disabled={apply.isPending} className="rounded-lg border border-line bg-surface px-2 py-1 font-medium hover:bg-card disabled:opacity-50">
            {apply.isPending ? "Applying…" : "Apply"}
          </button>
        )}
        {apply.isError && <span className="text-danger">{(apply.error as Error).message}</span>}
      </div>
      <p className="text-[10px] text-muted">You're confirming this change — review the summary first. General information only.</p>
    </div>
  );
}
