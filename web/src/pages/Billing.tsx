import { useQuery, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import { useFeatures } from "../lib/features";
import { Panel, PanelHead, KpiCard, Pill, Spinner, Button } from "../components/ui";
import type { BillingOverview } from "../types";

// Usage-based billing: free to join + a free credit allowance, then you pay your actual AI cost + a
// tiny margin from a pre-paid balance (Stripe top-up). The fee is generally claimable as a cost of
// managing your tax affairs — general information, not tax advice.

/** 1e-4-cent units → "$x.xx". e4 / 1e6 = dollars (1e4 units = 1 cent, 1e6 = 100 cents = $1). */
function dollars(e4: number): string {
  return `$${(Math.max(0, e4) / 1_000_000).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const TOPUPS = [1000, 2000, 5000]; // cents: $10 / $20 / $50

export function Billing() {
  const { has, loaded } = useFeatures();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["billing"], queryFn: () => api.billing(), enabled: has("billing") });
  const topup = useMutation({
    mutationFn: (cents: number) => api.billingTopup(cents),
    onSuccess: (r) => { window.location.href = r.url; },
    onError: (e) => toast.error((e as Error).message),
  });

  if (!has("billing")) return <Panel className="text-sm text-muted">Billing isn't enabled.</Panel>;
  if (isLoading || !loaded) return <Spinner />;
  if (error) return <Panel className="text-sm text-muted">Couldn't load: {(error as Error).message}</Panel>;
  const d: BillingOverview = data!;
  const low = d.balance_e4 <= d.free_grant_e4 * 0.2;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-4xl text-forest">Billing</h1>
        <div className="mt-1.5 text-xs font-medium text-ink-3">You only pay for the AI you use — at cost plus a small margin</div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard variant="feature" label="AI credit balance" value={dollars(d.balance_e4)} foot={low ? "Running low — top up below" : "Drawn down as you use AI features"} tone={low ? "warn" : undefined} />
        <KpiCard label="Service margin" value={`${d.markup_pct}%`} foot="Added over the measured AI cost" />
        <KpiCard label="Free allowance" value={dollars(d.free_grant_e4)} foot="One-off, on signup — no card needed to start" />
      </div>

      <Panel className="space-y-4">
        <PanelHead title="Top up credits" sub="Pre-pay; credits are drawn down as you use AI. Fees are generally claimable as a cost of managing your tax affairs." />
        {!d.configured && (
          <div className="rounded-xl border border-line bg-paper px-4 py-2.5 text-sm text-ink-2">
            Card payments aren't switched on yet — your free allowance still works. Top-ups go live once Stripe is connected.
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          {TOPUPS.map((c) => (
            <Button key={c} onClick={() => topup.mutate(c)} disabled={!d.configured || topup.isPending}>
              {topup.isPending ? "…" : `Add $${c / 100}`}
            </Button>
          ))}
        </div>
        <p className="text-xs text-ink-3">General information only — not tax advice. Whether a fee is deductible depends on your circumstances; confirm with a registered tax agent.</p>
      </Panel>

      <Panel>
        <PanelHead title="History" sub="Free allowance + top-ups" right={<button className="text-xs text-ink-3 underline hover:text-ink" onClick={() => refetch()}>Refresh</button>} />
        {d.ledger.length === 0 ? (
          <p className="text-sm text-muted">No credits yet.</p>
        ) : (
          <div className="space-y-1">
            {d.ledger.map((l, i) => (
              <div key={i} className="flex items-center gap-3 py-1.5 text-sm">
                <Pill tone={l.kind === "grant" ? "info" : "ok"}>{l.kind === "grant" ? "Free allowance" : "Top-up"}</Pill>
                <span className="min-w-0 flex-1 truncate text-ink-3">{l.created_at}</span>
                <span className="tnum font-semibold text-ink">+{dollars(l.amount_e4)}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
