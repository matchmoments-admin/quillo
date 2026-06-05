import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAdminAccess } from "../lib/features";
import { Card, Spinner, money } from "../components/ui";
import { ROLES, ROLE_LABEL, type Role, type AdminTenant } from "../types";

// Founder-only platform view: who signed up, their activity + AI spend, and a per-tenant roles editor.
// The server enforces the 'admin' role on every /api/admin/* call — this page is just the UI.
export function Admin() {
  const { isAdmin, loaded } = useAdminAccess();
  const overview = useQuery({ queryKey: ["admin", "overview"], queryFn: () => api.adminOverview(), enabled: isAdmin });
  const tenants = useQuery({ queryKey: ["admin", "tenants"], queryFn: () => api.adminTenants(), enabled: isAdmin });

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
