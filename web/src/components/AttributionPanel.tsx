import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useFeatures } from "../lib/features";
import { Card, Spinner, money } from "./ui";
import type { Person, IncomeActivity, AttributionInput } from "../types";

type EntityLite = { id: string; kind: string; name: string | null };

// Editable attribution row in the form (a superset of AttributionInput with string inputs).
interface RowState {
  entity_id: string;
  income_activity_id: string;
  attributed_pct: string; // empty = 100%
  work_use_pct: string;   // empty = 100%
  deduction_provision: string;
}

const PROVISIONS = [
  { v: "s8-1_general", label: "General work deduction (s8-1)" },
  { v: "div40", label: "Depreciation — plant (Div 40)" },
  { v: "div43", label: "Capital works (Div 43)" },
  { v: "s40-880", label: "Start-up cost (s40-880)" },
  { v: "wfh_fixed_rate", label: "Working-from-home (fixed rate)" },
  { v: "private_non_deductible", label: "Private — not deductible" },
];

// Slice 9 (attribution_labels): the SAME provisions, grouped by tax character so the long flat list is
// easier to scan. Values are identical to PROVISIONS above — the save payload is unchanged.
const PROVISION_GROUPS: { group: string; items: { v: string; label: string }[] }[] = [
  { group: "Salary / work", items: [{ v: "s8-1_general", label: "General work deduction (s8-1)" }] },
  { group: "Capital asset", items: [
    { v: "div40", label: "Depreciation — plant (Div 40)" },
    { v: "div43", label: "Capital works (Div 43)" },
    { v: "s40-880", label: "Start-up cost (s40-880)" },
  ] },
  { group: "Working from home", items: [{ v: "wfh_fixed_rate", label: "Working-from-home (fixed rate)" }] },
  { group: "Private", items: [{ v: "private_non_deductible", label: "Private — not deductible" }] },
];

const pct = (s: string) => (s.trim() === "" ? 100 : Math.max(0, Math.min(100, Number(s) || 0)));

/**
 * Phase B / G2 — the "who paid vs who claims" panel. Lets the user record that they PAID a cost but
 * only part of it is theirs to claim (a co-owned rental → their legal share; a personally-paid company
 * cost → the company, via a shareholder loan). General information only — never tax advice.
 */
