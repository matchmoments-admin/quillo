import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { Card, Button, Input, money, InfoTip } from "../ui";
import type { CgtAssetRow } from "../../types";
import { useFeatures } from "../../lib/features";
import { parseCostBaseElements } from "../../lib/capital";

const CGT_KINDS = ["shares", "crypto", "property", "managed_fund", "other"] as const;
const KIND_LABEL: Record<string, string> = { shares: "Shares", crypto: "Crypto", property: "Property", managed_fund: "Managed fund", other: "Other" };
const kindLabel = (a: CgtAssetRow) => (KIND_LABEL[a.asset_kind] ?? a.asset_kind) + (a.code ? ` · ${a.code}` : "");
// Units are fractional by nature (DRP reinvestments, crypto) — render what was entered, never round.
const unitsLabel = (u: number | null | undefined) => (u == null ? "—" : String(u));

// cgt_assets.units is the ACQUIRED parcel size and cgt_assets.status has been the literal 'held' since
// migration 0037, updated by nothing. Rendering those two raw (as C0 shipped) meant a holding still read
// "200 units · held" after the taxpayer sold 100 of them.
//
// The parcel row staying immutable is the RIGHT model — remaining quantity is DERIVED, so the acquisition
// record is never rewritten. capital_position (C3) now derives it SERVER-side and ships it as `position`, so
// there is ONE definition of "remaining" rather than a client copy waiting to drift from it. The local
// fallback below covers flag-OFF only, where no `position` is sent.
const STATUS_TEXT: Record<string, string> = { held: "held", part_disposed: "part sold", disposed: "sold" };
function localPosition(units: number | null | undefined, disposedUnits: number, hasEvents: boolean) {
  if (!hasEvents) return { units_remaining: units ?? null, status: "held" as const };
  if (units == null) return { units_remaining: null, status: "part_disposed" as const };
  const remaining = units - disposedUnits;
  return remaining <= 0 ? { units_remaining: 0, status: "disposed" as const } : { units_remaining: remaining, status: "part_disposed" as const };
}

