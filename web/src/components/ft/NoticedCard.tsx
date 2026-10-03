import { useState, type ReactNode } from "react";
import { FtButton, Skeleton, StatusGate, type StatusProps } from "./primitives";

/** What a card needs from a "We noticed…" signal (flag wages_payer, #577) — counts, dates and a total only. */
export interface NoticedCardSignal {
  kind: string;
  evidence: { n: number; first_date: string | null; last_date: string | null; total_cents: number; label: string; second_payer?: boolean };
}

/**
 * The card copy per signal kind (spec A3 table). Proposes, never asserts: a bank credit says where to look,
 * never what to record. Payroll in particular never becomes income (#554) — Yes marks the employer and asks
 * for the income statement.
 */
export function noticedCopy(s: NoticedCardSignal): { title: string; why: string } {
  const who = s.evidence.label || "this payer";
  switch (s.kind) {
    case "payroll":
      return s.evidence.second_payer
        ? { title: `A second employer? ${who} pays you too.`, why: "Regular deposits from the same payer usually mean a job. Saying yes marks them as an employer. The deposits are your take-home pay, so Quillo never counts them as income: your income statement carries the gross pay and tax withheld." }
        : { title: `Looks like pay from ${who}. Is this your wages?`, why: "Regular deposits from the same payer usually mean a job. Saying yes marks them as your employer. The deposits are your take-home pay, so Quillo never counts them as income: your income statement carries the gross pay and tax withheld." };
    case "platform":
      return { title: `Payouts from ${who}. Do you have an ABN for this?`, why: "Payouts from a gig or sharing platform are usually business income. Saying yes sets up a business activity and records these payouts as business income, counted once each. Whether fees are deducted before the payout is something to check in your records." };
    case "government":
      return { title: `Payments from ${who}. These are usually prefilled in myTax.`, why: "Government payments such as Youth Allowance are usually taxable and prefilled in myTax. Saying yes adds a line to check on your myTax worksheet. Nothing is recorded from the bank deposits." };
    case "interest":
      return { title: `Interest from ${who}. Usually prefilled.`, why: "Bank interest is usually prefilled in myTax. Saying yes adds a line to check on your myTax worksheet. Nothing is recorded from the bank deposits." };
    case "foreign":
      return { title: "Money from overseas. Is any of it income?", why: "A transfer from overseas isn't income by itself: it could be savings, a gift or pay. Saying yes notes that you have foreign income to enter. Nothing is recorded from the transfers." };
    default:
      return { title: `We noticed payments from ${who}.`, why: "Quillo spotted a pattern in your bank deposits. Nothing is recorded until you confirm." };
  }
}

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
  ...status
}: {
  signal: NoticedCardSignal;
  amount: string; // the formatted total (money() lives in the app shell, not the library)
  onYes: () => void;
  onNo: () => void;
  busy?: boolean;
  after?: ReactNode; // shown in place of the buttons once confirmed (e.g. the income-statement prompt)
} & StatusProps) {
  const [why, setWhy] = useState(false);
  const copy = noticedCopy(signal);
  const ev = signal.evidence;
  const span = ev.first_date && ev.last_date && ev.first_date !== ev.last_date ? `${ev.first_date} to ${ev.last_date}` : ev.first_date ?? "";
  return (
    <StatusGate
      what="this card"
      {...status}
      skeleton={
        <div className="rounded-[14px] border border-line bg-card p-4">
          <Skeleton lines={3} />
        </div>
      }
    >
      <div className="rounded-[14px] border border-line bg-card p-4">
        <p className="text-[15px] font-semibold text-ink">{copy.title}</p>
        <p className="mt-1 text-sm text-muted">
          {ev.n} deposit{ev.n === 1 ? "" : "s"} · {amount}
          {span ? ` · ${span}` : ""}
        </p>
        {why && <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-muted">{copy.why}</p>}
        {after ? (
          <div className="mt-3">{after}</div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <FtButton variant="primary" onClick={onYes} busy={busy}>
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
