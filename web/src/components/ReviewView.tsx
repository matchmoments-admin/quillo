import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { BucketPill, Button, ConfidencePill, Card, Spinner, money, getBaseCurrency, BUCKET_LABEL } from "./ui";
import { isPropertyBucket, CREDIT_OR_UNKNOWN } from "../lib/buckets";
import { CategoryPicker } from "./CategoryPicker";
import { ClaimPicker, claimEdits, claimResolve, claimSummary, claimIncomplete, type ClaimChoice } from "./ClaimPicker";
import { AccountantPassCard } from "./AccountantPassCard";
import { SortFlow } from "./SortFlow";
import { BulkBar, type BulkDone } from "./BulkBar";
import { UndoToast } from "./UndoToast";
import { useFeatures } from "../lib/features";
import { useActiveFy } from "../lib/activeFy";

// grouped_review_v2 wave 3c: a whole-review-queue merchant cluster (server-aggregated), used to show a
// group's true size and select the whole merchant even when it spans more than the loaded page.
type ReviewGroup = { group_key: string; n: number; total_cents: number; ids: string[] };
import type { Txn, ClarifyQuestion } from "../types";
import { ClarifyRow } from "./ClarifyCard";

/**
 * ReviewView — the "Needs review" experience, rendered as the default tab of the Transactions page.
 * This is the still-to-review backlog (review=true): single transactions are the unit of work, confirmed
 * inline. It is deliberately ALL-TIME (a cross-year backlog) and so ignores the global FY switcher. The
 * Receipts / Bank-lines filters live here (kind filter) and on the "All" browse tab. It replaced the
 * standalone Inbox page (now deleted; /inbox redirects here). General information only.
 */