export function CapitalEquity() {
  const qc = useQueryClient();
  const { has } = useFeatures();
  const holdingDetail = has("capital_holding_detail");
  const entityScope = has("capital_entity_scope");
  const fromTxn = has("capital_from_txn");
  const incomeLink = has("capital_income_link");
  const costBaseDetail = has("capital_cost_base_detail");
  const positionOn = has("capital_position");
  const assets = useQuery({ queryKey: ["cgt-assets"], queryFn: () => api.cgtAssets() });
  const events = useQuery({ queryKey: ["cgt-events"], queryFn: () => api.cgtEvents() });
  // capital_entity_scope: resolve entity names so a non-personal holding is visibly attributed — an
  // entity's gain is excluded from your headline, and that must be legible, not silent.
  const { data: sit } = useQuery({ queryKey: ["situation"], queryFn: () => api.situation(), enabled: entityScope });
  // capital_income_link (C-L): the reverse of the Income page's picker — a holding lists the dividends and
  // distributions recorded against it, so the association is visible from both ends (§4 of the brief: "a
  // holding must be selectable from a dividend row, and vice versa").
  const linkedIncome = useQuery({ queryKey: ["income", "by-holding"], queryFn: () => api.income(), enabled: incomeLink });
  const incomeFor = (assetId: string) => (linkedIncome.data ?? []).filter((r) => r.cgt_asset_id === assetId);
  const entityName = (entityId: string | null | undefined) =>
    (entityId ? (sit?.entities ?? []).find((e) => e.id === entityId) : null)?.name ?? null;
  const [addingAsset, setAddingAsset] = useState(false);
  const [addingEvent, setAddingEvent] = useState(false);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["cgt-assets"] });
    qc.invalidateQueries({ queryKey: ["cgt-events"] });
    qc.invalidateQueries({ queryKey: ["report"] }); // a disposal changes the net capital gain
  };
  const assetList = assets.data ?? [];
  const eventList = events.data ?? [];
  const disposedUnitsFor = (assetId: string) =>
    eventList.filter((e) => e.cgt_asset_id === assetId).reduce((t, e) => t + (e.units_disposed ?? 0), 0);
  const hasEventsFor = (assetId: string) => eventList.some((e) => e.cgt_asset_id === assetId);
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
                <td className="px-2 py-1">
                  {kindLabel(a)}
                  {holdingDetail && a.label ? <span className="text-muted"> · {a.label}</span> : null}
                  {entityScope && a.entity_id ? <span className="text-muted"> · held by {entityName(a.entity_id) ?? "an entity"} (not in your position)</span> : null}
                  {/* capital_from_txn: seeded from a brokerage deposit. A bank line can't evidence a
                      quantity, so say so plainly rather than presenting a half-record as complete. */}
                  {fromTxn && a.txn_id && a.units == null ? (
                    <span className="text-warn"> · from a deposit — confirm units &amp; cost base</span>
                  ) : null}
                  {incomeLink && incomeFor(a.id).length > 0 ? (
                    <span className="text-muted"> · {incomeFor(a.id).length} income record{incomeFor(a.id).length === 1 ? "" : "s"} ({money(incomeFor(a.id).reduce((t, r) => t + (r.amount_aud_cents ?? r.gross_cents), 0))})</span>
                  ) : null}
                </td>
                {/* capital_holding_detail: units + status were always stored and returned; nothing ever
                    captured or showed them, so a part-disposal couldn't be checked against what's held. */}
                {holdingDetail && (() => {
                  const pos = a.position ?? localPosition(a.units, disposedUnitsFor(a.id), hasEventsFor(a.id));
                  return (
                    <td className="px-2 py-1 text-right tabular-nums text-muted">
                      {pos.status === "part_disposed" && a.units != null
                        ? <>{unitsLabel(pos.units_remaining)} of {unitsLabel(a.units)} units</>
                        : <>{unitsLabel(pos.units_remaining)} units</>}
                    </td>
                  );
                })()}
                <td className="px-2 py-1 text-muted tabular-nums">{a.acquired_date ?? "—"}</td>
                <td className="px-2 py-1 text-right tabular-nums text-muted">
                  {/* C3: once something has been sold, the useful figure is what cost base is LEFT to set
                      against a future sale — not what the parcel originally cost. */}
                  {positionOn && a.position && a.position.cost_base_used_cents > 0
                    ? <>cost base left {money(a.position.cost_base_remaining_cents)} <span className="text-xs">of {money(a.cost_base_cents)}</span></>
                    : <>cost base {money(a.cost_base_cents)}</>}
                  {/* C2: show WHAT the cost base is made of, so the brokerage 0037 promised is visible
                      rather than buried in one opaque number. */}
                  {costBaseDetail && (() => {
                    const el = parseCostBaseElements(a.detail_json ?? null);
                    if (!el || el.brokerage_cents + el.incidental_cents === 0) return null;
                    return <span className="block text-xs">incl. {money(el.brokerage_cents + el.incidental_cents)} costs</span>;
                  })()}
                </td>
                {holdingDetail && (() => {
                  const pos = a.position ?? localPosition(a.units, disposedUnitsFor(a.id), hasEventsFor(a.id));
                  // The two over-conditions are DIFFERENT mistakes and must not share one label: units can
                  // be right while the cost base claimed across sales is over-stated, and telling that user
                  // "sold more than recorded" sends them to check the wrong figure. Both are surfaced,
                  // never blocked — a missing earlier parcel is the usual cause and the registered agent
                  // decides. Readiness carries the full explanation for each.
                  const overUnits = (a.position?.over_disposed_units ?? 0) > 0;
                  const overCost = (a.position?.over_used_cost_base_cents ?? 0) > 0;
                  return (
                    <td className="px-2 py-1 text-right text-xs text-muted">
                      {STATUS_TEXT[pos.status] ?? pos.status}
                      {overUnits ? <span className="block text-warn">sold more units than recorded — check</span> : null}
                      {overCost ? <span className="block text-warn">claimed more cost than this parcel cost — check</span> : null}
                    </td>
                  );
                })()}
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
                  {holdingDetail && <td className="px-2 py-1 text-right tabular-nums text-muted">{unitsLabel(e.units_disposed)} units</td>}
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
  const { has } = useFeatures();
  const holdingDetail = has("capital_holding_detail");
  const entityScope = has("capital_entity_scope");
  // capital_cost_base_detail (C2): migration 0037 promised "purchase + incidental costs (brokerage)" and
  // nothing ever captured them. cost_base_cents is now COMPUTED from these elements server-side, so the one
  // figure the engine reads can't disagree with the itemisation shown here.
  const costBaseDetail = has("capital_cost_base_detail");
  const [brokerage, setBrokerage] = useState("");
  const [incidental, setIncidental] = useState("");
  const [cbNote, setCbNote] = useState("");
  const [kind, setKind] = useState<string>("shares");
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [units, setUnits] = useState("");
  const [personId, setPersonId] = useState("");
  const [entityId, setEntityId] = useState("");
  const [acquired, setAcquired] = useState("");
  const [costBase, setCostBase] = useState("");
  // Owner picker: only worth showing once the tenant has more than the self person. "" = you, and the
  // server defaults to person_self_<uid> — so the payload stays identical for a single-person tenant.
  const { data: sit } = useQuery({ queryKey: ["situation"], queryFn: () => api.situation(), enabled: holdingDetail || entityScope });
  const persons = sit?.persons ?? [];
  // capital_entity_scope: a company/trust/SMSF is a SEPARATE TAXPAYER that lodges its own return, so its
  // holding must not reach your personal position. Same entity set the Income page offers.
  const entities = (sit?.entities ?? []).filter((e) => e.kind === "company" || e.kind === "trust" || e.kind === "smsf");
  const add = useMutation({
    mutationFn: () => api.addCgtAsset({
      asset_kind: kind, code: code || null, acquired_date: acquired || null,
      cost_base_cents: Math.round(parseFloat(costBase || "0") * 100),
      // The server recomputes cost_base_cents from the elements when they validate, so the two can never
      // drift. Selling costs are deliberately absent — they reduce proceeds, not the cost base.
      ...(costBaseDetail ? {
        cost_base_elements: {
          purchase_cents: Math.round(parseFloat(costBase || "0") * 100),
          brokerage_cents: Math.round(parseFloat(brokerage || "0") * 100),
          incidental_cents: Math.round(parseFloat(incidental || "0") * 100),
          other_cents: 0,
          note: cbNote || null,
        },
      } : {}),
      // capital_holding_detail: units/label/owner. Units are parsed as a plain float (fractional by
      // nature — DRP reinvestments, crypto) and left null when blank, which is today's stored value.
      ...(holdingDetail ? { units: units ? parseFloat(units) : null, label: label || null, person_id: personId || null } : {}),
      ...(entityScope ? { entity_id: entityId || null } : {}),
    }),
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
        {holdingDetail && <label className="text-sm">Units held<Input className="mt-1 w-full" inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value)} placeholder="e.g. 120 or 0.5" /></label>}
        <label className="text-sm">Acquired<Input className="mt-1 w-full" type="date" value={acquired} onChange={(e) => setAcquired(e.target.value)} /></label>
        <label className="text-sm">{costBaseDetail ? "Purchase price ($)" : "Cost base ($)"}<Input className="mt-1 w-full" inputMode="decimal" value={costBase} onChange={(e) => setCostBase(e.target.value)} /></label>
        {costBaseDetail && <label className="text-sm">Brokerage ($)<Input className="mt-1 w-full" inputMode="decimal" value={brokerage} onChange={(e) => setBrokerage(e.target.value)} placeholder="e.g. 9.50" /></label>}
        {costBaseDetail && <label className="text-sm">Other costs ($)<Input className="mt-1 w-full" inputMode="decimal" value={incidental} onChange={(e) => setIncidental(e.target.value)} placeholder="transfer duty, fees" /></label>}
        {costBaseDetail && <label className="text-sm">Evidence<Input className="mt-1 w-full" value={cbNote} onChange={(e) => setCbNote(e.target.value)} placeholder="CommSec contract note 1234" /></label>}
        {holdingDetail && <label className="text-sm">Description<Input className="mt-1 w-full" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Commonwealth Bank" /></label>}
        {holdingDetail && persons.length > 1 && (
          <label className="text-sm">Owner
            <select className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm" value={personId} onChange={(e) => setPersonId(e.target.value)}>
              <option value="">You</option>
              {persons.filter((p) => p.role !== "self").map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
            </select>
          </label>
        )}
        {entityScope && entities.length > 0 && (
          <label className="text-sm">Held by
            <select className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
              <option value="">You (personally)</option>
              {entities.map((e) => <option key={e.id} value={e.id}>{e.name ?? e.kind}</option>)}
            </select>
          </label>
        )}
      </div>
      {holdingDetail && (
        <p className="text-xs text-muted">Units let us check a part-sale against what you actually hold. General information only; confirm with a registered tax agent.</p>
      )}
      {costBaseDetail && (
        <p className="text-xs text-muted">
          Your cost base is the purchase price <strong>plus</strong> brokerage and other incidental costs — {money(
            Math.round(parseFloat(costBase || "0") * 100) + Math.round(parseFloat(brokerage || "0") * 100) + Math.round(parseFloat(incidental || "0") * 100),
          )} here. A bigger cost base means a smaller capital gain when you sell. Don't include the brokerage on
          the <em>sale</em> — that reduces the sale proceeds instead, and counting it twice would understate the gain.
          Cost-base elements are fact-specific; confirm with a registered tax agent.
        </p>
      )}
      {entityScope && entities.length > 0 && (
        <p className="text-xs text-muted">A company, trust or SMSF is a separate taxpayer that lodges its own return, so a holding you mark as held by one stays out of your personal position. Confirm the treatment with a registered tax agent.</p>
      )}
      <Button onClick={() => add.mutate()} disabled={add.isPending || !costBase}>{add.isPending ? "Saving…" : "Save holding"}</Button>
      {add.error && <p className="text-sm text-danger">{(add.error as Error).message}</p>}
    </Card>
  );
}

