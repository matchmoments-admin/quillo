import { useEffect, useRef, useState, type ReactNode } from "react";
import { money } from "../ui";
import { copyValue } from "./model";
import { FtButton, FtCheckbox, FtLink, Skeleton, StatusGate, type StatusProps } from "./primitives";

type CopyState = "idle" | "copied" | "failed";

/** The optional tick a worksheet line carries (Ship it, #590): "Done in myTax" / "Matches myTax". */
export interface WorksheetTick {
  checked: boolean;
  /** Ticked once, but the figure has changed since: shown unticked with a prompt to check it again. */
  stale?: boolean;
  label: string;
  onToggle: () => void;
}

/**
 * Worksheet line (design-system.md §4): the myTax label (e.g. `D5`, in mono), what it is, the
 * figure, a copy button and a link to the records behind it. Copy puts a plain number on the
 * clipboard (no symbol, no separators: what a myTax amount field takes). If the clipboard is
 * blocked it selects the figure so it can be copied by hand, and says so. A line with no figure yet
 * has nothing to copy. Optional: a `note` under the name, a `tick` ("Done in myTax"), and `figure`
 * to replace the amount + copy button for a line with nothing to type (a question myTax asks).
 */
export function WorksheetLine({
  code,
  label,
  amountCents,
  record,
  note,
  tick,
  figure,
  codeAfter,
  ...status
}: {
  /** myTax label, e.g. "D5". */
  code?: string;
  label: ReactNode;
  amountCents: number | null;
  /** The records behind the figure: an in-app route. */
  record?: { to: string; label: ReactNode };
  note?: ReactNode;
  tick?: WorksheetTick;
  /** Shown instead of the amount and the copy button. */
  figure?: ReactNode;
  /** Lead with the name and show the code after it, smaller (#590: myTax screens use banner names, not item numbers). */
  codeAfter?: boolean;
} & StatusProps) {
  const [copy, setCopy] = useState<CopyState>("idle");
  const figureRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (copy === "idle") return;
    const t = setTimeout(() => setCopy("idle"), copy === "failed" ? 6000 : 2000);
    return () => clearTimeout(t);
  }, [copy]);

  const value = copyValue(amountCents);
  const onCopy = async () => {
    if (value == null) return;
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setCopy("copied");
    } catch {
      // Fallback: select the figure so the user can copy it themselves.
      const el = figureRef.current;
      const sel = typeof window !== "undefined" ? window.getSelection() : null;
      if (el && sel) {
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      setCopy("failed");
    }
  };

  return (
    <StatusGate
      what="this line"
      {...status}
      emptyTitle={status.emptyTitle ?? "Nothing for this label yet"}
      skeleton={
        <div className="flex min-h-[56px] items-center gap-3 py-2">
          <Skeleton block className="h-5 w-9 rounded" />
          <Skeleton className="flex-1" />
          <Skeleton block className="h-11 w-20 rounded-lg" />
        </div>
      }
    >
      <div className="flex min-h-[56px] flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2 last:border-0">
        {tick && (
          <FtCheckbox className="-ml-2 flex-none" checked={tick.checked} onChange={() => tick.onToggle()}>
            <span className="sr-only">{tick.label}</span>
          </FtCheckbox>
        )}
        {code && !codeAfter && <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs font-semibold text-ink">{code}</span>}
        <div className="min-w-0 flex-1">
          <p className="text-[15px] text-ink">
            {label}
            {code && codeAfter && <span className="ml-2 whitespace-nowrap rounded bg-surface px-1.5 py-0.5 align-middle font-mono text-[11px] text-muted">{code}</span>}
          </p>
          {note && <p className="mt-0.5 text-[13px] leading-snug text-muted">{note}</p>}
          {tick?.stale && <p className="mt-0.5 text-[13px] font-semibold text-warn">This figure changed since you ticked it. Check it again in myTax.</p>}
          {record && (
            <FtLink to={record.to} className="text-[13px]">
              {record.label}
            </FtLink>
          )}
        </div>
        {figure ?? (
          <>
            <span ref={figureRef} className="font-mono text-[15px] font-semibold text-ink tnum">
              {money(amountCents)}
            </span>
            <FtButton
              variant="secondary"
              onClick={onCopy}
              disabled={value == null}
              aria-label={value == null ? "Nothing to copy" : `Copy ${code ? `${code} ` : ""}figure`}
            >
              {copy === "copied" ? "Copied" : "Copy"}
            </FtButton>
          </>
        )}
        <span role="status" aria-live="polite" className="w-full text-right text-xs text-danger empty:hidden">
          {copy === "failed" ? "Couldn't copy. The figure is selected, so copy it yourself." : ""}
        </span>
      </div>
    </StatusGate>
  );
}
