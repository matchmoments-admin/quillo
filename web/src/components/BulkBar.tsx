import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Button, BUCKET_LABEL } from "./ui";
import { isPropertyBucket } from "../lib/buckets";
import { CategoryPicker } from "./CategoryPicker";
import { ClaimPicker, claimEdits, claimResolve, claimSummary, claimIncomplete, type ClaimChoice } from "./ClaimPicker";
import { useFeatures } from "../lib/features";

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
  const { has } = useFeatures();
  const inlineClaim = has("inline_claim"); // owner feedback: resolve claims (donation/%/full/not) in the mass edit
  const bulkConfirm = has("bulk_confirm"); // "Confirm as-is": accept the AI's current categories for the selection
  const bulkIgnore = has("bulk_ignore"); // "Not spend": exclude the selection as non-spend (transfers the sweep missed)
  // mobile_bottom_tabs renders a FIXED bottom bar (z-30, <lg). The BulkBar previously sat at z-10 /
  // bottom-3, so mid-scroll it stuck to the viewport bottom UNDERNEATH the tab bar — invisible until
  // the user reached the very end of the page (live-testing find). Offset above the tabs on <lg and
  // stack above them everywhere.
  const tabsOn = has("mobile_bottom_tabs");
  const [claim, setClaim] = useState<ClaimChoice>("");
  const [pct, setPct] = useState<string>("");
  const { data: situation } = useQuery({ queryKey: ["situation"], queryFn: api.situation });
  const properties = situation?.properties ?? [];
  const needsProperty = isPropertyBucket(bucket); // pickable property buckets are property_rented/_vacant (income_property isn't selectable here)

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["transactions"] });
    qc.invalidateQueries({ queryKey: ["review-groups"] }); // grouped_review_v2: refresh whole-queue counts
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const apply = useMutation({
    mutationFn: async () => {
      // Corrections first (bucket/property + any claim-implied edits — one audited, undoable batch),
      // THEN the claim state, so the post-correction re-stamp can't override the user's explicit
      // confirmation. A donation FORCES bucket payg (claimEdits) — its bucket edit wins over the picker.
      const claimBatch = inlineClaim ? claimEdits(claim) : [];
      const edits = [
        ...(bucket && !claimBatch.some((e) => e.field === "bucket") ? [{ field: "bucket", value: bucket }] : []),
        ...(needsProperty && propertyId ? [{ field: "property_id", value: propertyId }] : []),
        ...claimBatch,
      ];
      const parts: string[] = [];
      let batchId: string | null = null;
      if (edits.length) {
        const r = await api.correctBatch(ids, edits, learnRule);
        const failed = r.failures.length ? `, ${r.failures.length} skipped` : "";
        const rule = r.rules_created ? ` · ${r.rules_created} rule${r.rules_created === 1 ? "" : "s"} remembered` : "";
        const to = claim === "donation" ? "payg" : bucket;
        parts.push(to ? `Re-categorised ${r.updated} to ${BUCKET_LABEL[to] ?? to}${failed}${rule}` : `Updated ${r.updated}${failed}${rule}`);
        batchId = r.batch_id || null;
      }
      const resolve = inlineClaim ? claimResolve(claim, pct) : null;
      if (resolve) {
        try {
          const d = await api.resolveDeductibility({ txnIds: ids, state: resolve.state, businessUsePct: resolve.businessUsePct });
          parts.push(claimSummary(claim, pct, d.updated));
          // A claim state can't be reverted by the corrections-only Undo — offering it would leave a
          // phantom confirmed claim under the reverted label. Suppress Undo when a claim was written.
          batchId = null;
        } catch (e) {
          // Partial failure must be HONEST: the corrections already applied (undo stays valid).
          return { message: `${parts.join(" · ")} — but setting the claim failed (${(e as Error).message}). The category change DID apply; set the claim from Review.`, batchId };
        }
      }
      return { message: `${parts.join(" · ")}.`, batchId };
    },
    onSuccess: (r) => {
      invalidate();
      onDone(r);
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

  // "Confirm as-is": accept the AI's CURRENT category for the whole selection and clear it from review,
  // without picking a new one. Position-neutral (the rows already count); not undoable (nothing changes
  // but the review status). Rows with no category are reported as skipped.
  const confirmAsIs = useMutation({
    mutationFn: () => api.confirmBatch(ids),
    onSuccess: (r) => {
      invalidate();
      const skipped = r.failures.length ? ` · ${r.failures.length} skipped (no category — open to categorise)` : "";
      onDone({ message: `Confirmed ${r.updated}${skipped}.`, batchId: null });
      onClear();
    },
    onError: (e) => onDone({ message: `Couldn't confirm: ${(e as Error).message}`, batchId: null }),
  });

  // "Not spend": exclude the selection as non-spend (transfers/repayments the sweep detector missed).
  // Undoable — the batch_id feeds the shared Undo toast — so no confirm dialog (undo-first).
  const ignore = useMutation({
    mutationFn: () => api.ignoreBatch(ids),
    onSuccess: (r) => {
      invalidate();
      const skipped = r.failures.length ? ` · ${r.failures.length} already excluded` : "";
      onDone({ message: `Excluded ${r.updated} as not spend${skipped}.`, batchId: r.batch_id || null });
      onClear();
    },
    onError: (e) => onDone({ message: `Couldn't exclude: ${(e as Error).message}`, batchId: null }),
  });

  const busy = apply.isPending || del.isPending || confirmAsIs.isPending || ignore.isPending;

  return (
    <div className={`sticky ${tabsOn ? "bottom-20 lg:bottom-3" : "bottom-3"} z-40 mx-auto flex w-full max-w-2xl flex-wrap items-center gap-2 rounded-xl border border-line bg-ink px-3 py-2 text-white shadow-lg`}>
      <span className="text-sm font-medium">{ids.length} selected</span>
      {bulkConfirm && (
        <button
          onClick={() => confirmAsIs.mutate()}
          disabled={busy}
          title="Accept the current category for all selected and clear them from review"
          className="rounded-lg border border-white/25 bg-white/10 px-2.5 py-1 text-sm font-medium hover:bg-white/20 disabled:opacity-50"
        >
          {confirmAsIs.isPending ? "Confirming…" : "Confirm as-is"}
        </button>
      )}
      <CategoryPicker
        bucket={claim === "donation" ? "payg" : bucket}
        propertyId={propertyId}
        onBucket={setBucket}
        onProperty={setPropertyId}
        properties={properties}
        disabled={busy || claim === "donation"}
        bucketPlaceholder="Change category to…"
        selectClassName="rounded-lg border border-white/20 bg-ink px-2 py-1 text-sm"
        mutedClassName="text-xs text-white/70"
      />
      {inlineClaim && (
        <ClaimPicker
          claim={claim}
          pct={pct}
          onClaim={setClaim}
          onPct={setPct}
          disabled={busy}
          selectClassName="rounded-lg border border-white/20 bg-ink px-2 py-1 text-sm"
          mutedClassName="w-full text-xs text-white/70"
        />
      )}
      <label className="flex items-center gap-1.5 text-xs text-white/80" title="Also create a rule so future imports of these merchants are categorised automatically">
        <input type="checkbox" checked={learnRule} onChange={(e) => setLearnRule(e.target.checked)} disabled={busy} className="h-3.5 w-3.5" />
        Remember as a rule
      </label>
      <Button onClick={() => apply.mutate()} disabled={busy || (!bucket && !(inlineClaim && claimResolve(claim, pct))) || (needsProperty && !propertyId) || (inlineClaim && claimIncomplete(claim, pct))}>
        {apply.isPending ? "Applying…" : "Apply"}
      </Button>
      {bulkIgnore && (
        <button
          onClick={() => ignore.mutate()}
          disabled={busy}
          title="Exclude these as non-spend (transfers/repayments) — kept out of your position. Undoable."
          className="rounded-lg px-2 py-1 text-sm text-white/80 hover:text-white"
        >
          {ignore.isPending ? "Excluding…" : "Not spend"}
        </button>
      )}
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
