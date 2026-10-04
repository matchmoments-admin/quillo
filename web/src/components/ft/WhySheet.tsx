import { useEffect, useId, useRef, type ReactNode } from "react";
import { STEP_GUIDES, type StepKey } from "../../content/stepGuides";
import { role } from "../../lib/theme";
import { FtButton, FtLink, GeneralInfoNote, Skeleton, StatusGate, type StatusProps } from "./primitives";

/**
 * The "Why?" sheet (design-system.md §4): explains the current step, it never drives it. A bottom
 * sheet on a phone, a right-hand drawer from md up. With `step`, the points and ATO links come from
 * content/stepGuides.ts (the static explainer when Ask Quillo is off); `children` adds more below
 * (the Ask Quillo drawer slot). Modal: Escape and the backdrop close it, focus moves in on open and
 * back to the opener on close, and the page behind doesn't scroll.
 */
export function WhySheet({
  open,
  onClose,
  step,
  title,
  children,
  ...status
}: {
  open: boolean;
  onClose: () => void;
  step?: StepKey;
  title?: ReactNode;
  children?: ReactNode;
} & StatusProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus();
    };
  }, [open]);

  if (!open) return null;
  const guide = step ? STEP_GUIDES[step] : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-stretch md:justify-end">
      <div aria-hidden className="absolute inset-0 bg-ink/30 motion-safe:animate-[ft-fade-in_220ms_cubic-bezier(0.16,1,0.3,1)]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[85vh] w-full flex-col rounded-t-2xl bg-card motion-safe:animate-[ft-sheet-in_220ms_cubic-bezier(0.16,1,0.3,1)] md:max-h-none md:w-[420px] md:rounded-none md:rounded-l-2xl"
        style={{ boxShadow: `0 -8px 24px ${role("text-primary", 0.1)}` }}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-2">
          <h2 id={titleId} className="font-display text-xl tracking-wide text-forest">
            {title ?? (guide ? `Why ${guide.title}?` : "Why?")}
          </h2>
          <FtButton ref={closeRef} variant="ghost" onClick={onClose} aria-label="Close">
            Close
          </FtButton>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))] pt-4">
          <StatusGate
            what="the explainer"
            {...status}
            emptyTitle={status.emptyTitle ?? "No explainer for this yet"}
            skeleton={<Skeleton lines={4} />}
          >
            {guide && (
              <>
                <ul className="space-y-2 text-sm leading-relaxed text-ink">
                  {guide.why.map((w) => (
                    <li key={w} className="flex gap-2">
                      <span aria-hidden className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-green" />
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
                {guide.links.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted">Read more on ato.gov.au</p>
                    <ul>
                      {guide.links.map((l) => (
                        <li key={l.url}>
                          <FtLink href={l.url} className="text-sm">
                            {l.label}
                          </FtLink>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
            {children}
          </StatusGate>
          <GeneralInfoNote />
        </div>
      </div>
    </div>
  );
}
