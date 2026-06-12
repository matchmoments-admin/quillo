import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAdminAccess } from "../lib/features";
import { Card, Spinner, money } from "../components/ui";
import { ROLES, ROLE_LABEL, type Role, type AdminTenant, type AdminSpend } from "../types";

// Founder-only platform view: who signed up, their activity + AI spend, and a per-tenant roles editor.
// The server enforces the 'admin' role on every /api/admin/* call — this page is just the UI.
export function Admin() {
  const { isAdmin, loaded } = useAdminAccess();
  const overview = useQuery({ queryKey: ["admin", "overview"], queryFn: () => api.adminOverview(), enabled: isAdmin });
  const tenants = useQuery({ queryKey: ["admin", "tenants"], queryFn: () => api.adminTenants(), enabled: isAdmin });
  const spend = useQuery({ queryKey: ["admin", "spend"], queryFn: () => api.adminSpend(), enabled: isAdmin });

  if (loaded && !isAdmin) return <Card className="p-6 text-sm text-muted">Not available.</Card>;
  if (!loaded || overview.isLoading) return <Spinner />;
  const o = overview.data;
  const cap = o?.daily_cap_cents ?? 0;
  const pct = cap > 0 ? Math.min(100, Math.round(((o?.spend_today_cents ?? 0) / cap) * 100)) : 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label="Tenants" value={String(o?.tenants ?? 0)} sub={`+${o?.signups_7d ?? 0} this week`} />
        <Metric label="AI spend today" value={money(o?.spend_today_cents ?? 0)} sub={cap ? `of ${money(cap)} cap (${pct}%)` : "no cap set"} />
        <Metric label="This month" value={money(o?.spend_month_cents ?? 0)} />
        <Metric label="All-time" value={money(o?.spend_all_cents ?? 0)} />
      </div>

      {spend.data && <SpendPanel data={spend.data} />}

      <Card className="overflow-hidden">
        <div className="border-b border-line px-4 py-3 text-sm font-medium">Tenants ({tenants.data?.length ?? 0})</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Joined</th>
                <th className="px-4 py-2">Roles</th>
                <th className="px-4 py-2 text-right">Txns</th>
                <th className="px-4 py-2 text-right">Spend</th>
                <th className="px-4 py-2">Last active</th>
              </tr>
            </thead>
            <tbody>
              {(tenants.data ?? []).map((t) => <TenantRow key={t.user_id} t={t} />)}
              {!tenants.data?.length && <tr><td colSpan={6} className="px-4 py-6 text-muted">No tenants yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="text-xs text-muted">Founder-only. Click a role to toggle it for that tenant. The server enforces the admin role on every call.</p>
    </div>
  );
}

// Cross-tenant AI spend + abuse signal. Highlights any tenant who tripped the daily cap today or is a
// large share of the global ceiling, plus the chat ("ask") slice of their spend. Read-only.
function SpendPanel({ data }: { data: AdminSpend }) {
  const cap = data.per_tenant_cap_cents;
  const sorted = [...data.tenants].sort((a, b) => b.today_cents - a.today_cents);
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3 text-sm">
        <span className="font-medium">Spend &amp; abuse</span>
        <span className="text-muted">
          Global today {money(data.spend_today_global_cents)}
          {data.global_ceiling_cents > 0 ? ` of ${money(data.global_ceiling_cents)} ceiling` : " (no ceiling)"}
        </span>
        {data.flagged > 0 ? (
          <span className="rounded-full bg-warn/10 px-2 py-0.5 text-xs font-bold text-warn">{data.flagged} hit the daily cap today</span>
        ) : (
          <span className="rounded-full bg-safe/10 px-2 py-0.5 text-xs font-medium text-safe">none over cap</span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-4 py-2">Tenant</th>
              <th className="px-4 py-2 text-right">Today</th>
              <th className="px-4 py-2 text-right">Chat today</th>
              <th className="px-4 py-2 text-right">7-day</th>
              <th className="px-4 py-2 text-right">Calls today</th>
              <th className="px-4 py-2 text-right">% of ceiling</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => (
              <tr key={t.user_id} className={`border-t border-line ${t.hit_cap_today ? "bg-warn/5" : ""}`}>
                <td className="px-4 py-2">{t.user_id === "me" ? "you (founder)" : t.user_id}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {money(t.today_cents)}
                  {cap > 0 && t.hit_cap_today && <span className="ml-1 text-[10px] font-bold uppercase text-warn">cap</span>}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-muted">{money(t.ask_today_cents)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{money(t.week_cents)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{t.calls_today}</td>
                <td className="px-4 py-2 text-right tabular-nums">{data.global_ceiling_cents > 0 ? `${t.pct_of_global}%` : "—"}</td>
              </tr>
            ))}
            {!sorted.length && <tr><td colSpan={6} className="px-4 py-6 text-muted">No AI spend in the last 7 days.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-2 text-xs text-muted">Top spenders (7-day), with the chat slice and daily-cap/ceiling signal. Complements the pre-call budget gate — it doesn't replace it.</p>
    </Card>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </Card>
  );
}

function parseRoles(json: string): Role[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((r): r is Role => (ROLES as readonly string[]).includes(r as string)) : [];
  } catch {
    return [];
  }
}

function TenantRow({ t }: { t: AdminTenant }) {
  const qc = useQueryClient();
  const roles = parseRoles(t.roles);
  const m = useMutation({
    mutationFn: (next: string[]) => api.setTenantRoles(t.user_id, next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "tenants"] }),
  });
  const toggle = (r: Role) => m.mutate(roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r]);
  return (
    <tr className="border-t border-line align-top">
      <td className="px-4 py-2">{t.email ?? <span className="text-muted">{t.user_id === "me" ? "you (founder)" : "—"}</span>}</td>
      <td className="px-4 py-2 text-muted">{(t.created_at ?? "").slice(0, 10)}</td>
      <td className="px-4 py-2">
        <div className="flex flex-wrap gap-1.5">
          {ROLES.map((r) => (
            <button
              key={r}
              type="button"
              disabled={m.isPending}
              onClick={() => toggle(r)}
              className={`rounded-full border px-2 py-0.5 text-xs transition disabled:opacity-50 ${roles.includes(r) ? "border-forest bg-sage text-forest" : "border-line text-muted hover:border-ink/40"}`}
            >
              {ROLE_LABEL[r]}
            </button>
          ))}
        </div>
        {m.isError && <div className="mt-1 text-xs text-danger">{(m.error as Error).message}</div>}
      </td>
      <td className="px-4 py-2 text-right tabular-nums">{t.txn_count}</td>
      <td className="px-4 py-2 text-right tabular-nums">{money(t.cost_cents)}</td>
      <td className="px-4 py-2 text-muted">{t.last_activity ? t.last_activity.slice(0, 10) : "—"}</td>
    </tr>
  );
}
