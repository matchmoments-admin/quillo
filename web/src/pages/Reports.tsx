import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, saveBlob } from "../api";
import { useActiveFy } from "../lib/activeFy";
import { useFeatures } from "../lib/features";
import { Card, Spinner, money, BUCKET_LABEL, InfoTip } from "../components/ui";
import { ScanFindings } from "../components/ScanFindings";
import { WorkMethodsCard } from "../components/WorkMethodsCard";
import { CarMethodsCard } from "../components/CarMethodsCard";

export function Reports() {
  // Driven by the global active-FY switcher (in the app header); change the year there.
  const { fy, label } = useActiveFy();
  const features = useFeatures();
  const scanOn = features.has("txn_scan");
  const { data, isLoading, error } = useQuery({ queryKey: ["report", fy], queryFn: () => api.report(fy) });
  const download = useMutation({ mutationFn: () => api.reportCsv(fy), onSuccess: ({ blob, filename }) => saveBlob(blob, filename) });
  // #256 pre-handoff gate: on Download, run the (instant, deterministic) scan first; if it finds anything,
  // show a NON-BLOCKING "N things worth checking" panel (Review / Download anyway). Never blocks; flag-off
  // is the untouched direct-download path.
  const [gateCount, setGateCount] = useState<number | null>(null);
  const precheck = useMutation({
    mutationFn: () => api.scan(fy),
    onSuccess: (res) => { if (res.summary.finding_count > 0) setGateCount(res.summary.finding_count); else download.mutate(); },
    onError: () => download.mutate(), // if the scan can't run, never block the hand-off
  });
  const onDownload = () => { if (scanOn) precheck.mutate(); else download.mutate(); };

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

      <button
        onClick={onDownload}
        disabled={download.isPending || precheck.isPending}
        className="inline-block rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-60"
      >
        {download.isPending
          ? "Preparing…"
          : precheck.isPending
            ? "Double-checking…"
            : features.has("accountant_schedule")
              ? "Download accountant schedule (CSV)"
              : "Download CSV for your tax agent"}
      </button>
      {download.isError && <p className="text-xs text-danger">Couldn't download: {(download.error as Error).message}</p>}
      {gateCount != null && (
        <Card className="flex flex-wrap items-center gap-3 border-warn/40 bg-warn/5 p-3 text-sm">
          <span className="font-medium text-ink">We found {gateCount} thing{gateCount === 1 ? "" : "s"} worth checking before you hand off.</span>
          <button
            onClick={() => { setGateCount(null); document.getElementById("double-check")?.scrollIntoView({ behavior: "smooth" }); }}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium hover:bg-card"
          >
            Review
          </button>
          <button
            onClick={() => { setGateCount(null); download.mutate(); }}
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface"
          >
            Download anyway
          </button>
        </Card>
      )}

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
            {data!.taxable_position_confirmed_cents != null ? (
              // #255: present as a range so the optimistic (tracked) figure is never shown alone as THE
              // position. Lead with the defensible/confirmed number; the tracked figure is the floor it
              // falls toward as pending spend is confirmed deductible.
              <div>
                <div className="text-xs uppercase tracking-wide text-muted">
                  Indicative position (individual) <InfoTip tip="A range: the first figure reflects only deductions confirmed so far (what you could defend today); it falls toward the second as you confirm the spend you've captured. General information only — not tax advice." />
                </div>
                <div className="mt-1 text-lg font-semibold tabular-nums">{money(data!.taxable_position_confirmed_cents)}</div>
                <div className="text-xs font-normal tabular-nums text-muted">
                  → {money(data!.taxable_position_cents)} if all tracked spend is confirmed deductible
                </div>
              </div>
            ) : (
              <Stat label="Indicative position (individual)" value={money(data!.taxable_position_cents)} />
            )}
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
            {data!.company_tracked_cents > 0 && (
              <>
                {" "}Business/company spend of{" "}
                <span className="font-medium text-ink">{money(data!.company_tracked_cents)}</span>{" "}
                is tracked separately and is <span className="font-medium text-ink">not</span> included in the
                individual position above (entity positions are computed separately).
              </>
            )}
          </p>

          {scanOn && <div id="double-check"><ScanFindings fyNum={fy} /></div>}

          {/* Inputs that shape the deductions above — the same WFH + car method cards as the Dashboard,
              so the figures that feed this report can be reviewed/adjusted where the report is read
              (the audit found the report otherwise gave no WFH/car visibility). Gated exactly as on the
              Dashboard so flag-OFF leaves this report byte-identical. */}
          {(features.has("wfh_car_methods") || features.has("car_methods") || features.has("car_logbook")) && (
            <CollapsibleSection title="Your work-from-home & car claim (edit)" defaultOpen={false}>
              {features.has("wfh_car_methods") && <WorkMethodsCard fyNum={fy} />}
              {(features.has("car_methods") || features.has("car_logbook")) && <CarMethodsCard fyNum={fy} />}
            </CollapsibleSection>
          )}

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

          {/* EPIC #134 engine outputs — each renders only when its flag is on and there's data. Grouped
              under one collapsible so the densest detail folds away when it isn't relevant; the whole
              group is omitted (not an empty header) when a simple PAYG return has none of it. */}
          {(data!.capital_gains || data!.ess || data!.trust || data!.franking_gross_up_cents != null || data!.super_deduction || data!.car_logbook || data!.gst || (data!.smsf_funds && data!.smsf_funds.length > 0)) && (
          <CollapsibleSection title="Detailed tax positions">
          {data!.capital_gains && (
            <Card className="overflow-hidden">
              <Th>Capital gains (CGT) — net gain is assessable income</Th>
              <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
                <Stat label="Gains (gross)" value={money(data!.capital_gains.gross_capital_gains_cents)} />
                <Stat label="Losses applied" value={money(data!.capital_gains.capital_losses_cents)} />
                <Stat label="50% discount" value={money(data!.capital_gains.discount_applied_cents)} />
                <Stat label="Net capital gain" value={money(data!.capital_gains.net_capital_gain_cents)} />
              </div>
            </Card>
          )}

          {data!.ess && (
            <Card className="overflow-hidden">
              <Th>Employee share scheme (ESS)</Th>
              <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3">
                <Stat label="Assessable discount" value={money(data!.ess.assessable_discount_cents)} />
                <Stat label="Startup (deferred to CGT)" value={money(data!.ess.startup_deferred_to_cgt_cents)} />
                <Stat label="Eligibility" value={data!.ess.ineligible_startup_flag ? "Check >10% rule" : "OK"} />
              </div>
            </Card>
          )}

          {data!.trust && (
            <Card className="overflow-hidden">
              <Th>Trust distributions to you (character retained)</Th>
              <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3">
                <Stat label="Assessable" value={money(data!.trust.assessable_cents)} />
                <Stat label="Franking credits" value={money(data!.trust.franking_credit_cents)} />
                <Stat label="Characters" value={Object.keys(data!.trust.by_character).join(", ") || "—"} />
              </div>
            </Card>
          )}

          {data!.franking_gross_up_cents != null && (
            <Card className="overflow-hidden">
              <Th>Franking credits (grossed up into income)</Th>
              <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3">
                <Stat label="Added to assessable income" value={money(data!.franking_gross_up_cents)} />
                <Stat label="Also a tax offset" value="Reduces tax payable (not shown here)" />
              </div>
            </Card>
          )}

          {data!.super_deduction && (
            <Card className="overflow-hidden">
              <Th>Personal super contributions (deduction)</Th>
              <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3">
                <Stat label="Deduction claimed" value={money(data!.super_deduction.claimed_cents)} />
                <Stat label="Contributed" value={money(data!.super_deduction.contributed_cents)} />
                <Stat label="Concessional cap" value={data!.super_deduction.over_cap ? `${money(data!.super_deduction.cap_cents)} — over cap` : money(data!.super_deduction.cap_cents)} />
              </div>
            </Card>
          )}

          {data!.car_logbook && (
            <Card className="overflow-hidden">
              <Th>Car — logbook vs cents-per-km (you can claim only one)</Th>
              <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
                <Stat label="Business use" value={`${Math.round(data!.car_logbook.business_use_pct)}%`} />
                <Stat label="Logbook method" value={money(data!.car_logbook.logbook_deduction_cents)} />
                <Stat label="Cents per km" value={money(data!.car_logbook.cents_per_km_cents)} />
                <Stat label="Recommended" value={`${data!.car_logbook.recommended_method === "logbook" ? "Logbook" : "Cents/km"} · ${money(data!.car_logbook.recommended_cents)}`} />
              </div>
            </Card>
          )}

          {data!.gst && (
            <Card className="overflow-hidden">
              <Th>GST — indicative BAS position (separate from income tax) <InfoTip k="bas" /></Th>
              <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3">
                <Stat label="GST collected (output)" value={money(data!.gst.output_gst_cents)} />
                <Stat label="GST credits (input)" value={money(data!.gst.input_gst_cents)} />
                <Stat label={data!.gst.net_gst_cents >= 0 ? "Net GST payable" : "Net GST refund"} value={money(Math.abs(data!.gst.net_gst_cents))} />
              </div>
              <p className="px-4 pb-3 text-xs text-muted">
                {data!.gst.source === "recorded"
                  ? "From the BAS periods you recorded (Settings)."
                  : "Estimated from your ledger — record your actual BAS periods in Settings to override this."}
                {data!.payg_instalments_cents ? ` PAYG instalments recorded this year: ${money(data!.payg_instalments_cents)} (pre-payments toward income tax — not part of your position).` : ""}
              </p>
            </Card>
          )}

          {data!.smsf_funds && data!.smsf_funds.length > 0 && (
            <Card className="overflow-hidden">
              <Th>SMSF fund position (a separate taxpayer) — ECPI exempts pension-phase earnings</Th>
              <table className="w-full text-sm">
                <tbody>
                  {data!.smsf_funds.map((f) => (
                    <tr key={f.entity_id} className="border-t border-line">
                      <td className="px-4 py-2">{f.name ?? "SMSF"}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted">income {money(f.assessable_income_cents)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted">ECPI {Math.round(f.ecpi_exempt_fraction * 100)}%</td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium">taxable {money(f.fund_taxable_income_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          </CollapsibleSection>
          )}

          {data!.per_property.length > 0 && (
            <Card className="overflow-hidden">
              <Th>Per-property position (rent − deductions − depreciation)</Th>
              <table className="w-full text-sm">
                <PagedRows rows={data!.per_property} cols={4} render={(p) => (
                    <tr key={p.property_id} className="border-t border-line">
                      <td className="px-4 py-2">{p.label ?? p.property_id}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted">rent {money(p.income_cents)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-muted">−{money(p.deduction_cents)} −{money(p.depreciation_cents)}</td>
                      <td className={`px-4 py-2 text-right tabular-nums font-medium ${p.net_cents < 0 ? "text-danger" : ""}`}>{money(p.net_cents)}</td>
                    </tr>
                  )} />
              </table>
            </Card>
          )}

          <Card className="overflow-hidden">
            <Th>By category + ATO label <InfoTip k="ato_label" /></Th>
            <table className="w-full text-sm">
              {data!.by_bucket.length ? (
                <PagedRows rows={data!.by_bucket} cols={4} render={(b, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="px-4 py-2">{BUCKET_LABEL[b.bucket] ?? b.bucket}</td>
                    <td className="px-4 py-2 text-muted">{b.ato_label ?? "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(b.total_cents)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted">GST {money(b.gst_cents)}</td>
                  </tr>
                )} />
              ) : (
                <tbody><Empty cols={4} /></tbody>
              )}
            </table>
          </Card>

          {data!.income_by_bucket.length > 0 && (
            <Card className="overflow-hidden">
              <Th>Income from bank credits (separate from documented income above)</Th>
              <table className="w-full text-sm">
                <PagedRows rows={data!.income_by_bucket} cols={4} render={(b, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="px-4 py-2">{BUCKET_LABEL[b.bucket] ?? b.bucket}</td>
                      <td className="px-4 py-2 text-muted">{b.ato_label ?? "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{money(b.total_cents)}</td>
                      <td className="px-4 py-2"></td>
                    </tr>
                  )} />
              </table>
            </Card>
          )}

          <Card className="overflow-hidden">
            <Th>Rental schedule (by property) <InfoTip tip="Per-property totals, mirroring how rental income and expenses are reported separately for each property on a tax return." /></Th>
            <table className="w-full text-sm">
              {data!.by_property.length ? (
                <PagedRows rows={data!.by_property} cols={2} render={(p) => (
                  <tr key={p.property_id} className="border-t border-line">
                    <td className="px-4 py-2">{p.label ?? p.property_id}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(p.total_cents)}</td>
                  </tr>
                )} />
              ) : (
                <tbody><Empty cols={2} /></tbody>
              )}
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
                <PagedRows rows={data!.undated_detail} cols={2} render={(u, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="px-4 py-2">{u.merchant ?? "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{money(u.total_cents)}</td>
                    </tr>
                  )} />
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

/**
 * A `<tbody>` that windows long lists: shows the first `initial` rows, then a "Show all N" toggle, so a
 * landlord with 80 properties or a heavy importer with 300 categories doesn't render hundreds of <tr>
 * at once (the report scale cliff). Renders its own tbody — drop it in place of a hand-written one.
 */
function PagedRows<T>({ rows, render, cols, initial = 12 }: { rows: T[]; render: (r: T, i: number) => ReactNode; cols: number; initial?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, initial);
  return (
    <tbody>
      {shown.map((r, i) => render(r, i))}
      {rows.length > initial && (
        <tr className="border-t border-line">
          <td colSpan={cols} className="px-4 py-2 text-center">
            <button onClick={() => setAll((v) => !v)} className="text-sm font-medium text-muted hover:text-ink">
              {all ? "Show fewer" : `Show all ${rows.length}`}
            </button>
          </td>
        </tr>
      )}
    </tbody>
  );
}

/**
 * A collapsible card group, so the rarer/denser tax-position detail (CGT, ESS, trust, super, GST, SMSF…)
 * is grouped under one heading the user can fold away — the summary up top stays the hero. Defaults open
 * so nothing in the deliverable is hidden by default; the user collapses what's not relevant to them.
 */
function CollapsibleSection({ title, children, defaultOpen = true }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="group space-y-4">
      <summary className="flex cursor-pointer items-center gap-2 px-1 text-sm font-semibold text-ink marker:content-none">
        <span className="text-muted transition group-open:rotate-90">›</span>
        {title}
      </summary>
      <div className="space-y-4 pt-1">{children}</div>
    </details>
  );
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
