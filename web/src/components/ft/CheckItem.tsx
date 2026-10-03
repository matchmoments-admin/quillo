import type { ReactNode } from "react";
import type { CheckTone } from "./model";
import { FtButton, Skeleton, StatusGate, cx, type StatusProps } from "./primitives";

const TONE: Record<CheckTone, { wrap: string; mark: string; label: string }> = {
  warn: { wrap: "border-warn/30 bg-warn-surface", mark: "bg-warn text-white", label: "Needs a look" },
  info: { wrap: "border-line bg-card", mark: "bg-info text-white", label: "For your info" },
};

/**
 * Check item (design-system.md §4): one thing the Check step found: missing, doubled up or
 * unmatched. `warn` needs the user's decision; `info` is context. Quillo proposes, the user decides:
 * actions are the user's to press. Tone is spelled out in text for screen readers.
 */
export function CheckItem({
  tone = "warn",
  title,
  body,
  actions,
  ...status
}: {
  tone?: CheckTone;
  title: ReactNode;
  body?: ReactNode;
  actions?: { label: ReactNode; onClick: () => void; primary?: boolean; busy?: boolean }[];
} & StatusProps) {
  const t = TONE[tone];
  return (
    <StatusGate
      what="this check"
      {...status}
      emptyTitle={status.emptyTitle ?? "Nothing to check here"}
      skeleton={
        <div className="flex gap-3 rounded-[14px] border border-line bg-card p-4">
          <Skeleton block className="h-6 w-6 rounded-full" />
          <Skeleton lines={3} className="flex-1" />
        </div>
      }
    >
      <div className={cx("flex gap-3 rounded-[14px] border p-4", t.wrap)}>
        <span aria-hidden className={cx("flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold", t.mark)}>
          {tone === "warn" ? "!" : "i"}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-ink">
            <span className="sr-only">{t.label}: </span>
            {title}
          </p>
          {body && <p className="mt-1 max-w-[65ch] text-sm leading-relaxed text-muted">{body}</p>}
          {actions && actions.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {actions.map((a, i) => (
                <FtButton key={i} variant={a.primary ? "primary" : "secondary"} onClick={a.onClick} busy={a.busy}>
                  {a.label}
                </FtButton>
              ))}
            </div>
          )}
        </div>
      </div>
    </StatusGate>
  );
}
