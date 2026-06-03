import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Card, Spinner, Button, Input, money } from "../components/ui";
import type { IncomeRow } from "../types";

function fyLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}
function defaultFyStart(): number {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

const INCOME_TYPES = [
  "salary_payg",
  "rent",
  "interest",
  "dividend",
  "managed_fund_distribution",
  "foreign_pension",
  "foreign_rent",
  "other",
] as const;

const TYPE_LABEL: Record<string, string> = {
  salary_payg: "Salary (PAYG)",
  rent: "Rent",
  interest: "Interest",
  dividend: "Dividend",
  managed_fund_distribution: "Managed fund",
  foreign_pension: "Foreign pension",
  foreign_rent: "Foreign rent",
  other: "Other",
};

export function Income() {
  const [fyStart, setFyStart] = useState(defaultFyStart());
  const fy = fyLabel(fyStart);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["income", fy], queryFn: () => api.income({ fy }) });
  const [adding, setAdding] = useState(false);

  const total = (data ?? []).reduce((s, r) => s + (r.amount_aud_cents ?? r.gross_cents), 0);
  const withholding = (data ?? []).reduce((s, r) => s + r.withholding_cents, 0);
  const franking = (data ?? []).reduce((s, r) => s + r.franking_credit_cents, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Income</h1>
        <div className="flex items-center gap-2 text-sm">
          <button className="rounded-lg border border-line px-2 py-1" onClick={() => setFyStart((y) => y - 1)}>←</button>
          <span className="tabular-nums">FY {fy}</span>
          <button className="rounded-lg border border-line px-2 py-1" onClick={() => setFyStart((y) => y + 1)}>→</button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Card className="p-4"><div className="text-xs uppercase tracking-wide text-muted">Gross income</div><div className="mt-1 text-xl font-semibold tabular-nums">{money(total)}</div></Card>
        <Card className="p-4"><div className="text-xs uppercase tracking-wide text-muted">PAYG withheld</div><div className="mt-1 text-xl font-semibold tabular-nums">{money(withholding)}</div></Card>
        <Card className="p-4"><div className="text-xs uppercase tracking-wide text-muted">Franking credits</div><div className="mt-1 text-xl font-semibold tabular-nums">{money(franking)}</div></Card>
      </div>

      <div>
        <Button variant="ghost" onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "+ Add income manually"}</Button>
      </div>
      {adding && <AddIncomeForm fy={fy} onDone={() => { setAdding(false); qc.invalidateQueries({ queryKey: ["income", fy] }); }} />}

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Card className="p-6 text-sm text-muted">Couldn't load: {(error as Error).message}</Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5">Date</th>
                <th className="px-4 py-2.5 text-right">Gross</th>
                <th className="px-4 py-2.5 text-right">Withheld</th>
                <th className="px-4 py-2.5 text-right">Franking</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((r) => <IncomeLine key={r.id} row={r} fy={fy} />)}
              {!(data ?? []).length && (
                <tr className="border-t border-line"><td colSpan={6} className="px-4 py-6 text-muted">No income recorded for this FY. Upload a payslip or agent statement from Documents, or add one manually.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      )}
      <p className="text-xs text-muted">General information only — not tax advice.</p>
    </div>
  );
}

function IncomeLine({ row, fy }: { row: IncomeRow; fy: string }) {
  const qc = useQueryClient();
  const del = useMutation({ mutationFn: () => api.deleteIncome(row.id), onSuccess: () => qc.invalidateQueries({ queryKey: ["income", fy] }) });
  return (
    <tr className="border-t border-line">
      <td className="px-4 py-2">
        {TYPE_LABEL[row.income_type] ?? row.income_type}
        {row.needs_review ? <span className="ml-2 rounded-full bg-warn/10 px-2 py-0.5 text-xs text-warn">review</span> : null}
      </td>
      <td className="px-4 py-2 text-muted tabular-nums">{row.txn_date ?? "—"}</td>
      <td className="px-4 py-2 text-right tabular-nums">{money(row.amount_aud_cents ?? row.gross_cents)}</td>
      <td className="px-4 py-2 text-right tabular-nums text-muted">{row.withholding_cents ? money(row.withholding_cents) : "—"}</td>
      <td className="px-4 py-2 text-right tabular-nums text-muted">{row.franking_credit_cents ? money(row.franking_credit_cents) : "—"}</td>
      <td className="px-4 py-2 text-right"><button className="text-xs text-danger hover:underline" onClick={() => del.mutate()}>delete</button></td>
    </tr>
  );
}

function AddIncomeForm({ fy, onDone }: { fy: string; onDone: () => void }) {
  const [type, setType] = useState<string>("salary_payg");
  const [gross, setGross] = useState("");
  const [withheld, setWithheld] = useState("");
  const [franking, setFranking] = useState("");
  const [date, setDate] = useState("");
  const add = useMutation({
    mutationFn: () =>
      api.addIncome({
        income_type: type,
        fy,
        gross_cents: Math.round(parseFloat(gross || "0") * 100),
        withholding_cents: Math.round(parseFloat(withheld || "0") * 100),
        franking_credit_cents: Math.round(parseFloat(franking || "0") * 100),
        txn_date: date || null,
      }),
    onSuccess: onDone,
  });
  return (
    <Card className="space-y-3 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className="text-sm">Type
          <select className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm" value={type} onChange={(e) => setType(e.target.value)}>
            {INCOME_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        </label>
        <label className="text-sm">Gross ($)<Input className="mt-1 w-full" inputMode="decimal" value={gross} onChange={(e) => setGross(e.target.value)} /></label>
        <label className="text-sm">Date<Input className="mt-1 w-full" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="text-sm">PAYG withheld ($)<Input className="mt-1 w-full" inputMode="decimal" value={withheld} onChange={(e) => setWithheld(e.target.value)} /></label>
        <label className="text-sm">Franking credit ($)<Input className="mt-1 w-full" inputMode="decimal" value={franking} onChange={(e) => setFranking(e.target.value)} /></label>
      </div>
      <Button onClick={() => add.mutate()} disabled={add.isPending || !gross}>{add.isPending ? "Saving…" : "Save income"}</Button>
      {add.error && <p className="text-sm text-danger">{(add.error as Error).message}</p>}
    </Card>
  );
}
