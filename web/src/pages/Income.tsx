import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import { useFeatures } from "../lib/features";
import { Card, Spinner, Button, Input, money } from "../components/ui";
import type { IncomeRow, CgtAssetRow } from "../types";

function fyLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}
function defaultFyStart(): number {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

const INCOME_TYPES = [
  "salary_payg",
  "business",
  "rent",
  "interest",
  "dividend",
  "managed_fund_distribution",
  "foreign_pension",
  "foreign_rent",
  "foreign_business",
  "non_cash_benefit",
  "other",
] as const;

const TYPE_LABEL: Record<string, string> = {
  salary_payg: "Salary (PAYG)",
  business: "Business (sole trader)",
  rent: "Rent",
  interest: "Interest",
  dividend: "Dividend",
  managed_fund_distribution: "Managed fund",
  foreign_pension: "Foreign pension",
  foreign_rent: "Foreign rent",
  foreign_business: "Foreign business income",
  non_cash_benefit: "Non-cash benefit (captured, not in position)",
  other: "Other",
};

export function Income() {
  const [fyStart, setFyStart] = useState(defaultFyStart());
  const fy = fyLabel(fyStart);
  const qc = useQueryClient();
  const { has } = useFeatures();
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

      <IncomeDedupe />

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

      {has("cgt_engine") && <CapitalEquity />}
      {has("ess_engine") && <EssGrants />}

      <p className="text-xs text-muted">General information only — not tax advice.</p>
    </div>
  );
}

// CGT (#138): a capital register — holdings (cgt_assets) + disposals (cgt_events). The net capital gain
// (50% discount + capital-loss offset) is computed server-side and shown on the year-end report.
const CGT_KINDS = ["shares", "crypto", "property", "managed_fund", "other"] as const;
const KIND_LABEL: Record<string, string> = { shares: "Shares", crypto: "Crypto", property: "Property", managed_fund: "Managed fund", other: "Other" };
const kindLabel = (a: CgtAssetRow) => (KIND_LABEL[a.asset_kind] ?? a.asset_kind) + (a.code ? ` · ${a.code}` : "");

