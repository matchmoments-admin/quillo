import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { Card, Button, Input, money, InfoTip } from "../ui";
import type { CgtAssetRow } from "../../types";
import { useFeatures } from "../../lib/features";

const CGT_KINDS = ["shares", "crypto", "property", "managed_fund", "other"] as const;
const KIND_LABEL: Record<string, string> = { shares: "Shares", crypto: "Crypto", property: "Property", managed_fund: "Managed fund", other: "Other" };
const kindLabel = (a: CgtAssetRow) => (KIND_LABEL[a.asset_kind] ?? a.asset_kind) + (a.code ? ` · ${a.code}` : "");

export function CapitalEquity() {
  const qc = useQueryClient();
  const assets = useQuery({ queryKey: ["cgt-assets"], queryFn: () => api.cgtAssets() });
  const events = useQuery({ queryKey: ["cgt-events"], queryFn: () => api.cgtEvents() });
  const [addingAsset, setAddingAsset] = useState(false);
  const [addingEvent, setAddingEvent] = useState(false);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["cgt-assets"] });
    qc.invalidateQueries({ queryKey: ["cgt-events"] });
    qc.invalidateQueries({ queryKey: ["report"] }); // a disposal changes the net capital gain
  };
  const assetList = assets.data ?? [];
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">Capital &amp; equity (CGT) <InfoTip k="capital_gains" /></div>
        <Button variant="ghost" onClick={() => setAddingAsset((v) => !v)}>{addingAsset ? "Cancel" : "+ Add a holding"}</Button>
      </div>
      <p className="text-xs text-muted">Record what you hold (shares, crypto, property) and what you sold. The net capital gain — after capital losses and the 50% discount on assets held 12+ months — appears on your year-end report. General information only; confirm with a registered tax agent.</p>
      {addingAsset && <AddCgtAssetForm onDone={() => { setAddingAsset(false); invalidate(); }} />}
      {assetList.length > 0 && (
        <table className="w-full text-sm">
          <tbody>
            {assetList.map((a) => (
              <tr key={a.id} className="border-t border-line">
                <td className="px-2 py-1">{kindLabel(a)}</td>
                <td className="px-2 py-1 text-muted tabular-nums">{a.acquired_date ?? "—"}</td>
                <td className="px-2 py-1 text-right tabular-nums text-muted">cost base {money(a.cost_base_cents)}</td>
                <td className="px-2 py-1 text-right"><button className="text-xs text-danger hover:underline" onClick={() => api.deleteCgtAsset(a.id).then(invalidate)}>delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex items-center justify-between border-t border-line pt-2">
        <div className="text-xs uppercase tracking-wide text-muted">Disposals (sell / swap / spend)</div>
        <Button variant="ghost" disabled={!assetList.length} onClick={() => setAddingEvent((v) => !v)}>{addingEvent ? "Cancel" : "+ Record a disposal"}</Button>
      </div>
      {addingEvent && assetList.length > 0 && <AddCgtEventForm assets={assetList} onDone={() => { setAddingEvent(false); invalidate(); }} />}
      {(events.data ?? []).length > 0 && (
        <table className="w-full text-sm">
          <tbody>
            {(events.data ?? []).map((e) => {
              const a = assetList.find((x) => x.id === e.cgt_asset_id);
              return (
                <tr key={e.id} className="border-t border-line">
                  <td className="px-2 py-1">{a ? kindLabel(a) : e.cgt_asset_id}</td>
                  <td className="px-2 py-1 text-muted tabular-nums">{e.event_date}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted">proceeds {money(e.proceeds_cents)} − cost {money(e.cost_base_used_cents)}</td>
                  <td className={`px-2 py-1 text-right tabular-nums font-medium ${e.proceeds_cents - e.cost_base_used_cents < 0 ? "text-danger" : ""}`}>{money(e.proceeds_cents - e.cost_base_used_cents)}</td>
                  <td className="px-2 py-1 text-right"><button className="text-xs text-danger hover:underline" onClick={() => api.deleteCgtEvent(e.id).then(invalidate)}>delete</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function AddCgtAssetForm({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState<string>("shares");
  const [code, setCode] = useState("");
  const [acquired, setAcquired] = useState("");
  const [costBase, setCostBase] = useState("");
  const add = useMutation({
    mutationFn: () => api.addCgtAsset({ asset_kind: kind, code: code || null, acquired_date: acquired || null, cost_base_cents: Math.round(parseFloat(costBase || "0") * 100) }),
    onSuccess: onDone,
  });
  return (
    <Card className="space-y-3 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="text-sm">Kind
          <select className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value)}>
            {CGT_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="text-sm">Code / name<Input className="mt-1 w-full" value={code} onChange={(e) => setCode(e.target.value)} placeholder="CBA, BTC…" /></label>
        <label className="text-sm">Acquired<Input className="mt-1 w-full" type="date" value={acquired} onChange={(e) => setAcquired(e.target.value)} /></label>
        <label className="text-sm">Cost base ($)<Input className="mt-1 w-full" inputMode="decimal" value={costBase} onChange={(e) => setCostBase(e.target.value)} /></label>
      </div>
      <Button onClick={() => add.mutate()} disabled={add.isPending || !costBase}>{add.isPending ? "Saving…" : "Save holding"}</Button>
      {add.error && <p className="text-sm text-danger">{(add.error as Error).message}</p>}
    </Card>
  );
}

function AddCgtEventForm({ assets, onDone }: { assets: CgtAssetRow[]; onDone: () => void }) {
  const { has } = useFeatures();
  const parcelMethod = has("cgt_parcel_method");
  const [assetId, setAssetId] = useState<string>(assets[0]?.id ?? "");
  const [date, setDate] = useState("");
  const [proceeds, setProceeds] = useState("");
  const [costUsed, setCostUsed] = useState("");
  const [method, setMethod] = useState("specific_id");
  const add = useMutation({
    mutationFn: () => api.addCgtEvent({ cgt_asset_id: assetId, event_date: date, proceeds_cents: Math.round(parseFloat(proceeds || "0") * 100), cost_base_used_cents: Math.round(parseFloat(costUsed || "0") * 100), ...(parcelMethod ? { method } : {}) }),
    onSuccess: onDone,
  });
  return (
    <Card className="space-y-3 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="text-sm">Holding
          <select className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            {assets.map((a) => <option key={a.id} value={a.id}>{kindLabel(a)}</option>)}
          </select>
        </label>
        <label className="text-sm">Disposal date<Input className="mt-1 w-full" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="text-sm">Proceeds ($)<Input className="mt-1 w-full" inputMode="decimal" value={proceeds} onChange={(e) => setProceeds(e.target.value)} /></label>
        <label className="text-sm">Cost base used ($)<Input className="mt-1 w-full" inputMode="decimal" value={costUsed} onChange={(e) => setCostUsed(e.target.value)} /></label>
        {/* cgt_parcel_method: records WHICH parcels the cost base represents. Parcel choice changes the
            gain — general information only, confirm with a registered tax agent. */}
        {parcelMethod && (
          <label className="text-sm">Parcel selection
            <select className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="specific_id">Specific parcels (I chose which)</option>
              <option value="fifo">First in, first out (FIFO)</option>
            </select>
          </label>
        )}
      </div>
      <Button onClick={() => add.mutate()} disabled={add.isPending || !date || !assetId}>{add.isPending ? "Saving…" : "Save disposal"}</Button>
      {add.error && <p className="text-sm text-danger">{(add.error as Error).message}</p>}
    </Card>
  );
}
