import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { useAdminAccess } from "../lib/features";
import { Button, Card, QueryError, Spinner } from "../components/ui";
import type { SecurityDashboard, SecurityPanel, SecurityPanelStatus } from "../types";

// Security & compliance (#636): one admin-only page the owner can show Fiskil (or print to PDF).
// The server enforces the admin role (non-admins get a 404); this page only renders what it returns —
// counts, ids and timestamps, never customer content. Live checks run on demand ("Run checks now")
// or daily from the cron, and only while the `security_monitoring` flag is ON.

const STATUS: Record<SecurityPanelStatus, { glyph: string; label: string; cls: string }> = {
  ok: { glyph: "✅", label: "In place", cls: "bg-safe/10 text-safe" },
  warn: { glyph: "🟡", label: "Needs attention", cls: "bg-warn/10 text-warn" },
  fail: { glyph: "❌", label: "Failing", cls: "bg-danger/10 text-danger" },
  not_set_up: { glyph: "⬜", label: "Not yet set up", cls: "bg-surface text-muted" },
  not_checked: { glyph: "⬜", label: "Not checked yet", cls: "bg-surface text-muted" },
};

export function SecurityCompliance() {
  const { isAdmin, loaded } = useAdminAccess();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "security"], queryFn: () => api.adminSecurity(), enabled: isAdmin });
  const run = useMutation({
    mutationFn: () => api.runSecurityChecks(),
    onSuccess: (d) => {
      qc.setQueryData(["admin", "security"], d);
      toast.success("Checks complete");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (loaded && !isAdmin) return <Card className="p-6 text-sm text-muted">Not available.</Card>;
  if (!loaded || q.isLoading) return <Spinner />;
  if (q.isError || !q.data) return <QueryError error={q.error} onRetry={() => q.refetch()} what="the security dashboard" />;
  const d: SecurityDashboard = q.data;
  const counts = d.panels.reduce<Record<string, number>>((acc, p) => ({ ...acc, [p.status]: (acc[p.status] ?? 0) + 1 }), {});

  return (
    <div className="space-y-6" data-print-root>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted" data-print-hide>
            <Link to="/admin" className="hover:text-ink">Admin</Link> / Security &amp; compliance
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Security &amp; compliance</h1>
          <p className="mt-1 text-sm text-muted">
            Quillo's information-security controls and their current status (CDR Rules Schedule 2). Generated {fmtTime(d.generated_at)}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2" data-print-hide>
          <Button variant="ghost" onClick={() => window.print()}>Print / save PDF</Button>
          <Button
            onClick={() => run.mutate()}
            disabled={!d.monitoring_enabled || run.isPending}
            title={d.monitoring_enabled ? undefined : "Turn on the security_monitoring flag to run live checks"}
          >
            {run.isPending ? "Running checks…" : "Run checks now"}
          </Button>
        </div>
      </div>

      <Card className="flex flex-wrap items-center gap-x-5 gap-y-2 p-4 text-sm">
        {(["ok", "warn", "fail", "not_set_up", "not_checked"] as const).filter((s) => counts[s]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span aria-hidden>{STATUS[s].glyph}</span>
            <span className="font-semibold tabular-nums">{counts[s]}</span>
            <span className="text-muted">{STATUS[s].label.toLowerCase()}</span>
          </span>
        ))}
        <span className="flex-1" />
        <span className="text-xs text-muted">
          Live checks: {d.last_check_at ? `last run ${fmtTime(d.last_check_at)} (${d.last_check_trigger === "schedule" ? "scheduled" : "manual"})` : "not run yet"}
          {" · "}
          {d.monitoring_enabled ? "scheduled daily while monitoring is on" : "monitoring is off (no scheduled checks)"}
        </span>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {d.panels.map((p) => <PanelCard key={p.key} p={p} />)}
      </div>

      <p className="text-xs text-muted">
        Counts, identifiers and timestamps only — this page never shows customer content or CDR data. Admin-only, enforced by the server.
      </p>
    </div>
  );
}

function StatusPill({ s }: { s: SecurityPanelStatus }) {
  const v = STATUS[s];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${v.cls}`}>
      <span aria-hidden>{v.glyph}</span>
      {v.label}
    </span>
  );
}

function PanelCard({ p }: { p: SecurityPanel }) {
  const metrics = Object.entries(p.metrics).filter(([, v]) => v !== null && v !== "");
  const wide = (p.rows?.length ?? 0) > 0;
  return (
    <Card className={`break-inside-avoid p-5 ${wide ? "md:col-span-2" : ""}`}>
      <div className="flex flex-wrap items-start gap-2">
        <h2 className="min-w-0 flex-1 text-base font-semibold">{p.title}</h2>
        <StatusPill s={p.status} />
      </div>
      <p className="mt-1.5 text-sm text-ink-2">{p.summary}</p>
      <div className="mt-1 text-xs text-muted">
        {p.checked_at ? `Last checked ${fmtTime(p.checked_at)}` : "Never checked"}
        {p.pending_ticket ? ` · lights up with #${p.pending_ticket}` : ""}
      </div>

      {metrics.length > 0 && (
        <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 border-t border-line pt-3 text-xs sm:grid-cols-2">
          {metrics.map(([k, v]) => (
            <div key={k} className="flex min-w-0 justify-between gap-2">
              <dt className="truncate text-muted">{humanKey(k)}</dt>
              <dd className="truncate text-right font-medium tabular-nums">{fmtMetric(k, v)}</dd>
            </div>
          ))}
        </dl>
      )}

      {wide && (
        <div className="mt-3 overflow-x-auto border-t border-line pt-3">
          <table className="w-full text-xs">
            <tbody>
              {p.rows!.map((r) => (
                <tr key={`${r.id}-${r.label}`} className="border-t border-line first:border-t-0 align-top">
                  <td className="w-6 py-1.5 pr-2" aria-label={r.status}>{r.status === "ok" ? "✅" : r.status === "warn" ? "🟡" : "⬜"}</td>
                  <td className="py-1.5 pr-3 font-medium">{r.id}</td>
                  <td className="py-1.5 pr-3">{r.label}</td>
                  <td className="py-1.5 text-muted">{r.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {p.evidence.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <span className="text-muted">Evidence:</span>
          {p.evidence.map((e) => (
            <a key={e.href + e.label} href={e.href} target="_blank" rel="noreferrer" className="text-forest underline underline-offset-2 hover:text-ink">
              {e.label}
            </a>
          ))}
        </div>
      )}
    </Card>
  );
}

const fmtTime = (iso: string) => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
};

const humanKey = (k: string) => {
  const s = k.replace(/_/g, " ").replace(/\b7d\b/, "(7 days)").replace(/\b30d\b/, "(30 days)").replace(/\b48h\b/, "(48 hours)");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function fmtMetric(k: string, v: number | string | boolean | null): string {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    if (k === "size_bytes") return v >= 1048576 ? `${(v / 1048576).toFixed(1)} MB` : `${Math.round(v / 1024)} KB`;
    if (/_open$/.test(k) && v >= 100) return "100+";
    return v.toLocaleString("en-AU");
  }
  if (typeof v === "string" && /_at$/.test(k)) return fmtTime(v);
  return String(v ?? "—");
}
