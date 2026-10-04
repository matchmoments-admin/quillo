// Shared primitives for the first-timer component library (spec A12 ticket b, #583; design record
// docs/first-timer/design-system.md §3–4). Every ft/ component builds on these, so the rules live in
// one place:
//   • look and feel is PRODUCTION's (owner directive 2026-10-04: "only the components updated and the
//     journey clearer, don't change the core UI"): buttons, cards, inputs and the focus ring reuse the
//     class strings exported from ../ui.tsx, and colour uses only the palette production pages use
//     (ink / forest / green / sage / moss / cream / paper / card / line / muted / surface / status) —
//     check-units fails on the Direction A roles (accent / line-strong / ok / warn-surface / focus);
//   • every interactive element is an FtButton / FtLink, which carry the ≥44px touch-target floor
//     and the visible focus ring (check-units asserts no other file renders a bare <button>/<a>);
//   • ft/-owned motion is `motion-safe:` only, so prefers-reduced-motion turns it off;
//   • loading / empty / error render through StatusGate, so every component has all three states.
// Copy is scanned by the tax-advice denylist (scripts/check-units.ts).

import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Link } from "react-router-dom";
import { DEFER_TO_AGENT } from "../../content/stepGuides";
import { BUTTON_BASE, BUTTON_TONE, CARD_CLASS, FOCUS_RING_CLASS, INPUT_CLASS } from "../ui";
import type { FtStatus } from "./model";

/** Minimum touch target (design-system.md §3: ≥44px). */
export const TAP = "min-h-[44px] min-w-[44px]";
/** Visible keyboard focus ring: production's ink ring (ui.tsx FOCUS_RING_CLASS, as on InfoTip / Term). */
export const FOCUS = FOCUS_RING_CLASS;
/** Quiet motion, reduced-motion safe. */
export const MOTION = "motion-safe:transition motion-safe:duration-150 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]";

export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(" ");

/**
 * Button tones. Owner directive (2026-10-04): the journey looks exactly like production, so every tone is
 * production's Button tone from ui.tsx (BUTTON_TONE), shared, never re-typed. `secondary` = production
 * ghost (bordered); `ghost` = the same without the border (Back links); `danger` = production's
 * destructive ghost (Accounts: `border-danger/40 text-danger`).
 */
export type FtButtonVariant = "primary" | "secondary" | "highlight" | "ghost" | "danger";

const VARIANT: Record<FtButtonVariant, string> = {
  primary: BUTTON_TONE.primary,
  secondary: BUTTON_TONE.ghost,
  highlight: BUTTON_TONE.highlight,
  ghost: "bg-transparent text-ink hover:bg-ink/5",
  danger: "border border-danger/40 bg-transparent text-danger hover:bg-danger/5",
};

/** The one button. `busy` disables it and announces the work in progress. Forwards its ref (focus management). */
export const FtButton = forwardRef<
  HTMLButtonElement,
  { variant?: FtButtonVariant; busy?: boolean; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>
>(function FtButton({ variant = "secondary", busy = false, className, children, disabled, type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(BUTTON_BASE, TAP, FOCUS, VARIANT[variant], className)}
      {...props}
    >
      {children}
    </button>
  );
});

/**
 * The one link. `to` routes inside the app; `href` opens outside it in a new tab (ATO pages).
 * `variant` makes it look like a button; omitted, it reads as an inline text link that still has
 * a 44px hit area.
 */
export function FtLink({
  to,
  href,
  variant,
  className,
  children,
  ...props
}: { to?: string; href?: string; variant?: FtButtonVariant; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const cls = cx(
    TAP,
    FOCUS,
    variant ? cx(BUTTON_BASE, VARIANT[variant]) : cx(MOTION, "inline-flex items-center rounded-lg text-ink underline underline-offset-2 hover:text-green"),
    className,
  );
  if (to !== undefined) {
    return (
      <Link to={to} className={cls} {...props}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls} {...props}>
      {children}
    </a>
  );
}

/** Text fields wear production's Input look (ui.tsx INPUT_CLASS, including its focus ring). */
const FIELD = INPUT_CLASS;

/** The one multi-line text field (#591, the Why? drawer's question box): 44px floor + the focus ring. */
export const FtTextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function FtTextArea({ className, rows = 2, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cx(TAP, FIELD, "w-full resize-none", className)}
      {...props}
    />
  );
});

/** The one single-line field (#585 About you: dates, occupation): 44px floor + the focus ring. */
export const FtInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function FtInput({ className, ...props }, ref) {
  return <input ref={ref} className={cx(TAP, FIELD, className)} {...props} />;
});

/**
 * The one tick box (#585 Get set up: the myTax self-check). The whole label row is the 44px hit area; the box
 * itself carries the focus ring. `children` is the visible label.
 */
