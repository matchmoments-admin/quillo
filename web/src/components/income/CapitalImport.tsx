import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { Button, money } from "../ui";
import type { CapitalImportParse, CapitalDraftRow } from "../../types";

// C6 (capital_statement_ingest): import holdings and disposals from a broker / share-registry /
// crypto-exchange CSV export.
//
// WHY THIS SCREEN EXISTS AT ALL, rather than importing straight from the upload: a wrong cost base does not
// announce itself. It sits there looking plausible and silently distorts a capital gain years later, at
// disposal. So the extraction is always shown and always confirmed — every row is listed, every row is
// individually deselectable, and rows we couldn't read are shown WITH their reason rather than quietly
// dropped (a taxpayer whose 40-row export became 37 holdings has no way to notice).

const KIND_LABEL: Record<string, string> = { shares: "Shares", crypto: "Crypto", managed_fund: "Managed fund", other: "Other" };

export function CapitalImport({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [parsed, setParsed] = useState<CapitalImportParse | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ holdings: number; disposals: number; unmatched: { source_row: number; code: string | null }[] } | null>(null);

  const upload = async (file: File) => {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await api.parseCapitalImport(file);
      if (r.duplicate) { setError("You've already imported that file. Re-exporting it won't create duplicates — nothing was added."); setParsed(null); return; }
      setParsed(r);
      // Pre-select everything importable. A row with a problem is never selectable: importing a holding
      // with no quantity just manufactures the incomplete record readiness then has to chase you about.
      setSelected(new Set((r.preview?.rows ?? []).filter((x) => !x.problem).map((x) => x.source_row)));
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const commit = async () => {
    if (!parsed) return;
    setBusy(true); setError(null);
    try {
      const r = await api.confirmCapitalImport(parsed.importId, [...selected]);
      setResult(r);
      setParsed(null);
      qc.invalidateQueries({ queryKey: ["cgt-assets"] });
      qc.invalidateQueries({ queryKey: ["cgt-events"] });
      qc.invalidateQueries({ queryKey: ["report"] });
      qc.invalidateQueries({ queryKey: ["readiness"] });
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const rows = parsed?.preview?.rows ?? [];
  const toggle = (n: number) => setSelected((s) => { const next = new Set(s); if (next.has(n)) next.delete(n); else next.add(n); return next; });

  return (
    <div className="rounded-2xl border border-ink/10 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-medium">Import holdings from a CSV</div>
          <div className="text-xs text-muted">
            A share, ETF or crypto export from your broker, registry or exchange. A bank line can't tell us
            units, price or brokerage — an export can. Nothing is added until you confirm.
          </div>
        </div>
        <button className="text-xs text-muted hover:underline" onClick={onDone}>close</button>
      </div>

      {!parsed && !result && (
        <label className="mt-3 block cursor-pointer rounded border border-dashed border-ink/25 p-4 text-center text-sm text-muted hover:border-ink/50">
          <input type="file" accept=".csv,text/csv" className="hidden" disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
          {busy ? "Reading your file…" : "Choose a CSV file"}
        </label>
      )}

      {error && <div className="mt-3 rounded bg-danger/10 p-2 text-sm text-danger">{error}</div>}

      {result && (
        <div className="mt-3 space-y-2 text-sm">
          <div className="rounded bg-safe/10 p-2 text-safe">
            Added {result.holdings} holding{result.holdings === 1 ? "" : "s"}
            {result.disposals ? ` and ${result.disposals} disposal${result.disposals === 1 ? "" : "s"}` : ""}.
          </div>
          {result.unmatched.length > 0 && (
            <div className="rounded bg-warn/10 p-2 text-warn">
              {result.unmatched.length} sale{result.unmatched.length === 1 ? "" : "s"} couldn't be matched to a
              holding you own ({result.unmatched.map((u) => u.code ?? `row ${u.source_row}`).join(", ")}), so
              {result.unmatched.length === 1 ? " it was" : " they were"} skipped. Add the parcel first, then
              record the sale — we won't invent a holding to hang a sale on, because which parcel a sale came
              from changes the gain and that's your call.
            </div>
          )}
          {result.disposals > 0 && (
            <div className="rounded bg-warn/10 p-2 text-warn">
              Imported sales have no cost base yet — an export says what you sold for, not which parcel you
              used, and that choice changes the gain. Open each sale and set the cost base before you file.
            </div>
          )}
        </div>
      )}

      {parsed && parsed.preview && (
        <div className="mt-3">
          <div className="mb-2 text-sm">
            Found <strong>{parsed.preview.acquisitions}</strong> holding{parsed.preview.acquisitions === 1 ? "" : "s"}
            {parsed.preview.disposals > 0 && <> and <strong>{parsed.preview.disposals}</strong> sale{parsed.preview.disposals === 1 ? "" : "s"}</>}
            {parsed.preview.problems > 0 && <span className="text-warn"> · {parsed.preview.problems} row{parsed.preview.problems === 1 ? "" : "s"} I couldn't read</span>}
            {parsed.preview.skipped > 0 && <span className="text-muted"> · {parsed.preview.skipped} blank row{parsed.preview.skipped === 1 ? "" : "s"} skipped</span>}
          </div>
          <div className="max-h-80 overflow-auto rounded-xl border border-ink/10">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-cream text-xs text-muted">
                <tr>
                  <th className="px-2 py-1 text-left">Import</th>
                  <th className="px-2 py-1 text-left">Asset</th>
                  <th className="px-2 py-1 text-left">Kind</th>
                  <th className="px-2 py-1 text-left">Date</th>
                  <th className="px-2 py-1 text-right">Units</th>
                  <th className="px-2 py-1 text-right">Amount</th>
                  <th className="px-2 py-1 text-left">Type</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: CapitalDraftRow) => (
                  <tr key={r.source_row} className={r.problem ? "opacity-60" : ""}>
                    <td className="px-2 py-1">
                      <input type="checkbox" checked={selected.has(r.source_row)} disabled={!!r.problem}
                        onChange={() => toggle(r.source_row)} aria-label={`import row ${r.source_row}`} />
                    </td>
                    <td className="px-2 py-1">{r.code ?? r.label ?? "—"}</td>
                    <td className="px-2 py-1 text-muted">{KIND_LABEL[r.asset_kind] ?? r.asset_kind}</td>
                    <td className="px-2 py-1 tabular-nums text-muted">{r.date ?? "—"}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{r.units ?? "—"}</td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {money(r.amount_cents)}
                      {r.fee_cents > 0 && <span className="block text-xs text-muted">incl. {money(r.fee_cents)} fees</span>}
                    </td>
                    <td className="px-2 py-1 text-xs">
                      {r.side === "acquire" ? "buy" : "sell"}
                      {/* Shown, never silently dropped — and the ORIGINAL file row number, so it's findable
                          in the user's own spreadsheet. */}
                      {r.problem && <span className="block text-warn">row {r.source_row}: {r.problem}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button disabled={busy || selected.size === 0} onClick={() => void commit()}>
              {busy ? "Adding…" : `Add ${selected.size} row${selected.size === 1 ? "" : "s"}`}
            </Button>
            <Button variant="ghost" disabled={busy}
              onClick={() => { void api.discardCapitalImport(parsed.importId); setParsed(null); }}>
              Cancel
            </Button>
            <span className="text-xs text-muted">Check the figures against your statement — cost bases are fact-specific and a registered tax agent should confirm them.</span>
          </div>
        </div>
      )}
    </div>
  );
}
