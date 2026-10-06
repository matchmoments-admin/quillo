import type { ReactNode } from "react";
import { STEP_GUIDES } from "../../content/stepGuides";
import { JOURNEY_STEPS, STEP_TOTAL, segmentStates, stepLabel, type JourneyStep } from "./model";
import { FtButton, Skeleton, StatusGate, cx, type StatusProps } from "./primitives";

/**
 * Step header (spec A12 / design-system.md §4): progress segments, "Step n of 4 · N more after this", a
 * small Why? text button beside it (it opens the explainer; the footer stays a two-button Back / primary
 * row), an optional `sub` line for progress inside the step ("Question 2 of 6"), then the step title and
 * its one-line intro. Title and intro come from content/stepGuides.ts so the header and the Why? sheet
 * never disagree; pass `title` / `intro` to override. `bare` keeps only the progress row, for an opening
 * card that carries the step's heading itself (one H1 per screen).
 */
export function StepHeader({
  step,
  title,
  intro,
  right,
  sub,
  onWhy,
  bare = false,
  ...status
}: { step: JourneyStep; title?: ReactNode; intro?: ReactNode; right?: ReactNode; sub?: ReactNode; onWhy?: () => void; bare?: boolean } & StatusProps) {
  const n = JOURNEY_STEPS.indexOf(step) + 1;
  const segs = segmentStates(n, STEP_TOTAL);
  const label = stepLabel(n, STEP_TOTAL);
  const guide = STEP_GUIDES[step];
  return (
    <header className="space-y-3">
      <div className="flex items-center gap-3">
        <ol aria-label="Journey progress" className="flex flex-1 gap-1">
          {segs.map((s, i) => (
            <li
              key={JOURNEY_STEPS[i]}
              aria-current={s === "current" ? "step" : undefined}
              className={cx("h-1.5 flex-1 rounded-full", s === "todo" ? "bg-surface" : s === "current" ? "bg-green" : "bg-green/45")}
            >
              <span className="sr-only">
                {STEP_GUIDES[JOURNEY_STEPS[i] as JourneyStep].title}: {s === "done" ? "done" : s === "current" ? "current step" : "to do"}
              </span>
            </li>
          ))}
        </ol>
        <span className="shrink-0 text-xs text-muted">{label}</span>
        {onWhy && (
          <FtButton variant="link" className="shrink-0 text-xs" onClick={onWhy} aria-haspopup="dialog">
            Why?
          </FtButton>
        )}
      </div>
      {sub && <p className="text-xs text-muted">{sub}</p>}
      <StatusGate
        what="this step"
        {...status}
        skeleton={
          <div className="space-y-3">
            <Skeleton className="max-w-xs" />
            <Skeleton lines={2} className="max-w-[65ch]" />
          </div>
        }
      >
        {!bare && (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="font-display text-4xl text-forest">{title ?? guide.title}</h1>
              <p className="mt-1 max-w-[65ch] text-sm leading-relaxed text-muted">{intro ?? guide.intro}</p>
            </div>
            {right}
          </div>
        )}
      </StatusGate>
    </header>
  );
}
