import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { usePartnerAccess } from "../lib/features";
import { Card, Spinner, money } from "../components/ui";
import type { PartnerLead, PartnerPortalOffer } from "../types";

// Partner-staff view of THEIR org only. The server resolves the caller's partner_id from
// partner_members and scopes every query to it — this page never sees another org's leads, and never
// sees the consumer's identity or ledger (Tier-1 keeps PII in Quillo). Mirrors the founder-only Admin
// page, but role-gated on 'partner' instead of 'admin'.

// The funnel stages we always show, in order, even when a stage has zero leads.
const STAGES = ["clicked", "converted", "paid"] as const;
const STAGE_LABEL: Record<string, string> = {
  created: "Created", presented: "Presented", clicked: "Clicked", converted: "Converted",
  paid: "Paid", dismissed: "Dismissed", expired: "Expired", clawed_back: "Clawed back",
};
const STATUS_TONE: Record<string, string> = {
  paid: "bg-forest/10 text-forest", converted: "bg-sage/20 text-forest",
  clicked: "bg-line text-ink-2", clawed_back: "bg-red-100 text-red-700",
};

export function Partner() {
  const { isPartner, loaded } = usePartnerAccess();
  const portal = useQuery({ queryKey: ["partner", "overview"], queryFn: () => api.partnerOverview(), enabled: isPartner });

  if (loaded && !isPartner) return <Card className="p-6 text-sm text-muted">Not available.</Card>;
  if (!loaded || portal.isLoading) return <Spinner />;
  const d = portal.data;
  if (!d?.partner) return <Card className="p-6 text-sm text-muted">No partner organisation is linked to your account.</Card>;

  const byStatus = Object.fromEntries(d.funnel.map((f) => [f.status, f]));
  const liveOffers = d.offers.filter((o) => o.active).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{d.partner.name}</h1>
          <div className="mt-1 text-xs font-medium uppercase tracking-wide text-muted">{d.partner.vertical} · {d.partner.status} · partner portal</div>
        </div>
      </div>

      {/* Funnel: counts per stage + earned (paid) revenue. */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {STAGES.map((s) => (
          <Metric key={s} label={STAGE_LABEL[s]} value={String(byStatus[s]?.n ?? 0)} />
        ))}
        <Metric label="Revenue (paid)" value={money(d.revenue_cents)} sub={`${d.total} lead${d.total === 1 ? "" : "s"} total`} />
      </div>

      {/* Leads — anonymised. We show the attribution token (the partner's own key), status, dates and
          revenue. We NEVER show who the consumer is — that stays inside Quillo. */}
      <Card className="overflow-hidden">
        <div className="border-b border-line px-4 py-3 text-sm font-medium">Leads ({d.leads.length})</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-2">Reference</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Created</th>
                <th className="px-4 py-2">Updated</th>
                <th className="px-4 py-2 text-right">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {d.leads.map((l) => <LeadRow key={l.referral_token} l={l} />)}
              {!d.leads.length && <tr><td colSpan={5} className="px-4 py-6 text-muted">No leads yet. They appear here when a user clicks your offer in Quillo.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Offers — read-only in this first version (editing/creating offers is founder/admin for now). */}
      <Card className="overflow-hidden">
        <div className="border-b border-line px-4 py-3 text-sm font-medium">Offers ({liveOffers} live / {d.offers.length})</div>
        <div className="divide-y divide-line">
          {d.offers.map((o) => <OfferRow key={o.id} o={o} />)}
          {!d.offers.length && <div className="px-4 py-6 text-sm text-muted">No offers configured yet.</div>}
        </div>
      </Card>

      <p className="text-xs text-muted">You only ever see your own organisation's leads. We never share who the consumer is — they reach you only if they choose to click through.</p>
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold tnum">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </Card>
  );
}

function LeadRow({ l }: { l: PartnerLead }) {
  return (
    <tr className="border-t border-line">
      <td className="px-4 py-2 font-mono text-xs text-ink-2">{l.referral_token.slice(0, 8)}…</td>
      <td className="px-4 py-2"><span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_TONE[l.status] ?? "bg-line text-ink-2"}`}>{STAGE_LABEL[l.status] ?? l.status}</span></td>
      <td className="px-4 py-2 text-xs text-muted">{l.created_at.slice(0, 10)}</td>
      <td className="px-4 py-2 text-xs text-muted">{l.updated_at.slice(0, 10)}</td>
      <td className="px-4 py-2 text-right tnum">{l.revenue_cents ? money(l.revenue_cents) : "—"}</td>
    </tr>
  );
}

function OfferRow({ o }: { o: PartnerPortalOffer }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className={`h-2 w-2 shrink-0 rounded-full ${o.active ? "bg-forest" : "bg-line"}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{o.title ?? o.id}</div>
        <div className="truncate text-xs text-muted">{o.vertical} · {o.target_url}</div>
      </div>
      <span className="shrink-0 text-xs text-muted">{o.active ? "Live" : "Off"}</span>
    </div>
  );
}