export function FtCheckbox({ checked, onChange, children, className }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode; className?: string }) {
  return (
    <label className={cx(TAP, "flex cursor-pointer items-center gap-3 text-sm font-medium text-ink", className)}>
      <input type="checkbox" className={cx(FOCUS, "h-4 w-4 shrink-0")} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

/** The one dropdown (#585 About you: a period's answer): 44px floor + the focus ring. */
export const FtSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function FtSelect({ className, children, ...props }, ref) {
  return (
    <select ref={ref} className={cx(TAP, FIELD, className)} {...props}>
      {children}
    </select>
  );
});

/** A pill badge — production's pill language (ui.tsx BucketPill / ConfidencePill / Pill tones). */
export function Badge({ tone = "neutral", children }: { tone?: "highlight" | "ok" | "warn" | "info" | "danger" | "neutral"; children: ReactNode }) {
  const t = {
    highlight: "bg-sage text-forest",
    ok: "bg-safe/10 text-safe",
    warn: "bg-warn/10 text-warn",
    info: "bg-info/10 text-info",
    danger: "bg-danger/10 text-danger",
    neutral: "bg-surface text-muted",
  }[tone];
  return <span className={cx("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium", t)}>{children}</span>;
}

/**
 * Skeleton text lines, or one shaped `block` (size it with className). Pulses only when motion is
 * allowed; hidden from assistive tech (StatusGate announces loading).
 */
export function Skeleton({ lines = 1, block = false, className }: { lines?: number; block?: boolean; className?: string }) {
  if (block) return <div aria-hidden className={cx("bg-surface motion-safe:animate-pulse", className)} />;
  return (
    <div aria-hidden className={cx("space-y-2", className)}>
      {Array.from({ length: Math.max(1, lines) }, (_, i) => (
        <div key={i} className={cx("h-3.5 rounded-full bg-surface motion-safe:animate-pulse", i === lines - 1 && lines > 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

/** Nothing here yet. Says what's missing and, optionally, the next thing to do. */
export function EmptyState({ title = "Nothing here yet", body, action }: { title?: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-ink/25 bg-paper p-5 text-center">
      <p className="text-sm font-semibold text-ink">{title}</p>
      {body && <p className="mx-auto mt-1 max-w-[65ch] text-sm text-muted">{body}</p>}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

/**
 * A failed load. Never silent: says it couldn't load and offers Retry when the caller can retry,
 * so "couldn't load" never looks like "nothing here".
 */
export function ErrorState({ what = "this", error, onRetry }: { what?: string; error?: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : typeof error === "string" && error ? error : "something went wrong";
  return (
    <div role="alert" className={cx(CARD_CLASS, "flex flex-wrap items-center justify-between gap-3 p-4 text-sm")}>
      <p className="text-danger">
        Couldn't load {what}: {msg}
      </p>
      {onRetry && (
        <FtButton variant="secondary" onClick={onRetry}>
          Retry
        </FtButton>
      )}
    </div>
  );
}

/** Props every ft/ component takes for its load state. */
export interface StatusProps {
  /** Default `ready`. */
  status?: FtStatus;
  /** Shown by the error state. */
  error?: unknown;
  onRetry?: () => void;
  /** Overrides the empty state's text. */
  emptyTitle?: ReactNode;
  emptyBody?: ReactNode;
  emptyAction?: ReactNode;
}

/**
 * Renders the loading (component-shaped skeleton), empty or error state, or the content when ready.
 * `what` names the thing for the error and loading announcements ("your claims").
 */
export function StatusGate({
  status = "ready",
  what,
  skeleton,
  error,
  onRetry,
  emptyTitle,
  emptyBody,
  emptyAction,
  children,
}: StatusProps & { what: string; skeleton: ReactNode; children: ReactNode }) {
  if (status === "loading") {
    return (
      <div role="status" aria-live="polite">
        <span className="sr-only">Loading {what}</span>
        {skeleton}
      </div>
    );
  }
  if (status === "error") return <ErrorState what={what} error={error} onRetry={onRetry} />;
  if (status === "empty") return <EmptyState title={emptyTitle} body={emptyBody} action={emptyAction} />;
  return <>{children}</>;
}

/** The general-information footnote shown on every money surface (spec §3.4). */
export function GeneralInfoNote({ className }: { className?: string }) {
  return (
    <p className={cx("max-w-[65ch] text-xs leading-relaxed text-muted", className)}>
      General information only, not tax advice. {DEFER_TO_AGENT}
    </p>
  );
}

/** A decision card surface: production's Card (ui.tsx CARD_CLASS). */
export function FtCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(CARD_CLASS, className)}>{children}</div>;
}
