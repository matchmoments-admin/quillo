import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useFeatures } from "../lib/features";
import { Card, Spinner, Button, Input, money } from "../components/ui";
import type { AssetRow, ScheduleRow, VehicleLogbookRow } from "../types";

const CLASS_LABEL: Record<string, string> = {
  div40_plant: "Plant & equipment (Div 40)",
  div43_capital_works: "Capital works (Div 43)",
  business_asset: "Business pool",
  low_value_pool: "Low-value pool",
  immediate: "Immediate write-off",
};

export function Assets() {
  const qc = useQueryClient();
  const { has } = useFeatures();
  const { data, isLoading, error } = useQuery({ queryKey: ["assets"], queryFn: () => api.assets() });
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Assets &amp; depreciation</h1>
        <Button variant="ghost" onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "+ Add asset"}</Button>
      </div>
      <p className="text-sm text-muted">
        Decline in value carries forward each year automatically. Upload a quantity-surveyor
        schedule from Documents to bulk-import. General information only — not tax advice.
      </p>

      {adding && <AddAssetForm onDone={() => { setAdding(false); qc.invalidateQueries({ queryKey: ["assets"] }); }} />}

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Card className="p-6 text-sm text-muted">Couldn't load: {(error as Error).message}</Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-2.5">Asset</th>
                <th className="px-4 py-2.5">Class</th>
                <th className="px-4 py-2.5 text-right">Cost</th>
                <th className="px-4 py-2.5 text-right">This FY</th>
                <th className="px-4 py-2.5 text-right">Adjustable value</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((a) => <AssetLine key={a.id} a={a} />)}
              {!(data ?? []).length && (
                <tr className="border-t border-line"><td colSpan={6} className="px-4 py-6 text-muted">No assets yet.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      )}

      {has("car_logbook") && <VehicleLogbooks assets={data ?? []} />}
    </div>
  );
}