function AddCgtEventForm({ assets, onDone }: { assets: CgtAssetRow[]; onDone: () => void }) {
  const { has } = useFeatures();
  const parcelMethod = has("cgt_parcel_method");
  const holdingDetail = has("capital_holding_detail");
  const [assetId, setAssetId] = useState<string>(assets[0]?.id ?? "");
  const [date, setDate] = useState("");
  const [proceeds, setProceeds] = useState("");
  const [costUsed, setCostUsed] = useState("");
  const [unitsDisposed, setUnitsDisposed] = useState("");
  const [method, setMethod] = useState("specific_id");
  const add = useMutation({
    mutationFn: () => api.addCgtEvent({
      cgt_asset_id: assetId, event_date: date,
      proceeds_cents: Math.round(parseFloat(proceeds || "0") * 100),
      cost_base_used_cents: Math.round(parseFloat(costUsed || "0") * 100),
      ...(parcelMethod ? { method } : {}),
      // capital_holding_detail: the schedule has always printed a Units column from this value; nothing
      // ever set it. Blank ⇒ null ⇒ the column stays blank exactly as today.
      ...(holdingDetail ? { units_disposed: unitsDisposed ? parseFloat(unitsDisposed) : null } : {}),
    }),
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
        {holdingDetail && <label className="text-sm">Units sold<Input className="mt-1 w-full" inputMode="decimal" value={unitsDisposed} onChange={(e) => setUnitsDisposed(e.target.value)} placeholder="e.g. 50" /></label>}
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
