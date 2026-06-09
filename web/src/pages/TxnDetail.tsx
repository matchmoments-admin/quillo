import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { BUCKETS } from "../types";
import { BUCKET_LABEL, Card, Spinner, money, ConfidencePill, InfoTip } from "../components/ui";
import { GLOSSARY, type GlossaryKey } from "../content/glossary";
import { AttributionPanel } from "../components/AttributionPanel";
import { useFeatures } from "../lib/features";

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
  const [date, setDate] = useState<string>("");
  const [seededId, setSeededId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
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
    setDate(txn.txn_date ?? "");
    setDirty(false);
    setSeededId(id);
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
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["txn", id] });
      // Flag-gated: after categorising one line to a spend/asset bucket, offer to apply it to the
      // still-to-review look-alikes. Flag OFF (or no siblings) ⇒ navigate immediately, as before.
      if (has("apply_to_siblings") && isSpendBucket(bucket)) {
        try {
          const preview = await api.siblingsPreview(id);
          if (preview.n > 0) {
            setApplyTo({ n: preview.n, total_cents: preview.total_cents, edit: { bucket, ato_label: label || undefined, property_id: propertyId || undefined } });
            return; // hold on the page to show the prompt
          }
        } catch {
          /* preview is best-effort — fall through to navigate */
        }
      }
      navigate("/");
    },
  });

  // Fan the just-saved edit out to the seed's look-alikes (+ learn a rule), then leave.
  const fanout = useMutation({
    mutationFn: () => api.applyToSiblings(id, applyTo!.edit, true),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["clarify"] });
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

  if (txnQ.isLoading) return <Spinner />;
  if (!txn) return <Card className="p-6 text-sm text-muted">Transaction not found.</Card>;

  const isPdf = (txn.receipt_key ?? "").toLowerCase().endsWith(".pdf");
  const props = sitQ.data?.properties ?? [];
  const looksRent = /\brent\b|rental payment|real estate|property manager|tenancy/.test(desc) && (txn.bucket === "payg" || txn.bucket === "unknown" || txn.bucket == null);
  const wfhActive = (wfhQ.data?.wfh_hours ?? 0) > 0;

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
            <Field k="GST" tipKey="gst" v={txn.currency && txn.currency !== "AUD" ? "n/a (overseas)" : money(txn.gst_cents)} />
            <Field k="Date" tipKey="fy" v={`${txn.txn_date ?? "— undated —"}${fyLabel(txn.txn_date) ? `  ·  FY ${fyLabel(txn.txn_date)}` : ""}`} />
            {txn.paid_account && <Field k="Paid via" tipKey="paid_via" v={txn.paid_account} />}
            <Field k="Source" v={txn.source} />
            <Field k="Status" v={txn.status} />
          </Card>

          {txn.reasoning && (
            <Card className="space-y-1 bg-surface p-4">
              <div className="text-xs font-medium uppercase tracking-wide text-ink-3">Why this bucket? <InfoTip k="reasoning" /></div>
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

            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">ATO label <InfoTip k="ato_label" /></span>
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

            {/* Property applies to rental EXPENSE buckets and to rent INCOME (income_property) — a rent
                credit must be attributable to its property, or its rental income never ties in. */}
            {(bucket === "property_rented" || bucket === "property_vacant" || bucket === "income_property") && (
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">Property <InfoTip tip={bucket === "income_property" ? "Which property this rent was received for, so it counts as that property's rental income." : "Which of your investment properties this cost belongs to, so per-property totals stay accurate."} /></span>
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
                {bucket === "income_property" && (
                  <span className="mt-1 block text-xs text-muted">Tagging the property attributes this credit. To make it count in the position, record it as rental income (or link it under "possible duplicate income"). General info only.</span>
                )}
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
                  onClick={() => navigate("/")}
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

          {/* Were you reimbursed? (G2) — employer-reimbursed spend isn't your deductible cost, so the
              position excludes it. Shown for spend (debit), not income/refund credits. */}
          {(txn.direction ?? "debit") === "debit" && txn.bucket !== "refund" && (
            <Card className="space-y-1 p-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={!!txn.reimbursed} disabled={reimb.isPending} onChange={(e) => reimb.mutate(e.target.checked)} />
                <span className="font-medium">My employer reimbursed me for this</span>
              </label>
              <p className="text-xs text-muted">Reimbursed spend isn't deductible — you didn't bear the cost. Ticking this excludes it from your position. General information only.</p>
            </Card>
          )}

          {/* Phase B / G2 — who paid vs who claims (payer≠claimant). Flag-gated: appears with the
              attribution engine so the panel and the position activate together. */}
          {has("attribution_engine") && (
            <AttributionPanel
              key={id}
              txnId={id}
              txnAmountCents={txn.amount_aud_cents ?? txn.amount_cents ?? 0}
              entities={sitQ.data?.entities ?? []}
              persons={sitQ.data?.persons ?? []}
            />
          )}

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
