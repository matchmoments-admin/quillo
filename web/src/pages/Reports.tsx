import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Card, Spinner, money, BUCKET_LABEL } from "../components/ui";

function defaultFyStart(): number {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

export function Reports() {
  const [fy, setFy] = useState(defaultFyStart());
  const { data, isLoading, error } = useQuery({ queryKey: ["report", fy], queryFn: () => api.report(fy) });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Year-end report</h1>
        <div className="flex items-center gap-2 text-sm">
          <button className="rounded-lg border border-line px-2 py-1" onClick={() => setFy((y) => y - 1)}>
            ←
          </button>
          <span className="tabular-nums">
            FY {fy}–{String((fy + 1) % 100).padStart(2, "0")}
          </span>
          <button className="rounded-lg border border-line px-2 py-1" onClick={() => setFy((y) => y + 1)}>
            →
          </button>
        </div>
      </div>

      <a href={api.reportCsvUrl(fy)} className="inline-block rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-ink/90">
        Download CSV for your tax agent
      </a>

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Card className="p-6 text-sm text-muted">Couldn't load: {(error as Error).message}</Card>
      ) : (
        <>
          <Card className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
            <div>
              <span className="text-muted">ABN</span> <span className="font-medium">{data!.abn ?? "(not set)"}</span>
            </div>
            <div>
              <span className="text-muted">GST credits (ITC) on company expenses</span>{" "}
              <span className="font-medium tabular-nums">{money(data!.gst_credits_cents)}</span>
            </div>
          </Card>

          <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
            <Stat label="Total income" value={money(data!.total_income_cents)} />
            <Stat label="Deductions" value={money(data!.total_deductions_cents)} />
            <Stat label="Depreciation" value={money(data!.depreciation_cents)} />
            <Stat label="Indicative position" value={money(data!.taxable_position_cents)} />
          </Card>

          {(data!.income.franking_credit_cents > 0 || data!.income.foreign_tax_paid_cents > 0) && (
            <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3">
              <Stat label="PAYG withheld" value={money(data!.income.withholding_cents)} />
              <Stat label="Franking credits" value={money(data!.income.franking_credit_cents)} />
              <Stat label="Foreign tax offset (FITO)" value={money(data!.income.foreign_tax_paid_cents)} />
            </Card>
          )}

          {data!.income.by_type.length > 0 && (
            <Card className="overflow-hidden">
              <Th>Income</Th>
              <table className="w-full text-sm">
                <tbody>
                  {data!.income.by_type.map((it, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="px-4 py-2">{it.income_type}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{money(it.gross_cents)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted">withheld {money(it.withholding_cents)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted">franking {money(it.franking_credit_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {data!.per_property.length > 0 && (
            <Card className="overflow-hidden">
              <Th>Per-property position (rent − deductions − depreciation)</Th>
              <table className="w-full text-sm">
                <tbody>
                  {data!.per_property.map((p) => (
                    <tr key={p.property_id} className="border-t border-line">
                      <td className="px-4 py-2">{p.label ?? p.property_id}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted">rent {money(p.income_cents)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted">−{money(p.deduction_cents)} −{money(p.depreciation_cents)}</td>
                      <td className={`px-4 py-2 text-right tabular-nums font-medium ${p.net_cents < 0 ? "text-danger" : ""}`}>{money(p.net_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <Card className="overflow-hidden">
            <Th>By bucket + ATO label</Th>
            <table className="w-full text-sm">
              <tbody>
                {data!.by_bucket.map((b, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="px-4 py-2">{BUCKET_LABEL[b.bucket] ?? b.bucket}</td>
                    <td className="px-4 py-2 text-muted">{b.ato_label ?? "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(b.total_cents)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted">GST {money(b.gst_cents)}</td>
                  </tr>
                ))}
                {!data!.by_bucket.length && <Empty cols={4} />}
              </tbody>
            </table>
          </Card>

          <Card className="overflow-hidden">
            <Th>Rental schedule (by property)</Th>
            <table className="w-full text-sm">
              <tbody>
                {data!.by_property.map((p) => (
                  <tr key={p.property_id} className="border-t border-line">
                    <td className="px-4 py-2">{p.label ?? p.property_id}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(p.total_cents)}</td>
                  </tr>
                ))}
                {!data!.by_property.length && <Empty cols={2} />}
              </tbody>
            </table>
          </Card>

          <Card className="overflow-hidden">
            <Th>Company BAS quarters</Th>
            <table className="w-full text-sm">
              <tbody>
                {data!.company_quarters.map((q) => (
                  <tr key={q.quarter} className="border-t border-line">
                    <td className="px-4 py-2">{q.quarter}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(q.total_cents)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted">GST {money(q.gst_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {data!.undated_detail.length > 0 && (
            <Card className="overflow-hidden border-warn/40">
              <Th>Undated — assign a date so these land in an FY ({data!.undated.n})</Th>
              <table className="w-full text-sm">
                <tbody>
                  {data!.undated_detail.map((u, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="px-4 py-2">{u.merchant ?? "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{money(u.total_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <p className="text-xs text-muted">
            General information only — not tax advice. Have a registered tax/BAS agent confirm before lodging.
          </p>
        </>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted">{children}</div>;
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
function Empty({ cols }: { cols: number }) {
  return (
    <tr className="border-t border-line">
      <td colSpan={cols} className="px-4 py-4 text-sm text-muted">
        No data for this FY.
      </td>
    </tr>
  );
}
