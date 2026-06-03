import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Card, Spinner, money } from "../components/ui";
import type { PositionLine, ReadinessFinding } from "../types";

function defaultFyStart(): number {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

const SEVERITY_ORDER: ReadinessFinding["severity"][] = ["blocker", "review", "info"];
const SEVERITY_LABEL: Record<ReadinessFinding["severity"], string> = { blocker: "Must fix", review: "Review", info: "Good to know" };
const SEVERITY_CLASS: Record<ReadinessFinding["severity"], string> = {
  blocker: "bg-danger/10 text-danger",
  review: "bg-warn/10 text-warn",
  info: "bg-ink/5 text-ink",
};
const GROUP_LABEL: Record<PositionLine["group"], string> = { income: "Income", deduction: "Deductions", depreciation: "Depreciation", property: "Per-property position" };

export function Filing() {
  const [fy, setFy] = useState(defaultFyStart());
  const { data, isLoading, error } = useQuery({ queryKey: ["filing-readiness", fy], queryFn: () => api.filingReadiness(fy) });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between print:hidden">
        <h1 className="text-2xl font-semibold tracking-tight">File your return</h1>
        <div className="flex items-center gap-2 text-sm">
          <button className="rounded-lg border border-line px-2 py-1" onClick={() => setFy((y) => y - 1)}>←</button>
          <span className="tabular-nums">FY {fy}–{String((fy + 1) % 100).padStart(2, "0")}</span>
          <button className="rounded-lg border border-line px-2 py-1" onClick={() => setFy((y) => y + 1)}>→</button>
        </div>
      </div>

      <p className="text-sm text-muted print:hidden">
        Everything you've captured, pulled together so you (and your accountant) can see the position and what's worth a second look before lodging.
      </p>

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Card className="p-6 text-sm text-muted">Couldn't load: {(error as Error).message}</Card>
      ) : data ? (
        <>
          {/* Readiness banner */}
          <Card className={`p-4 ${data.readiness_score.ready ? "border-safe/40" : "border-warn/40"}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-lg font-semibold">
                  {data.readiness_score.ready
                    ? data.readiness_score.review > 0
                      ? `${data.readiness_score.review} item(s) worth a look before lodging`
                      : "Nothing flagged — but always confirm with your agent"
                    : `${data.readiness_score.blockers} item(s) to fix first`}
                </div>
                <div className="mt-0.5 text-sm text-muted">{data.handoff.situation_summary}</div>
              </div>
              <div className="flex flex-none gap-2 print:hidden">
                <button onClick={() => window.print()} className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-ink/90">Print / Save as PDF</button>
                <a href={api.reportCsvUrl(fy)} className="rounded-lg border border-line px-4 py-2 text-sm font-medium hover:bg-surface">CSV for your agent</a>
              </div>
            </div>
          </Card>

          {/* Indicative position with reasoning */}
          <Card className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted">Indicative taxable position</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums">{money(data.position.indicative_taxable_position_cents)}</div>
            <div className="mt-1 text-xs text-muted">{data.position.caption}</div>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
              <span>PAYG withheld <span className="tabular-nums text-ink">{money(data.position.credits.withholding_cents)}</span></span>
              <span>Franking credits <span className="tabular-nums text-ink">{money(data.position.credits.franking_credit_cents)}</span></span>
              <span>Foreign tax (FITO) <span className="tabular-nums text-ink">{money(data.position.credits.foreign_tax_paid_cents)}</span></span>
              <span>GST credits <span className="tabular-nums text-ink">{money(data.position.credits.gst_credits_cents)}</span></span>
            </div>
          </Card>

          {/* Why each line is what it is */}
          {SEVERITY_ORDER.length > 0 && data.position.lines.length > 0 && (
            <Card className="overflow-hidden">
              <div className="px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted">How that's made up — and why</div>
              {(["income", "deduction", "depreciation", "property"] as PositionLine["group"][]).map((g) => {
                const rows = data.position.lines.filter((l) => l.group === g);
                if (!rows.length) return null;
                return (
                  <div key={g}>
                    <div className="border-t border-line bg-surface px-4 py-1.5 text-xs font-medium text-muted">{GROUP_LABEL[g]}</div>
                    {rows.map((l, i) => (
                      <details key={i} className="border-t border-line px-4 py-2">
                        <summary className="flex cursor-pointer items-center justify-between text-sm">
                          <span>{l.label}</span>
                          <span className="tabular-nums font-medium">{money(l.amount_cents)}</span>
                        </summary>
                        <div className="mt-1 text-xs text-muted">{l.basis} — {l.why}</div>
                      </details>
                    ))}
                  </div>
                );
              })}
            </Card>
          )}

          {/* Things to double-check */}
          <Card className="overflow-hidden">
            <div className="px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted">Things to double-check {data.findings.length ? `(${data.findings.length})` : ""}</div>
            {data.findings.length === 0 ? (
              <div className="border-t border-line px-4 py-4 text-sm text-muted">Nothing flagged from your records for this year. That's not a clearance — your agent should still confirm.</div>
            ) : (
              SEVERITY_ORDER.map((sev) => {
                const items = data.findings.filter((x) => x.severity === sev);
                if (!items.length) return null;
                return items.map((x) => (
                  <div key={x.id} className="border-t border-line px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_CLASS[sev]}`}>{SEVERITY_LABEL[sev]}</span>
                      <span className="text-sm font-medium">{x.title}</span>
                      {x.defer_to_agent && <span className="rounded-full bg-ink/5 px-2 py-0.5 text-xs text-muted">agent decides</span>}
                    </div>
                    <div className="mt-1 text-sm text-muted">{x.general_info_note}</div>
                  </div>
                ));
              })
            )}
          </Card>

          {/* Claims + checklist live on the Dashboard; link rather than duplicate the accept/dismiss controls. */}
          <Card className="p-4 text-sm print:hidden">
            Suggested deductions and your FY checklist are on the{" "}
            <Link to="/dashboard" className="text-ink underline underline-offset-2">Dashboard</Link> — accept or dismiss them there, then re-check this page.
          </Card>

          <p className="text-xs text-muted">{data.disclaimer}</p>
        </>
      ) : null}
    </div>
  );
}
