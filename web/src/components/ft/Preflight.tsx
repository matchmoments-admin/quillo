import type { ReactNode } from "react";
import { Badge } from "./primitives";

// Pre-flight pieces (H&R Block review (d), pattern P1): the opening card of a step says once what's coming
// and what to have ready, so the screens after it can stay short. Production look only: the card is an
// FtCard, the numbers sit on production's sage, the "You'll need" items are static Badges (not toggles).

/** A bordered numbered list: one line per item, in order. `title` is optional (bold lead-in). */
export function PreflightSteps({ label, items }: { label: string; items: readonly { key: string; title?: ReactNode; body: ReactNode }[] }) {
  return (
    <ol aria-label={label} className="divide-y divide-line rounded-xl border border-line">
      {items.map((it, i) => (
        <li key={it.key} className="flex items-start gap-3 px-3 py-2.5 text-sm">
          <span aria-hidden className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sage text-xs font-semibold text-forest">
            {i + 1}
          </span>
          <span className="min-w-0 leading-relaxed text-muted">
            {it.title && <span className="font-semibold text-ink">{it.title}. </span>}
            {it.body}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** "You'll need": what to have ready, as a row of static badges. */
export function YoullNeed({ items }: { items: readonly string[] }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">You'll need</p>
      <ul className="flex flex-wrap gap-2">
        {items.map((t) => (
          <li key={t}>
            <Badge>{t}</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}