function AssetLine({ a }: { a: AssetRow }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const sched = useQuery({ queryKey: ["schedule", a.id], queryFn: () => api.assetSchedule(a.id), enabled: open });
  const del = useMutation({ mutationFn: () => api.deleteAsset(a.id), onSuccess: () => qc.invalidateQueries({ queryKey: ["assets"] }) });
  return (
    <>
      <tr className="border-t border-line">
        <td className="px-4 py-2">
          <button className="text-left hover:underline" onClick={() => setOpen((v) => !v)}>{a.label}</button>
          {a.is_second_hand ? <span className="ml-2 rounded-full bg-surface px-2 py-0.5 text-xs text-muted">2nd-hand</span> : null}
          {a.needs_review ? <span className="ml-2 rounded-full bg-warn/10 px-2 py-0.5 text-xs text-warn">review</span> : null}
        </td>
        <td className="px-4 py-2 text-muted">{CLASS_LABEL[a.asset_class] ?? a.asset_class}</td>
        <td className="px-4 py-2 text-right tabular-nums">{money(a.cost_cents)}</td>
        <td className="px-4 py-2 text-right tabular-nums">{money(a.this_fy_deduction_cents)}</td>
        <td className="px-4 py-2 text-right tabular-nums text-muted">{money(a.adjustable_value_cents)}</td>
        <td className="px-4 py-2 text-right"><button className="text-xs text-danger hover:underline" onClick={() => del.mutate()}>delete</button></td>
      </tr>
      {open && (
        <tr className="bg-surface/40">
          <td colSpan={6} className="px-4 py-3">
            {sched.isLoading ? <span className="text-xs text-muted">Loading schedule…</span> : (
              <table className="w-full text-xs">
                <thead><tr className="text-left text-muted"><th className="py-1">FY</th><th>Opening</th><th>Days</th><th>Deduction</th><th>Closing</th><th>Method</th></tr></thead>
                <tbody>
                  {(sched.data ?? []).map((s: ScheduleRow) => (
                    <tr key={s.fy} className="border-t border-line/60">
                      <td className="py-1 tabular-nums">{s.fy}</td>
                      <td className="tabular-nums">{money(s.opening_adjustable_value_cents)}</td>
                      <td className="tabular-nums">{s.days_held}</td>
                      <td className="tabular-nums font-medium">{money(s.deduction_cents)}</td>
                      <td className="tabular-nums">{money(s.closing_adjustable_value_cents)}</td>
                      <td className="text-muted">{s.method_applied}</td>
                    </tr>
                  ))}
                  {!(sched.data ?? []).length && <tr><td colSpan={6} className="py-2 text-muted">No schedule rows.</td></tr>}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function AddAssetForm({ onDone }: { onDone: () => void }) {
  const [label, setLabel] = useState("");
  const [assetClass, setAssetClass] = useState("div40_plant");
  const [cost, setCost] = useState("");
  const [acquired, setAcquired] = useState("");
  const [life, setLife] = useState("");
  const [method, setMethod] = useState("diminishing_value");
  const [ownedBy, setOwnedBy] = useState("self");
  const [reimbursed, setReimbursed] = useState(false);
  const [workPct, setWorkPct] = useState("100");
  const [isCar, setIsCar] = useState(false);
  const notMine = ownedBy === "employer" || reimbursed;
  const add = useMutation({
    mutationFn: () =>
      api.addAsset({
        label,
        asset_class: assetClass,
        cost_cents: Math.round(parseFloat(cost || "0") * 100),
        acquired_date: acquired,
        effective_life_years: life ? parseFloat(life) : null,
        method: assetClass === "div40_plant" ? method : null,
        div43_rate: assetClass === "div43_capital_works" ? 0.025 : null,
        owned_by: ownedBy,
        reimbursed: reimbursed ? 1 : 0,
        is_car: isCar ? 1 : 0,
        business_use_pct: workPct.trim() === "" ? 100 : Math.max(0, Math.min(100, Number(workPct))),
      } as Partial<AssetRow> & { method: string | null; div43_rate: number | null; owned_by: string; reimbursed: number; is_car: number; business_use_pct: number }),
    onSuccess: onDone,
  });
  return (
    <Card className="space-y-3 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className="text-sm">Label<Input className="mt-1 w-full" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
        <label className="text-sm">Class
          <select className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm" value={assetClass} onChange={(e) => setAssetClass(e.target.value)}>
            {Object.entries(CLASS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="text-sm">Cost ($)<Input className="mt-1 w-full" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} /></label>
        <label className="text-sm">Acquired<Input className="mt-1 w-full" type="date" value={acquired} onChange={(e) => setAcquired(e.target.value)} /></label>
        {assetClass === "div40_plant" && (
          <>
            <label className="text-sm">Effective life (yrs)<Input className="mt-1 w-full" inputMode="decimal" value={life} onChange={(e) => setLife(e.target.value)} /></label>
            <label className="text-sm">Method
              <select className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="diminishing_value">Diminishing value</option>
                <option value="prime_cost">Prime cost</option>
              </select>
            </label>
          </>
        )}
        <label className="text-sm">Who owns it?
          <select className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm" value={ownedBy} onChange={(e) => setOwnedBy(e.target.value)}>
            <option value="self">I bought it / it's mine</option>
            <option value="employer">Employer-owned</option>
          </select>
        </label>
        <label className="text-sm">% used for work<Input className="mt-1 w-full" inputMode="decimal" value={workPct} onChange={(e) => setWorkPct(e.target.value)} placeholder="100" /></label>
        <label className="flex items-center gap-2 text-sm sm:col-span-3">
          <input type="checkbox" checked={reimbursed} onChange={(e) => setReimbursed(e.target.checked)} />
          My employer reimbursed me for this
        </label>
        <label className="flex items-center gap-2 text-sm sm:col-span-3">
          <input type="checkbox" checked={isCar} onChange={(e) => setIsCar(e.target.checked)} />
          This is a motor vehicle (enables the logbook method below)
        </label>
      </div>
      {notMine && (
        <p className="rounded-lg bg-surface px-3 py-2 text-xs text-muted">
          You can't claim decline-in-value on gear your employer owns or reimbursed — you didn't bear the cost. We'll
          record it for your records but it won't appear as a deduction. General information only.
        </p>
      )}
      <Button onClick={() => add.mutate()} disabled={add.isPending || !label || !cost || !acquired}>{add.isPending ? "Saving…" : "Save asset"}</Button>
      {add.error && <p className="text-sm text-danger">{(add.error as Error).message}</p>}
    </Card>
  );
}

// Logbook (#142): a 12-week vehicle logbook. The report compares the logbook deduction (business-use % ×
// (running costs + car decline-in-value)) against cents-per-km and recommends the higher.
function VehicleLogbooks({ assets }: { assets: AssetRow[] }) {
  const qc = useQueryClient();
  const logs = useQuery({ queryKey: ["vehicle-logbooks"], queryFn: () => api.vehicleLogbooks() });
  const [adding, setAdding] = useState(false);
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["vehicle-logbooks"] }); qc.invalidateQueries({ queryKey: ["report"] }); };
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">Vehicle logbook</div>
        <Button variant="ghost" onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "+ Add a logbook"}</Button>
      </div>
      <p className="text-xs text-muted">A 12-week logbook gives your business-use %. We compare the logbook method (your % × running costs + car decline-in-value) with cents-per-km and recommend the higher on your report. General information only.</p>
      {adding && <AddLogbookForm assets={assets} onDone={() => { setAdding(false); invalidate(); }} />}
      {(logs.data ?? []).length > 0 && (
        <table className="w-full text-sm">
          <tbody>
            {(logs.data ?? []).map((l) => (
              <tr key={l.id} className="border-t border-line">
                <td className="px-2 py-1 tabular-nums">{l.fy}</td>
                <td className="px-2 py-1 text-muted tabular-nums">{l.business_use_pct != null ? `${Math.round(l.business_use_pct)}%` : l.total_km ? `${Math.round(((l.business_km ?? 0) / l.total_km) * 100)}%` : "—"} business</td>
                <td className="px-2 py-1 text-right tabular-nums text-muted">running {money(l.running_costs_cents)}</td>
                <td className="px-2 py-1 text-right"><button className="text-xs text-danger hover:underline" onClick={() => api.deleteVehicleLogbook(l.id).then(invalidate)}>delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function AddLogbookForm({ assets, onDone }: { assets: AssetRow[]; onDone: () => void }) {
  const [assetId, setAssetId] = useState("");
  const [businessKm, setBusinessKm] = useState("");
  const [totalKm, setTotalKm] = useState("");
  const [running, setRunning] = useState("");
  const add = useMutation({
    mutationFn: () => api.addVehicleLogbook({
      asset_id: assetId || null,
      business_km: businessKm ? Number(businessKm) : null,
      total_km: totalKm ? Number(totalKm) : null,
      running_costs_cents: Math.round(parseFloat(running || "0") * 100),
    }),
    onSuccess: onDone,
  });
  return (
    <Card className="space-y-3 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="text-sm">Car (optional)
          <select className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">— none —</option>
            {assets.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
        <label className="text-sm">Business km<Input className="mt-1 w-full" inputMode="numeric" value={businessKm} onChange={(e) => setBusinessKm(e.target.value)} /></label>
        <label className="text-sm">Total km<Input className="mt-1 w-full" inputMode="numeric" value={totalKm} onChange={(e) => setTotalKm(e.target.value)} /></label>
        <label className="text-sm">Running costs ($)<Input className="mt-1 w-full" inputMode="decimal" value={running} onChange={(e) => setRunning(e.target.value)} placeholder="fuel, rego, insurance…" /></label>
      </div>
      <Button onClick={() => add.mutate()} disabled={add.isPending || !running}>{add.isPending ? "Saving…" : "Save logbook"}</Button>
      {add.error && <p className="text-sm text-danger">{(add.error as Error).message}</p>}
    </Card>
  );
}
