import { useEffect, useRef, useState } from "react";
import { Badge, FtButton, FtCard, FtCheckbox, FtLink, copyValue } from "../components/ft";
import { InfoTip, Term, money } from "../components/ui";
import { SCREEN_TICK_LABEL } from "../content/mytaxMirror";
import { buildMirror, mirrorProgress, screenDone, screenLineProgress, type MirrorLine, type MirrorScreen } from "../lib/mytaxMirror";
import type { useWorksheetTicks } from "../lib/useWorksheetTicks";
import { isTickable } from "../lib/worksheetTicks";
import type { MytaxWorksheet, MytaxWorksheetLine } from "../types";

// The myTax mirror (#790, flag mytax_mirror; needs mytax_worksheet for its data). Replaces the Ship it
// worksheet's section cards with one card per myTax screen, in myTax's order (lib/mytaxMirror.ts):
//   • each card names the screen as myTax does and where it sits ("Prepare return › Income");
//   • a "Check" line (does it match what myTax pre-filled?) and what to do if it's different;
//   • every figure has Copy (plain digits, "Copied" shown on the button; if the clipboard is blocked the figure
//     is selected and it says so). Lines stack on a phone: the name and note get the full width, then the
//     figure + Copy on their own row (WorksheetLine keeps its one-row layout for the flag-OFF worksheet);
//   • ticks persist per FY in ui_state (the worksheet's own ticks, so nothing ticked before is lost); a tick on a
//     figure that has changed since goes stale and asks to be checked again;
//   • "n of m screens done" plus a "Next screen to do" jump, for picking up after an interruption.
// Quillo never lodges and never shows a refund, tax payable, rate or levy figure.

type Ticks = ReturnType<typeof useWorksheetTicks>;

function tickLabel(line: MytaxWorksheetLine): string {
  if (line.kind === "check") return "Matches myTax";
  if (line.key.startsWith("tick:")) return "Ticked in myTax";
  if (line.kind === "answer") return "Answered in myTax";
  return "Done in myTax";
}

const anchor = (key: string) => `mytax-screen-${key.replace(/[^a-z0-9]+/gi, "-")}`;

export function MytaxMirror({ ws, ticks, fy }: { ws: MytaxWorksheet; ticks: Ticks; fy: number }) {
  const screens = buildMirror(ws.sections);
  const progress = mirrorProgress(screens, ticks.ticks, fy);
  const jump = (key: string) => {
    const el = document.getElementById(anchor(key));
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.focus({ preventScroll: true });
  };
  return (
    <div className="space-y-4">
      <FtCard className="space-y-2 p-4 sm:p-5">
        <p className="text-sm text-ink" aria-live="polite">
          <span className="font-semibold tnum">
            {progress.done} of {progress.total}
          </span>{" "}
          myTax screens done
        </p>
        <div className="h-2 overflow-hidden rounded-full bg-surface" aria-hidden="true">
          <div className="h-full rounded-full bg-safe transition-[width]" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
        </div>
        <p className="max-w-[65ch] text-sm text-muted">
          Open myTax in another window and work down these cards in the same order. Copy puts the plain number on your clipboard, ready to paste into
          a myTax amount field. Tick each line once myTax shows the same figure; you can untick it any time.
        </p>
        {progress.next && ticks.ready && (
          <FtButton variant="link" className="text-sm" onClick={() => jump(progress.next!.key)}>
            Next screen to do: {progress.next.title}
          </FtButton>
        )}
      </FtCard>
      {screens.map((s, i) => (
        <MirrorCard key={s.key} screen={s} n={i + 1} ticks={ticks} fy={fy} />
      ))}
    </div>
  );
}

