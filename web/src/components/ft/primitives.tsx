// Shared primitives for the first-timer component library (spec A12 ticket b, #583; design record
// docs/first-timer/design-system.md §3–4). Every ft/ component builds on these, so the rules live in
// one place:
//   • colour only through semantic roles (Tailwind aliases onto design/tokens.mjs; the raw-colour
//     guard in npm test enforces it), so quiet-light and quiet-dark both just work;
//   • every interactive element is an FtButton / FtLink, which carry the ≥44px touch-target floor
//     and the visible focus ring (check-units asserts no other file renders a bare <button>/<a>);
//   • motion is `motion-safe:` only (150ms ease-out, press = scale 0.98), so prefers-reduced-motion
//     turns it off;
//   • loading / empty / error render through StatusGate, so every component has all three states.
// Copy is scanned by the tax-advice denylist (scripts/check-units.ts).

import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { DEFER_TO_AGENT } from "../../content/stepGuides";
import type { FtStatus } from "./model";

/** Minimum touch target (design-system.md §3: ≥44px). */
export const TAP = "min-h-[44px] min-w-[44px]";
/** Visible keyboard focus ring: 2px, 2px offset, focus.ring role. */
export const FOCUS = "focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
/** Quiet motion, reduced-motion safe. */
export const MOTION = "motion-safe:transition motion-safe:duration-150 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]";
const PRESS = "motion-safe:active:scale-[0.98]";

export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(" ");

export type FtButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const VARIANT: Record<FtButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover",
  secondary: "border border-line-strong bg-card text-ink hover:bg-surface",
  ghost: "bg-transparent text-ink hover:bg-surface",
  danger: "border border-danger/40 bg-card text-danger hover:bg-danger-surface",
};

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg px-4 text-[15px] font-semibold disabled:cursor-not-allowed disabled:opacity-50";

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
      className={cx(BUTTON_BASE, TAP, FOCUS, MOTION, PRESS, VARIANT[variant], className)}
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
    MOTION,
    variant ? cx(BUTTON_BASE, PRESS, VARIANT[variant]) : "inline-flex items-center rounded-lg text-accent underline underline-offset-2 hover:text-accent-hover",
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

/** A pill badge. Tones map to status roles. */
export function Badge({ tone = "neutral", children }: { tone?: "accent" | "ok" | "warn" | "info" | "danger" | "neutral"; children: ReactNode }) {
  const t = {
    accent: "bg-accent-soft text-accent",
    ok: "bg-accent-soft text-ok",
    warn: "bg-warn-surface text-warn",
    info: "bg-surface text-info",
    danger: "bg-danger-surface text-danger",
    neutral: "bg-surface text-muted",
  }[tone];
  return <span className={cx("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold", t)}>{children}</span>;
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
    <div className="rounded-[14px] border border-dashed border-line-strong bg-paper p-5 text-center">
      <p className="text-[15px] font-semibold text-ink">{title}</p>
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
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-danger/30 bg-danger-surface p-4">
      <p className="text-sm text-danger">
        Couldn't load {what}: {msg}
      </p>
      {onRetry && (
        <FtButton variant="danger" onClick={onRetry}>
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

/** A decision card surface (raised, bordered, 14px radius). */
export function FtCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-[14px] border border-line bg-card", className)}>{children}</div>;
}
