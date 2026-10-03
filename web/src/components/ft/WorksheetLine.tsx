import { useEffect, useState, type ReactNode } from "react";
import { money } from "../ui";
import { copyValue } from "./model";
import { FtButton, FtLink, Skeleton, StatusGate, type StatusProps } from "./primitives";

type CopyState = "idle" | "copied" | "failed";

/**
 * Worksheet line (design-system.md §4): the myTax label (e.g. `D5`, in mono), what it is, the
 * figure, a copy button and a link to the records behind it. Copy puts a plain number on the
 * clipboard (no symbol, no separators: what a myTax amount field takes). If the clipboard is
 * blocked it says so instead of failing silently. A line with no figure yet has nothing to copy.
 */
export function WorksheetLine({
  code,
  label,
  amountCents,
  record,
  ...status
}: {
  /** myTax label, e.g. "D5". */
  code?: string;
  label: ReactNode;
  amountCents: number | null;
  /** The records behind the figure: an in-app route. */
  record?: { to: string; label: ReactNode };
} & StatusProps) {
  const [copy, setCopy] = useState<CopyState>("idle");
  useEffect(() => {
    if (copy === "idle") return;
    const t = setTimeout(() => setCopy("idle"), 2000);
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
        {code && <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs font-semibold text-ink">{code}</span>}
        <div className="min-w-0 flex-1">
          <p className="text-[15px] text-ink">{label}</p>
          {record && (
            <FtLink to={record.to} className="text-[13px]">
              {record.label}
            </FtLink>
          )}
        </div>
        <span className="font-mono text-[15px] font-semibold text-ink tnum">{money(amountCents)}</span>
        <FtButton
          variant="secondary"
          onClick={onCopy}
          disabled={value == null}
          aria-label={value == null ? "Nothing to copy" : `Copy ${code ? `${code} ` : ""}figure`}
        >
          {copy === "copied" ? "Copied" : "Copy"}
        </FtButton>
        <span role="status" aria-live="polite" className="w-full text-right text-xs text-danger empty:hidden">
          {copy === "failed" ? "Couldn't copy. Select the figure and copy it yourself." : ""}
        </span>
      </div>
    </StatusGate>
  );
}
