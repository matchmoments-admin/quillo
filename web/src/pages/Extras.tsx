import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import { useFeatures } from "../lib/features";
import { Panel, PanelHead, KpiCard, Pill, Spinner, Button, Input, Meter, InfoTip, Term, money } from "../components/ui";
import type { PhiOverview, PhiPolicyView, PhiLoggable } from "../types";

// Government health-service finder (Healthdirect) — a neutral, no-commission directory we signpost to.
const HEALTHDIRECT_FINDER_URL = "https://www.healthdirect.gov.au/australian-health-services";

// Private Health Extras Tracker — FACTUAL engagement surface. Track per-category extras limits vs
// spend-to-date against the reset date ("use it before you lose it"). Never a tax output; never advice.

const SELECT_CLS = "mt-1 w-full rounded-lg border border-line bg-card px-3 py-2 text-sm outline-none transition focus:border-ink/40 focus:ring-2 focus:ring-ink/10";
const COVER_TYPES = [
  { v: "hospital", l: "Hospital" },
  { v: "extras", l: "Extras" },
  { v: "combined", l: "Combined (hospital + extras)" },
];
const RESET_BASES = [
  { v: "calendar", l: "Calendar year (resets 1 Jan)" },
  { v: "financial_year", l: "Financial year (resets 1 Jul)" },
  { v: "anniversary", l: "Policy anniversary" },
];

function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

