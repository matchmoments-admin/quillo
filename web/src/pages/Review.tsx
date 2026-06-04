import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import { Card, Spinner, Button, Input, money, BUCKET_LABEL } from "../components/ui";

const DEDUCTIBLE_STATES = new Set(["likely_deductible", "confirmed_deductible"]);

function fyLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}
function defaultFyStart(): number {
  const now = new Date();
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

// A (bucket, ato_label) aggregated across its deductibility rows.
type Label = { bucket: string; ato_label: string | null; n: number; total_cents: number; resolved_cents: number; states: string[] };

export function Review() {
  const [fyStart, setFyStart] = useState(defaultFyStart());
  const fy = fyLabel(fyStart);
  const { data, isLoading, error } = useQuery({ queryKey: ["review", fy], queryFn: () => api.reviewSummary(fy) });

  const labels = useMemo<Label[]>(() => {
    const m = new Map<string, Label>();
    for (const r of data?.rows ?? []) {
      const key = `${r.bucket}||${r.ato_label ?? ""}`;
      const cur = m.get(key) ?? { bucket: r.bucket, ato_label: r.ato_label, n: 0, total_cents: 0, resolved_cents: 0, states: [] };
      cur.n += r.n;
      cur.total_cents += r.total_cents;
      if (DEDUCTIBLE_STATES.has(r.deductibility)) cur.resolved_cents += r.resolved_cents;
      if (!cur.states.includes(r.deductibility)) cur.states.push(r.deductibility);
      m.set(key, cur);
    }
    return [...m.values()].sort((a, b) => b.total_cents - a.total_cents);
  }, [data]);

  const captured = labels.reduce((s, l) => s + l.total_cents, 0);
  const resolvedDeductible = labels.reduce((s, l) => s + l.resolved_cents, 0);
  const undetermined = (data?.rows ?? []).filter((r) => r.deductibility === "undetermined").reduce((s, r) => s + r.total_cents, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Year-end review</h1>
        <div className="flex items-center gap-2 text-sm">
          <button className="rounded-lg border border-line px-2 py-1" onClick={() => setFyStart((y) => y - 1)}>←</button>
          <span className="tabular-nums">FY {fy}</span>
          <button className="rounded-lg border border-line px-2 py-1" onClick={() => setFyStart((y) => y + 1)}>→</button>
        </div>
      </div>

      <Card className="grid grid-cols-3 gap-4 p-4">
        <Stat label="Tracked spend" value={money(captured)} />
        <Stat label="Still to review" value={money(undetermined)} />
        <Stat label="Confirmed deductible" value={money(resolvedDeductible)} />
      </Card>
      <p className="px-1 text-xs text-muted">
        Resolve what's actually deductible, label by label — set a full claim, mark it not deductible, or apportion a
        business-use %. General information only — not tax advice; confirm your claims with a registered tax agent before
        lodging. This never predicts a refund.
      </p>

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Card className="p-6 text-sm text-muted">Couldn't load: {(error as Error).message}</Card>
      ) : labels.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">No tracked spend to review for FY {fy}.</Card>
      ) : (
        <div className="space-y-2">
          {labels.map((l) => (
            <LabelRow key={`${l.bucket}||${l.ato_label ?? ""}`} label={l} fy={fy} />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

const STATE_LABEL: Record<string, string> = {
  undetermined: "Not reviewed",
  likely_deductible: "Likely deductible",
  likely_not: "Likely not",
  needs_apportionment: "Needs apportionment",
  confirmed_deductible: "Deductible",
  confirmed_not: "Not deductible",
};

function LabelRow({ label, fy }: { label: Label; fy: string }) {
  const qc = useQueryClient();
  const [pct, setPct] = useState<string>("");
  const resolve = useMutation({
    mutationFn: (v: { state: string; businessUsePct?: number | null }) =>
      api.resolveDeductibility({ fy, bucket: label.bucket, atoLabel: label.ato_label, state: v.state, businessUsePct: v.businessUsePct ?? null }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["review", fy] });
      qc.invalidateQueries({ queryKey: ["report"] });
      toast.success(`Updated ${r.updated} transaction(s).`);
    },
    onError: (e) => toast.error("Couldn't update", { description: (e as Error).message }),
  });
  const apportion = () => {
    const n = Number(pct);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      toast.error("Enter a business-use % between 0 and 100");
      return;
    }
    resolve.mutate({ state: "confirmed_deductible", businessUsePct: n });
  };
  const currentState = label.states.length === 1 ? label.states[0]! : label.states.includes("undetermined") ? "undetermined" : "mixed";

  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0">
        <div className="text-sm font-medium">
          {BUCKET_LABEL[label.bucket] ?? label.bucket}
          {label.ato_label ? <span className="text-muted"> · {label.ato_label}</span> : null}
        </div>
        <div className="text-xs text-muted">
          <span className="tabular-nums">{money(label.total_cents)}</span> across {label.n} txn(s) ·{" "}
          {currentState === "mixed" ? "mixed" : STATE_LABEL[currentState] ?? currentState}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" disabled={resolve.isPending} onClick={() => resolve.mutate({ state: "confirmed_deductible" })}>Deductible</Button>
        <Button variant="ghost" disabled={resolve.isPending} onClick={() => resolve.mutate({ state: "confirmed_not" })}>Not deductible</Button>
        <div className="flex items-center gap-1">
          <Input className="w-16" placeholder="%" value={pct} onChange={(e) => setPct(e.target.value)} />
          <Button variant="ghost" disabled={resolve.isPending} onClick={apportion}>Apportion</Button>
        </div>
        <Button variant="ghost" disabled={resolve.isPending} onClick={() => resolve.mutate({ state: "undetermined" })}>Reset</Button>
      </div>
    </Card>
  );
}
