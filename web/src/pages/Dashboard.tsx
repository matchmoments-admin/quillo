import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { api } from "../api";
import { Card, Spinner, money, BUCKET_LABEL } from "../components/ui";

export function Dashboard() {
  const { data, isLoading, error } = useQuery({ queryKey: ["dashboard"], queryFn: () => api.dashboard() });
  if (isLoading) return <Spinner />;
  if (error) return <Card className="p-6 text-sm text-muted">Couldn't load: {(error as Error).message}</Card>;
  const d = data!;
  const total = d.by_bucket.reduce((s, b) => s + b.total_cents, 0);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Tracked total" value={money(total)} />
        <Stat label="Needs review" value={String(d.needs_review)} tone={d.needs_review ? "warn" : "safe"} to="/" />
        <Stat label="Buckets used" value={String(d.by_bucket.length)} />
      </div>

      <Card className="divide-y divide-line">
        <SectionTitle>By bucket</SectionTitle>
        {d.by_bucket.length ? (
          d.by_bucket.map((b) => <Line key={b.bucket} k={BUCKET_LABEL[b.bucket] ?? b.bucket} n={b.n} v={money(b.total_cents)} />)
        ) : (
          <Empty />
        )}
      </Card>

      <Card className="divide-y divide-line">
        <SectionTitle>By property</SectionTitle>
        {d.by_property.length ? (
          d.by_property.map((p) => <Line key={p.property_id} k={p.label ?? p.property_id} n={p.n} v={money(p.total_cents)} />)
        ) : (
          <Empty />
        )}
      </Card>

      <p className="text-sm text-muted">
        Year-end totals + BAS quarters are on the <Link to="/reports" className="text-accent">Reports</Link> page.
      </p>
    </div>
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