export function Extras() {
  const { has, loaded } = useFeatures();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["phi"], queryFn: () => api.phi(), enabled: has("phi_extras_tracker") });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["phi"] });

  const consent = useMutation({
    mutationFn: () => api.phiConsent("I consent to Quillo storing my private-health policy, limits and usage to track my extras balances."),
    onSuccess: () => { toast.success("Extras tracking is on"); invalidate(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const scan = useMutation({
    mutationFn: () => api.phiScan(),
    onSuccess: (r) => { toast.success(`Checked — ${r.resets} reminder${r.resets === 1 ? "" : "s"}${r.setups ? `, ${r.setups} to set up` : ""}`); invalidate(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const withdraw = useMutation({
    mutationFn: () => api.phiWithdrawConsent(),
    onSuccess: () => { toast.success("Tracking off — your extras data is kept; you can delete it in Settings → Privacy"); invalidate(); },
    onError: (e) => toast.error((e as Error).message),
  });

  if (!has("phi_extras_tracker")) return <Panel className="text-sm text-muted">The Private Health Extras tracker isn't enabled.</Panel>;
  if (isLoading || !loaded) return <Spinner />;
  if (error) return <Panel className="text-sm text-muted">Couldn't load: {(error as Error).message}</Panel>;
  const d: PhiOverview = data!;

  if (!d.consented) return <ConsentGate onConsent={() => consent.mutate()} pending={consent.isPending} disclaimer={d.disclaimer} />;

  const totalUnused = d.policies.reduce((s, p) => s + p.total_unused_cents, 0);
  const totalLimit = d.policies.reduce((s, p) => s + p.total_limit_cents, 0);
  const withLimits = d.policies.filter((p) => p.total_limit_cents > 0).sort((a, b) => a.weeks_to_reset - b.weeks_to_reset);
  const soonest = withLimits[0];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="font-display text-4xl text-forest">Extras</h1>
          <div className="mt-1.5 text-xs font-medium text-ink-3">Your private-health extras — use it before you lose it</div>
        </div>
        <span className="flex-1" />
        <Button variant="ghost" className="h-9 px-4 text-xs uppercase tracking-wide" onClick={() => scan.mutate()} disabled={scan.isPending}>
          {scan.isPending ? "Checking…" : "Check reminders"}
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard variant="feature" label={<>Unused extras cover <InfoTip k="phi_unused" /></>} value={money(totalUnused)} foot={totalLimit > 0 ? `of ${money(totalLimit)} in tracked limits` : d.policies.length === 0 ? "Add a policy to start tracking" : "Add your limits below"} />
        <KpiCard variant="accent" label={<>Next reset <InfoTip k="phi_reset_basis" /></>} value={soonest ? fmtDate(soonest.reset_date) : "—"} foot={soonest ? `in about ${soonest.weeks_to_reset} week${soonest.weeks_to_reset === 1 ? "" : "s"}` : "Add a policy to track this"} />
        <KpiCard label="Policies tracked" value={String(d.policies.length)} foot={d.policies.length === 0 ? "None yet" : "Across your household"} />
      </div>

      {d.policies.length === 0 ? (
        <Panel className="text-sm text-ink-2">
          No policies yet. The quickest way: <strong>auto-fill from your fund</strong> below — pick your product and we pre-fill the standard limits for you to confirm. Then add what you've used so far, and Quillo tracks what's unused before your <Term k="phi_reset_basis">limits reset</Term>.
        </Panel>
      ) : (
        d.policies.map((p) => <PolicyCard key={p.id} p={p} options={d.category_options} onChange={invalidate} />)
      )}

      {d.policies.length > 0 && d.loggable.length > 0 && (
        <QuickLogCard loggable={d.loggable} policyId={d.policies[0].id} options={d.category_options} onChange={invalidate} />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <AutoSetupForm onDone={invalidate} />
        <AddPolicyForm onDone={invalidate} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <p className="max-w-2xl text-xs text-ink-3">{d.disclaimer} Extras tracking is general information to help you use your own cover — it is not health or financial advice, and it does not change your tax position. You can stop tracking and withdraw consent anytime; your data is kept until you delete it in Settings → Privacy.</p>
        <button
          className="shrink-0 text-xs text-ink-3 underline hover:text-danger"
          onClick={() => { if (confirm("Stop tracking and withdraw health-data consent? Your saved policies and limits are kept (delete them in Settings → Privacy), but new edits are blocked until you consent again.")) withdraw.mutate(); }}
        >
          Stop tracking &amp; withdraw consent
        </button>
      </div>
    </div>
  );
}

function ConsentGate({ onConsent, pending, disclaimer }: { onConsent: () => void; pending: boolean; disclaimer: string }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-4xl text-forest">Extras</h1>
        <div className="mt-1.5 text-xs font-medium text-ink-3">Track your private-health extras — use it before you lose it</div>
      </div>
      <Panel className="space-y-4">
        <PanelHead title="A quick consent first" sub="Your health information is sensitive — we ask separately before storing it" />
        <p className="text-sm text-ink-2">
          To track your extras (physio, dental, optical and the like) Quillo stores your policy, your per-category
          limits and the benefits you've used. That's <strong>health information</strong>, which the Privacy Act treats
          as sensitive — so we ask for a separate opt-in before saving any of it. It's kept in your account only, never
          shared. You can withdraw consent anytime from this page, and export or delete the data in Settings → Privacy.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
          <li>Factual tracking only — your balances and reset dates. No treatment suggestions, no provider steering.</li>
          <li>It never affects your tax position.</li>
          <li>Withdraw consent here anytime; export or delete the data in Settings → Privacy.</li>
        </ul>
        <Button onClick={onConsent} disabled={pending}>{pending ? "Saving…" : "I consent — turn on extras tracking"}</Button>
        <p className="text-xs text-ink-3">{disclaimer}</p>
      </Panel>
    </div>
  );
}

function PolicyCard({ p, options, onChange }: { p: PhiPolicyView; options: { value: string; label: string }[]; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const del = useMutation({ mutationFn: () => api.phiDeletePolicy(p.id), onSuccess: onChange, onError: (e) => toast.error((e as Error).message) });
  const delLimit = useMutation({ mutationFn: (id: string) => api.phiDeleteLimit(id), onSuccess: onChange, onError: (e) => toast.error((e as Error).message) });
  const delUsage = useMutation({ mutationFn: (id: string) => api.phiDeleteUsage(id), onSuccess: onChange, onError: (e) => toast.error((e as Error).message) });
  const confirmAll = useMutation({ mutationFn: () => api.phiConfirm(p.id), onSuccess: () => { toast.success("Limits confirmed"); onChange(); }, onError: (e) => toast.error((e as Error).message) });

  const coverLabel = COVER_TYPES.find((c) => c.v === p.cover_type)?.l ?? null;
  const unverified = p.categories.filter((c) => c.verified === 0).length;

  return (
    <Panel className="space-y-4">
      <PanelHead
        title={p.insurer || "Private health policy"}
        sub={<>Resets {fmtDate(p.reset_date)} · in about {p.weeks_to_reset} week{p.weeks_to_reset === 1 ? "" : "s"}</>}
        right={
          <div className="flex items-center gap-2">
            {coverLabel ? <Pill tone="info">{coverLabel}</Pill> : null}
            {p.source === "detected" ? <span className="inline-flex items-center gap-1"><Pill tone="info">Detected</Pill><InfoTip k="phi_detected" /></span> : null}
            <button className="text-xs text-ink-3 underline hover:text-ink" onClick={() => setEditing((v) => !v)}>{editing ? "Close" : "Edit"}</button>
            <button className="text-xs text-ink-3 underline hover:text-danger" onClick={() => { if (confirm("Delete this policy and its limits/usage?")) del.mutate(); }}>Delete</button>
          </div>
        }
      />

      {editing && <EditPolicyForm p={p} onDone={() => { setEditing(false); onChange(); }} />}

      {unverified > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sage/40 bg-sage/10 px-4 py-2.5 text-sm">
          <span className="text-ink-2">We pre-filled {unverified} limit{unverified === 1 ? "" : "s"} from the standard product — check them against your fund's app, then confirm. Edit any that differ.</span>
          <Button className="h-8 shrink-0 px-3 text-xs uppercase tracking-wide" onClick={() => confirmAll.mutate()} disabled={confirmAll.isPending}>{confirmAll.isPending ? "…" : "Confirm all"}</Button>
        </div>
      )}

      {p.categories.length === 0 ? (
        <p className="text-sm text-muted">No limits yet — add one below (e.g. Physiotherapy $500).</p>
      ) : (
        <div className="space-y-3">
          {p.categories.map((c) => {
            const frac = c.annual_limit_cents > 0 ? Math.min(1, c.used_cents / c.annual_limit_cents) : 0;
            // "Unused is the thing to notice": flag a category with lots still available (ochre);
            // green once most of it is used; neutral when fully used (nothing left to flag).
            const tone = c.remaining_cents <= 0 ? "neutral" : frac < 0.5 ? "warn" : "ok";
            return (
              <div key={c.category} className="rounded-xl border border-line bg-paper px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink">{c.label}</span>
                  <InfoTip k="phi_annual_limit" />
                  {c.annual_limit_cents > 0
                    ? <Pill tone={tone}>{money(c.remaining_cents)} unused</Pill>
                    : <Pill tone="neutral">no limit set</Pill>}
                  {c.combined_group ? <Pill tone="info">shared limit</Pill> : null}
                  {c.verified === 0 ? <Pill tone="warn">confirm</Pill> : null}
                  <span className="flex-1" />
                  {c.limit_id ? <button className="text-xs text-ink-3 underline hover:text-danger" onClick={() => delLimit.mutate(c.limit_id!)}>Remove limit</button> : null}
                </div>
                <Meter frac={frac} className={frac < 0.5 ? "bg-warn" : "bg-green"} />
                <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-ink-3">
                  <span>{c.annual_limit_cents > 0 ? <>{money(c.used_cents)} used of {money(c.annual_limit_cents)} limit</> : <>{money(c.used_cents)} recorded · add a limit to track what's left</>}</span>
                  {c.provider_term && c.remaining_cents > 0 && (
                    <a href={HEALTHDIRECT_FINDER_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-forest underline">
                      Find a {c.provider_term} near you ↗
                    </a>
                  )}
                </div>
                {c.entries.length > 0 && (
                  <ul className="mt-2 space-y-1 border-t border-line pt-2">
                    {c.entries.map((e) => (
                      <li key={e.id} className="flex items-center gap-2 text-xs text-ink-3">
                        <span className="tnum text-ink-2">{money(e.amount_used_cents)}</span>
                        <span>{e.used_on ? fmtDate(e.used_on) : "no date"}</span>
                        <span className="flex-1" />
                        <button className="underline hover:text-danger" onClick={() => delUsage.mutate(e.id)} aria-label="Delete this entry">Delete</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <LimitForm policyId={p.id} options={options} onDone={onChange} />
        <UsageForm policyId={p.id} options={options} onDone={onChange} />
      </div>
    </Panel>
  );
}

function EditPolicyForm({ p, onDone }: { p: PhiPolicyView; onDone: () => void }) {
  const [insurer, setInsurer] = useState(p.insurer ?? "");
  const [coverType, setCoverType] = useState(p.cover_type ?? "combined");
  const [resetBasis, setResetBasis] = useState(p.reset_basis);
  const save = useMutation({
    mutationFn: () => api.phiSavePolicy({ id: p.id, insurer: insurer || null, cover_type: coverType, reset_basis: resetBasis }),
    onSuccess: onDone,
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="rounded-xl border border-line bg-card p-4">
      <div className="text-xs font-bold uppercase tracking-wide text-ink-3">Edit policy</div>
      <div className="mt-2 grid gap-3 sm:grid-cols-3">
        <label className="text-sm">Insurer
          <Input className="mt-1 w-full" value={insurer} onChange={(e) => setInsurer(e.target.value)} placeholder="Bupa, Medibank, HCF…" />
        </label>
        <label className="text-sm">Cover type <InfoTip k="phi_cover_type" />
          <select className={SELECT_CLS} value={coverType} onChange={(e) => setCoverType(e.target.value)}>
            {COVER_TYPES.map((c) => <option key={c.v} value={c.v}>{c.l}</option>)}
          </select>
        </label>
        <label className="text-sm">Limits reset on <InfoTip k="phi_reset_basis" />
          <select className={SELECT_CLS} value={resetBasis} onChange={(e) => setResetBasis(e.target.value)}>
            {RESET_BASES.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}
          </select>
        </label>
      </div>
      <Button className="mt-3 h-9 px-4 text-xs uppercase tracking-wide" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save changes"}
      </Button>
    </div>
  );
}

function LimitForm({ policyId, options, onDone }: { policyId: string; options: { value: string; label: string }[]; onDone: () => void }) {
  const [category, setCategory] = useState(options[0]?.value ?? "physiotherapy");
  const [amount, setAmount] = useState("");
  const parsed = parseFloat(amount);
  const valid = Number.isFinite(parsed) && parsed > 0;
  const save = useMutation({
    mutationFn: () => api.phiSaveLimit({ policy_id: policyId, category, annual_limit_cents: Math.round(parsed * 100) }),
    onSuccess: () => { setAmount(""); onDone(); },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="rounded-xl border border-line bg-card p-4">
      <div className="text-xs font-bold uppercase tracking-wide text-ink-3">Add / update a limit</div>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <label className="text-sm">Category
          <select className={SELECT_CLS} value={category} onChange={(e) => setCategory(e.target.value)}>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="text-sm">Annual limit ($) <InfoTip k="phi_annual_limit" />
          <Input className="mt-1 w-full" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="500" />
        </label>
      </div>
      <Button className="mt-3 h-9 px-4 text-xs uppercase tracking-wide" onClick={() => save.mutate()} disabled={save.isPending || !valid}>
        {save.isPending ? "Saving…" : "Save limit"}
      </Button>
    </div>
  );
}

function UsageForm({ policyId, options, onDone }: { policyId: string; options: { value: string; label: string }[]; onDone: () => void }) {
  const [category, setCategory] = useState(options[0]?.value ?? "physiotherapy");
  const [amount, setAmount] = useState("");
  const [usedOn, setUsedOn] = useState("");
  const parsed = parseFloat(amount);
  const valid = Number.isFinite(parsed) && parsed > 0;
  const save = useMutation({
    mutationFn: () => api.phiRecordUsage({ policy_id: policyId, category, amount_used_cents: Math.round(parsed * 100), used_on: usedOn || null }),
    onSuccess: () => { setAmount(""); setUsedOn(""); onDone(); },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="rounded-xl border border-line bg-card p-4">
      <div className="text-xs font-bold uppercase tracking-wide text-ink-3">Record a benefit used</div>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <label className="text-sm">Category
          <select className={SELECT_CLS} value={category} onChange={(e) => setCategory(e.target.value)}>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="text-sm">Benefit used ($) <InfoTip k="phi_benefit_used" />
          <Input className="mt-1 w-full" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="80" />
        </label>
        <label className="col-span-2 text-sm">Date (optional)
          <Input className="mt-1 w-full" type="date" value={usedOn} onChange={(e) => setUsedOn(e.target.value)} />
        </label>
      </div>
      <p className="mt-1 text-xs text-ink-3">Enter the rebate your fund paid back, not the full amount you paid the clinic.</p>
      <Button className="mt-3 h-9 px-4 text-xs uppercase tracking-wide" onClick={() => save.mutate()} disabled={save.isPending || !valid}>
        {save.isPending ? "Saving…" : "Record usage"}
      </Button>
    </div>
  );
}

// Quick-log (Path A): one-tap recording of detected allied-health transactions against an extras limit
// — no typing/AI. Each row prefills the merchant, amount, date + a best-guess category to confirm.
function QuickLogCard({ loggable, policyId, options, onChange }: { loggable: PhiLoggable[]; policyId: string; options: { value: string; label: string }[]; onChange: () => void }) {
  return (
    <Panel className="space-y-3">
      <PanelHead title="Recent health spending — log it" sub="We spotted these in your transactions. One tap records them against your extras. Enter the rebate your fund paid if it differs from what you paid the clinic." />
      <div className="space-y-2">
        {loggable.map((t) => <QuickLogRow key={t.txn_id} t={t} policyId={policyId} options={options} onChange={onChange} />)}
      </div>
    </Panel>
  );
}

function QuickLogRow({ t, policyId, options, onChange }: { t: PhiLoggable; policyId: string; options: { value: string; label: string }[]; onChange: () => void }) {
  const [category, setCategory] = useState(t.suggested_category);
  const log = useMutation({
    mutationFn: () => api.phiRecordUsage({ policy_id: policyId, category, amount_used_cents: t.amount_cents, used_on: t.txn_date, txn_id: t.txn_id }),
    onSuccess: () => { toast.success("Logged against your extras"); onChange(); },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-paper px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate font-medium text-ink">{t.merchant}</span>
      <span className="text-xs text-ink-3">{fmtDate(t.txn_date)}</span>
      <span className="tnum font-semibold text-ink">{money(t.amount_cents)}</span>
      <select className="rounded-lg border border-line bg-card px-2 py-1 text-xs" value={category} onChange={(e) => setCategory(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <Button className="h-8 px-3 text-xs uppercase tracking-wide" onClick={() => log.mutate()} disabled={log.isPending}>{log.isPending ? "…" : "Log"}</Button>
    </div>
  );
}

function AutoSetupForm({ onDone }: { onDone: () => void }) {
  const { data: insurers } = useQuery({ queryKey: ["phi-products"], queryFn: () => api.phiProducts(), staleTime: 300_000 });
  const [insurerId, setInsurerId] = useState("");
  const [productId, setProductId] = useState("");
  const apply = useMutation({
    mutationFn: () => api.phiApplyProduct(productId),
    onSuccess: (r) => { toast.success(`Loaded ${r.limits} limits — check & confirm them`); setProductId(""); onDone(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const insurer = insurers?.find((i) => i.insurer_id === insurerId);
  return (
    <Panel className="space-y-3">
      <PanelHead title="Auto-fill from your fund" sub="Pick your product — we pre-fill the standard limits for you to confirm" />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">Insurer
          <select className={SELECT_CLS} value={insurerId} onChange={(e) => { setInsurerId(e.target.value); setProductId(""); }}>
            <option value="">Choose…</option>
            {insurers?.map((i) => <option key={i.insurer_id} value={i.insurer_id}>{i.insurer_name}</option>)}
          </select>
        </label>
        <label className="text-sm">Product
          <select className={SELECT_CLS} value={productId} onChange={(e) => setProductId(e.target.value)} disabled={!insurer}>
            <option value="">Choose…</option>
            {insurer?.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>
      <Button onClick={() => apply.mutate()} disabled={apply.isPending || !productId}>{apply.isPending ? "Loading…" : "Auto-fill my extras"}</Button>
      <p className="text-xs text-ink-3">We pre-fill each service's standard limit from the public product information (PHIS). Your actual limits can differ with loyalty/tenure, so you'll confirm or edit them — then add what you've used. Can't find your product? Add it manually on the right.</p>
    </Panel>
  );
}

function AddPolicyForm({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [insurer, setInsurer] = useState("");
  const [coverType, setCoverType] = useState("combined");
  const [resetBasis, setResetBasis] = useState("calendar");
  const save = useMutation({
    mutationFn: () => api.phiSavePolicy({ insurer: insurer || null, cover_type: coverType, reset_basis: resetBasis }),
    onSuccess: () => { setInsurer(""); setCoverType("combined"); setResetBasis("calendar"); setOpen(false); onDone(); },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!open) return <Button variant="ghost" className="h-9 px-4 text-xs uppercase tracking-wide" onClick={() => setOpen(true)}>+ Add a policy</Button>;
  return (
    <Panel className="space-y-3">
      <PanelHead title="Add a policy" sub="Your fund and when its extras limits reset" />
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">Insurer
          <Input className="mt-1 w-full" value={insurer} onChange={(e) => setInsurer(e.target.value)} placeholder="Bupa, Medibank, HCF…" />
        </label>
        <label className="text-sm">Cover type <InfoTip k="phi_cover_type" />
          <select className={SELECT_CLS} value={coverType} onChange={(e) => setCoverType(e.target.value)}>
            {COVER_TYPES.map((c) => <option key={c.v} value={c.v}>{c.l}</option>)}
          </select>
        </label>
        <label className="text-sm">Limits reset on <InfoTip k="phi_reset_basis" />
          <select className={SELECT_CLS} value={resetBasis} onChange={(e) => setResetBasis(e.target.value)}>
            {RESET_BASES.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}
          </select>
        </label>
      </div>
      <div className="flex gap-2">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving…" : "Add policy"}</Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </Panel>
  );
}
