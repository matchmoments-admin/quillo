import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { BUCKETS } from "../types";
import { BUCKET_LABEL, Card, Spinner, money, ConfidencePill, InfoTip, getBaseCurrency } from "../components/ui";
import { GLOSSARY, type GlossaryKey } from "../content/glossary";
import { AttributionPanel } from "../components/AttributionPanel";
import { useFeatures } from "../lib/features";
import { isPropertyBucket } from "../lib/buckets";

export function TxnDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const txnQ = useQuery({ queryKey: ["txn", id], queryFn: () => api.transaction(id) });
  const sitQ = useQuery({ queryKey: ["situation"], queryFn: () => api.situation() });
  const { has } = useFeatures();

  const [bucket, setBucket] = useState<string>("");
  const [label, setLabel] = useState<string>("");
  const [propertyId, setPropertyId] = useState<string>("");
  const [refundForId, setRefundForId] = useState<string>(""); // #258: which expense this refund reverses
  const [date, setDate] = useState<string>("");
  const [seededId, setSeededId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showDetail, setShowDetail] = useState(false); // #253: "Add detail" disclosure (categorise_v2)
  // "Edit one → update its look-alikes": after a categorisation save, hold on the page to offer
  // fanning the same edit out to the still-to-review siblings (+ learn a rule). Null = navigate away.
  const [applyTo, setApplyTo] = useState<{ n: number; total_cents: number; edit: { bucket?: string; ato_label?: string; property_id?: string } } | null>(null);

  const txn = txnQ.data;
  // Re-seed the form whenever a DIFFERENT txn loads. This route reuses the same component instance
  // across :id changes (React Router doesn't remount on a param change), so a one-time `seeded` flag
  // left the previous txn's bucket/label/date in the form when navigating txn→txn — and a "Save"
  // would then write those STALE values against the new txn's id. Keying the seed on `id` fixes it.
  if (txn && seededId !== id) {
    setBucket(txn.bucket ?? "");
    setLabel(txn.ato_label ?? "");
    setPropertyId(txn.property_id ?? "");
    setRefundForId(txn.refund_for_txn_id ?? "");
    setDate(txn.txn_date ?? "");
    setDirty(false);
    setSeededId(id);
  }

  // A property_id only belongs on a property bucket. The selector is merely HIDDEN on other buckets,
  // so without this a stale property_id would persist (and fan onto siblings) when re-bucketing away
  // from a rental — counting the amount against that property. Clear it whenever the bucket isn't one
  // the property selector is shown for.
  const effPropId = isPropertyBucket(bucket) ? propertyId : "";
  // #258: a refund→expense link only belongs on a 'refund' credit; clear it on any other bucket so a
  // stale link can't persist (and net) when the row is re-bucketed away from 'refund'.
  const effRefundFor = bucket === "refund" ? refundForId : "";

  const save = useMutation({
    mutationFn: async () => {
      if (!txn) return;
      const ops: Promise<unknown>[] = [];
      if (bucket && bucket !== txn.bucket) ops.push(api.correct(id, "bucket", bucket));
      if (label !== (txn.ato_label ?? "")) ops.push(api.correct(id, "ato_label", label));
      if (effPropId !== (txn.property_id ?? "")) ops.push(api.correct(id, "property_id", effPropId));
      if (effRefundFor !== (txn.refund_for_txn_id ?? "")) ops.push(api.correct(id, "refund_for_txn_id", effRefundFor));
      if (date !== (txn.txn_date ?? "")) ops.push(api.correct(id, "txn_date", date));
      // "Confirm as-is" when nothing changed: record acceptance of the current bucket. Skip for an
      // unknown bucket — re-writing bucket='unknown' would keep the row stuck in Needs-review; the
      // user must pick a real category (the BUCKETS dropdown above) before it can be confirmed.
      if (ops.length === 0 && txn.bucket && txn.bucket !== "unknown") ops.push(api.correct(id, "bucket", txn.bucket));
      await Promise.all(ops);
    },
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["txn", id] });
      qc.invalidateQueries({ queryKey: ["report"] });
      qc.invalidateQueries({ queryKey: ["filing-readiness"] });
      // Flag-gated: after categorising one line to a spend/asset bucket, offer to apply it to the
      // still-to-review look-alikes. Flag OFF (or no siblings) ⇒ navigate immediately, as before.
      if (has("apply_to_siblings") && isSpendBucket(bucket)) {
        try {
          const preview = await api.siblingsPreview(id);
          if (preview.n > 0) {
            setApplyTo({ n: preview.n, total_cents: preview.total_cents, edit: { bucket, ato_label: label || undefined, property_id: effPropId || undefined } });
            return; // hold on the page to show the prompt
          }
        } catch {
          /* preview is best-effort — fall through to navigate */
        }
      }
      navigate("/inbox");
    },
  });

  // Fan the just-saved edit out to the seed's look-alikes (+ learn a rule), then leave.
  const fanout = useMutation({
    mutationFn: () => api.applyToSiblings(id, applyTo!.edit, true),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["clarify"] });
      navigate("/inbox");
    },
  });

  const del = useMutation({
    mutationFn: () => api.deleteTxn(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      navigate("/inbox");
    },
  });

  // #130: record a rent credit (already tagged to a property + saved) as that property's rental income,
  // linked so it counts once. Reads the PERSISTED bucket/property, so the user saves the tag first.
  const recordIncome = useMutation({
    mutationFn: () => api.recordTxnIncome(id),
    onSuccess: () => {
      for (const k of ["income", "report", "dashboard", "transactions", "filing-readiness"]) qc.invalidateQueries({ queryKey: [k] });
      qc.invalidateQueries({ queryKey: ["txn", id] });
    },
  });
  const canRecordIncome = has("record_credit_income") && txn?.bucket === "income_property" && !!txn?.property_id && txn?.direction === "credit" && txn?.status !== "ignored";

  const reimb = useMutation({
    mutationFn: (v: boolean) => api.setTxnReimbursed(id, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["txn", id] });
      qc.invalidateQueries({ queryKey: ["report"] });
      qc.invalidateQueries({ queryKey: ["filing-readiness"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
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

  // Journey explainers (R7 / G4): detect rent-like and phone/internet lines from the text. These —
  // and the wfhQ hook they feed — are computed BEFORE the early returns below so every hook is called
  // in the same order on every render. A hook placed after an early `return` changes the hook count
  // between the loading and loaded renders, which crashes the page with React error #310. `txn` may be
  // undefined while loading, so guard each field; the real values resolve once it's present.
  const desc = `${txn?.merchant ?? ""} ${txn?.raw_description ?? ""}`.toLowerCase();
  const looksPhoneInternet = /\b(telstra|optus|vodafone|tpg|iinet|aussie ?broadband|belong|superloop|internet|broadband|nbn|mobile|phone plan)\b/.test(desc);
  const fyStart = txn?.txn_date && /^\d{4}-\d{2}-\d{2}$/.test(txn.txn_date) ? (Number(txn.txn_date.slice(5, 7)) >= 7 ? Number(txn.txn_date.slice(0, 4)) : Number(txn.txn_date.slice(0, 4)) - 1) : null;
  const wfhQ = useQuery({ queryKey: ["work-use", fyStart], queryFn: () => api.workUse(fyStart as number), enabled: looksPhoneInternet && fyStart != null });
  // #258: candidate expenses to link a refund to (countable debits in the same FY). Only fetched for a
  // refund credit when refund_netting_v2 is on — the picker is hidden otherwise, so no wasted call.
  const isRefund = txn?.bucket === "refund" && txn?.direction === "credit";
  const refundCandQ = useQuery({
    queryKey: ["txn-expenses", fyStart],
    queryFn: () => api.transactions({ fy: fyStart as number, countable: true, limit: 500 }),
    enabled: has("refund_netting_v2") && isRefund && fyStart != null,
  });

  if (txnQ.isLoading) return <Spinner />;
  if (!txn) return <Card className="p-6 text-sm text-muted">Transaction not found.</Card>;

  const isPdf = (txn.receipt_key ?? "").toLowerCase().endsWith(".pdf");
  const props = sitQ.data?.properties ?? [];
  const looksRent = /\brent\b|rental payment|real estate|property manager|tenancy/.test(desc) && (txn.bucket === "payg" || txn.bucket === "unknown" || txn.bucket == null);
  const wfhActive = (wfhQ.data?.wfh_hours ?? 0) > 0;
  // #253: collapse the secondary fields behind "Add detail" when categorise_v2 is on, so the screen is
  // one decision (Category) + one button. Never hide a field that already carries content — an existing
  // ATO label, a property/refund that needs choosing, or an undated row — so the disclosure auto-opens
  // for those. Flag OFF ⇒ detailOpen is always true ⇒ every field inline as before (byte-identical).
  const v2cat = has("categorise_v2");
  const detailRelevant = !!label || !date || isPropertyBucket(bucket) || (has("refund_netting_v2") && isRefund);
  const detailOpen = !v2cat || showDetail || detailRelevant;

  // Slice 6 (txn_drawer): the secondary fields as named pieces. Primary column = Category + property
  // (+ record-income) + Save; everything else folds into ONE "More options" drawer that auto-opens on
  // the FULL detailRelevant condition (so a dated supplier refund's link picker is never buried — a
  // silent money bug). OFF ⇒ these consts render in exactly today's positions ⇒ byte-identical.
  const drawer = has("txn_drawer");
  const atoLabelField = (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">ATO label <InfoTip k="ato_label" /></span>
      <input
        value={label}
        onChange={(e) => { setLabel(e.target.value); setDirty(true); }}
        placeholder="e.g. company:office-supplies"
        className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2"
      />
    </label>
  );
  const propertyField = isPropertyBucket(bucket) ? (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">Property <InfoTip tip={bucket === "income_property" ? "Which property this rent was received for, so it counts as that property's rental income." : "Which of your investment properties this cost belongs to, so per-property totals stay accurate."} /></span>
      <select
        value={propertyId}
        onChange={(e) => { setPropertyId(e.target.value); setDirty(true); }}
        className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2"
      >
        <option value="">— choose —</option>
        {props.map((p) => (
          <option key={p.id} value={p.id}>{p.label} ({p.status})</option>
        ))}
      </select>
      {bucket === "income_property" && (
        canRecordIncome ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <button
              onClick={() => recordIncome.mutate()}
              disabled={recordIncome.isPending || recordIncome.isSuccess}
              className="rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium hover:bg-card disabled:opacity-50"
            >
              {recordIncome.isSuccess ? "Recorded ✓" : recordIncome.isPending ? "Recording…" : "Record as rental income"}
            </button>
            <span className="text-xs text-muted">Counts it once as this property's rent (links the credit). General info only.</span>
            {recordIncome.isError && <span className="text-xs text-danger">{(recordIncome.error as Error).message}</span>}
          </div>
        ) : (
          <span className="mt-1 block text-xs text-muted">Tagging the property attributes this credit. Save it, then "Record as rental income" makes it count once (or link it under "possible duplicate income"). General info only.</span>
        )
      )}
    </label>
  ) : null;
  const refundField = has("refund_netting_v2") && isRefund ? (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">This refunds which expense? <InfoTip tip="Link this refund to the work/rental expense it reverses, so the deduction is reduced by the refund. Leave it unlinked for a personal reimbursement or a return on a personal purchase — those don't affect your deductions. General info only." /></span>
      <select
        value={refundForId}
        onChange={(e) => { setRefundForId(e.target.value); setDirty(true); }}
        className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2"
      >
        <option value="">— unlinked (personal reimbursement — doesn't reduce deductions) —</option>
        {(refundCandQ.data ?? []).filter((e) => e.id !== id).map((e) => (
          <option key={e.id} value={e.id}>{e.merchant ?? "Unknown"} · {money(e.amount_aud_cents ?? e.amount_cents)} · {e.txn_date ?? "undated"}</option>
        ))}
      </select>
      {refundCandQ.isLoading && <span className="mt-1 block text-xs text-muted">Loading your expenses…</span>}
    </label>
  ) : null;
  const dateField = (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">
        Date {date ? `· FY ${fyLabel(date) ?? "?"}` : "· undated — set one so it lands in a tax year"}
      </span>
      <input
        type="date"
        value={date}
        onChange={(e) => { setDate(e.target.value); setDirty(true); }}
        className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2"
      />
    </label>
  );
  const reimbursedCard = (txn.direction ?? "debit") === "debit" && txn.bucket !== "refund" ? (
    <Card className="space-y-1 p-4 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={!!txn.reimbursed} disabled={reimb.isPending} onChange={(e) => reimb.mutate(e.target.checked)} />
        <span className="font-medium">My employer reimbursed me for this</span>
      </label>
      <p className="text-xs text-muted">Reimbursed spend isn't deductible — you didn't bear the cost. Ticking this excludes it from your position. General information only.</p>
    </Card>
  ) : null;
  const attributionCard = has("attribution_engine") ? (
    <AttributionPanel key={id} txnId={id} txnAmountCents={txn.amount_aud_cents ?? txn.amount_cents ?? 0} entities={sitQ.data?.entities ?? []} persons={sitQ.data?.persons ?? []} />
  ) : null;
  const qboSection = txn.bucket === "company" ? (
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
          <button onClick={() => push.mutate()} disabled={push.isPending} className="rounded-lg border border-line px-3 py-2 font-medium transition hover:bg-surface disabled:opacity-50">
            {push.isPending ? "Pushing…" : "Push to QuickBooks (non-feed)"}
          </button>
          {pushMsg && <p className="text-muted">{pushMsg}</p>}
        </>
      )}
    </Card>
  ) : null;
  const deleteBtn = (
    <>
      <button
        onClick={() => { if (confirm("Delete this receipt permanently? This removes the image and can't be undone.")) del.mutate(); }}
        disabled={del.isPending}
        className="w-full rounded-lg border border-danger/30 py-2 text-sm font-medium text-danger transition hover:bg-danger/5 disabled:opacity-50"
      >
        {del.isPending ? "Deleting…" : "Delete receipt"}
      </button>
      {del.isError && <p className="text-sm text-danger">Couldn't delete: {(del.error as Error).message}</p>}
    </>
  );
  const historySection = txn.corrections.length > 0 ? (
    <Card className="p-4 text-sm">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Correction history</div>
      <ul className="space-y-1 text-muted">
        {txn.corrections.map((c, i) => (
          <li key={i}><span className="text-ink">{c.field}</span>: {c.old_value ?? "∅"} → {c.new_value ?? "∅"}</li>
        ))}
      </ul>
    </Card>
  ) : null;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 sm:grid-cols-[1fr_1.2fr]">
        {/* Receipt preview */}
        <Card className="overflow-hidden">
          {isPdf ? (
            <div className="grid h-64 place-items-center bg-surface text-sm text-muted">PDF receipt</div>
          ) : txn.receipt_key ? (
            <img src={api.receiptUrl(id)} alt="receipt" className="max-h-[28rem] w-full object-contain bg-surface" />
          ) : (
            <div className="grid h-64 place-items-center bg-surface text-sm text-muted">No receipt attached</div>
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
              v={`${money(txn.amount_cents)}${txn.currency && txn.currency !== getBaseCurrency() ? ` ${txn.currency}` : ""}`}
            />
            {txn.currency && txn.currency !== getBaseCurrency() && (
              <Field
                k={`${getBaseCurrency()} (est.)`}
                v={`${money(txn.amount_aud_cents)}${txn.fx_rate ? ` @ ${txn.fx_rate.toFixed(4)}` : " — set manually"}`}
              />
            )}
            <Field k="GST" tipKey="gst" v={txn.currency && txn.currency !== getBaseCurrency() ? "n/a (overseas)" : money(txn.gst_cents)} />
            <Field k="Date" tipKey="fy" v={`${txn.txn_date ?? "— undated —"}${fyLabel(txn.txn_date) ? `  ·  FY ${fyLabel(txn.txn_date)}` : ""}`} />
            {txn.paid_account && <Field k="Paid via" tipKey="paid_via" v={txn.paid_account} />}
            <Field k="Source" v={txn.source} />
            <Field k="Status" v={txn.status} />
          </Card>

          {txn.reasoning && (
            <Card className="space-y-1 bg-surface p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-ink-3">Why this category? <InfoTip k="reasoning" /></div>
              <p className="text-sm text-ink">{txn.reasoning}</p>
              <p className="text-xs text-muted">General information only — not tax advice. Confirm with a registered tax/BAS agent.</p>
            </Card>
          )}

          <Card className="space-y-4 p-4">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Bucket{" "}
                <InfoTip
                  tip={
                    <>
                      {GLOSSARY[(bucket && bucket in GLOSSARY ? bucket : "bucket") as GlossaryKey].short} Changing this teaches Quillo your
                      preferences for similar future transactions.
                    </>
                  }
                />
              </span>
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

            {drawer ? (
              /* Slice 6: primary column keeps just the property selector + record-income; ATO label,
                 date and refund-link live in the "More options" drawer below (auto-opens when relevant). */
              propertyField
            ) : (
              <>
                {v2cat && !detailRelevant && (
                  <button
                    type="button"
                    onClick={() => setShowDetail((s) => !s)}
                    className="text-xs font-semibold text-ink-3 underline underline-offset-2 hover:text-ink"
                  >
                    {showDetail ? "Hide detail" : "Add detail (ATO label, date…)"}
                  </button>
                )}
                {detailOpen && (
                  <>
                    {atoLabelField}
                    {propertyField}
                    {refundField}
                    {dateField}
                  </>
                )}
              </>
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

          {/* "Edit one → update its look-alikes" — the apply-to-siblings prompt (flag apply_to_siblings). */}
          {applyTo && (
            <Card className="space-y-3 border-ink/20 bg-surface p-4">
              <div className="text-sm">
                <span className="font-medium">{applyTo.n} look-alike{applyTo.n === 1 ? "" : "s"}</span> still to review
                {applyTo.total_cents ? <> · {money(applyTo.total_cents)}</> : null} match this merchant. Apply{" "}
                <span className="font-medium">{BUCKET_LABEL[applyTo.edit.bucket as keyof typeof BUCKET_LABEL] ?? applyTo.edit.bucket}</span> to all of
                them and remember it for future imports?
              </div>
              <p className="text-xs text-muted">Updates them in one step — you can Undo. General information only — not tax advice.</p>
              <div className="flex gap-2">
                <button
                  onClick={() => fanout.mutate()}
                  disabled={fanout.isPending}
                  className="flex-1 rounded-lg bg-ink py-2 font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
                >
                  {fanout.isPending ? "Applying…" : `Apply to ${applyTo.n} & remember`}
                </button>
                <button
                  onClick={() => navigate("/inbox")}
                  disabled={fanout.isPending}
                  className="rounded-lg border border-line px-3 py-2 font-medium transition hover:bg-card disabled:opacity-50"
                >
                  Just this one
                </button>
              </div>
              {fanout.isError && <p className="text-sm text-danger">Couldn't apply: {(fanout.error as Error).message}</p>}
            </Card>
          )}

          {/* R7 — reassure on rent: not deductible for an employee, but point to the claim she CAN make. */}
          {looksRent && (
            <Card className="border-line bg-surface p-3 text-xs text-muted">
              Rent on your own home isn't deductible when you're an employee — but your home-office <span className="font-medium text-ink">running costs are</span>, via the working-from-home method on your Dashboard. General information only.
            </Card>
          )}
          {/* G4 — phone/internet double-dip guard: the 70c fixed rate already bundles these. */}
          {looksPhoneInternet && wfhActive && (
            <Card className="border-warn/40 bg-warn/5 p-3 text-xs text-warn">
              Already covered by the 70c working-from-home rate — phone &amp; internet are bundled into that method, so don't also claim this line separately. General information only.
            </Card>
          )}

          {drawer ? (
            /* Slice 6: ONE "More options" drawer replacing today's two disclosures. Auto-opens on the FULL
               detailRelevant condition so a dated supplier refund's link picker is never buried (money bug). */
            <details className="rounded-2xl border border-line bg-card" open={detailRelevant}>
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink-2">More options — ATO label, date, refund link, who claims, delete</summary>
              <div className="space-y-3 px-4 pb-4">
                {atoLabelField}
                {dateField}
                {refundField}
                {reimbursedCard}
                {attributionCard}
                {qboSection}
                {deleteBtn}
                {historySection}
              </div>
            </details>
          ) : (
            <>
              {/* Reimbursement (G2) + who-paid-vs-who-claims attribution (Phase B). With apply_to_siblings on,
                  the default detail view is category → property → apply-to-siblings, and these power-user
                  controls tuck into a collapsed "Advanced" section (#166). Flag-off ⇒ rendered inline, exactly
                  as before (byte-identical). */}
              {(() => {
                if (!reimbursedCard && !attributionCard) return null;
                if (has("apply_to_siblings")) {
                  return (
                    <details className="rounded-2xl border border-line bg-card">
                      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink-2">Advanced — reimbursement &amp; who claims</summary>
                      <div className="space-y-3 px-4 pb-4">
                        {reimbursedCard}
                        {attributionCard}
                      </div>
                    </details>
                  );
                }
                return (
                  <>
                    {reimbursedCard}
                    {attributionCard}
                  </>
                );
              })()}
              {/* QuickBooks: reconcile-vs-push. Fed accounts reconcile (don't push); use this
                  only for a NON-FEED company expense (cash / a card not connected to QBO). */}
              {qboSection}
              {deleteBtn}
              {historySection}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Spend/asset buckets are the ones safe to fan out to siblings + learn a rule. Income/refund
// (money-IN) buckets are excluded — those route through the income flow (single-count dedupe), and
// the server rejects them on the apply-to-siblings seam — so we never offer the prompt for them.
const MONEY_IN_BUCKETS = ["income_business", "income_property", "income_personal", "refund"];
function isSpendBucket(b: string): boolean {
  return !!b && !MONEY_IN_BUCKETS.includes(b);
}

// AU financial year (Jul–Jun) label for a YYYY-MM-DD date, or null if missing/unparseable.
function fyLabel(d: string | null): string | null {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const y = Number(d.slice(0, 4));
  const mo = Number(d.slice(5, 7));
  const startYear = mo >= 7 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

function Field({ k, v, tipKey }: { k: string; v: string; tipKey?: GlossaryKey }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span className="text-muted">
        {k}
        {tipKey ? <> <InfoTip k={tipKey} /></> : null}
      </span>
      <span className="font-medium tabular-nums">{v}</span>
    </div>
  );
}
