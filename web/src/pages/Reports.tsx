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
function Empty({ cols }: { cols: number }) {
  return (
    <tr className="border-t border-line">
      <td colSpan={cols} className="px-4 py-4 text-sm text-muted">
        No data for this FY.
      </td>
    </tr>
  );
}