export function AttributionPanel({ txnId, txnAmountCents, entities, persons }: { txnId: string; txnAmountCents: number; entities: EntityLite[]; persons: Person[] }) {
  const qc = useQueryClient();
  const { has } = useFeatures();
  const labelsV2 = has("attribution_labels");
  const stateQ = useQuery({ queryKey: ["attributions", txnId], queryFn: () => api.txnAttributions(txnId) });
  const actsQ = useQuery({ queryKey: ["income-activities"], queryFn: () => api.incomeActivities() });

  const [payer, setPayer] = useState<string | null>(null);
  const [rows, setRows] = useState<RowState[] | null>(null);
  const [seeded, setSeeded] = useState(false);

  // Seed the form once from the server state.
  if (stateQ.data && !seeded) {
    setPayer(stateQ.data.payer_person_id ?? (persons.find((p) => p.role === "self")?.id ?? null));
    setRows(
      (stateQ.data.attributions ?? []).map((a) => ({
        entity_id: a.entity_id,
        income_activity_id: a.income_activity_id ?? "",
        attributed_pct: a.attributed_pct == null ? "" : String(a.attributed_pct),
        work_use_pct: a.work_use_pct == null ? "" : String(a.work_use_pct),
        deduction_provision: a.deduction_provision ?? "s8-1_general",
      })),
    );
    setSeeded(true);
  }

  const save = useMutation({
    mutationFn: () => {
      const attributions: AttributionInput[] = (rows ?? []).map((r) => ({
        entity_id: r.entity_id,
        income_activity_id: r.income_activity_id || null,
        attributed_pct: r.attributed_pct.trim() === "" ? null : pct(r.attributed_pct),
        work_use_pct: r.work_use_pct.trim() === "" ? null : pct(r.work_use_pct),
        deduction_provision: r.deduction_provision || null,
      }));
      return api.setTxnAttributions(txnId, { payer_person_id: payer, attributions });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attributions", txnId] });
      qc.invalidateQueries({ queryKey: ["report"] });
      qc.invalidateQueries({ queryKey: ["filing-readiness"] });
    },
  });
  const clear = useMutation({
    mutationFn: () => api.clearTxnAttributions(txnId),
    onSuccess: () => { setSeeded(false); qc.invalidateQueries({ queryKey: ["attributions", txnId] }); qc.invalidateQueries({ queryKey: ["report"] }); },
  });

  if (stateQ.isLoading || actsQ.isLoading || rows == null) return <Card className="p-4"><Spinner /></Card>;

  const activities = actsQ.data ?? [];
  const companyIds = new Set(entities.filter((e) => e.kind === "company").map((e) => e.id));
  const entityName = (e: EntityLite) => e.name ?? e.kind;
  const setRow = (i: number, patch: Partial<RowState>) => setRows((rs) => (rs ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...(rs ?? []), { entity_id: entities[0]?.id ?? "", income_activity_id: "", attributed_pct: "", work_use_pct: "", deduction_provision: "s8-1_general" }]);
  const removeRow = (i: number) => setRows((rs) => (rs ?? []).filter((_, j) => j !== i));

  const pctSum = (rows ?? []).reduce((s, r) => s + (r.attributed_pct.trim() === "" ? 0 : pct(r.attributed_pct)), 0);
  const previewCents = (r: RowState) => Math.round((txnAmountCents * pct(r.attributed_pct) * pct(r.work_use_pct)) / 10000);
  const anyCompany = (rows ?? []).some((r) => companyIds.has(r.entity_id));
  const activitiesFor = (r: RowState): IncomeActivity[] =>
    activities.filter((a) => a.entity_id === r.entity_id || a.entity_id == null || a.activity_type === "rental_property");

  return (
    <Card className="space-y-4 p-4">
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-muted">Who paid vs who claims</div>
        <p className="mt-1 text-xs text-muted">
          If you paid a cost but only part of it is yours to claim — a co-owned rental (your share follows
          legal ownership, regardless of who paid), or a cost that belongs to your company — record it here.
          General information only, not tax advice.
        </p>
      </div>

      <label className="block">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">Who actually paid?</span>
        <select value={payer ?? ""} onChange={(e) => setPayer(e.target.value || null)} className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2 text-sm">
          <option value="">—</option>
          {persons.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
        </select>
      </label>

      <div className="space-y-3">
        {(rows ?? []).map((r, i) => (
          <div key={i} className={`space-y-2 rounded-lg border bg-surface p-3 ${labelsV2 && pctSum > 100 ? "border-danger" : "border-line"}`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">Claimed by</span>
              <button onClick={() => removeRow(i)} className="text-xs text-danger hover:underline">remove</button>
            </div>
            <select value={r.entity_id} onChange={(e) => setRow(i, { entity_id: e.target.value, income_activity_id: "" })} className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm">
              {entities.map((e) => <option key={e.id} value={e.id}>{entityName(e)} ({e.kind})</option>)}
            </select>
            <select value={r.income_activity_id} onChange={(e) => setRow(i, { income_activity_id: e.target.value })} className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm">
              <option value="">— activity (optional) —</option>
              {activitiesFor(r).map((a) => <option key={a.id} value={a.id}>{a.label ?? a.activity_type} · {a.activity_type}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-muted">Your share %</span>
                <input value={r.attributed_pct} onChange={(e) => setRow(i, { attributed_pct: e.target.value })} placeholder="100" inputMode="decimal" className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2 text-sm" />
              </label>
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-muted">Work-use %</span>
                <input value={r.work_use_pct} onChange={(e) => setRow(i, { work_use_pct: e.target.value })} placeholder="100" inputMode="decimal" className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2 text-sm" />
              </label>
            </div>
            <select value={r.deduction_provision} onChange={(e) => setRow(i, { deduction_provision: e.target.value })} className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm">
              {labelsV2
                ? PROVISION_GROUPS.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.items.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
                    </optgroup>
                  ))
                : PROVISIONS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
            </select>
            {labelsV2 ? (
              <div className="flex items-center justify-between rounded-lg bg-ink/5 px-3 py-2">
                <span className="text-xs font-medium text-muted">This costs you</span>
                <span className="text-sm font-semibold tabular-nums text-ink">{money(previewCents(r))}</span>
              </div>
            ) : (
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">Claimed amount</span>
                <span className="font-medium tabular-nums">{money(previewCents(r))}</span>
              </div>
            )}
            {companyIds.has(r.entity_id) && (
              <p className="text-[11px] text-muted">Recorded as a loan from you to the company (not a Division 7A dividend — that risk runs the other way).</p>
            )}
          </div>
        ))}
      </div>

      <button onClick={addRow} className="w-full rounded-lg border border-dashed border-line py-2 text-sm font-medium text-muted transition hover:bg-surface">+ Add who claims this</button>

      {pctSum > 100 && <p className="text-xs text-danger">Your shares add up to {pctSum}% — that's over 100%.</p>}
      {anyCompany && (
        <p className="text-[11px] text-muted">A cost claimed by your company reduces the company's position, not your salary — see the company section on your hand-off.</p>
      )}

      <div className="flex gap-2">
        <button onClick={() => save.mutate()} disabled={save.isPending || pctSum > 100} className="flex-1 rounded-lg bg-ink py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50">
          {save.isPending ? "Saving…" : "Save attribution"}
        </button>
        {(rows ?? []).length > 0 && (
          <button onClick={() => clear.mutate()} disabled={clear.isPending} className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-muted transition hover:bg-surface disabled:opacity-50">Clear</button>
        )}
      </div>
      {save.isError && <p className="text-sm text-danger">Couldn't save: {(save.error as Error).message}</p>}
      {save.isSuccess && !save.isPending && <p className="text-xs text-safe">Saved ✓</p>}
    </Card>
  );
}
