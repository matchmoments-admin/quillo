import { useState, type ReactNode } from "react";
import { FtButton, Skeleton, StatusGate, type StatusProps } from "./primitives";
import { noticedCopy, type NoticedCardSignal } from "./model";

/**
 * "We noticed…" card (spec A3): one detected pattern in the bank's money-in with Yes / No / Not sure.
 * Yes and No are the user's call (the parent runs them); Not sure leaves the card open and shows why.
 */
export function NoticedCard({
  signal,
  amount,
  onYes,
  onNo,
  busy,
  after,
  choices,
  onYesAs,
  ...status
}: {
  signal: NoticedCardSignal;
  amount: string; // the formatted total (money() lives in the app shell, not the library)
  onYes: () => void;
  onNo: () => void;
  busy?: boolean;
  after?: ReactNode; // shown in place of the buttons once confirmed (e.g. the income-statement prompt)
  /** wages_link_statement (#832): income-statement employers to link this pay to; Yes asks which one first. */
  choices?: string[];
  onYesAs?: (employerName: string | null) => void;
} & StatusProps) {
  const [why, setWhy] = useState(false);
  const [asking, setAsking] = useState(false);
  const copy = noticedCopy(signal);
  const ev = signal.evidence;
  const span = ev.first_date && ev.last_date && ev.first_date !== ev.last_date ? `${ev.first_date} to ${ev.last_date}` : ev.first_date ?? "";
  return (
    <StatusGate
      what="this card"
      {...status}
      skeleton={
        <div className="rounded-2xl border border-line bg-card shadow-card p-4">
          <Skeleton lines={3} />
        </div>
      }
    >
      <div className="rounded-2xl border border-line bg-card shadow-card p-4">
        <p className="text-sm font-semibold text-ink">{copy.title}</p>
        <p className="mt-1 text-sm text-muted">
          {signal.kind === "rental_property" ? `${ev.n} statement${ev.n === 1 ? "" : "s"} · ${amount} rent` : `${ev.n} deposit${ev.n === 1 ? "" : "s"} · ${amount}`}
          {span ? ` · ${span}` : ""}
        </p>
        {why && <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-muted">{copy.why}</p>}
        {after ? (
          <div className="mt-3">{after}</div>
        ) : asking && choices?.length && onYesAs ? (
          <div className="mt-3 space-y-2" role="group" aria-label="Which income statement is this pay from?">
            <p className="text-sm font-semibold text-ink">Which income statement is this pay from?</p>
            <p className="max-w-[65ch] text-sm text-muted">Your bank may name your employer differently from the income statement. Pick the one this pay belongs to.</p>
            <div className="flex flex-wrap gap-2">
              {choices.map((c) => (
                <FtButton key={c} onClick={() => onYesAs(c)} busy={busy}>
                  {c}
                </FtButton>
              ))}
              <FtButton variant="ghost" onClick={() => onYesAs(null)} disabled={busy}>
                Its income statement isn't added yet
              </FtButton>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <FtButton variant="primary" onClick={choices?.length && onYesAs ? () => setAsking(true) : onYes} busy={busy}>
              Yes
            </FtButton>
            <FtButton onClick={onNo} disabled={busy}>
              No
            </FtButton>
            <FtButton variant="ghost" onClick={() => setWhy(true)} disabled={busy || why}>
              Not sure? Why
            </FtButton>
          </div>
        )}
      </div>
    </StatusGate>
  );
}
