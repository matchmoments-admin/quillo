import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import { useActiveFy } from "../lib/activeFy";
import { useFeatures } from "../lib/features";
import { Panel, PanelHead, KpiCard, Pill, Spinner, Button, Input, money } from "../components/ui";
import type { RecurringBill, Opportunity } from "../types";

// A green chart-segment palette cycled across the top-spender rows (matches Dashboard).
const SWATCH = ["#0c3f26", "#15643a", "#1c7a48", "#97a86f", "#2f6bd6", "#9a6712"];

const CADENCE_LABEL: Record<string, string> = {
  weekly: "Weekly", fortnightly: "Fortnightly", monthly: "Monthly",
  quarterly: "Quarterly", annual: "Annual", irregular: "Irregular",
};
const CATEGORY_LABEL: Record<string, string> = {
  energy: "Energy", gas: "Gas", water: "Water", internet: "Internet", mobile: "Mobile",
  insurance: "Insurance", health: "Health", streaming: "Streaming", other: "Other",
};

export function Savings() {
  const { fy, label } = useActiveFy();
  const { has } = useFeatures();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["savings", fy], queryFn: () => api.savings(fy), enabled: has("advisory_layer") });

  const scan = useMutation({
    mutationFn: () => api.savingsScan(),
    onSuccess: (r) => { toast.success(`Scanned — ${r.recurring} recurring, ${r.opportunities} opportunities`); qc.invalidateQueries({ queryKey: ["savings"] }); },
    onError: (e) => toast.error((e as Error).message),
  });
  const dismissOpp = useMutation({ mutationFn: (id: string) => api.dismissOpportunity(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["savings"] }) });
  const dismissBill = useMutation({ mutationFn: (id: string) => api.dismissRecurringBill(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["savings"] }) });
  const confirmBill = useMutation({ mutationFn: (id: string) => api.confirmRecurringBill(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["savings"] }) });

  if (!has("advisory_layer")) return <Panel className="text-sm text-muted">The Savings & Opportunities layer isn't enabled.</Panel>;
  if (isLoading) return <Spinner />;
  if (error) return <Panel className="text-sm text-muted">Couldn't load: {(error as Error).message}</Panel>;
  const d = data!;
  const rr = d.run_rate;
  const yoy = d.yoy;

  const subscriptions = d.recurring_bills.filter((b) => b.is_subscription);
  const bills = d.recurring_bills.filter((b) => !b.is_subscription);
  const annualCommitment = d.recurring_bills.reduce((s, b) => s + (b.annual_amount_cents ?? 0), 0);

  return (
    <div className="space-y-6">
      {/* Topbar */}
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="font-display text-4xl text-forest">Savings</h1>
          <div className="mt-1.5 text-xs font-medium text-ink-3">Your spending, in facts · FY {label}</div>
        </div>
        <span className="flex-1" />
        <Button variant="ghost" className="h-9 px-4 text-xs uppercase tracking-wide" onClick={() => scan.mutate()} disabled={scan.isPending}>
          {scan.isPending ? "Scanning…" : "Re-scan"}
        </Button>
      </div>

      {/* Run-rate KPI row — factual: spent-so-far + at-this-rate annualised. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard variant="feature" label={`Spent so far · FY ${label}`} value={money(rr.spent_cents)} foot={`${rr.items} tracked item${rr.items === 1 ? "" : "s"}`} />
        <KpiCard variant="accent" label="At this rate, a full year" value={money(rr.annualised_cents)} foot="Plain arithmetic from your spend — not a prediction" />
        <KpiCard label="Recurring commitment / year" value={money(annualCommitment)} foot={`${d.recurring_bills.length} recurring payment${d.recurring_bills.length === 1 ? "" : "s"} detected`} />
      </div>

      {/* Year-over-year — factual delta vs the prior FY, no commentary. */}
      {(yoy.this_cents > 0 || yoy.prior_cents > 0) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-card px-3 py-2 text-sm text-ink-2">
          <span className="font-semibold text-ink">{money(yoy.this_cents)}</span>
          <span className="text-ink-3">tracked spend this year vs</span>
          <span className="font-semibold text-ink">{money(yoy.prior_cents)}</span>
          <span className="text-ink-3">last year</span>
          {yoy.delta_pct != null && (
            <Pill tone={yoy.delta_cents > 0 ? "warn" : "ok"}>
              {yoy.delta_cents >= 0 ? "+" : "−"}{money(Math.abs(yoy.delta_cents))} ({yoy.delta_pct >= 0 ? "+" : ""}{yoy.delta_pct}%)
            </Pill>
          )}
        </div>
      )}

      {/* Opportunities — factual nudges; each dismissible; signpost to government comparators only. */}
      {d.opportunities.length > 0 && (
        <Panel>
          <PanelHead title="Worth a look" sub="General information — you decide and start anything yourself" />
          <div className="space-y-3">
            {d.opportunities.map((o: Opportunity) => (
              <div key={o.id} className="rounded-xl border border-line bg-paper px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-ink">{o.title}</span>
                      {o.category ? <Pill tone="info">{CATEGORY_LABEL[o.category] ?? o.category}</Pill> : null}
                    </div>
                    <p className="mt-1 text-sm text-ink-2">{o.body}</p>
                    {o.signpost_url ? (
                      <a href={o.signpost_url} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-block text-sm font-semibold text-forest underline">
                        {o.signpost_label} →
                      </a>
                    ) : null}
                  </div>
                  <button className="shrink-0 text-xs text-ink-3 underline hover:text-ink" onClick={() => dismissOpp.mutate(o.id)}>Dismiss</button>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* Top spenders — annualised per biller/merchant (the "yearly wake-up figure"). */}
      <Panel>
        <PanelHead title="Where it goes" sub={`Top spend this FY · annualised at your current rate`} />
        {rr.top_spenders.length === 0 ? (
          <p className="text-sm text-muted">No tracked spend for FY {label} yet. Import statements in Accounts to populate this.</p>
        ) : (
          <div className="space-y-2">
            {rr.top_spenders.map((s, i) => (
              <div key={s.label + i} className="flex items-center gap-3 py-1.5">
                <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: SWATCH[i % SWATCH.length] }} />
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{s.label}</span>
                <span className="text-xs text-ink-3">{s.n}×</span>
                <span className="w-24 text-right text-sm font-semibold tnum text-ink">{money(s.spent_cents)}</span>
                <span className="w-28 text-right text-xs tnum text-ink-3">~{money(s.annualised_cents)}/yr</span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Recurring bills + subscriptions, split. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <RecurringPanel title="Subscriptions" sub="Fixed-amount, recurring" items={subscriptions} onDismiss={(id) => dismissBill.mutate(id)} onConfirm={(id) => confirmBill.mutate(id)} />
        <RecurringPanel title="Bills" sub="Usage-based, recurring" items={bills} onDismiss={(id) => dismissBill.mutate(id)} onConfirm={(id) => confirmBill.mutate(id)} />
      </div>

      {/* Savings calculator — factual "set aside $X/year" arithmetic (no product, no investing). */}
      <SavingsCalculator defaultAnnualCents={rr.top_spenders[0]?.annualised_cents ?? 0} />

      <p className="text-xs text-ink-3">{d.disclaimer}</p>
    </div>
  );
}

function RecurringPanel({ title, sub, items, onDismiss, onConfirm }: { title: string; sub: string; items: RecurringBill[]; onDismiss: (id: string) => void; onConfirm: (id: string) => void }) {
  return (
    <Panel>
      <PanelHead title={title} sub={sub} />
      {items.length === 0 ? (
        <p className="text-sm text-muted">None detected yet — we confirm a stream after a few occurrences.</p>
      ) : (
        <div className="space-y-2">
          {items.map((b) => {
            const annual = b.annual_amount_cents ?? 0;
            return (
              <div key={b.id} className="flex items-center gap-3 rounded-xl border border-line bg-paper px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-ink">{b.label ?? b.biller_key}</span>
                    {b.cadence ? <Pill>{CADENCE_LABEL[b.cadence] ?? b.cadence}</Pill> : null}
                    {b.pinned ? <Pill tone="ok">Confirmed</Pill> : b.status === "early" ? <Pill tone="warn">Early</Pill> : null}
                    {b.is_essential ? <Pill tone="info">{CATEGORY_LABEL[b.category ?? "other"] ?? b.category}</Pill> : null}
                  </div>
                  <div className="mt-0.5 text-xs text-ink-3">
                    {money(b.typical_amount_cents)} × {b.occurrences} seen{annual > 0 ? ` · ~${money(annual)}/yr` : ""}
                    {b.next_expected_date ? ` · next ~${b.next_expected_date}` : ""}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {!b.pinned && <button className="text-xs font-semibold text-forest underline" onClick={() => onConfirm(b.id)}>Confirm</button>}
                  <button className="text-xs text-ink-3 underline hover:text-ink" onClick={() => onDismiss(b.id)}>Dismiss</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// Factual savings calculator. Mirrors src/lib/advisory.ts `savingsProjection` (end-of-year annuity)
// — kept tiny + client-side so the slider is instant. NOT investing, NO product, an illustration only.
function savingsProjection(annualCents: number, years: number, ratePct: number) {
  const n = Math.max(0, Math.floor(years));
  const r = Math.max(0, ratePct) / 100;
  const contributed = Math.max(0, Math.round(annualCents)) * n;
  const total = r === 0 ? contributed : Math.round(annualCents * ((Math.pow(1 + r, n) - 1) / r));
  return { contributed, total, interest: Math.max(0, total - contributed) };
}

function SavingsCalculator({ defaultAnnualCents }: { defaultAnnualCents: number }) {
  const [annual, setAnnual] = useState(Math.max(520, Math.round(defaultAnnualCents / 100)) || 1000); // dollars
  const [years, setYears] = useState(5);
  const [rate, setRate] = useState(4.5);
  const p = savingsProjection(Math.round(annual * 100), years, rate);
  return (
    <Panel>
      <PanelHead title="If you set aside…" sub="Factual arithmetic — not advice, no product" />
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-ink-3">Per year ($)</span>
          <Input type="number" min={0} value={annual} onChange={(e) => setAnnual(Math.max(0, Number(e.target.value) || 0))} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-ink-3">For (years)</span>
          <Input type="number" min={1} max={40} value={years} onChange={(e) => setYears(Math.min(40, Math.max(1, Number(e.target.value) || 1)))} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-ink-3">Assumed interest (%)</span>
          <Input type="number" min={0} max={20} step={0.1} value={rate} onChange={(e) => setRate(Math.min(20, Math.max(0, Number(e.target.value) || 0)))} />
        </label>
      </div>
      <div className="mt-4 rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink-2">
        Setting aside <span className="font-semibold text-ink">{money(annual * 100)}</span> a year for{" "}
        <span className="font-semibold text-ink">{years}</span> year{years === 1 ? "" : "s"} is about{" "}
        <span className="font-semibold text-forest">{money(p.total)}</span> ({money(p.contributed)} set aside plus{" "}
        {money(p.interest)} interest at an assumed {rate}%).{" "}
        <a href="https://moneysmart.gov.au/saving/savings-goals-calculator" target="_blank" rel="noopener noreferrer" className="font-semibold text-forest underline">
          ASIC MoneySmart's calculator →
        </a>
      </div>
    </Panel>
  );
}
