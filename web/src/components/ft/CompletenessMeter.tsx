import type { ReactNode } from "react";
import { completeness } from "./model";
import { Skeleton, StatusGate, cx, type StatusProps } from "./primitives";

/**
 * Completeness meter (design-system.md §4): how many items are ready, as "n of m ready" and a bar.
 * It counts items, never money: there is no amount prop by design, so it can't become a refund
 * meter (spec §3.4: no surface shows a refund or tax figure).
 */
export function CompletenessMeter({
  done,
  total,
  label = "Ready for myTax",
  className,
  ...status
}: { done: number; total: number; label?: ReactNode; className?: string } & StatusProps) {
  const c = completeness(done, total);
  return (
    <div className={cx("space-y-2", className)}>
      <StatusGate
        what="your progress"
        {...status}
        emptyTitle={status.emptyTitle ?? "Nothing to count yet"}
        skeleton={
          <div className="space-y-2">
            <Skeleton className="w-1/3" />
            <Skeleton block className="h-2 w-full rounded-full" />
          </div>
        }
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-semibold text-ink">{label}</span>
          <span className="text-xs text-muted tnum">{c.label}</span>
        </div>
        <div
          role="progressbar"
          aria-label={typeof label === "string" ? label : "Progress"}
          aria-valuemin={0}
          aria-valuemax={c.total}
          aria-valuenow={c.done}
          aria-valuetext={c.label}
          className="h-2 overflow-hidden rounded-full bg-surface"
        >
          <div
            className="h-full rounded-full bg-green motion-safe:transition-[width] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]"
            style={{ width: `${c.pct}%` }}
          />
        </div>
      </StatusGate>
    </div>
  );
}
