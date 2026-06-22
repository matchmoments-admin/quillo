import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import { useFeatures } from "../lib/features";
import { Panel, PanelHead, KpiCard, Pill, Spinner, Button, Input, Meter, money } from "../components/ui";
import type { PhiOverview, PhiPolicyView } from "../types";

// Private Health Extras Tracker — FACTUAL engagement surface. Track per-category extras limits vs
// spend-to-date against the reset date ("use it before you lose it"). Never a tax output; never advice.

const SELECT_CLS = "mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm";
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
    onSuccess: (r) => { toast.success(`Checked — ${r.resets} reminder${r.resets === 1 ? "" : "s"}`); invalidate(); },
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
        <KpiCard variant="feature" label="Unused extras cover" value={money(totalUnused)} foot={totalLimit > 0 ? `of ${money(totalLimit)} in tracked limits` : "Add your limits below"} />
        <KpiCard variant="accent" label="Next reset" value={soonest ? fmtDate(soonest.reset_date) : "—"} foot={soonest ? `in about ${soonest.weeks_to_reset} week${soonest.weeks_to_reset === 1 ? "" : "s"}` : "Add a policy to track this"} />
        <KpiCard label="Policies tracked" value={String(d.policies.length)} foot={d.policies.length === 0 ? "None yet" : "Across your household"} />
      </div>

      {d.policies.length === 0 ? (
        <Panel className="text-sm text-ink-2">
          No policies yet. Add your private-health policy below, then enter each extras limit (e.g. physio $500, dental $700) and the benefits you've used so far. Quillo will track what's unused before your limits reset.
        </Panel>
      ) : (
        d.policies.map((p) => <PolicyCard key={p.id} p={p} options={d.category_options} onChange={invalidate} />)
      )}

      <AddPolicyForm onDone={invalidate} />

      <p className="text-xs text-ink-3">{d.disclaimer} Extras tracking is general information to help you use your own cover — it is not health or financial advice, and it does not change your tax position.</p>
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
          shared, and you can withdraw consent or delete it anytime in Settings → Privacy.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
          <li>Factual tracking only — your balances and reset dates. No treatment suggestions, no provider steering.</li>
          <li>It never affects your tax position.</li>
          <li>Stored in your account; export or delete it whenever you like.</li>
        </ul>
        <Button onClick={onConsent} disabled={pending}>{pending ? "Saving…" : "I consent — turn on extras tracking"}</Button>
        <p className="text-xs text-ink-3">{disclaimer}</p>
      </Panel>
    </div>
  );
}

function PolicyCard({ p, options, onChange }: { p: PhiPolicyView; options: { value: string; label: string }[]; onChange: () => void }) {
  const del = useMutation({ mutationFn: () => api.phiDeletePolicy(p.id), onSuccess: onChange, onError: (e) => toast.error((e as Error).message) });
  const delLimit = useMutation({ mutationFn: (id: string) => api.phiDeleteLimit(id), onSuccess: onChange, onError: (e) => toast.error((e as Error).message) });

  const coverLabel = COVER_TYPES.find((c) => c.v === p.cover_type)?.l ?? null;

  return (
    <Panel className="space-y-4">
      <PanelHead
        title={p.insurer || "Private health policy"}
        sub={<>Resets {fmtDate(p.reset_date)} · in about {p.weeks_to_reset} week{p.weeks_to_reset === 1 ? "" : "s"}</>}
        right={
          <div className="flex items-center gap-2">
            {coverLabel ? <Pill tone="info">{coverLabel}</Pill> : null}
            {p.source === "detected" ? <Pill tone="warn">Detected</Pill> : null}
            <button className="text-xs text-ink-3 underline hover:text-danger" onClick={() => { if (confirm("Delete this policy and its limits/usage?")) del.mutate(); }}>Delete</button>
          </div>
        }
      />

      {p.categories.length === 0 ? (
        <p className="text-sm text-muted">No limits yet — add one below (e.g. Physiotherapy $500).</p>
      ) : (
        <div className="space-y-3">
          {p.categories.map((c) => {
            const frac = c.annual_limit_cents > 0 ? Math.min(1, c.used_cents / c.annual_limit_cents) : 0;
            const tone = c.remaining_cents <= 0 ? "ok" : frac >= 0.85 ? "ok" : "warn";
            return (
              <div key={c.limit_id} className="rounded-xl border border-line bg-paper px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink">{c.label}</span>
                  <Pill tone={tone === "warn" ? "warn" : "ok"}>{money(c.remaining_cents)} unused</Pill>
                  <span className="flex-1" />
                  <button className="text-xs text-ink-3 underline hover:text-danger" onClick={() => delLimit.mutate(c.limit_id)}>Remove</button>
                </div>
                <div className="mt-2"><Meter frac={frac} /></div>
                <div className="mt-1 text-xs text-ink-3">{money(c.used_cents)} used of {money(c.annual_limit_cents)} limit</div>
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

function LimitForm({ policyId, options, onDone }: { policyId: string; options: { value: string; label: string }[]; onDone: () => void }) {
  const [category, setCategory] = useState(options[0]?.value ?? "physiotherapy");
  const [amount, setAmount] = useState("");
  const save = useMutation({
    mutationFn: () => api.phiSaveLimit({ policy_id: policyId, category, annual_limit_cents: Math.round(parseFloat(amount || "0") * 100) }),
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
        <label className="text-sm">Annual limit ($)
          <Input className="mt-1 w-full" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="500" />
        </label>
      </div>
      <Button className="mt-3 h-9 px-4 text-xs uppercase tracking-wide" onClick={() => save.mutate()} disabled={save.isPending || !amount}>
        {save.isPending ? "Saving…" : "Save limit"}
      </Button>
    </div>
  );
}

function UsageForm({ policyId, options, onDone }: { policyId: string; options: { value: string; label: string }[]; onDone: () => void }) {
  const [category, setCategory] = useState(options[0]?.value ?? "physiotherapy");
  const [amount, setAmount] = useState("");
  const [usedOn, setUsedOn] = useState("");
  const save = useMutation({
    mutationFn: () => api.phiRecordUsage({ policy_id: policyId, category, amount_used_cents: Math.round(parseFloat(amount || "0") * 100), used_on: usedOn || null }),
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
        <label className="text-sm">Benefit used ($)
          <Input className="mt-1 w-full" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="80" />
        </label>
        <label className="col-span-2 text-sm">Date (optional)
          <Input className="mt-1 w-full" type="date" value={usedOn} onChange={(e) => setUsedOn(e.target.value)} />
        </label>
      </div>
      <Button className="mt-3 h-9 px-4 text-xs uppercase tracking-wide" onClick={() => save.mutate()} disabled={save.isPending || !amount}>
        {save.isPending ? "Saving…" : "Record usage"}
      </Button>
    </div>
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
        <label className="text-sm">Cover type
          <select className={SELECT_CLS} value={coverType} onChange={(e) => setCoverType(e.target.value)}>
            {COVER_TYPES.map((c) => <option key={c.v} value={c.v}>{c.l}</option>)}
          </select>
        </label>
        <label className="text-sm">Limits reset on
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
