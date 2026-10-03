import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useActiveFy } from "../lib/activeFy";
import { useWorksheetTicks } from "../lib/useWorksheetTicks";
import { isTickable, tickId } from "../lib/worksheetTicks";
import { ErrorState, FtButton, FtLink, GeneralInfoNote, Skeleton } from "../components/ft";
import { money } from "../components/ui";

// Lodge in myTax, print view (/lodge/print; spec A9 ticket b, #590; flags ft_journey + mytax_worksheet). The same
// worksheet as the page, laid out for paper: browser print / "Save as PDF" (no server PDF library). Ticks
// show as boxes, ticked or empty, so the printout works as a checklist beside myTax. The app shell's chrome
// is print:hidden, so only this sheet prints.

export function ShipItPrint() {
  const { fy, label } = useActiveFy();
  const ws = useQuery({ queryKey: ["mytax-worksheet", fy], queryFn: () => api.mytaxWorksheet(fy) });
  const ticks = useWorksheetTicks(fy);
  const printedOn = new Date().toLocaleDateString();

  return (
    <div className="mx-auto max-w-3xl space-y-6 print:max-w-none print:space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <FtLink to="/lodge">Back to Lodge in myTax</FtLink>
        <FtButton variant="primary" onClick={() => window.print()} disabled={!ws.data}>
          Print or save as PDF
        </FtButton>
      </div>

      <header className="space-y-1">
        <h1 className="text-[26px] font-semibold text-ink">myTax worksheet: FY {label}</h1>
        <p className="text-xs text-muted">Prepared with Quillo on {printedOn}. Your own recorded figures, for you to type into myTax.</p>
      </header>

      {ws.isLoading ? (
        <Skeleton lines={6} />
      ) : ws.error ? (
        <ErrorState what="your myTax worksheet" error={ws.error} onRetry={() => ws.refetch()} />
      ) : ws.data ? (
        <>
          <p className="text-sm text-ink">{ws.data.header.intro}</p>
          {ws.data.header.early_lodge_note && <p className="text-sm text-ink">{ws.data.header.early_lodge_note}</p>}
          {!ws.data.tie_back.ok && (
            <p className="rounded-lg border border-warn/40 p-3 text-sm font-semibold text-warn">
              These lines don't add up to the full breakdown yet. Don't copy them into myTax until that's sorted.
            </p>
          )}
          {ws.data.unlabelled.n > 0 && (
            <p className="text-sm text-muted">
              {ws.data.unlabelled.n === 1 ? "1 work expense isn't" : `${ws.data.unlabelled.n} work expenses aren't`} on a line yet: it needs a
              deduction label first.
            </p>
          )}
          {ws.data.sections.length === 0 && <p className="text-sm text-muted">Nothing to put in myTax yet.</p>}
          {ws.data.sections.map((s) => (
            <section key={s.key} className="break-inside-avoid-page">
              <h2 className="border-b border-line-strong pb-1 text-base font-semibold text-ink">{s.title}</h2>
              <table className="mt-1 w-full text-sm">
                <tbody>
                  {s.lines.map((l) => {
                    const id = tickId(s.key, l.key);
                    const tickable = isTickable(l);
                    const ticked = tickable && ticks.stateOf(id, l.amount_cents) === "ticked";
                    return (
                      <tr key={id} className="break-inside-avoid border-b border-line align-top">
                        <td className="w-8 py-2 pr-2">
                          {tickable && (
                            <span
                              aria-label={ticked ? "Ticked" : "Not ticked"}
                              className="inline-grid h-4 w-4 place-items-center rounded-sm border border-ink text-[11px] font-bold leading-none text-ink"
                            >
                              {ticked ? "✓" : ""}
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-2">
                          <div className="text-ink">
                            {l.name}
                            {l.label && <span className="ml-2 whitespace-nowrap font-mono text-[11px] text-muted">{l.label}</span>}
                          </div>
                          {l.note && <div className="mt-0.5 text-xs text-muted">{l.note}</div>}
                        </td>
                        <td className="whitespace-nowrap py-2 text-right font-mono font-semibold text-ink tnum">
                          {l.kind === "answer" ? (l.key.startsWith("tick:") ? "Tick in myTax" : "Answer in myTax") : l.kind === "note" ? "" : l.amount_cents == null ? "Not entered" : money(l.amount_cents)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          ))}
          <p className="text-sm text-ink">
            When you tick myTax's declaration, you're confirming every figure, including the prefilled ones, is right and that you hold the records.
          </p>
          <p className="text-xs leading-relaxed text-muted">{ws.data.disclaimer}</p>
        </>
      ) : null}
      <GeneralInfoNote />
    </div>
  );
}
