import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useActiveFy } from "../lib/activeFy";
import { Card, Spinner, money, BUCKET_LABEL, InfoTip } from "../components/ui";

export function Reports() {
  // Driven by the global active-FY switcher (in the app header); change the year there.
  const { fy, label } = useActiveFy();
  const { data, isLoading, error } = useQuery({ queryKey: ["report", fy], queryFn: () => api.report(fy) });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">
          Year-end report{" "}
          <InfoTip tip="A full-financial-year summary to hand to your registered tax agent. General information — Quillo doesn't lodge for you." />
        </h1>
        <span className="inline-flex items-center gap-1 text-sm tabular-nums text-muted">
          FY {label}
          <InfoTip k="fy" />
        </span>
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
              <span className="text-muted">ABN</span> <InfoTip k="abn" /> <span className="font-medium">{data!.abn ?? "(not set)"}</span>
            </div>
            <div>
              <span className="text-muted">GST credits (ITC) on company expenses</span> <InfoTip k="itc" />{" "}
              <span className="font-medium tabular-nums">{money(data!.gst_credits_cents)}</span>
            </div>
          </Card>

          <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
            <Stat label="Total income" value={money(data!.total_income_cents)} />
            {/* This is captured spend in deductible-context buckets, NOT a confirmed claimable
                figure — deductibility is decided at year-end review (see the caveat below). */}
            <Stat label={<>Tracked spend (pending review) <InfoTip k="deductible_vs_claimable" /></>} value={money(data!.total_deductions_cents)} />
            <Stat label="Depreciation" value={money(data!.depreciation_cents)} />
            <Stat label="Indicative position" value={money(data!.taxable_position_cents)} />
          </Card>
          <p className="px-1 text-xs text-muted">
            "Tracked spend" is what you've captured in deductible-context buckets — not a claimable amount.
            Deductibility is finalised in your year-end review with your registered tax agent. Confirmed
            deductible so far: <span className="font-medium text-ink">{money(data!.resolved_deductible_cents)}</span>
            {data!.resolved_deductible_cents === 0 ? " (no review run yet)." : "."}
            {data!.refunds_cents > 0 && (
              <>
                {" "}Refunds/reimbursements of{" "}
                <span className="font-medium text-ink">{money(data!.refunds_cents)}</span>{" "}
                have been netted against tracked spend.
              </>
            )}
          </p>

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
            <Th>By bucket + ATO label <InfoTip k="ato_label" /></Th>
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

          {data!.income_by_bucket.length > 0 && (
            <Card className="overflow-hidden">
              <Th>Income from bank credits (separate from documented income above)</Th>
              <table className="w-full text-sm">
                <tbody>
                  {data!.income_by_bucket.map((b, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="px-4 py-2">{BUCKET_LABEL[b.bucket] ?? b.bucket}</td>
                      <td className="px-4 py-2 text-muted">{b.ato_label ?? "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{money(b.total_cents)}</td>
                      <td className="px-4 py-2"></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <Card className="overflow-hidden">
            <Th>Rental schedule (by property) <InfoTip tip="Per-property totals, mirroring how rental income and expenses are reported separately for each property on a tax return." /></Th>
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
            <Th>Company BAS quarters <InfoTip k="bas" /></Th>
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
              <Th>Undated — assign a date so these land in an FY ({data!.undated.n}) <InfoTip tip="Receipts with no readable date can't be placed in a financial year. Add a date so they're counted in the right year." /></Th>
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
function Stat({ label, value }: { label: React.ReactNode; value: string }) {
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