function MirrorCard({ screen, n, ticks, fy }: { screen: MirrorScreen; n: number; ticks: Ticks; fy: number }) {
  const done = ticks.ready && screenDone(screen, ticks.ticks, fy);
  const lp = screenLineProgress(screen, ticks.ticks, fy);
  return (
    <section id={anchor(screen.key)} tabIndex={-1} aria-labelledby={`${anchor(screen.key)}-h`} className="scroll-mt-4 focus:outline-none">
      <FtCard className={`p-4 sm:p-5 ${done ? "border-safe/40" : ""}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-muted">
              <span className="tnum">{n}.</span> In myTax: {screen.where}
            </p>
            <h2 id={`${anchor(screen.key)}-h`} className="font-display text-xl tracking-wide text-forest">
              {screen.title} {screen.term && <InfoTip k={screen.term} />}
            </h2>
          </div>
          {ticks.ready && (done ? <Badge tone="ok">Done</Badge> : lp.total > 0 ? <Badge tone="neutral">{`${lp.done} of ${lp.total} ticked`}</Badge> : null)}
        </div>
        <div className="mt-3 space-y-1 rounded-lg border border-line bg-surface p-3 text-sm">
          <p className="text-ink">
            <span className="font-semibold">Check: </span>
            {screen.check}{" "}
            {screen.mode === "prefilled" && <Term k="prefill">What's prefill?</Term>}
          </p>
          <p className="text-muted">
            <span className="font-semibold text-ink">If it's different: </span>
            {screen.ifDiffers}
          </p>
        </div>
        <div className="mt-2">
          {screen.lines.map((ml) => (
            <MirrorLineRow key={ml.tickId} ml={ml} screenTitle={screen.title} ticks={ticks} />
          ))}
        </div>
        {screen.screenTickId && ticks.ready && (
          <FtCheckbox className="mt-2" checked={ticks.stateOf(screen.screenTickId, null) === "ticked"} onChange={() => ticks.toggle(screen.screenTickId!, null)}>
            {SCREEN_TICK_LABEL}
          </FtCheckbox>
        )}
      </FtCard>
    </section>
  );
}

type CopyState = "idle" | "copied" | "failed";

/** One field: tick, myTax's name (+ Explain), the note, then the figure and Copy — stacked on a phone, one row from sm up. */
function MirrorLineRow({ ml, screenTitle, ticks }: { ml: MirrorLine; screenTitle: string; ticks: Ticks }) {
  const l = ml.line;
  const [copy, setCopy] = useState<CopyState>("idle");
  const figureRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (copy === "idle") return;
    const t = setTimeout(() => setCopy("idle"), copy === "failed" ? 6000 : 2000);
    return () => clearTimeout(t);
  }, [copy]);
  const value = copyValue(l.amount_cents);
  const onCopy = async () => {
    if (value == null) return;
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setCopy("copied");
    } catch {
      // Select the figure so it can be copied by hand, and say so.
      const el = figureRef.current;
      const sel = window.getSelection();
      if (el && sel) {
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      setCopy("failed");
    }
  };
  const state = ticks.stateOf(ml.tickId, l.amount_cents);
  const tickable = isTickable(l) && ticks.ready;
  const figure =
    l.kind === "answer" ? (
      <Badge tone="info">You'll be asked this</Badge>
    ) : l.kind === "note" ? (
      <span className="text-sm text-muted">Nothing to enter</span>
    ) : l.amount_cents == null ? (
      <Badge tone="warn">Not entered</Badge>
    ) : (
      <>
        <span ref={figureRef} className="text-base font-semibold text-ink tnum">
          {money(l.amount_cents)}
        </span>
        <FtButton variant="secondary" onClick={onCopy} aria-label={`Copy ${l.label ? `${l.label} ` : ""}figure`}>
          {copy === "copied" ? "Copied" : "Copy"}
        </FtButton>
      </>
    );
  return (
    <div className="border-b border-line py-3 last:border-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-1">
          {tickable && (
            <FtCheckbox className="-my-2 -ml-2 flex-none" checked={state === "ticked"} onChange={() => ticks.toggle(ml.tickId, l.amount_cents)}>
              <span className="sr-only">{`${tickLabel(l)}: ${screenTitle}, ${l.name}`}</span>
            </FtCheckbox>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm text-ink">
              {l.name} {ml.term && <InfoTip k={ml.term} />}
              {l.label && <span className="ml-1 whitespace-nowrap rounded bg-surface px-1.5 py-0.5 align-middle text-[11px] text-muted">{l.label}</span>}
            </p>
            {l.note && <p className="mt-0.5 text-xs leading-snug text-muted">{l.note}</p>}
            {state === "stale" && <p className="mt-0.5 text-xs font-semibold text-warn">This figure changed since you ticked it. Check it again in myTax.</p>}
            {l.record_href && (
              <FtLink to={l.record_href} className="text-xs">
                See records
              </FtLink>
            )}
          </div>
        </div>
        <div className="flex flex-none items-center justify-end gap-3">{figure}</div>
      </div>
      <p role="status" aria-live="polite" className="text-right text-xs text-danger empty:hidden">
        {copy === "failed" ? "Couldn't copy. The figure is selected, so copy it yourself." : ""}
      </p>
    </div>
  );
}