function CapitalEquity() {
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
        <div className="text-sm font-semibold">Capital &amp; equity (CGT)</div>
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
  const [assetId, setAssetId] = useState<string>(assets[0]?.id ?? "");
  const [date, setDate] = useState("");
  const [proceeds, setProceeds] = useState("");
  const [costUsed, setCostUsed] = useState("");
  const add = useMutation({
    mutationFn: () => api.addCgtEvent({ cgt_asset_id: assetId, event_date: date, proceeds_cents: Math.round(parseFloat(proceeds || "0") * 100), cost_base_used_cents: Math.round(parseFloat(costUsed || "0") * 100) }),
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
      </div>
      <Button onClick={() => add.mutate()} disabled={add.isPending || !date || !assetId}>{add.isPending ? "Saving…" : "Save disposal"}</Button>
      {add.error && <p className="text-sm text-danger">{(add.error as Error).message}</p>}
    </Card>
  );
}

// ESS (#141): employee share scheme grants. Upfront/deferral discounts are assessable; startup defers to CGT.
const ESS_SCHEMES = ["taxed_upfront", "deferral", "startup"] as const;
const SCHEME_LABEL: Record<string, string> = { taxed_upfront: "Taxed upfront", deferral: "Deferral", startup: "Startup concession" };

function EssGrants() {
  const qc = useQueryClient();
  const grants = useQuery({ queryKey: ["ess-grants"], queryFn: () => api.essGrants() });
  const [adding, setAdding] = useState(false);
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["ess-grants"] }); qc.invalidateQueries({ queryKey: ["report"] }); };
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">Employee share scheme (ESS)</div>
        <Button variant="ghost" onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "+ Add a grant"}</Button>
      </div>
      <p className="text-xs text-muted">RSUs / options from your employer. Taxed-upfront and deferral discounts are assessable income at their taxing point; a startup-concession grant isn't taxed now — it's a capital gain when you sell. General information only.</p>
      {adding && <AddEssGrantForm onDone={() => { setAdding(false); invalidate(); }} />}
      {(grants.data ?? []).length > 0 && (
        <table className="w-full text-sm">
          <tbody>
            {(grants.data ?? []).map((g) => (
              <tr key={g.id} className="border-t border-line">
                <td className="px-2 py-1">{SCHEME_LABEL[g.scheme_type] ?? g.scheme_type}{g.ownership_gt_10pct ? " · >10%" : ""}</td>
                <td className="px-2 py-1 text-muted tabular-nums">{g.taxing_point_date ?? g.grant_date ?? "—"}</td>
                <td className="px-2 py-1 text-right tabular-nums text-muted">discount {money(g.discount_cents)}</td>
                <td className="px-2 py-1 text-right"><button className="text-xs text-danger hover:underline" onClick={() => api.deleteEssGrant(g.id).then(invalidate)}>delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function AddEssGrantForm({ onDone }: { onDone: () => void }) {
  const [scheme, setScheme] = useState<string>("taxed_upfront");
  const [date, setDate] = useState("");
  const [discount, setDiscount] = useState("");
  const [gt10, setGt10] = useState(false);
  const add = useMutation({
    mutationFn: () => api.addEssGrant({ scheme_type: scheme, taxing_point_date: date || null, grant_date: date || null, discount_cents: Math.round(parseFloat(discount || "0") * 100), ownership_gt_10pct: gt10 ? 1 : 0 }),
    onSuccess: onDone,
  });
  return (
    <Card className="space-y-3 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="text-sm">Scheme
          <select className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm" value={scheme} onChange={(e) => setScheme(e.target.value)}>
            {ESS_SCHEMES.map((s) => <option key={s} value={s}>{SCHEME_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="text-sm">Taxing point<Input className="mt-1 w-full" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="text-sm">Discount ($)<Input className="mt-1 w-full" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} /></label>
        <label className="mt-6 flex items-center gap-2 text-sm"><input type="checkbox" checked={gt10} onChange={(e) => setGt10(e.target.checked)} /> Own &gt;10%</label>
      </div>
      <Button onClick={() => add.mutate()} disabled={add.isPending || !discount}>{add.isPending ? "Saving…" : "Save grant"}</Button>
      {add.error && <p className="text-sm text-danger">{(add.error as Error).message}</p>}
    </Card>
  );
}

// Income de-dup (flag income_dedupe): surfaces credit bank-lines that look like a documented
// income row so the user can confirm the pair counts once (not double). Suggest-only — nothing is
// merged until the user clicks Link. Hidden when the flag is off or there's nothing to reconcile.
function IncomeDedupe() {
  const { has } = useFeatures();
  const qc = useQueryClient();
  const enabled = has("income_dedupe");
  const { data } = useQuery({ queryKey: ["income-matches"], queryFn: () => api.incomeMatches(), enabled });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["income-matches"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["report"] }); // dedupe changes the report's income section
  };
  const link = useMutation({
    mutationFn: (v: { txnId: string; incomeId: string }) => api.linkIncome(v.txnId, v.incomeId),
    onSuccess: () => { toast.success("Linked — counted once in your reports."); refresh(); },
    onError: (e) => toast.error("Couldn't link", { description: (e as Error).message }),
  });
  const unlink = useMutation({
    mutationFn: (txnId: string) => api.unlinkIncome(txnId),
    onSuccess: () => { toast.success("Unlinked — the credit counts on its own again."); refresh(); },
    onError: (e) => toast.error("Couldn't unlink", { description: (e as Error).message }),
  });
  if (!enabled || !data || (!data.suggestions.length && !data.matched.length)) return null;
  return (
    <Card className="space-y-3 p-4">
      <div className="text-sm font-semibold">Possible duplicate income</div>
      <p className="text-xs text-muted">
        A bank credit that looks like a payslip/documented income row would otherwise count twice.
        Link a pair so it counts once. General information only — confirm with a registered tax agent.
      </p>
      {data.suggestions.map((s) => (
        <div key={s.txn_id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-sm">
          <div>
            <span className="font-medium">{s.merchant ?? "Bank credit"}</span>{" "}
            <span className="tabular-nums">{money(s.txn_amount_cents)}</span>{" "}
            <span className="text-muted">{s.txn_date ?? ""}</span>
            <span className="text-muted"> ≈ {s.income_type} {money(s.income_gross_cents)}{s.income_date ? ` (${s.income_date})` : ""}</span>
          </div>
          <Button onClick={() => link.mutate({ txnId: s.txn_id, incomeId: s.income_id })} disabled={link.isPending}>
            Link (count once)
          </Button>
        </div>
      ))}
      {data.matched.map((m) => (
        <div key={m.txn_id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-sm text-muted">
          <div>
            Linked: <span className="font-medium text-ink">{m.merchant ?? "Bank credit"}</span>{" "}
            <span className="tabular-nums">{money(m.txn_amount_cents)}</span> ↔ {m.income_type} {money(m.income_gross_cents)}
          </div>
          <Button variant="ghost" onClick={() => unlink.mutate(m.txn_id)} disabled={unlink.isPending}>Unlink</Button>
        </div>
      ))}
    </Card>
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
  const [entityId, setEntityId] = useState("");
  // Entities you can attribute income to (company / trust / SMSF). Default "" = you (the individual).
  // SMSF/company/trust are separate taxpayers, so attributing fund earnings here keeps them off your
  // personal position and feeds the per-entity reads (e.g. smsfFundPositions sums income by entity_id).
  const { data: sit } = useQuery({ queryKey: ["situation"], queryFn: () => api.situation() });
  const entities = (sit?.entities ?? []).filter((e) => e.kind === "company" || e.kind === "trust" || e.kind === "smsf");
  const add = useMutation({
    mutationFn: () =>
      api.addIncome({
        income_type: type,
        fy,
        gross_cents: Math.round(parseFloat(gross || "0") * 100),
        withholding_cents: Math.round(parseFloat(withheld || "0") * 100),
        franking_credit_cents: Math.round(parseFloat(franking || "0") * 100),
        txn_date: date || null,
        entity_id: entityId || null,
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
        {entities.length > 0 && (
          <label className="text-sm">Attribute to
            <select className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
              <option value="">Me (individual)</option>
              {entities.map((e) => <option key={e.id} value={e.id}>{e.name ?? e.kind}</option>)}
            </select>
          </label>
        )}
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
