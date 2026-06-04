import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Panel, PanelHead, KpiCard, Meter, Pill, Spinner, Button, money, BUCKET_LABEL, InfoTip } from "../components/ui";
import type { ChecklistItem } from "../types";

const FEATURE_LABEL: Record<string, string> = {
  receipt: "Receipts",
  text: "Typed expenses",
  statement_columns: "Statement column-map",
  statement_pdf: "PDF statements",
  statement_batch: "Statement categorisation",
};
const cents = (c: number) => `$${(c / 100).toFixed(c < 100 ? 4 : 2)}`;

// A green chart-segment palette cycled across breakdown rows (forest → moss → sage → info).
const SWATCH = ["#0c3f26", "#15643a", "#1c7a48", "#97a86f", "#2f6bd6", "#9a6712"];

export function Dashboard() {
  const { data, isLoading, error } = useQuery({ queryKey: ["dashboard"], queryFn: () => api.dashboard() });
  const usage = useQuery({ queryKey: ["usage"], queryFn: () => api.usage() });
  if (isLoading) return <Spinner />;
  if (error) return <Panel className="text-sm text-muted">Couldn't load: {(error as Error).message}</Panel>;
  const d = data!;
  const total = d.by_bucket.reduce((s, b) => s + b.total_cents, 0);
  const income = d.income_by_bucket.reduce((s, b) => s + b.total_cents, 0);
  const u = usage.data;

  return (
    <div className="space-y-6">
      {/* Topbar */}
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="font-display text-4xl text-forest">Dashboard</h1>
          <div className="mt-1.5 text-xs font-medium text-ink-3">Your tracked tax position · across all records</div>
        </div>
        <span className="flex-1" />
        <Link to="/reports">
          <Button variant="ghost" className="h-9 px-4 text-xs uppercase tracking-wide">
            Reports
          </Button>
        </Link>
        <Link to="/filing">
          <Button className="h-9 px-4 text-xs uppercase tracking-wide">File</Button>
        </Link>
      </div>

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard variant="feature" label="Tracked total" value={money(total)} foot={`${d.by_bucket.reduce((s, b) => s + b.n, 0)} categorised items`} />
        <Link to="/">
          <KpiCard
            variant="accent"
            label="Needs review"
            value={String(d.needs_review)}
            foot={d.needs_review ? "Open the inbox to clear them" : "All caught up"}
          />
        </Link>
        <KpiCard label="Deduction buckets" value={String(d.by_bucket.length)} foot="Categories in use" />
        <KpiCard label="Income tracked" value={money(income)} foot="From bank credits" />
      </div>

      <ChecklistCard />
      <ClaimsCard />

      {/* Breakdowns */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel>
          <PanelHead title={<>By bucket <InfoTip k="bucket" /></>} sub={d.by_bucket.length ? `${d.by_bucket.length} categories` : undefined} />
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
              />
            ))}
          </div>
        </Panel>
      )}

      {u && (
        <Panel>
          <PanelHead title={<>AI cost <InfoTip k="ai_cost" /></>} sub="measured" />
          <div className="divide-y divide-line">
            <SimpleRow k="Today" v={cents(u.today_cents)} />
            <SimpleRow k={`This month · ${u.calls} calls`} v={cents(u.month_cents)} />
            {u.by_feature.map((f) => (
              <SimpleRow key={f.feature ?? "?"} k={FEATURE_LABEL[f.feature ?? ""] ?? f.feature ?? "—"} sub={`${f.calls}`} v={cents(f.cost_cents)} />
            ))}
          </div>
          {u.by_fy.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">
                By financial year{u.markup_pct > 0 ? ` · billable incl. ${u.markup_pct}% fee` : ""}
              </div>
              <div className="divide-y divide-line">
                {u.by_fy.map((f) => (
                  <SimpleRow
                    key={f.fy}
                    k={`FY ${f.fy}`}
                    sub={`${f.calls} calls · ${cents(f.cost_cents)} cost`}
                    v={cents(f.billable_cents)}
                  />
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">
                Billable = measured AI cost{u.markup_pct > 0 ? ` + ${u.markup_pct}%` : ""}
                {u.app_fee_cents > 0 ? ` + ${cents(u.app_fee_cents)} fee` : ""}. Shown for transparency — not yet charged.
              </p>
            </div>
          )}
        </Panel>
      )}

      <p className="text-sm text-muted">
        Year-end totals, depreciation schedule + BAS quarters are on the{" "}
        <Link to="/reports" className="text-ink underline underline-offset-2">
          Reports
        </Link>{" "}
        page.
      </p>
    </div>
  );
}

function ChecklistCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["checklist"], queryFn: () => api.checklist() });
  const gen = useMutation({ mutationFn: () => api.generateChecklist(), onSuccess: () => qc.invalidateQueries({ queryKey: ["checklist"] }) });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.setChecklistStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["checklist"] }),
  });
  const items = (data ?? []) as ChecklistItem[];
  const open = items.filter((i) => i.status === "open");

  // Empty / not-yet-generated → the sage "checklist strip" CTA from the design.
  if (!isLoading && !items.length) {
    return (
      <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-sage bg-sage px-6 py-5">
        <span className="grid h-11 w-11 flex-none place-items-center rounded-xl bg-forest text-cream">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 6l1.5 1.5L8 5M4 11l1.5 1.5L8 10M4 16l1.5 1.5L8 15M11 6h5M11 11h5M11 16h5" />
          </svg>
        </span>
        <div className="min-w-0">
          <div className="font-display text-lg text-forest">This year's checklist</div>
          <div className="text-[13px] text-forest/70">A to-do list tailored to your situation — rental, company, super &amp; investments.</div>
        </div>
        <span className="flex-1" />
        <Button onClick={() => gen.mutate()} disabled={gen.isPending}>
          {gen.isPending ? "Generating…" : "Generate"}
        </Button>
      </div>
    );
  }

  return (
    <Panel>
      <PanelHead
        title="This year's checklist"
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
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.setClaimStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["claims"] }),
  });
  const open = (data ?? []).filter((c) => c.status === "suggested");
  if (!open.length) return null;
  return (
    <Panel>
      <PanelHead title="Claim guidance" sub={`${open.length}`} />
      <div className="divide-y divide-line">
        {open.slice(0, 6).map((c) => (
          <div key={c.id} className="flex items-start justify-between gap-3 py-3 text-sm">
            <span>
              {c.suggestion}
              {c.claim_type ? <span className="ml-2"><Pill tone="info">{c.claim_type}</Pill></span> : null}
            </span>
            <div className="flex flex-none gap-2 text-xs">
              <button className="text-safe hover:underline" onClick={() => setStatus.mutate({ id: c.id, status: "accepted" })}>keep</button>
              <button className="text-muted hover:underline" onClick={() => setStatus.mutate({ id: c.id, status: "dismissed" })}>dismiss</button>
            </div>
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
}: {
  swatch: string;
  name: string;
  n: number;
  value: string;
  frac?: number;
}) {
  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-4">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="h-2.5 w-2.5 flex-none rounded" style={{ background: swatch }} />
          <span className="truncate text-sm font-semibold">{name}</span>
          <span className="text-xs text-ink-3">· {n}</span>
        </span>
        <span className="font-semibold tnum">{value}</span>
      </div>
      {frac != null && <Meter frac={frac} />}
    </div>
  );
}

function SimpleRow({ k, sub, v }: { k: string; sub?: string; v: string }) {
  return (
    <div className="flex items-center justify-between py-2.5 text-sm">
      <span className="text-muted">
        {k}
        {sub ? <span className="ml-1 text-ink-3">· {sub}</span> : null}
      </span>
      <span className="font-semibold tnum">{v}</span>
    </div>
  );
}

function Empty() {
  return <div className="py-4 text-sm text-muted">No data yet.</div>;
}
