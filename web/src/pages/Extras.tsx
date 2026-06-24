import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import { useFeatures } from "../lib/features";
import { Panel, PanelHead, Pill, Spinner, Button, Input, Meter, InfoTip, Term, money } from "../components/ui";
import { computeSuggestions, haversineKm, formatKm, type Suggestion } from "../lib/phi-suggestions";
import type { PhiOverview, PhiPolicyView, PhiCategoryLine, PhiProvider } from "../types";

// Government health-service finder (Healthdirect) — a neutral, no-commission directory we signpost to.
const HEALTHDIRECT_FINDER_URL = "https://www.healthdirect.gov.au/australian-health-services";

// Google universal Maps search / directions URLs — open the native Maps app on mobile (Android/iOS) or
// maps.google on web, cross-platform, with NO API call.
function mapsSearchUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
function mapsDirectionsUrl(query: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(query)}`;
}

// Private Health Extras Tracker — FACTUAL engagement surface. Track per-category extras limits vs
// spend-to-date against the reset date ("use it before you lose it"). Never a tax output; never advice.

// Cover-ring palette (token hexes; the ring is drawn with inline conic-gradient — no component exists).
const RING_USED = "#0c3f26"; // forest
const RING_TRACK = "rgba(12,63,38,0.10)";
const RING_HOLE = "#eef0d2"; // paper — the page background the ring sits on

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

// A category line paired with the policy it belongs to — the flattened unit the dashboard renders.
type FlatCategory = { policy: PhiPolicyView; c: PhiCategoryLine };

export function Extras() {
  const { has, loaded } = useFeatures();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["phi"], queryFn: () => api.phi(), enabled: has("phi_extras_tracker") });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["phi"] });
  // Which category row to auto-expand + scroll to (set by a "Find a provider" suggestion).
  const [focus, setFocus] = useState<string | null>(null);

  const consent = useMutation({
    mutationFn: () => api.phiConsent("I consent to Quillo storing my private-health policy, limits and usage to track my extras balances."),
    onSuccess: () => { toast.success("Extras tracking is on"); invalidate(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const withdraw = useMutation({
    mutationFn: () => api.phiWithdrawConsent(),
    onSuccess: () => { toast.success("Tracking off — your extras data is kept; you can delete it in Settings → Privacy"); invalidate(); },
    onError: (e) => toast.error((e as Error).message),
  });

  const d: PhiOverview | undefined = data;
  const totalUnused = d ? d.policies.reduce((s, p) => s + p.total_unused_cents, 0) : 0;
  const totalLimit = d ? d.policies.reduce((s, p) => s + p.total_limit_cents, 0) : 0;
  const totalUsed = d ? d.policies.reduce((s, p) => s + p.total_used_cents, 0) : 0;
  const withLimits = d ? d.policies.filter((p) => p.total_limit_cents > 0).sort((a, b) => a.weeks_to_reset - b.weeks_to_reset) : [];
  const soonest = withLimits[0];
  const suggestions = useMemo(() => (d ? computeSuggestions(d) : []), [d]);
  // All category lines across policies, biggest unused first ("most left").
  const flat: FlatCategory[] = useMemo(() => {
    if (!d) return [];
    return d.policies.flatMap((policy) => policy.categories.map((c) => ({ policy, c })))
      .sort((a, b) => b.c.remaining_cents - a.c.remaining_cents);
  }, [d]);

  if (!has("phi_extras_tracker")) return <Panel className="text-sm text-muted">The Private Health Extras tracker isn't enabled.</Panel>;
  if (isLoading || !loaded) return <Spinner />;
  if (error) return <Panel className="text-sm text-muted">Couldn't load: {(error as Error).message}</Panel>;
  if (!d) return <Spinner />;

  if (!d.consented) return <ConsentGate onConsent={() => consent.mutate()} pending={consent.isPending} disclaimer={d.disclaimer} />;

  const onFind = (_policyId: string, category: string) => {
    setFocus(category);
    // Defer to let the row mount/expand, then bring it into view.
    setTimeout(() => document.getElementById(`cat-${category}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
  };
  const insurers = Array.from(new Set(d.policies.map((p) => p.insurer).filter(Boolean))) as string[];

  return (
    <div className="space-y-8">
      {/* App bar */}
      <div className="flex items-center justify-between">
        <h1 className="font-display text-4xl text-forest">Extras</h1>
        {soonest ? <Pill tone="neutral">Resets {fmtDate(soonest.reset_date)}</Pill> : null}
      </div>

      {d.policies.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <CoverRing unused={totalUnused} used={totalUsed} limit={totalLimit} soonest={soonest} />

          {totalLimit > 0 && (
            <div className="text-center sm:text-left">
              <h2 className="font-display text-3xl leading-tight text-forest sm:text-4xl">
                You have <span className="text-green">{money(totalUnused)}</span> to use before it resets.
              </h2>
              <p className="mt-2 text-sm text-ink-2">
                That's your extras cover{insurers.length ? <> with {insurers.join(" & ")}</> : null}, still unclaimed. Most people never use theirs — here's where yours can go.
              </p>
            </div>
          )}

          <SuggestedNext suggestions={suggestions} onFind={onFind} onChange={invalidate} />

          <AllCategories flat={flat} options={d.category_options} focus={focus} onChange={invalidate} />

          <ClaimedTracker used={totalUsed} limit={totalLimit} />
        </>
      )}

      <ManageSection d={d} onChange={invalidate} onWithdraw={() => { if (confirm("Stop tracking and withdraw health-data consent? Your saved policies and limits are kept (delete them in Settings → Privacy), but new edits are blocked until you consent again.")) withdraw.mutate(); }} />
    </div>
  );
}

