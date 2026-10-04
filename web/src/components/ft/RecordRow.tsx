import type { ReactNode } from "react";
import { RECORD_STATUS_LABEL, type RecordStatus } from "./model";
import { FtButton, Skeleton, StatusGate, cx, type StatusProps } from "./primitives";

const DOT: Record<RecordStatus, string> = {
  recorded: "bg-safe",
  needs_record: "bg-warn",
  exception: "bg-info",
};
const TEXT: Record<RecordStatus, string> = {
  recorded: "text-safe",
  needs_record: "text-warn",
  exception: "text-info",
};

/**
 * Record row (design-system.md §4): what the record is for, its status and one action
 * ("Add receipt", "View"). Status is shown as text as well as colour, so it never relies on colour
 * alone. Use inside a list; `status="loading"` renders a row-shaped skeleton.
 */
export function RecordRow({
  label,
  meta,
  recordStatus,
  action,
  ...status
}: {
  label: ReactNode;
  /** Date, amount or file name. */
  meta?: ReactNode;
  recordStatus: RecordStatus;
  action?: { label: ReactNode; onClick: () => void; busy?: boolean };
} & StatusProps) {
  return (
    <StatusGate
      what="this record"
      {...status}
      emptyTitle={status.emptyTitle ?? "No records yet"}
      skeleton={
        <div className="flex min-h-[56px] items-center gap-3 px-1 py-2">
          <Skeleton block className="h-2.5 w-2.5 rounded-full" />
          <Skeleton lines={2} className="flex-1" />
          <Skeleton block className="h-11 w-24 rounded-lg" />
        </div>
      }
    >
      <div className="flex min-h-[56px] items-center gap-3 border-b border-line px-1 py-2 last:border-0">
        <span aria-hidden className={cx("h-2.5 w-2.5 shrink-0 rounded-full", DOT[recordStatus])} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-ink">{label}</p>
          <p className="text-xs">
            <span className={cx("font-semibold", TEXT[recordStatus])}>{RECORD_STATUS_LABEL[recordStatus]}</span>
            {meta && <span className="text-muted"> · {meta}</span>}
          </p>
        </div>
        {action && (
          <FtButton variant={recordStatus === "needs_record" ? "primary" : "secondary"} onClick={action.onClick} busy={action.busy}>
            {action.label}
          </FtButton>
        )}
      </div>
    </StatusGate>
  );
}
