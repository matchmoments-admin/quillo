import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useActiveFy } from "../lib/activeFy";
import { Panel, PanelHead, KpiCard, Meter, Pill, Spinner, Button, money, BUCKET_LABEL, InfoTip } from "../components/ui";
import { FindAndAttachSheet } from "../components/FindAndAttachSheet";
import { WorkMethodsCard } from "../components/WorkMethodsCard";
import { CarMethodsCard } from "../components/CarMethodsCard";
import { SetupChecklist } from "../components/SetupChecklist";
import { AskQuillo } from "../components/AskQuillo";
import { useFeatures } from "../lib/features";
import type { ChecklistItem } from "../types";

// A green chart-segment palette cycled across breakdown rows (forest → moss → sage → info).
const SWATCH = ["#0c3f26", "#15643a", "#1c7a48", "#97a86f", "#2f6bd6", "#9a6712"];

export function Dashboard() {
  const { fy, label } = useActiveFy();
  const { has } = useFeatures();
  const { data, isLoading, error } = useQuery({ queryKey: ["dashboard", fy], queryFn: () => api.dashboard(fy) });
  if (isLoading) return <Spinner />;
  if (error) return <Panel className="text-sm text-muted">Couldn't load: {(error as Error).message}</Panel>;
  const d = data!;
  const total = d.by_bucket.reduce((s, b) => s + b.total_cents, 0);
  const income = d.income_by_bucket.reduce((s, b) => s + b.total_cents, 0);

  return (
    <div className="space-y-6">
      {/* Topbar */}
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="font-display text-4xl text-forest">Dashboard</h1>
          <div className="mt-1.5 text-xs font-medium text-ink-3">What you've tracked · FY {label}</div>
        </div>
        <span className="flex-1" />
        <Link to="/reports">
          <Button variant="ghost" className="h-9 px-4 text-xs uppercase tracking-wide">
            Reports
          </Button>
        </Link>
        <Link to="/filing">
          <Button className="h-9 px-4 text-xs uppercase tracking-wide">Handoff</Button>
        </Link>
      </div>

      {/* The all-time "still to sort" backlog is surfaced canonically by the NextActionBar (the active CTA)
          and the JourneySpine "Sort" badge directly above — a third copy here was redundant (#256 follow-up:
          de-duplicate the dashboard chrome), so it's removed. */}

      {/* KPI row — every figure here is scoped to the active FY. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard variant="feature" label="Tracked spend" value={money(total)} foot={`${d.by_bucket.reduce((s, b) => s + b.n, 0)} categorised items · not your tax position`} />
        <KpiCard label="Deduction categories" value={String(d.by_bucket.length)} foot="Categories in use" />
        <KpiCard label="Income tracked" value={money(income)} foot="From bank credits" />
      </div>

      {/* Undated spend belongs to no FY, so it's excluded from the figures above — surface it so the
          per-year totals can be trusted as complete, with a one-click route to add the dates. */}
      {d.undated.n > 0 && (
        <Link
          to="/transactions?undated=true"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-card px-3 py-2 text-sm text-ink-2 shadow-card transition hover:border-ink/40"
        >
          <span className="font-semibold text-ink">{d.undated.n} undated {d.undated.n === 1 ? "item" : "items"}</span>
          <span className="text-ink-3">({money(d.undated.total_cents)}) aren't in any year's totals —</span>
          <span className="font-semibold text-forest">add dates to include them →</span>
        </Link>
      )}

      {/* #246: onboarding-completeness — "bring these in" evidence checklist, derived from the user's
          situation. Near the top so a half-set-up user sees what's missing before working the numbers. */}
      {has("onboarding_checklist") && <SetupChecklist />}

      {/* Savings run-rate — the "yearly wake-up figure" (factual annualisation), links into the Save tab. */}
      {has("advisory_layer") && <RunRateStrip fy={fy} />}

      {/* Ask Quillo — grounded tax Q&A from the user's own ledger. Superseded by the floating bubble:
          show the embedded card ONLY when the bubble is off (a fallback so chat survives if floating_chat
          is ever disabled), so there's never two chats at once. */}
      {has("ask_quillo") && !has("floating_chat") && <AskQuillo />}

      {/* Working-from-home + car: the #1 PAYG claims, captured here on the Position surface (the one
          canonical place — Review no longer carries a second copy). #245: WFH and car are now separate
          tools (car has nothing to do with WFH). */}
      {has("wfh_car_methods") && <WorkMethodsCard fyNum={fy} />}
      {(has("car_methods") || has("car_logbook")) && <CarMethodsCard fyNum={fy} />}

      <ChecklistCard />
      <ClaimsCard />

      {/* Breakdowns */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel>
          <PanelHead title={<>By category <InfoTip k="bucket" /></>} sub={d.by_bucket.length ? `${d.by_bucket.length} categories` : undefined} />
          {d.by_bucket.length ? (
            <div className="divide-y divide-line">
              {d.by_bucket.map((b, i) => (
                <BreakdownRow
                  key={b.bucket}
                  swatch={SWATCH[i % SWATCH.length]}
                  name={BUCKET_LABEL[b.bucket] ?? b.bucket}
                  n={b.n}
                  value={money(b.total_cents)}
                  frac={total ? b.total_cents / total : 0}
                  to={`/transactions?bucket=${encodeURIComponent(b.bucket)}`}
                />
              ))}
            </div>
          ) : (
            <Empty />
          )}
        </Panel>

        <Panel>
          <PanelHead title={<>By property <InfoTip tip="Costs attributed to each investment property, so each one's position is clear at tax time. Whether a cost is claimable is confirmed in your year-end review." /></>} />
          {d.by_property.length ? (
            <div className="divide-y divide-line">
              {d.by_property.map((p, i) => (
                <BreakdownRow
                  key={p.property_id}
                  swatch={SWATCH[i % SWATCH.length]}
                  name={p.label ?? p.property_id}
                  n={p.n}
                  value={money(p.total_cents)}
                  to={`/transactions?property=${encodeURIComponent(p.property_id)}`}
                />
              ))}
            </div>
          ) : (
            <Empty />
          )}
        </Panel>
      </div>

      {d.income_by_bucket.length > 0 && (
        <Panel>
          <PanelHead title={<>Income <InfoTip tip="Money coming in, detected from bank credits and grouped by source. Tracked separately from spending so your income side is complete at year-end." /></>} sub="from bank credits" />
          <div className="divide-y divide-line">
            {d.income_by_bucket.map((b, i) => (
              <BreakdownRow
                key={b.bucket}
                swatch={SWATCH[i % SWATCH.length]}
                name={BUCKET_LABEL[b.bucket] ?? b.bucket}
                n={b.n}
                value={money(b.total_cents)}
                frac={income ? b.total_cents / income : 0}
                to={`/transactions?bucket=${encodeURIComponent(b.bucket)}`}
              />
            ))}
          </div>
        </Panel>
      )}

      <p className="text-sm text-muted">
        Year-end totals, depreciation schedule + BAS quarters are on the Reports page (top right).
      </p>
    </div>
  );
}

function ChecklistCard() {
  const qc = useQueryClient();
  const { label } = useActiveFy();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["checklist", label] });
  const { data, isLoading } = useQuery({ queryKey: ["checklist", label], queryFn: () => api.checklist(label) });
  const gen = useMutation({ mutationFn: () => api.generateChecklist(label), onSuccess: invalidate });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.setChecklistStatus(id, status),
    onSuccess: invalidate,
  });
  const items = (data ?? []) as ChecklistItem[];
  const open = items.filter((i) => i.status === "open");

  // Auto-generate the situation-driven checklist on first visit per FY, so "what's left to do" is the
  // single source of truth on the handoff flow rather than a manual step a user can miss (#76). Safe to
  // re-run — generateChecklist is idempotent (UNIQUE + ON CONFLICT DO NOTHING). The ref bounds it to one
  // attempt per FY per mount so a genuinely empty result can't loop; the manual button stays as a fallback.
  const autoGenFy = useRef<string | null>(null);
  useEffect(() => {
    if (isLoading || items.length || gen.isPending) return;
    if (autoGenFy.current === label) return;
    autoGenFy.current = label;
    gen.mutate();
  }, [isLoading, items.length, label, gen]);

  // Empty → the situation-driven checklist auto-generates on first visit (the effect above), so this is
  // just a quiet placeholder; no manual "Generate" button (the loaded-state "Refresh" covers re-runs).
  if (!isLoading && !items.length) {
    return (
      <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-sage bg-sage px-6 py-5">
        <span className="grid h-11 w-11 flex-none place-items-center rounded-xl bg-forest text-cream">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 6l1.5 1.5L8 5M4 11l1.5 1.5L8 10M4 16l1.5 1.5L8 15M11 6h5M11 11h5M11 16h5" />
          </svg>
        </span>
        <div className="min-w-0">
          <div className="font-display text-lg text-forest">FY {label} checklist</div>
          <div className="text-[13px] text-forest/70">
            {gen.isPending ? "Building a to-do list tailored to your situation…" : "Nothing to do here yet — it'll fill in as you add your situation."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <Panel>
      <PanelHead
        title={`FY ${label} checklist`}
        sub={items.length ? `${open.length} open` : undefined}
        right={
          <Button variant="ghost" className="h-8 px-3 text-xs uppercase tracking-wide" onClick={() => gen.mutate()} disabled={gen.isPending}>
            {gen.isPending ? "…" : "Refresh"}
          </Button>
        }
      />
      {isLoading ? (
        <div className="py-4"><Spinner /></div>
      ) : (
        <div className="divide-y divide-line">
          {items.map((i) => (
            <div key={i.id} className="flex items-start justify-between gap-3 py-3">
              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 accent-green"
                  checked={i.status === "done"}
                  onChange={(e) => setStatus.mutate({ id: i.id, status: e.target.checked ? "done" : "open" })}
                />
                <span className={i.status !== "open" ? "text-muted line-through" : ""}>
                  {i.title}
                  {i.due_hint ? <span className="ml-2 rounded-full bg-surface px-2 py-0.5 text-xs text-muted">{i.due_hint}</span> : null}
                  {i.rationale ? <span className="mt-0.5 block text-xs text-muted">{i.rationale}</span> : null}
                </span>
              </label>
              {i.status === "open" && (
                <button className="flex-none text-xs text-muted hover:underline" onClick={() => setStatus.mutate({ id: i.id, status: "dismissed" })}>
                  dismiss
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function ClaimsCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["claims"], queryFn: () => api.claims() });
  const [evidenceFor, setEvidenceFor] = useState<string | null>(null);
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.setClaimStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["claims"] }),
  });
  // Include 'capturing' (evidence being attached) so a claim doesn't vanish the moment you attach.
  const open = (data ?? []).filter((c) => c.status === "suggested" || c.status === "capturing");
  if (!open.length) return null;
  return (
    <Panel>
      <PanelHead title="Claim guidance" sub={`${open.length}`} />
      <div className="divide-y divide-line">
        {open.slice(0, 6).map((c) => (
          <div key={c.id} className="py-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <span>
                {c.suggestion}
                {c.claim_type ? <span className="ml-2"><Pill tone="info">{c.claim_type}</Pill></span> : null}
                {c.status === "capturing" ? <span className="ml-2"><Pill tone="info">capturing</Pill></span> : null}
              </span>
              <div className="flex flex-none gap-2 text-xs">
                <button className="text-ink hover:underline" onClick={() => setEvidenceFor(evidenceFor === c.id ? null : c.id)}>
                  {evidenceFor === c.id ? "hide" : "find evidence"}
                </button>
                <button className="text-safe hover:underline" onClick={() => setStatus.mutate({ id: c.id, status: "accepted" })}>keep</button>
                <button className="text-muted hover:underline" onClick={() => setStatus.mutate({ id: c.id, status: "dismissed" })}>dismiss</button>
              </div>
            </div>
            {evidenceFor === c.id && <FindAndAttachSheet claimId={c.id} />}
          </div>
        ))}
      </div>
      <div className="pt-3 text-xs text-muted">General information only — not tax advice.</div>
    </Panel>
  );
}

function BreakdownRow({
  swatch,
  name,
  n,
  value,
  frac,
  to,
}: {
  swatch: string;
  name: string;
  n: number;
  value: string;
  frac?: number;
  to?: string; // when set, the row links into the Inbox filtered to this category/property
}) {
  const inner = (
    <>
      <div className="flex items-center justify-between gap-4">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="h-2.5 w-2.5 flex-none rounded" style={{ background: swatch }} />
          <span className="truncate text-sm font-semibold">{name}</span>
          <span className="text-xs text-ink-3">· {n}</span>
        </span>
        <span className="font-semibold tnum">{value}</span>
      </div>
      {frac != null && <Meter frac={frac} />}
    </>
  );
  if (to) {
    return (
      <Link to={to} className="block py-3 transition hover:opacity-70">
        {inner}
      </Link>
    );
  }
  return <div className="py-3">{inner}</div>;
}

function Empty() {
  return <div className="py-4 text-sm text-muted">No data yet.</div>;
}

// Compact run-rate strip (flag advisory_layer): the factual "at this rate, ~$X/year" wake-up figure,
// reusing the shared ["savings", fy] query (the Save page uses the same cache entry). Links into /savings.
function RunRateStrip({ fy }: { fy: number }) {
  const { data } = useQuery({ queryKey: ["savings", fy], queryFn: () => api.savings(fy) });
  const rr = data?.run_rate;
  if (!rr || rr.spent_cents <= 0) return null;
  return (
    <Link
      to="/savings"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-card px-3 py-2 text-sm text-ink-2 shadow-card transition hover:border-ink/40"
    >
      <span className="font-semibold text-ink">{money(rr.spent_cents)} spent so far this year</span>
      <span className="text-ink-3">— at this rate that's about {money(rr.annualised_cents)} across a full year.</span>
      <span className="font-semibold text-forest">See your savings →</span>
    </Link>
  );
}
