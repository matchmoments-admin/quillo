import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { Card, Button, Input, money } from "../ui";

// ESS (#141): employee share scheme grants. Upfront/deferral discounts are assessable; startup defers to CGT.
const ESS_SCHEMES = ["taxed_upfront", "deferral", "startup"] as const;
const SCHEME_LABEL: Record<string, string> = { taxed_upfront: "Taxed upfront", deferral: "Deferral", startup: "Startup concession" };

export function EssGrants() {
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
