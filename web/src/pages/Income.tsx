import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import { useFeatures } from "../lib/features";
import { useActiveFy } from "../lib/activeFy";
import { Card, Spinner, Button, Input, money, InfoTip } from "../components/ui";
import { CapitalEquity } from "../components/income/CapitalEquity";
import { EssGrants } from "../components/income/EssGrants";
import type { IncomeRow } from "../types";

// Mirror of src/lib/ledger-totals.ts NON_ASSESSABLE_INCOME_TYPES — income types captured but EXCLUDED
// from the assessable position. Keep in sync with the server (the source of truth for the math).
const NON_ASSESSABLE_INCOME_TYPES = new Set(["non_cash_benefit", "super_pension", "employment_lump_sum"]);

// AU financial-year bounds for a start year (1 Jul → 30 Jun). Used to FY-scope client-side lists.
function fyBounds(startYear: number): { from: string; to: string } {
  return { from: `${startYear}-07-01`, to: `${startYear + 1}-06-30` };
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
  "super_pension",
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
  super_pension: "Super pension (captured, not in position)",
  other: "Other",
};

export function Income() {
  // Single source of truth for the FY: the app-wide header switcher (no second control on this page).
  const { fy: fyStart, label: fy } = useActiveFy();
  const qc = useQueryClient();
  const { has } = useFeatures();
  const { data, isLoading, error } = useQuery({ queryKey: ["income", fy], queryFn: () => api.income({ fy }) });
  const [adding, setAdding] = useState(false);

  // #A1: upload an income statement → the existing documents-upload → payslip-extract → recordIncome path.
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadDocument(file),
    onMutate: () => setNote("Reading your income statement with Claude…"),
    onSuccess: (r) => {
      if (r.routed && r.doc_type === "payslip") {
        setNote("Income statement read — check the row below (switch to the statement's FY; confirm anything flagged for review).");
        qc.invalidateQueries({ queryKey: ["income"] }); // any FY — the statement may land in a different year
        qc.invalidateQueries({ queryKey: ["dashboard"] });
        qc.invalidateQueries({ queryKey: ["transactions"] });
      } else if (!r.routed && r.doc_type === "payslip") {
        // The exact-duplicate guard short-circuits a re-upload of the same file — it's not a read failure.
        setNote("You've already uploaded this exact file — it's in Documents. To re-read it, delete it there first, then upload again.");
      } else if (r.doc_type === "unknown") {
        setNote("Couldn't process it — this usually means AI consent (onboarding/Settings) or budget. Check Documents.");
      } else {
        setNote(`Filed to Documents as "${r.doc_type}" — that didn't read as an income statement. Add it manually below if needed.`);
      }
    },
    onError: (e) => {
      const msg = (e as Error).message;
      setNote(msg.includes("consent") ? "We need your consent to read documents with AI — set that up in onboarding/Settings first." : `Couldn't read it: ${msg}`);
    },
  });

  // The "Gross income" card must show the ASSESSABLE total — capture-only types (lump sums, super pension,
  // non-cash) are excluded from the position (mirrors NON_ASSESSABLE_INCOME_TYPES in ledger-totals.ts).
  // Gated on income_statement_multi so OFF is byte-identical (and this also fixes a pre-existing bug where
  // super_pension/non_cash inflated the card). Inert when the user has no such rows.
  const showAssessableSplit = has("income_statement_multi");
  const rows = data ?? [];
  const capturedRows = showAssessableSplit ? rows.filter((r) => NON_ASSESSABLE_INCOME_TYPES.has(r.income_type)) : [];
  const assessableRows = showAssessableSplit ? rows.filter((r) => !NON_ASSESSABLE_INCOME_TYPES.has(r.income_type)) : rows;
  const total = assessableRows.reduce((s, r) => s + (r.amount_aud_cents ?? r.gross_cents), 0);
  const withholding = assessableRows.reduce((s, r) => s + r.withholding_cents, 0);
  const franking = assessableRows.reduce((s, r) => s + r.franking_credit_cents, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Income</h1>
        <span className="text-sm tabular-nums text-muted">FY {fy}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "+ Add income manually"}</Button>
        {has("income_statement_upload") && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.currentTarget.value = ""; }}
            />
            <Button variant="ghost" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
              {upload.isPending ? "Reading…" : "↑ Upload income statement"}
            </Button>
          </>
        )}
      </div>
      {note && <p className="text-sm text-muted">{note}</p>}
      {adding && <AddIncomeForm fy={fy} onDone={() => { setAdding(false); qc.invalidateQueries({ queryKey: ["income", fy] }); }} />}

      <div className="grid grid-cols-3 gap-3">
        <Card className="p-4"><div className="text-xs uppercase tracking-wide text-muted">Gross income</div><div className="mt-1 text-xl font-semibold tabular-nums">{money(total)}</div></Card>
        <Card className="p-4"><div className="text-xs uppercase tracking-wide text-muted">PAYG withheld</div><div className="mt-1 text-xl font-semibold tabular-nums">{money(withholding)}</div></Card>
        <Card className="p-4"><div className="text-xs uppercase tracking-wide text-muted">Franking credits <InfoTip k="franking_credit" /></div><div className="mt-1 text-xl font-semibold tabular-nums">{money(franking)}</div></Card>
      </div>

      <IncomeDedupe fyStart={fyStart} />

      {capturedRows.length > 0 && (
        <Card className="border-warn/30 bg-warn/5 p-4">
          <div className="text-sm font-semibold text-ink">Captured — not in your assessable position</div>
          <p className="mt-0.5 text-xs text-muted">
            These have special treatment we don't compute (e.g. tax-free redundancy, super pension). They're kept
            for your records but excluded from the Gross income above — confirm their treatment with a registered
            tax agent. General information only.
          </p>
          <ul className="mt-2 divide-y divide-line text-sm">
            {capturedRows.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-1.5">
                <span className="text-ink">{r.ato_label ?? r.income_type}</span>
                <span className="tabular-nums text-muted">{money(r.amount_aud_cents ?? r.gross_cents)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

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


// Income de-dup (flag income_dedupe): surfaces credit bank-lines that look like a documented
// income row so the user can confirm the pair counts once (not double). Suggest-only — nothing is
// merged until the user clicks Link. Hidden when the flag is off or there's nothing to reconcile.
function IncomeDedupe({ fyStart }: { fyStart: number }) {
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
  // FY-scope to the active year: a credit/income pair only makes sense against the FY you're viewing
  // (a 2024-25 rent credit shouldn't surface while you're on 2025-26). Null dates fall through (kept).
  const { from, to } = fyBounds(fyStart);
  const inFy = (d?: string | null) => !d || (d >= from && d <= to);
  const suggestions = (data?.suggestions ?? []).filter((s) => inFy(s.income_date ?? s.txn_date));
  const matched = (data?.matched ?? []).filter((m) => inFy(m.txn_date));
  if (!enabled || !data || (!suggestions.length && !matched.length)) return null;
  return (
    <Card className="space-y-3 p-4">
      <div className="text-sm font-semibold">Possible duplicate income</div>
      <p className="text-xs text-muted">
        A bank credit that looks like a payslip/documented income row would otherwise count twice.
        Link a pair so it counts once. General information only — confirm with a registered tax agent.
      </p>
      {suggestions.map((s) => (
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
      {matched.map((m) => (
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

// Slice B: AMMA managed-fund distribution components — these dollar fields map to AmmaComponents (cents).
const MF_FIELDS = [
  { key: "franked", label: "Franked dividends ($)", group: "income" },
  { key: "unfranked", label: "Unfranked dividends ($)", group: "income" },
  { key: "interest", label: "Interest ($)", group: "income" },
  { key: "other", label: "Other Australian income ($)", group: "income" },
  { key: "foreign", label: "Foreign income ($)", group: "income" },
  { key: "frankingCredit", label: "Franking credit ($)", group: "credit" },
  { key: "foreignTax", label: "Foreign tax paid ($)", group: "credit" },
  { key: "cgDiscounted", label: "Capital gain — discounted method, GROSS ($)", group: "cgt" },
  { key: "cgOther", label: "Capital gain — other method ($)", group: "cgt" },
  { key: "costBase", label: "AMIT cost-base net amount ($, +/−)", group: "costbase" },
] as const;
type MfKey = (typeof MF_FIELDS)[number]["key"];

function AddIncomeForm({ fy, onDone }: { fy: string; onDone: () => void }) {
  const { has } = useFeatures();
  const [type, setType] = useState<string>("salary_payg");
  const [gross, setGross] = useState("");
  const [withheld, setWithheld] = useState("");
  const [franking, setFranking] = useState("");
  const [date, setDate] = useState("");
  const [entityId, setEntityId] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [mf, setMf] = useState<Record<MfKey, string>>(() => Object.fromEntries(MF_FIELDS.map((f) => [f.key, ""])) as Record<MfKey, string>);
  // Entities you can attribute income to (company / trust / SMSF). Default "" = you (the individual).
  // SMSF/company/trust are separate taxpayers, so attributing fund earnings here keeps them off your
  // personal position and feeds the per-entity reads (e.g. smsfFundPositions sums income by entity_id).
  const { data: sit } = useQuery({ queryKey: ["situation"], queryFn: () => api.situation() });
  const entities = (sit?.entities ?? []).filter((e) => e.kind === "company" || e.kind === "trust" || e.kind === "smsf");
  // Rent income must attribute to a property, or it never reaches that property's per-property schedule
  // (report filters property_id IS NOT NULL). Required when the tenant has any property.
  const properties = sit?.properties ?? [];
  const needsProperty = type === "rent" || type === "foreign_rent";

  // The component form shows ONLY for a personal managed-fund distribution (cgtTotals isn't entity-scoped,
  // so an entity's capital gain would leak into the personal headline → component capture is personal-only).
  const isMf = type === "managed_fund_distribution" && has("mf_components") && !entityId;
  const c = (s: string) => Math.round(parseFloat(s || "0") * 100);
  const components = {
    franked_cents: c(mf.franked), unfranked_cents: c(mf.unfranked), interest_cents: c(mf.interest),
    other_income_cents: c(mf.other), foreign_income_cents: c(mf.foreign),
    franking_credit_cents: c(mf.frankingCredit), foreign_tax_paid_cents: c(mf.foreignTax),
    capital_gain_discounted_cents: c(mf.cgDiscounted), capital_gain_other_cents: c(mf.cgOther),
    amit_cost_base_net_amount_cents: c(mf.costBase),
  };
  const mfOrdinary = components.franked_cents + components.unfranked_cents + components.interest_cents + components.other_income_cents + components.foreign_income_cents;
  const mfCg = components.capital_gain_discounted_cents + components.capital_gain_other_cents;
  const mfTotal = mfOrdinary + mfCg + components.amit_cost_base_net_amount_cents;
  const mfHasAny = mfOrdinary > 0 || mfCg > 0 || components.amit_cost_base_net_amount_cents !== 0;

  const add = useMutation({
    mutationFn: () =>
      isMf
        ? api.addIncome({ income_type: type, fy, txn_date: date || null, components })
        : api.addIncome({
            income_type: type, fy,
            gross_cents: c(gross), withholding_cents: c(withheld), franking_credit_cents: c(franking),
            txn_date: date || null, entity_id: entityId || null,
            property_id: needsProperty ? propertyId || null : null,
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
        {needsProperty && properties.length > 0 && (
          <label className="text-sm">Property
            <select className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm" value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
              <option value="">— choose —</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
        )}
        <label className="text-sm">Date<Input className="mt-1 w-full" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        {!isMf && <>
          <label className="text-sm">Gross ($)<Input className="mt-1 w-full" inputMode="decimal" value={gross} onChange={(e) => setGross(e.target.value)} /></label>
          <label className="text-sm">PAYG withheld ($)<Input className="mt-1 w-full" inputMode="decimal" value={withheld} onChange={(e) => setWithheld(e.target.value)} /></label>
          <label className="text-sm">Franking credit ($)<Input className="mt-1 w-full" inputMode="decimal" value={franking} onChange={(e) => setFranking(e.target.value)} /></label>
        </>}
      </div>

      {isMf && (
        <div className="space-y-2 rounded-lg border border-line bg-paper/40 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">AMMA distribution components</div>
          <p className="text-xs text-muted">Enter your managed-fund / ETF distribution from its AMMA (tax) statement. The capital-gain amounts feed the CGT engine (the discounted-method amount is the GROSS gain — we apply the 50% discount). The AMIT cost-base net amount isn't assessable; it adjusts your units' cost base for a future sale.</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {MF_FIELDS.map((field) => (
              <label key={field.key} className="text-sm">{field.label}
                <Input className="mt-1 w-full" inputMode="decimal" value={mf[field.key]} onChange={(e) => setMf((m) => ({ ...m, [field.key]: e.target.value }))} />
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-2 text-xs tabular-nums text-muted">
            <span>Assessable ordinary <span className="text-ink">{money(mfOrdinary)}</span></span>
            <span>Capital gain → CGT <span className="text-ink">{money(mfCg)}</span></span>
            <span>Cost-base adjustment (not assessable) <span className="text-ink">{money(components.amit_cost_base_net_amount_cents)}</span></span>
            <span>Total distribution <span className="text-ink">{money(mfTotal)}</span></span>
          </div>
        </div>
      )}
      {type === "managed_fund_distribution" && has("mf_components") && entityId && (
        <p className="text-xs text-muted">Component capture is for personal distributions only right now — attributing to an entity records a single gross amount.</p>
      )}

      {/* Rent MUST attach to a property (the engine keys the income on property_id). Disable on the
          zero-property case too — previously the selector was hidden and save stayed enabled, so rent
          saved with no property and 400'd server-side with no feedback. */}
      <Button onClick={() => add.mutate()} disabled={add.isPending || (isMf ? !mfHasAny : !gross) || (needsProperty && !propertyId)}>{add.isPending ? "Saving…" : "Save income"}</Button>
      {needsProperty && properties.length === 0 ? (
        <p className="text-xs text-muted">Add a rental property first in <Link to="/settings" className="font-medium text-ink underline">Settings → Properties</Link>, then come back to record its rent.</p>
      ) : needsProperty && !propertyId ? (
        <p className="text-xs text-muted">Choose which property this rent is for so it counts in that property's position.</p>
      ) : null}
      {add.error && <p className="text-sm text-danger">{(add.error as Error).message}</p>}
    </Card>
  );
}