// ── Cover ring ────────────────────────────────────────────────────────────────────────────────────
function CoverRing({ unused, used, limit, soonest }: { unused: number; used: number; limit: number; soonest?: PhiPolicyView }) {
  const frac = limit > 0 ? Math.min(1, used / limit) : 0;
  const deg = Math.round(frac * 360);
  return (
    <div className="flex flex-col items-center">
      <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-ink-3">Unused extras cover</div>
      <div className="relative mt-3 h-60 w-60">
        <div className="absolute inset-0 rounded-full" style={{ background: `conic-gradient(${RING_USED} 0deg ${deg}deg, ${RING_TRACK} ${deg}deg 360deg)` }} />
        <div className="absolute rounded-full" style={{ inset: 21, background: RING_HOLE }} />
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="font-display text-5xl leading-none text-forest tnum">{money(unused)}</div>
          <div className="mt-1.5 text-[12.5px] text-ink-3">{money(used)} of {money(limit)} used</div>
        </div>
      </div>
      {soonest && (
        <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-warn/30 bg-warn/10 px-4 py-2">
          <span className="h-1.5 w-1.5 rounded-full bg-warn" />
          <span className="text-[12.5px] font-semibold text-warn">Resets in {soonest.weeks_to_reset} week{soonest.weeks_to_reset === 1 ? "" : "s"} · {fmtDate(soonest.reset_date)}</span>
        </div>
      )}
    </div>
  );
}

// ── Suggested next ────────────────────────────────────────────────────────────────────────────────
function SuggestedNext({ suggestions, onFind, onChange }: { suggestions: Suggestion[]; onFind: (policyId: string, category: string) => void; onChange: () => void }) {
  if (suggestions.length === 0) return null;
  return (
    <div className="space-y-3">
      <div>
        <h2 className="font-display text-2xl text-forest">Suggested next</h2>
        <div className="text-xs text-ink-3">Biggest, easiest wins first</div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {suggestions.map((s) => <SuggestionCard key={s.key} s={s} onFind={onFind} onChange={onChange} />)}
      </div>
    </div>
  );
}

