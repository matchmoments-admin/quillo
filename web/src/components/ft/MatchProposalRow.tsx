import type { ReactNode } from "react";
import { Badge, FtButton, Skeleton, StatusGate, type StatusProps } from "./primitives";

/** One side of a pair, already formatted by the caller (name, amount, date). */
export interface MatchSide {
  name: ReactNode;
  amount: ReactNode;
  date?: ReactNode;
}

function Side({ label, side }: { label: string; side: MatchSide }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className="truncate text-sm text-ink">{side.name}</p>
      <p className="text-xs text-muted">
        <span className="tnum font-semibold text-ink">{side.amount}</span>
        {side.date && <span> · {side.date}</span>}
      </p>
    </div>
  );
}

/**
 * Match proposal row (spec A8): "Receipt: Officeworks, 3 Mar → Bank line: OFFICEWORKS 0423, 4 Mar", with
 * the user's actions (Match / Not this one for a proposal; Undo for a pair already linked). Quillo
 * proposes, the user decides: nothing is linked until the user presses Match.
 */
export function MatchProposalRow({
  receipt,
  line,
  badge,
  note,
  actions,
  ...status
}: {
  receipt: MatchSide;
  line: MatchSide;
  /** Short label above the pair, e.g. "Matched automatically" or "Money in". */
  badge?: ReactNode;
  note?: ReactNode;
  actions: { label: ReactNode; onClick: () => void; primary?: boolean; busy?: boolean; disabled?: boolean }[];
} & StatusProps) {
  return (
    <StatusGate
      what="this match"
      {...status}
      emptyTitle={status.emptyTitle ?? "Nothing to match"}
      skeleton={
        <div className="rounded-2xl border border-line bg-card shadow-card p-4">
          <Skeleton lines={3} />
        </div>
      }
    >
      <div className="rounded-2xl border border-line bg-card shadow-card p-4">
        {badge && (
          <div className="mb-2">
            <Badge tone="info">{badge}</Badge>
          </div>
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Side label="Receipt" side={receipt} />
          <span aria-hidden className="hidden text-muted sm:block">→</span>
          <Side label="Bank line" side={line} />
        </div>
        {note && <p className="mt-2 max-w-[65ch] text-xs leading-relaxed text-muted">{note}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {actions.map((a, i) => (
            <FtButton key={i} variant={a.primary ? "primary" : "secondary"} onClick={a.onClick} busy={a.busy} disabled={a.disabled}>
              {a.label}
            </FtButton>
          ))}
        </div>
      </div>
    </StatusGate>
  );
}
