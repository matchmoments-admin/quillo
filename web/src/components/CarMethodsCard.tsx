import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import { useFeatures } from "../lib/features";
import { Card, Button, Input, money, parseMoneyToCents } from "./ui";
import type { AssetRow } from "../types";

// Car deductions — its own tool (#245), split out of the work-from-home panel: car has nothing to do
// with WFH. Two ATO methods, you claim ONE:
//   • Cents-per-km: min(work km, 5,000) × 88c. Simple, no receipts; best for ≤5,000 work km.
//   • Logbook: a 12-week logbook gives business-use %, applied to actual running costs + car decline-in-
//     value, with no km cap; best for heavy/expensive-car use. The report computes both and recommends
//     the higher. GENERAL INFO ONLY — confirm with a registered tax agent.
export function CarMethodsCard({ fyNum }: { fyNum: number }) {
  const qc = useQueryClient();
  const { has } = useFeatures();
  const centsPerKmEnabled = has("car_methods");
  const data = useQuery({ queryKey: ["car-use", fyNum], queryFn: () => api.carUse(fyNum), enabled: centsPerKmEnabled });
  const report = useQuery({ queryKey: ["report", fyNum], queryFn: () => api.report(fyNum) });
  // Assets feed only the logbook block — don't fetch them unless that block renders.
  const assets = useQuery({ queryKey: ["assets"], queryFn: () => api.assets(), enabled: has("car_logbook") });
  const [km, setKm] = useState<string>("");
  const [seeded, setSeeded] = useState<number | null>(null);
  if (centsPerKmEnabled && data.data && seeded !== fyNum) {
    setKm(data.data.work_km != null ? String(data.data.work_km) : "");
    setSeeded(fyNum);
  }
  const estCar = Math.round(Math.min(Number(km) || 0, 5000) * 88);
  const cl = report.data?.car_logbook;

  const save = useMutation({
    mutationFn: () => api.setCarUse(fyNum, { work_km: km.trim() === "" ? null : Math.max(0, Number(km)) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["car-use", fyNum] });
      qc.invalidateQueries({ queryKey: ["report"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Saved your car km.");
    },
    onError: (e) => toast.error("Couldn't save", { description: (e as Error).message }),
  });

  return (
    <Card className="space-y-3 p-4">
      <div>
        <div className="text-sm font-semibold">Car expenses</div>
        <div className="text-xs text-muted">
          Two ATO methods — you can claim only <span className="font-medium">one</span>. <span className="font-medium">Cents-per-km</span> is
          simple (no receipts, capped at 5,000 work km); a <span className="font-medium">logbook</span> can claim more for heavy or
          expensive-car use. Your report compares both and recommends the higher. General information only.
        </div>
      </div>

      {centsPerKmEnabled && (
        <label className="block text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Work-related car km this year (cents-per-km)</span>
          <Input type="number" min="0" value={km} onChange={(e) => setKm(e.target.value)} placeholder="e.g. 1200" />
          <span className="mt-0.5 block text-xs text-muted">≈ {money(estCar)} at 88c/km (max 5,000 km)</span>
          <div className="mt-2"><Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save km"}</Button></div>
        </label>
      )}

      {cl && (
        <p className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-muted">
          Logbook ({Math.round(cl.business_use_pct)}% business) = <span className="font-medium text-ink">{money(cl.logbook_deduction_cents)}</span> vs
          cents-per-km <span className="font-medium text-ink">{money(cl.cents_per_km_cents)}</span> — recommended:{" "}
          <span className="font-medium text-ink">{cl.recommended_method === "logbook" ? "logbook" : "cents-per-km"}</span> ({money(cl.recommended_cents)}).
        </p>
      )}

      {has("car_logbook") && <VehicleLogbooks assets={assets.data ?? []} />}
    </Card>
  );
}

// Logbook (#142): a 12-week vehicle logbook. The report compares the logbook deduction (business-use % ×
// (running costs + car decline-in-value)) against cents-per-km and recommends the higher. Lifted from the
// Assets page (#245) so the whole car concern lives in one tool.
function VehicleLogbooks({ assets }: { assets: AssetRow[] }) {
  const qc = useQueryClient();
  const logs = useQuery({ queryKey: ["vehicle-logbooks"], queryFn: () => api.vehicleLogbooks() });
  const [adding, setAdding] = useState(false);
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["vehicle-logbooks"] }); qc.invalidateQueries({ queryKey: ["report"] }); };
  return (
    <div className="space-y-3 border-t border-line pt-3">
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
                <td className="px-2 py-1 text-right"><button className="text-xs text-danger hover:underline" onClick={() => { if (confirm("Delete this logbook? You'll need to re-enter the km and running costs.")) api.deleteVehicleLogbook(l.id).then(invalidate); }}>delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
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
      running_costs_cents: parseMoneyToCents(running) ?? 0,
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
      {/* Require both km figures: without them business_use_pct can't be derived and the row is dead
          weight (and total_km=0 would make the %-of-business calc meaningless). */}
      <Button onClick={() => add.mutate()} disabled={add.isPending || !running || !businessKm.trim() || !(Number(totalKm) > 0)}>{add.isPending ? "Saving…" : "Save logbook"}</Button>
      {add.error && <p className="text-sm text-danger">{(add.error as Error).message}</p>}
    </Card>
  );
}