function SuggestionCard({ s, onFind, onChange }: { s: Suggestion; onFind: (policyId: string, category: string) => void; onChange: () => void }) {
  const confirmM = useMutation({ mutationFn: () => api.phiConfirm(s.policyId!), onSuccess: () => { toast.success("Limits confirmed"); onChange(); }, onError: (e) => toast.error((e as Error).message) });
  const logM = useMutation({
    mutationFn: () => api.phiRecordUsage({ policy_id: s.policyId!, category: s.loggable!.suggested_category, amount_used_cents: s.loggable!.amount_cents, used_on: s.loggable!.txn_date, txn_id: s.loggable!.txn_id }),
    onSuccess: () => { toast.success("Logged against your extras"); onChange(); },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="rounded-2xl border border-line bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        {s.badge ? <span className="rounded-md bg-warn/15 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-warn">{s.badge}</span> : <span className="text-[10px] font-bold uppercase tracking-wide text-ink-3">{s.kind === "log" ? "Detected" : s.kind === "confirm" ? "Action" : "Get started"}</span>}
        {s.sub ? <span className="text-[11px] text-ink-3">{s.sub}</span> : null}
      </div>
      <div className="mt-2.5 text-base font-bold text-ink">{s.title}</div>
      <div className="mt-1 text-[12.5px] leading-snug text-ink-2">{s.body}</div>
      <div className="mt-3">
        {s.kind === "find" && (
          <Button className="h-9 w-full px-4 text-xs uppercase tracking-wide" onClick={() => onFind(s.policyId!, s.category!)}>Find a {s.providerTerm}</Button>
        )}
        {s.kind === "log" && (
          <Button className="h-9 w-full px-4 text-xs uppercase tracking-wide" onClick={() => logM.mutate()} disabled={logM.isPending}>{logM.isPending ? "Logging…" : "Log it"}</Button>
        )}
        {s.kind === "confirm" && (
          <Button className="h-9 w-full px-4 text-xs uppercase tracking-wide" onClick={() => confirmM.mutate()} disabled={confirmM.isPending}>{confirmM.isPending ? "…" : "Confirm limits"}</Button>
        )}
        {s.kind === "setup" && (
          <Button className="h-9 w-full px-4 text-xs uppercase tracking-wide" onClick={() => document.getElementById("phi-manage")?.scrollIntoView({ behavior: "smooth" })}>Set up my fund</Button>
        )}
      </div>
    </div>
  );
}

// ── All categories ──────────────────────────────────────────────────────────────────────────────
function AllCategories({ flat, options, focus, onChange }: { flat: FlatCategory[]; options: { value: string; label: string }[]; focus: string | null; onChange: () => void }) {
  const [showAll, setShowAll] = useState(false);
  if (flat.length === 0) return null;
  let visible = showAll ? flat : flat.slice(0, 4);
  // Ensure the focused row (from a "Find a provider" suggestion) is in the DOM to expand + scroll to.
  if (focus && !visible.some((f) => f.c.category === focus)) {
    const extra = flat.find((f) => f.c.category === focus);
    if (extra) visible = [...visible, extra];
  }
  const hiddenLeft = flat.slice(4).reduce((s, f) => s + Math.max(0, f.c.remaining_cents), 0);
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-2xl text-forest">All categories</h2>
        <span className="text-xs font-semibold text-green">Sort: most left</span>
      </div>
      <div className="space-y-2">
        {visible.map((f) => <CategoryRow key={`${f.policy.id}:${f.c.category}`} f={f} options={options} defaultOpen={focus === f.c.category} onChange={onChange} />)}
      </div>
      {flat.length > 4 && (
        <button className="w-full py-2 text-center text-[13px] font-semibold text-green" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show all ${flat.length} categories${hiddenLeft > 0 ? ` (${money(hiddenLeft)} more)` : ""}`} ›
        </button>
      )}
    </div>
  );
}

function CategoryRow({ f, options, defaultOpen, onChange }: { f: FlatCategory; options: { value: string; label: string }[]; defaultOpen: boolean; onChange: () => void }) {
  const { policy, c } = f;
  const [open, setOpen] = useState(defaultOpen);
  const [logging, setLogging] = useState(false);
  // A "Find a provider" suggestion can focus this row after it's already mounted — expand it then.
  useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);
  const delLimit = useMutation({ mutationFn: () => api.phiDeleteLimit(c.limit_id!), onSuccess: onChange, onError: (e) => toast.error((e as Error).message) });
  const delUsage = useMutation({ mutationFn: (id: string) => api.phiDeleteUsage(id), onSuccess: onChange, onError: (e) => toast.error((e as Error).message) });
  const frac = c.annual_limit_cents > 0 ? Math.min(1, c.used_cents / c.annual_limit_cents) : 0;

  return (
    <div id={`cat-${c.category}`} className="overflow-hidden rounded-2xl border border-line bg-card">
      <button className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left" onClick={() => setOpen((v) => !v)}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-ink">{c.label}</span>
            {c.combined_group ? <Pill tone="info">Shared</Pill> : null}
            {c.verified === 0 ? <Pill tone="warn">Confirm</Pill> : null}
          </div>
          <div className="mt-0.5 text-[11.5px] text-ink-3">{c.annual_limit_cents > 0 ? <>{money(c.used_cents)} used · {money(c.remaining_cents)} left</> : <>{money(c.used_cents)} recorded · no limit set</>}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-display text-2xl leading-none text-forest tnum">{c.annual_limit_cents > 0 ? money(c.remaining_cents) : money(c.used_cents)}</div>
        </div>
      </button>

      {open && (
        <div className="space-y-3 border-t border-line px-4 py-3">
          {c.annual_limit_cents > 0 && <Meter frac={frac} className={frac < 0.5 ? "bg-warn" : "bg-green"} />}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
            <span>{c.annual_limit_cents > 0 ? <>{money(c.used_cents)} used of {money(c.annual_limit_cents)} limit</> : <>add a limit to track what's left</>}</span>
            {c.limit_id ? <button className="underline hover:text-danger" onClick={() => delLimit.mutate()}>Remove limit</button> : null}
            <button className="font-semibold text-green underline" onClick={() => setLogging((v) => !v)}>{logging ? "Hide claim form" : "Log a claim"}</button>
          </div>

          {c.provider_term && c.remaining_cents > 0 && (
            <ProviderFinder category={c.category} providerTerm={c.provider_term} onLogClaim={() => setLogging(true)} />
          )}

          {logging && (
            <UsageForm policyId={policy.id} options={options} prefill={{ category: c.category }} onDone={() => { setLogging(false); onChange(); }} />
          )}

          {c.entries.length > 0 && (
            <ul className="space-y-1 border-t border-line pt-2">
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
      )}
    </div>
  );
}

// ── Claimed this year ─────────────────────────────────────────────────────────────────────────────
function ClaimedTracker({ used, limit }: { used: number; limit: number }) {
  return (
    <div className="space-y-2">
      <div>
        <h2 className="font-display text-2xl text-forest">Claimed this year</h2>
        <div className="text-xs text-ink-3">Your logged activity, against this period's cover</div>
      </div>
      {used <= 0 ? (
        <div className="rounded-2xl border border-dashed border-line px-5 py-6 text-center">
          <div className="font-display text-3xl text-forest">{money(0)} <span className="font-sans text-[15px] font-medium text-ink-3">of {money(limit)} claimed</span></div>
          <div className="mt-1.5 text-[12.5px] text-ink-2">Nothing logged yet — every claim you log appears here and grows this bar.</div>
        </div>
      ) : (
        <div className="rounded-2xl border border-line bg-card px-5 py-5">
          <div className="font-display text-3xl text-forest">{money(used)} <span className="font-sans text-[15px] font-medium text-ink-3">of {money(limit)} claimed</span></div>
          <Meter frac={limit > 0 ? Math.min(1, used / limit) : 0} className="bg-green" />
        </div>
      )}
    </div>
  );
}

// ── Manage (collapsed) ────────────────────────────────────────────────────────────────────────────
function ManageSection({ d, onChange, onWithdraw }: { d: PhiOverview; onChange: () => void; onWithdraw: () => void }) {
  const scan = useMutation({
    mutationFn: () => api.phiScan(),
    onSuccess: (r) => { toast.success(`Checked — ${r.resets} reminder${r.resets === 1 ? "" : "s"}${r.setups ? `, ${r.setups} to set up` : ""}`); onChange(); },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <details id="phi-manage" className="group rounded-2xl border border-line bg-card" open={d.policies.length === 0}>
      <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4">
        <span className="font-display text-xl text-forest">Manage policies &amp; limits</span>
        <span className="text-xs text-ink-3 group-open:hidden">Set up your fund, edit limits, settings ›</span>
      </summary>
      <div className="space-y-5 border-t border-line px-5 py-5">
        <div className="grid gap-4 lg:grid-cols-2">
          <AutoSetupForm onDone={onChange} />
          <AddPolicyForm onDone={onChange} />
        </div>

        {d.policies.map((p) => <PolicyManageCard key={p.id} p={p} options={d.category_options} onChange={onChange} />)}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <Button variant="ghost" className="h-9 px-4 text-xs uppercase tracking-wide" onClick={() => scan.mutate()} disabled={scan.isPending}>{scan.isPending ? "Checking…" : "Check reminders"}</Button>
          <button className="text-xs text-ink-3 underline hover:text-danger" onClick={onWithdraw}>Stop tracking &amp; withdraw consent</button>
        </div>
        <p className="text-xs text-ink-3">{d.disclaimer} Extras tracking is general information to help you use your own cover — it is not health or financial advice, and it does not change your tax position. You can stop tracking anytime; your data is kept until you delete it in Settings → Privacy.</p>
      </div>
    </details>
  );
}

// Per-policy management: edit details, add limits, delete. (The day-to-day view lives in All categories.)
function PolicyManageCard({ p, options, onChange }: { p: PhiPolicyView; options: { value: string; label: string }[]; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const del = useMutation({ mutationFn: () => api.phiDeletePolicy(p.id), onSuccess: onChange, onError: (e) => toast.error((e as Error).message) });
  const confirmAll = useMutation({ mutationFn: () => api.phiConfirm(p.id), onSuccess: () => { toast.success("Limits confirmed"); onChange(); }, onError: (e) => toast.error((e as Error).message) });
  const coverLabel = COVER_TYPES.find((c) => c.v === p.cover_type)?.l ?? null;
  const unverified = p.categories.filter((c) => c.verified === 0).length;
  return (
    <div className="space-y-3 rounded-xl border border-line bg-paper p-4">
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
          <span className="text-ink-2">{unverified} pre-filled limit{unverified === 1 ? "" : "s"} to check against your fund's app.</span>
          <Button className="h-8 shrink-0 px-3 text-xs uppercase tracking-wide" onClick={() => confirmAll.mutate()} disabled={confirmAll.isPending}>{confirmAll.isPending ? "…" : "Confirm all"}</Button>
        </div>
      )}
      <LimitForm policyId={p.id} options={options} onDone={onChange} />
    </div>
  );
}

function EmptyState() {
  return (
    <Panel className="text-sm text-ink-2">
      No policies yet. The quickest way: <strong>auto-fill from your fund</strong> in <em>Manage policies</em> below — pick your product and we pre-fill the standard limits for you to confirm. Then add what you've used, and Quillo tracks what's unused before your <Term k="phi_reset_basis">limits reset</Term>.
    </Panel>
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

// ── Provider finder (v2 layout: bigger map, distance chips, Call/Website/Directions, log-claim CTA) ──
// Flag OFF ⇒ today's exact static Healthdirect link. Flag ON ⇒ opt-in: device location (coarsened to
// ~1km) or a 4-digit postcode → a FACTUAL list of nearby providers (no ranking/commission/fund-status).
type SearchTarget = { lat: number; lng: number } | { postcode: string };
type GeoState = "idle" | "locating" | "denied" | "unsupported";

function ProviderFinder({ category, providerTerm, onLogClaim }: { category: string; providerTerm: string; onLogClaim?: () => void }) {
  const { has } = useFeatures();
  const [open, setOpen] = useState(false);
  const [postcode, setPostcode] = useState("");
  const [target, setTarget] = useState<SearchTarget | null>(null);
  const [nonce, setNonce] = useState(0); // bumped on each explicit search → forces a refetch even for an identical target
  const [geo, setGeo] = useState<GeoState>("idle");
  const valid = /^\d{4}$/.test(postcode);

  const q = useQuery({
    queryKey: ["phi-providers", category, target, nonce],
    queryFn: () => (target && "postcode" in target
      ? api.phiProviders(category, { postcode: target.postcode })
      : api.phiProviders(category, { lat: (target as { lat: number }).lat, lng: (target as { lng: number }).lng })),
    enabled: !!target,
    staleTime: 600_000, // 10min in-memory only (no persisted cache — Google ToS)
  });

  // Ask the device for location — coordinates coarsened to ~1km (2dp) BEFORE they leave the device.
  const locate = () => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) { setGeo("unsupported"); return; }
    setGeo("locating");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Math.round(pos.coords.latitude * 100) / 100;
        const lng = Math.round(pos.coords.longitude * 100) / 100;
        setGeo("idle");
        setTarget({ lat, lng });
        setNonce((n) => n + 1);
      },
      () => setGeo("denied"),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600_000 },
    );
  };
  const searchPostcode = () => { if (!valid) return; setTarget({ postcode }); setNonce((n) => n + 1); };

  if (!has("phi_provider_directory")) {
    return (
      <a href={HEALTHDIRECT_FINDER_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-forest underline">
        Find a {providerTerm} near you ↗
      </a>
    );
  }

  if (!open) {
    return (
      <Button className="h-9 px-4 text-xs uppercase tracking-wide" onClick={() => { setOpen(true); locate(); }}>
        Find a {providerTerm} near you
      </Button>
    );
  }

  const res = q.data;
  const providers = res?.providers ?? [];
  const finderUrl = res?.finder_url ?? HEALTHDIRECT_FINDER_URL;
  const empty = q.isSuccess && providers.length === 0;
  const center = res?.center ?? null;
  const usingLocation = !!target && !("postcode" in target);
  const locationLabel = usingLocation ? "your area" : (target && "postcode" in target ? target.postcode : "");
  const allInMapsUrl = center
    ? `https://www.google.com/maps/search/${encodeURIComponent(providerTerm)}/@${center.lat},${center.lng},12z`
    : mapsSearchUrl(`${providerTerm} near ${locationLabel} Australia`);

  return (
    <div className="w-full overflow-hidden rounded-2xl border border-line bg-paper text-ink-2">
      <div className="flex flex-wrap items-end gap-2 p-3">
        <label className="min-w-0 flex-1 text-xs font-semibold text-ink-3">
          Postcode or suburb
          <Input
            className="mt-1 w-full"
            inputMode="numeric"
            maxLength={4}
            value={postcode}
            placeholder="e.g. 2000"
            onChange={(e) => setPostcode(e.target.value.replace(/\D/g, "").slice(0, 4))}
            onKeyDown={(e) => { if (e.key === "Enter") searchPostcode(); }}
          />
        </label>
        <Button className="h-9 shrink-0 px-4 text-xs uppercase tracking-wide" onClick={searchPostcode} disabled={!valid || q.isFetching}>
          {q.isFetching ? "Searching…" : "Search"}
        </Button>
        <button type="button" className="h-9 shrink-0 self-end px-2 text-xs text-ink-3 underline hover:text-ink" onClick={() => setOpen(false)}>Close</button>
      </div>

      <div className="px-3 pb-1">
        <button type="button" onClick={locate} disabled={geo === "locating"} className="inline-flex items-center gap-1 text-xs font-semibold text-forest underline disabled:no-underline disabled:text-ink-3">
          📍 {geo === "locating" ? "Finding your location…" : "Use my location"}
        </button>
        {geo === "denied" && <span className="ml-2 text-xs text-ink-3">Couldn't access your location — enter a postcode.</span>}
        {geo === "unsupported" && <span className="ml-2 text-xs text-ink-3">Location isn't available here — enter a postcode.</span>}
        {usingLocation && q.isSuccess && <span className="ml-2 text-xs text-ink-3">Showing results near you.</span>}
      </div>

      {q.isError && (
        <p className="px-3 py-2 text-xs text-ink-2">
          {(q.error as Error)?.message || "Couldn't search just now."}{" "}
          <a href={allInMapsUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-forest underline">Open in Maps ↗</a>
          {" · "}
          <a href={finderUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-forest underline">Healthdirect ↗</a>
        </p>
      )}

      {q.isSuccess && providers.length > 0 && (
        <>
          {res?.embed_key && (
            // Full-bleed interactive map, centred on the SAME point the list was biased to.
            <div className="relative mt-1">
              <iframe
                title={`Map of nearby ${providerTerm}s`}
                className="h-64 w-full border-y border-line"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                allowFullScreen
                src={center
                  ? `https://www.google.com/maps/embed/v1/search?key=${res.embed_key}&q=${encodeURIComponent(providerTerm)}&center=${center.lat},${center.lng}&zoom=12`
                  : `https://www.google.com/maps/embed/v1/search?key=${res.embed_key}&q=${encodeURIComponent(`${providerTerm} near ${locationLabel} Australia`)}`}
              />
              <a href={allInMapsUrl} target="_blank" rel="noopener noreferrer" className="absolute bottom-2 right-2 rounded-lg bg-card/90 px-3 py-1.5 text-[11.5px] font-semibold text-green">Open in Maps ↗</a>
            </div>
          )}
          <p className="px-3 pt-3 text-xs text-ink-3"><strong className="text-ink-2">Confirm they accept your fund</strong> before booking. Quillo earns nothing from these listings — no paid placement.</p>
          <ul className="space-y-2 p-3">
            {providers.map((pv, i) => <ProviderRow key={`${pv.name}-${i}`} pv={pv} center={center} />)}
          </ul>
          {onLogClaim && (
            <div className="px-3 pb-3">
              <div className="flex items-center justify-between gap-3 rounded-2xl bg-surface px-4 py-3">
                <div>
                  <div className="text-sm font-bold text-ink">Been already?</div>
                  <div className="text-xs text-ink-2">Log a claim to track your balance</div>
                </div>
                <Button className="h-9 shrink-0 px-4 text-xs uppercase tracking-wide" onClick={onLogClaim}>Log claim</Button>
              </div>
            </div>
          )}
        </>
      )}

      {empty && (
        <div className="m-3 rounded-lg border border-sage/40 bg-sage/10 px-3 py-2.5 text-xs text-ink-2">
          We couldn't list {providerTerm}s for {locationLabel}. Open a live map search instead:{" "}
          <a href={allInMapsUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-forest underline">Open in Maps ↗</a>
          {" · "}
          <a href={finderUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-forest underline">Healthdirect ↗</a>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-[11px] text-ink-3">
        <a href={res?.attribution?.href ?? "https://www.google.com"} target="_blank" rel="noopener noreferrer" className="underline hover:text-ink">
          {res?.attribution?.text ?? "Powered by Google"}
        </a>
        {q.isSuccess && providers.length > 0 && (
          <a href={finderUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-ink">Healthdirect ↗</a>
        )}
      </div>
    </div>
  );
}

function ProviderRow({ pv, center }: { pv: PhiProvider; center: { lat: number; lng: number } | null }) {
  const dirUrl = mapsDirectionsUrl([pv.name, pv.address].filter(Boolean).join(" "));
  const km = center ? haversineKm(center, pv) : null;
  return (
    <li className="rounded-2xl border border-line bg-card px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-bold text-ink">{pv.name}</div>
          {pv.address && <div className="mt-0.5 text-xs text-ink-3">{pv.address}</div>}
        </div>
        {km != null && <span className="shrink-0 rounded-md bg-surface px-2 py-1 text-[11px] font-semibold text-ink-2">{formatKm(km)}</span>}
      </div>
      <div className="mt-3 flex gap-2">
        {pv.phone
          ? <a href={`tel:${pv.phone.replace(/\s/g, "")}`} className="flex-1 rounded-xl bg-forest py-2.5 text-center text-[12.5px] font-semibold text-cream">Call</a>
          : <span className="flex-1 rounded-xl bg-surface py-2.5 text-center text-[12.5px] font-semibold text-ink-3">No phone</span>}
        {pv.website && <a href={pv.website} target="_blank" rel="noopener noreferrer" className="flex-1 rounded-xl bg-surface py-2.5 text-center text-[12.5px] font-semibold text-green">Website</a>}
        <a href={dirUrl} target="_blank" rel="noopener noreferrer" className="flex-1 rounded-xl bg-surface py-2.5 text-center text-[12.5px] font-semibold text-green">Directions</a>
      </div>
    </li>
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
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
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

// Record a benefit used. `prefill` seeds the form (from a category row, or — Phase 3 — a scanned receipt).
function UsageForm({ policyId, options, onDone, prefill }: { policyId: string; options: { value: string; label: string }[]; onDone: () => void; prefill?: { category?: string; amount?: string; usedOn?: string } }) {
  const [category, setCategory] = useState(prefill?.category ?? options[0]?.value ?? "physiotherapy");
  const [amount, setAmount] = useState(prefill?.amount ?? "");
  const [usedOn, setUsedOn] = useState(prefill?.usedOn ?? "");
  const parsed = parseFloat(amount);
  const valid = Number.isFinite(parsed) && parsed > 0;
  const save = useMutation({
    mutationFn: () => api.phiRecordUsage({ policy_id: policyId, category, amount_used_cents: Math.round(parsed * 100), used_on: usedOn || null }),
    onSuccess: () => { setAmount(""); setUsedOn(""); onDone(); },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="rounded-xl border border-line bg-card p-4">
      <div className="text-xs font-bold uppercase tracking-wide text-ink-3">Log a claim</div>
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-sm">Category
          <select className={SELECT_CLS} value={category} onChange={(e) => setCategory(e.target.value)}>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="text-sm">Benefit used ($) <InfoTip k="phi_benefit_used" />
          <Input className="mt-1 w-full" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="80" />
        </label>
        <label className="text-sm sm:col-span-2">Date (optional)
          <Input className="mt-1 w-full" type="date" value={usedOn} onChange={(e) => setUsedOn(e.target.value)} />
        </label>
      </div>
      <p className="mt-1 text-xs text-ink-3">Enter the rebate your fund paid back, not the full amount you paid the clinic.</p>
      <Button className="mt-3 h-9 px-4 text-xs uppercase tracking-wide" onClick={() => save.mutate()} disabled={save.isPending || !valid}>
        {save.isPending ? "Saving…" : "Record claim"}
      </Button>
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
  if (!open) return <Button variant="ghost" className="h-9 px-4 text-xs uppercase tracking-wide" onClick={() => setOpen(true)}>+ Add a policy manually</Button>;
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
