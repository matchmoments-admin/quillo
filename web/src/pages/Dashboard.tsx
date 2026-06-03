import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { api } from "../api";
import { Card, Spinner, Button, money, BUCKET_LABEL } from "../components/ui";
import type { ChecklistItem } from "../types";

const FEATURE_LABEL: Record<string, string> = {
  receipt: "Receipts",
  text: "Typed expenses",
  statement_columns: "Statement column-map",
  statement_pdf: "PDF statements",
  statement_batch: "Statement categorisation",
};
const cents = (c: number) => `$${(c / 100).toFixed(c < 100 ? 4 : 2)}`;

export function Dashboard() {
  const { data, isLoading, error } = useQuery({ queryKey: ["dashboard"], queryFn: () => api.dashboard() });
  const usage = useQuery({ queryKey: ["usage"], queryFn: () => api.usage() });
  if (isLoading) return <Spinner />;
  if (error) return <Card className="p-6 text-sm text-muted">Couldn't load: {(error as Error).message}</Card>;
  const d = data!;
  const total = d.by_bucket.reduce((s, b) => s + b.total_cents, 0);
  const u = usage.data;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Tracked total" value={money(total)} />
        <Stat label="Needs review" value={String(d.needs_review)} tone={d.needs_review ? "warn" : "safe"} to="/" />
        <Stat label="Buckets used" value={String(d.by_bucket.length)} />
      </div>

      <ChecklistCard />
      <ClaimsCard />

      <Card className="divide-y divide-line">
        <SectionTitle>By bucket</SectionTitle>
        {d.by_bucket.length ? (
          d.by_bucket.map((b) => <Line key={b.bucket} k={BUCKET_LABEL[b.bucket] ?? b.bucket} n={b.n} v={money(b.total_cents)} />)
        ) : (
          <Empty />
        )}
      </Card>

      {d.income_by_bucket.length > 0 && (
        <Card className="divide-y divide-line">
          <SectionTitle>Income (from bank credits)</SectionTitle>
          {d.income_by_bucket.map((b) => (
            <Line key={b.bucket} k={BUCKET_LABEL[b.bucket] ?? b.bucket} n={b.n} v={money(b.total_cents)} />
          ))}
        </Card>
      )}

      <Card className="divide-y divide-line">
        <SectionTitle>By property</SectionTitle>
        {d.by_property.length ? (
          d.by_property.map((p) => <Line key={p.property_id} k={p.label ?? p.property_id} n={p.n} v={money(p.total_cents)} />)
        ) : (
          <Empty />
        )}
      </Card>

      {u && (
        <Card className="divide-y divide-line">
          <SectionTitle>AI cost (measured)</SectionTitle>
          <div className="flex items-center justify-between px-4 py-2.5 text-sm">
            <span className="text-muted">Today</span>
            <span className="font-medium tabular-nums">{cents(u.today_cents)}</span>
          </div>
          <div className="flex items-center justify-between px-4 py-2.5 text-sm">
            <span className="text-muted">This month · {u.calls} calls</span>
            <span className="font-medium tabular-nums">{cents(u.month_cents)}</span>
          </div>
          {u.by_feature.map((f) => (
            <Line key={f.feature ?? "?"} k={FEATURE_LABEL[f.feature ?? ""] ?? f.feature ?? "—"} n={f.calls} v={cents(f.cost_cents)} />
          ))}
        </Card>
      )}

      <p className="text-sm text-muted">
        Year-end totals + BAS quarters are on the <Link to="/reports" className="text-ink underline underline-offset-2">Reports</Link> page.
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
  return (
    <Card className="divide-y divide-line">
      <div className="flex items-center justify-between px-4 py-2.5">
        <SectionTitle>This year's checklist {items.length ? `· ${open.length} open` : ""}</SectionTitle>
        <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => gen.mutate()} disabled={gen.isPending}>
          {gen.isPending ? "…" : items.length ? "Refresh" : "Generate"}
        </Button>
      </div>
      {isLoading ? (
        <div className="px-4 py-4"><Spinner /></div>
      ) : !items.length ? (
        <div className="px-4 py-4 text-sm text-muted">Generate a checklist tailored to your situation (rental, company, super, investments).</div>
      ) : (
        items.map((i) => (
          <div key={i.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={i.status === "done"} onChange={(e) => setStatus.mutate({ id: i.id, status: e.target.checked ? "done" : "open" })} />
              <span className={i.status !== "open" ? "text-muted line-through" : ""}>
                {i.title}
                {i.due_hint ? <span className="ml-2 rounded-full bg-surface px-2 py-0.5 text-xs text-muted">{i.due_hint}</span> : null}
                {i.rationale ? <span className="mt-0.5 block text-xs text-muted">{i.rationale}</span> : null}
              </span>
            </label>
            {i.status === "open" && (
              <button className="flex-none text-xs text-muted hover:underline" onClick={() => setStatus.mutate({ id: i.id, status: "dismissed" })}>dismiss</button>
            )}
          </div>
        ))
      )}
    </Card>
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
    <Card className="divide-y divide-line">
      <SectionTitle>Claim guidance · {open.length}</SectionTitle>
      {open.slice(0, 6).map((c) => (
        <div key={c.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
          <span>
            {c.suggestion}
            {c.claim_type ? <span className="ml-2 rounded-full bg-surface px-2 py-0.5 text-xs text-muted">{c.claim_type}</span> : null}
          </span>
          <div className="flex flex-none gap-2 text-xs">
            <button className="text-safe hover:underline" onClick={() => setStatus.mutate({ id: c.id, status: "accepted" })}>keep</button>
            <button className="text-muted hover:underline" onClick={() => setStatus.mutate({ id: c.id, status: "dismissed" })}>dismiss</button>
          </div>
        </div>
      ))}
      <div className="px-4 py-2 text-xs text-muted">General information only — not tax advice.</div>
    </Card>
  );
}

function Stat({ label, value, tone, to }: { label: string; value: string; tone?: "safe" | "warn"; to?: string }) {
  const body = (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "warn" ? "text-warn" : tone === "safe" ? "text-safe" : ""}`}>
        {value}
      </div>
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}
function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted">{children}</div>;
}
function Line({ k, n, v }: { k: string; n: number; v: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span>
        {k} <span className="text-muted">· {n}</span>
      </span>
      <span className="font-medium tabular-nums">{v}</span>
    </div>
  );
}
function Empty() {
  return <div className="px-4 py-4 text-sm text-muted">No data yet.</div>;
}