export function ReviewView() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<BulkDone | null>(null);
  const { has } = useFeatures();
  const hasAccountantPass = has("accountant_pass");
  const grouped = has("grouped_review"); // #342: merchant-grouped review + kind filter
  const groupedV2 = has("grouped_review_v2"); // wave 3: cluster by the server's normalised group_key
  const unified = has("unified_review_groups") && groupedV2 && hasAccountantPass; // wave 4: clarify answers inline in the groups
  const [kind, setKind] = useState<"" | "receipt" | "bank_line">(""); // restored receipt/bank-line filter
  const { fy: activeFy } = useActiveFy();
  const toggleSel = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // All-time, review-only — the same ["transactions", …] cache the rest of the app invalidates.
  const { data, isLoading, error } = useQuery({
    queryKey: ["transactions", "needs_review", limit],
    queryFn: () => api.transactions({ review: true, limit }),
  });

  const upload = useMutation({
    mutationFn: (files: File[]) => api.upload(files),
    onMutate: (files) =>
      setNote(files.length > 1 ? `Reading ${files.length} images as one receipt…` : "Reading your receipt with Claude…"),
    onSuccess: () => {
      setNote("Receipt added and categorised ✓");
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["transactions-all"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => setNote(`Upload failed: ${(e as Error).message}`),
  });

  const pickFile = () => fileRef.current?.click();

  const txns = useMemo(() => data ?? [], [data]); // stable ref so the group/clarify memos below don't recompute every render

  // ── Rules of Hooks: EVERY hook below MUST stay above the isLoading/error early returns. A fresh load
  // renders with isLoading=true first (fewer hooks) then re-renders with data (more hooks); if these sit
  // after the return the hook count changes between renders → React error #310 crash. ──
  // grouped_review_v2 wave 3c: whole-queue merchant clusters, so a group's header can show its TRUE size
  // and "select all" the whole merchant even when it spans more than the loaded page. Indexed by group_key.
  const { data: reviewGroupsData } = useQuery({ queryKey: ["review-groups"], queryFn: api.reviewGroups, enabled: groupedV2 });
  const groupIndex = useMemo(() => {
    const m = new Map<string, ReviewGroup>();
    for (const g of reviewGroupsData?.groups ?? []) m.set(g.group_key, g);
    return m;
  }, [reviewGroupsData]);

  // unified_review_groups (wave 4): pull the clarify smart-answers + properties so each matching group
  // header can offer them inline (reusing ClarifyRow). Indexed by group_key; the set of keys visible in
  // the loaded list is handed to SortFlow so the standalone card drops the groups now shown inline.
  const { data: clarifyData } = useQuery({ queryKey: ["clarify", activeFy], queryFn: () => api.clarifyQuestions(activeFy), enabled: unified });
  const { data: unifiedSituation } = useQuery({ queryKey: ["situation"], queryFn: api.situation, enabled: unified });
  const clarifyByKey = useMemo(() => {
    const m = new Map<string, ClarifyQuestion>();
    for (const q of clarifyData ?? []) m.set(q.group_key, q);
    return m;
  }, [clarifyData]);
  // A clarify group is "shown inline" — and so excluded from the standalone card — ONLY when it actually
  // renders as a GroupBlock (which carries the inline ClarifyRow). That mirrors GroupedList's render test
  // (>1 loaded row of the key, OR the whole-queue group has >1) over the kind-filtered set, so a lone
  // loaded row that renders as a singleton stays in the card and nothing is lost.
  const visibleClarifyKeys = useMemo(() => {
    if (!unified) return undefined;
    const loaded = kind ? txns.filter((t) => (t.kind ?? "") === kind) : txns;
    const loadedByKey = new Map<string, number>();
    for (const t of loaded) if (t.group_key) loadedByKey.set(t.group_key, (loadedByKey.get(t.group_key) ?? 0) + 1);
    const keys = new Set<string>();
    for (const [k, n] of loadedByKey) {
      if (clarifyByKey.has(k) && (n > 1 || (groupIndex.get(k)?.n ?? 0) > 1)) keys.add(k);
    }
    return keys;
  }, [unified, txns, kind, clarifyByKey, groupIndex]);

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

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-3">
        {/* Review is a running, cross-year backlog — say so, since the global FY switcher has no effect here. */}
        <p className="px-1 text-xs text-muted">Showing all years — review is a running backlog.</p>
        <Button onClick={pickFile} disabled={upload.isPending}>
          {upload.isPending ? "Uploading…" : "+ Add receipt"}
        </Button>
      </div>

      {/* "Do my books" runs automatically on import — this is just a status strip with a manual Re-scan. */}
      {hasAccountantPass && <AccountantPassCard fy={activeFy} />}

      {/* Mobile camera: `capture` opens the rear camera; accept images + PDFs. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => {
          const fs = Array.from(e.target.files ?? []);
          if (fs.length) upload.mutate(fs);
          e.currentTarget.value = "";
        }}
      />
      {note && <p className="text-sm text-muted">{note}</p>}

      {/* #342: receipt/bank-line filter — restored from the old Inbox (ReviewView had dropped it). Only
          when grouped_review is ON, so flag-OFF stays byte-identical. */}
      {grouped && txns.length > 0 && (
        <div className="inline-flex rounded-lg border border-line p-0.5 text-xs" role="tablist" aria-label="Filter by kind">
          {([["", "All"], ["receipt", "Receipts"], ["bank_line", "Bank lines"]] as const).map(([v, label]) => (
            <button
              key={v}
              role="tab"
              aria-selected={kind === v}
              onClick={() => setKind(v)}
              className={`rounded-md px-2.5 py-1 font-medium transition ${kind === v ? "bg-ink text-white" : "text-muted hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {txns.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">Nothing needs review — you're all caught up.</Card>
      ) : grouped ? (
        (() => {
          const visible = kind ? txns.filter((t) => (t.kind ?? "") === kind) : txns;
          return (
            <>
              {/* Grouped mode previously dropped the flat view's page-level select-all — restore it so a
                  whole page can feed the BulkBar in one tick (operates over the kind-filtered set). Gated
                  by grouped_review_v2 so wave 3 stays fully dark (byte-identical) until that flag flips. */}
              {groupedV2 && (
                <label className="flex items-center gap-2 px-1 text-xs text-muted">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={visible.length > 0 && visible.every((t) => selected.has(t.id))}
                    onChange={(e) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        for (const t of visible) e.target.checked ? next.add(t.id) : next.delete(t.id);
                        return next;
                      })
                    }
                  />
                  Select all on this page
                </label>
              )}
              <GroupedList
                txns={visible}
                v2={groupedV2}
                groupIndex={groupIndex}
                clarifyByKey={unified ? clarifyByKey : undefined}
                clarifyProperties={unifiedSituation?.properties ?? []}
                onClarifyDone={() => qc.invalidateQueries({ queryKey: ["clarify"] })}
                selected={selected}
                onToggleOne={toggleSel}
                onSetMany={(ids, on) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    for (const id of ids) on ? next.add(id) : next.delete(id);
                    return next;
                  })
                }
                onDone={setFlash}
                limit={limit}
                onLoadMore={() => setLimit((l) => l + 50)}
                total={txns.length}
              />
            </>
          );
        })()
      ) : (
        <>
          <label className="flex items-center gap-2 px-1 text-xs text-muted">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={txns.length > 0 && txns.every((t) => selected.has(t.id))}
              onChange={(e) => setSelected(e.target.checked ? new Set(txns.map((t) => t.id)) : new Set())}
            />
            Select all on this page
          </label>
          <ul className="space-y-3">
            {txns.map((t) => (
              <li key={t.id}>
                <Row txn={t} selected={selected.has(t.id)} onToggle={() => toggleSel(t.id)} onDone={setFlash} />
              </li>
            ))}
          </ul>
          {txns.length >= limit && (
            <button onClick={() => setLimit((l) => l + 50)} className="w-full rounded-lg border border-line py-2 text-sm text-muted hover:text-ink">
              Load more
            </button>
          )}
        </>
      )}

      {/* "Finish these" — group-action wrap-up (sort repeat merchants, confirm loan interest, exclude
          transfers). Self-hides when there's nothing left. */}
      <SortFlow fy={activeFy} hasAccountantPass={hasAccountantPass} excludeClarifyKeys={visibleClarifyKeys} />

      {selected.size > 0 && <BulkBar ids={[...selected]} onClear={() => setSelected(new Set())} onDone={setFlash} />}
      {flash && <UndoToast flash={flash} onClose={() => setFlash(null)} />}
    </div>
  );
}

/**
 * #342 — the merchant-grouped review list. Lines that normalise to the same merchant are gathered into
 * one collapsible group ("5× Coles · $200") with a single 'select all in group' checkbox that feeds the
 * EXISTING BulkBar — so a whole look-alike set is categorised in one action instead of row-by-row.
 * Singletons render as plain rows. Biggest groups lead (most lines cleared per action).
 */
function GroupedList({
  txns,
  v2,
  groupIndex,
  clarifyByKey,
  clarifyProperties,
  onClarifyDone,
  selected,
  onToggleOne,
  onSetMany,
  onDone,
  limit,
  onLoadMore,
  total,
}: {
  txns: Txn[];
  v2: boolean;
  groupIndex: Map<string, ReviewGroup>;
  clarifyByKey?: Map<string, ClarifyQuestion>;
  clarifyProperties: { id: string; label: string }[];
  onClarifyDone: () => void;
  selected: Set<string>;
  onToggleOne: (id: string) => void;
  onSetMany: (ids: string[], on: boolean) => void;
  onDone: (d: BulkDone) => void;
  limit: number;
  onLoadMore: () => void;
  total: number;
}) {
  const m = new Map<string, Txn[]>();
  for (const t of txns) {
    // grouped_review_v2: cluster by the server's normalised group_key (strips dates/reference numbers,
    // so "RSL ART UNION 123456/123457" collapse into ONE group). A null key (no usable merchant identity)
    // falls back to the row id so it stays its own singleton — never a junk group. Without v2, the legacy
    // exact merchant-string key.
    const key = v2 ? t.group_key || t.id : (t.merchant ?? t.raw_description ?? "Unknown").toLowerCase().trim() || "unknown";
    const arr = m.get(key);
    if (arr) arr.push(t);
    else m.set(key, [t]);
  }
  // Order by the FULL group size when known (v2) so the biggest merchants lead even if few of their rows
  // are on this page; fall back to the loaded count.
  const entries = [...m.entries()].sort((a, b) => (groupIndex.get(b[0])?.n ?? b[1].length) - (groupIndex.get(a[0])?.n ?? a[1].length));

  if (txns.length === 0) return <Card className="p-6 text-center text-sm text-muted">Nothing matches this filter.</Card>;

  return (
    <div className="space-y-3">
      {entries.map(([key, rows]) =>
        rows.length > 1 || (groupIndex.get(key)?.n ?? 0) > 1 ? (
          <GroupBlock key={rows[0]!.id} rows={rows} full={v2 ? groupIndex.get(key) : undefined} clarifyQ={clarifyByKey?.get(key)} clarifyProperties={clarifyProperties} onClarifyDone={onClarifyDone} selected={selected} onToggleOne={onToggleOne} onSetMany={onSetMany} onDone={onDone} />
        ) : (
          <Row key={rows[0]!.id} txn={rows[0]!} selected={selected.has(rows[0]!.id)} onToggle={() => onToggleOne(rows[0]!.id)} onDone={onDone} />
        ),
      )}
      {total >= limit && (
        <button onClick={onLoadMore} className="w-full rounded-lg border border-line py-2 text-sm text-muted hover:text-ink">
          Load more
        </button>
      )}
    </div>
  );
}

function GroupBlock({
  rows,
  full,
  clarifyQ,
  clarifyProperties,
  onClarifyDone,
  selected,
  onToggleOne,
  onSetMany,
  onDone,
}: {
  rows: Txn[];
  full?: ReviewGroup;
  clarifyQ?: ClarifyQuestion;
  clarifyProperties: { id: string; label: string }[];
  onClarifyDone: () => void;
  selected: Set<string>;
  onToggleOne: (id: string) => void;
  onSetMany: (ids: string[], on: boolean) => void;
  onDone: (d: BulkDone) => void;
}) {
  // `full` (grouped_review_v2) is the whole-queue cluster: its ids/count/total span the ENTIRE merchant,
  // not just the loaded page, so the header checkbox selects the whole merchant and the count is honest.
  const selIds = full ? full.ids : rows.map((r) => r.id);
  const count = full?.n ?? rows.length;
  const total = full?.total_cents ?? rows.reduce((s, r) => s + Math.abs(r.amount_cents ?? 0), 0);
  const allSel = selIds.length > 0 && selIds.every((id) => selected.has(id));
  const hiddenCount = full ? full.n - rows.length : 0; // members not on the loaded page
  const label = rows[0]!.merchant ?? rows[0]!.raw_description ?? "Unknown";
  return (
    <details open className="rounded-2xl border border-line bg-card">
      <summary className="flex cursor-pointer items-center gap-3 p-3 text-sm marker:content-none">
        <input
          type="checkbox"
          className="h-4 w-4 flex-none"
          checked={allSel}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onSetMany(selIds, e.target.checked)}
          aria-label={`Select all ${count} ${label}`}
        />
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        <span className="flex-none text-xs tabular-nums text-muted">
          {count}× · {money(total)}
          {hiddenCount > 0 && <span className="text-muted/70"> · {rows.length} shown</span>}
        </span>
      </summary>
      {/* unified_review_groups: the clarify smart-answers (income/ignore/capital/spend + rule-learning)
          for this merchant, inline — the same answerClarify seam the standalone card uses. */}
      {clarifyQ && (
        <ul className="border-t border-line p-2">
          <ClarifyRow q={clarifyQ} properties={clarifyProperties} onDone={onClarifyDone} />
        </ul>
      )}
      <ul className="space-y-2 border-t border-line p-2">
        {rows.map((t) => (
          <li key={t.id}>
            <Row txn={t} selected={selected.has(t.id)} onToggle={() => onToggleOne(t.id)} onDone={onDone} />
          </li>
        ))}
      </ul>
    </details>
  );
}

function Row({ txn, selected, onToggle, onDone }: { txn: Txn; selected: boolean; onToggle: () => void; onDone?: (d: BulkDone) => void }) {
  const qc = useQueryClient();
  const { has } = useFeatures();
  const inlineEdit = has("txn_inline_edit"); // #343
  const ruleFromAction = has("rule_from_action"); // offer "always file <merchant> here" after an inline edit
  const isLine = txn.kind === "bank_line";
  const [editing, setEditing] = useState(false);
  const [bucket, setBucket] = useState(txn.bucket ?? "");
  const [propertyId, setPropertyId] = useState(txn.property_id ?? "");
  const inlineClaim = has("inline_claim"); // owner feedback: resolve the claim right here (donation/%/full/not)
  const [claim, setClaim] = useState<ClaimChoice>("");
  const [pct, setPct] = useState("");
  const { data: situation } = useQuery({ queryKey: ["situation"], queryFn: api.situation, enabled: inlineEdit });
  const properties = situation?.properties ?? [];
  const needsProperty = isPropertyBucket(bucket);

  const invalidate = () => {
    for (const k of ["transactions", "transactions-all", "review-groups", "dashboard", "report", "filing-readiness"]) qc.invalidateQueries({ queryKey: [k] });
  };
  // Inline "Confirm as-is": accept the current bucket and drop the row from the queue without bouncing
  // through the detail page. Mirrors TxnDetail's confirm — re-applying the same bucket records
  // acceptance and clears needs_review.
  const confirm = useMutation({
    mutationFn: () => api.correct(txn.id, "bucket", txn.bucket!),
    onSuccess: invalidate,
  });
  // #343 inline edit — recategorise this one line (+ property) via the audited correctBatch seam, then
  // surface the SHARED Undo toast (onDone) and stay in place. No navigation to the detail page.
  const save = useMutation({
    mutationFn: async () => {
      // Corrections first (bucket/property + claim-implied edits), THEN the claim state, so the
      // post-correction re-stamp can't override the explicit confirmation. A donation forces bucket
      // payg (claimEdits) — coherence with the D9 label.
      const claimBatch = inlineClaim ? claimEdits(claim) : [];
      const effBucket = claimBatch.some((e) => e.field === "bucket") ? "payg" : bucket;
      const r = await api.correctBatch(
        [txn.id],
        [...(claimBatch.some((e) => e.field === "bucket") ? [] : [{ field: "bucket", value: bucket }]), ...(needsProperty && propertyId ? [{ field: "property_id", value: propertyId }] : []), ...claimBatch],
      );
      const resolve = inlineClaim ? claimResolve(claim, pct) : null;
      let claimNote = "";
      let batchId: string | null = r.batch_id || null;
      if (resolve) {
        try {
          const d = await api.resolveDeductibility({ txnIds: [txn.id], state: resolve.state, businessUsePct: resolve.businessUsePct });
          claimNote = ` · ${claimSummary(claim, pct, d.updated)}`;
          batchId = null; // Undo can't revert a claim state — don't offer it (phantom-claim guard)
        } catch (e) {
          claimNote = ` — but setting the claim failed (${(e as Error).message}); the category change DID apply. Set the claim from Review.`;
        }
      }
      // rule_from_action: for a plain SPEND-bucket categorisation (not a donation/claim), peek at look-alikes
      // so the toast can offer "always file <merchant> here". Best-effort — a preview failure (e.g.
      // apply_to_siblings off, or no usable merchant key) just omits the offer. Skipped when a claim state
      // was written (that path suppresses Undo and isn't a merchant→category rule).
      let remember: BulkDone["remember"];
      if (ruleFromAction && !resolve && bucket && !CREDIT_OR_UNKNOWN.has(bucket)) {
        try {
          const p = await api.siblingsPreview(txn.id);
          remember = { txnId: txn.id, bucket, propertyId: needsProperty && propertyId ? propertyId : undefined, label: txn.merchant ?? txn.raw_description ?? "this merchant", n: p.n };
        } catch { /* no offer */ }
      }
      return { message: `Recategorised to ${BUCKET_LABEL[effBucket] ?? effBucket}${claimNote}.`, batchId, remember };
    },
    onSuccess: (r) => {
      invalidate();
      onDone?.(r);
      setEditing(false);
    },
    onError: (e) => toast.error("Couldn't save", { description: (e as Error).message }),
  });
  // You can't "confirm as-is" an unknown row — that would re-write bucket='unknown' and it would never
  // leave the queue. Force such rows into the detail page to pick a real category.
  const canConfirm = !!txn.bucket && txn.bucket !== "unknown";
  return (
    <div className="space-y-2">
    <div className="flex items-center gap-2">
      <input type="checkbox" checked={selected} onChange={onToggle} className="h-4 w-4 flex-none" aria-label="Select transaction" />
      <Link to={`/txn/${txn.id}`} className="min-w-0 flex-1">
        <Card className="flex items-center gap-4 p-3 transition hover:shadow-md">
          {isLine ? (
            <div className="grid h-14 w-14 flex-none place-items-center rounded-lg border border-line bg-surface text-[10px] font-medium uppercase text-muted">
              line
            </div>
          ) : (
            <img
              src={api.receiptUrl(txn.id)}
              alt=""
              className="h-14 w-14 flex-none rounded-lg border border-line bg-surface object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
              }}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{txn.merchant ?? txn.raw_description ?? "Unknown"}</span>
              {!isLine && <ConfidencePill value={txn.confidence} />}
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
              {txn.currency && txn.currency !== getBaseCurrency() && <span className="ml-1 text-xs text-muted">{txn.currency}</span>}
            </div>
            {txn.currency && txn.currency !== getBaseCurrency() ? (
              <div className="text-xs text-muted">≈ {money(txn.amount_aud_cents)} {getBaseCurrency()}</div>
            ) : (
              txn.gst_cents != null && <div className="text-xs text-muted">GST {money(txn.gst_cents)}</div>
            )}
          </div>
        </Card>
      </Link>
      <div className="flex flex-none items-center gap-1.5">
        {inlineEdit && (
          <button
            onClick={() => { setBucket(txn.bucket ?? ""); setPropertyId(txn.property_id ?? ""); setEditing((v) => !v); }}
            title="Change the category here without leaving the list"
            className="rounded-lg border border-line px-3 py-2 text-sm font-medium transition hover:bg-surface"
          >
            {editing ? "Close" : "Edit"}
          </button>
        )}
        <button
          onClick={() => confirm.mutate()}
          disabled={confirm.isPending || !canConfirm}
          title={confirm.isPending ? "Confirming…" : canConfirm ? "Accept the current category and clear it from review" : "Open it to choose a category first"}
          className="rounded-lg border border-line px-3 py-2 text-sm font-medium transition hover:bg-surface disabled:opacity-50"
        >
          {confirm.isPending ? "…" : "Confirm ✓"}
        </button>
        {confirm.isError && <p className="mt-1 max-w-[7rem] text-right text-xs text-danger">{(confirm.error as Error).message}</p>}
      </div>
    </div>
    {inlineEdit && editing && (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3 text-sm">
        <CategoryPicker
          bucket={inlineClaim && claim === "donation" ? "payg" : bucket}
          propertyId={propertyId}
          onBucket={setBucket}
          onProperty={setPropertyId}
          properties={properties}
          disabled={inlineClaim && claim === "donation"}
          bucketPlaceholder="Choose category…"
          bucketAriaLabel="Category"
          selectClassName="rounded-lg border border-line bg-card px-2 py-1.5"
          mutedClassName="text-xs text-muted"
        />
        {inlineClaim && (
          <ClaimPicker
            claim={claim}
            pct={pct}
            onClaim={setClaim}
            onPct={setPct}
            disabled={save.isPending}
            selectClassName="rounded-lg border border-line bg-card px-2 py-1.5"
            mutedClassName="w-full text-xs text-muted"
          />
        )}
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || (!bucket && claim !== "donation") || (needsProperty && !propertyId) || (inlineClaim && claimIncomplete(claim, pct))}
          className="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
        <Link to={`/txn/${txn.id}`} className="text-xs font-medium text-muted hover:text-ink">Full editor →</Link>
      </div>
    )}
    </div>
  );
}
