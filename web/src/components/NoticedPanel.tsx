import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import { useActiveFy } from "../lib/activeFy";
import { money } from "./ui";
import { FtLink, GeneralInfoNote, NoticedCard } from "./ft";
import type { NoticedConfirmResult, NoticedSignal } from "../types";

/**
 * "We noticed…" (flag wages_payer, #577; spec A3). The deterministic credit triage's open signals for the active
 * FY, one card each. Rendered by the caller only when the flag is on. Refetched after an import (the "signals"
 * query key), so cards appear on the same screen without a reload. Ticket (b) moves this onto the Bring in page.
 */
export function NoticedPanel() {
  const { fy } = useActiveFy();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["noticed", fy], queryFn: () => api.noticed(fy) });
  // Confirmed cards stay on screen with their follow-up (e.g. the income-statement prompt) until the next visit.
  const [done, setDone] = useState<Record<string, { signal: NoticedSignal; result: NoticedConfirmResult }>>({});
  const confirm = useMutation({
    mutationFn: (s: NoticedSignal) => api.confirmNoticed(s.id).then((result) => ({ signal: s, result })),
    onSuccess: ({ signal, result }) => {
      setDone((d) => ({ ...d, [signal.id]: { signal, result } }));
      for (const k of ["noticed", "readiness", "income", "report", "transactions", "dashboard", "situation"]) qc.invalidateQueries({ queryKey: [k] });
    },
    onError: (e) => toast.error("Couldn't save that", { description: (e as Error).message }),
  });
  const dismiss = useMutation({
    mutationFn: (s: NoticedSignal) => api.dismissNoticed(s.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["noticed"] }),
    onError: (e) => toast.error("Couldn't dismiss", { description: (e as Error).message }),
  });

  const open = q.data ?? [];
  const shown = [...Object.values(done).map((d) => d.signal).filter((s) => !open.some((o) => o.id === s.id)), ...open];
  if (!q.isLoading && !q.error && shown.length === 0) return null;
  const busyId = (confirm.isPending && confirm.variables?.id) || (dismiss.isPending && dismiss.variables?.id) || null;

  return (
    <section aria-labelledby="noticed-h" className="space-y-3">
      <h2 id="noticed-h" className="text-lg font-semibold">We noticed…</h2>
      {q.isLoading || q.error ? (
        <NoticedCard
          status={q.isLoading ? "loading" : "error"}
          error={q.error}
          onRetry={() => q.refetch()}
          signal={{ kind: "", evidence: { n: 0, first_date: null, last_date: null, total_cents: 0, label: "" } }}
          amount=""
          onYes={() => {}}
          onNo={() => {}}
        />
      ) : (
        shown.map((s) => (
          <NoticedCard
            key={s.id}
            signal={s}
            amount={money(s.evidence.total_cents)}
            busy={busyId === s.id}
            onYes={() => confirm.mutate(s)}
            onNo={() => dismiss.mutate(s)}
            after={done[s.id] ? <Confirmed result={done[s.id]!.result} /> : undefined}
          />
        ))
      )}
      <GeneralInfoNote />
    </section>
  );
}

function Confirmed({ result }: { result: NoticedConfirmResult }) {
  if (result.kind === "payroll") {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-ink">{result.prompt}</p>
        {result.needs_occupation && <p className="text-muted">Add what this job is in About you so Quillo can suggest what to look for.</p>}
        {!!result.previously_recorded && (
          <p className="text-warn">
            {result.previously_recorded} of these deposits were recorded earlier as personal income. Once your income statement is in, remove those
            entries on the Income page so your pay isn't counted twice.
          </p>
        )}
        <FtLink to="/income?type=salary_payg">Add your income statement</FtLink>
      </div>
    );
  }
  if (result.kind === "platform") {
    return <p className="text-sm text-ink">Done. {result.income_recorded} payout{result.income_recorded === 1 ? "" : "s"} recorded as business income, each counted once.</p>;
  }
  const type = result.offer_manual_income?.[0];
  return (
    <div className="space-y-2 text-sm">
      <p className="text-ink">{result.kind === "foreign" ? "Noted. If any of it is income, add it on the Income page." : "Added to your myTax worksheet to check."}</p>
      {type && <FtLink to={`/income?type=${type}`}>Add it on the Income page</FtLink>}
    </div>
  );
}
