import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { GLOSSARY, type GlossaryKey } from "../content/glossary";
import { currencySymbol, currencyLocale } from "../lib/currency";

// UK epic stop 2 — base-currency-aware money(). The SPA is single-tenant-per-session, so the base
// currency is module-level state set ONCE from situation.base_currency (see setMoneyCurrency, called by
// the app shell). money() keeps its (cents) signature so all ~149 call sites are unchanged.
//
// AU byte-identical contract: the defaults are '$' + 'en-AU' (AU's symbol/locale). The SPA has no
// currency_base kill-switch — display follows the payload's base_currency — so AU byte-identity rests
// ENTIRELY on these defaults holding when base_currency is absent/cached-missing/'AUD'. setMoneyCurrency
// is a no-op for those, so an old/cached situation with no base_currency renders exactly as before.
let _baseCurrency = "AUD";
let _moneySymbol = "$";
let _moneyLocale = "en-AU";

/** Set the session's base currency (call once from the app shell when situation loads). Falsy/absent ⇒
 *  leaves the AU defaults ($/en-AU) in place, so a missing payload field never perturbs AU rendering. */
export function setMoneyCurrency(code: string | null | undefined): void {
  if (!code) return; // absent ⇒ keep AU defaults (byte-identical)
  _baseCurrency = code.trim().toUpperCase();
  _moneySymbol = currencySymbol(_baseCurrency);
  _moneyLocale = currencyLocale(_baseCurrency);
}

/** The session's base currency code (e.g. 'AUD' | 'GBP'). Used by display discriminators that compare a
 *  row's own currency against the tenant base (e.g. "show ≈ converted amount only for FOREIGN rows"). */
export function getBaseCurrency(): string {
  return _baseCurrency;
}

export const money = (cents: number | null): string =>
  cents == null ? "—" : `${_moneySymbol}${(cents / 100).toLocaleString(_moneyLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// #249: parse a user-entered money/number string TOLERANTLY. Users type figures exactly as printed on
// a statement — "$48,963.37", "1,234.56" — but `Number("48,963.37")` is NaN, which JSON-encodes to
// null and 400s server-side with no feedback. Strip the currency symbol, thousands separators and
// whitespace first. Returns null for empty/junk so callers surface an error instead of POSTing NaN.
const _cleanNum = (s: string): number | null => {
  if (s == null || String(s).trim() === "") return null;
  const n = Number(String(s).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
/** Parse a money string to integer cents (comma/$/space tolerant). null when not a number. */
export const parseMoneyToCents = (s: string): number | null => {
  const n = _cleanNum(s);
  return n == null ? null : Math.round(n * 100);
};
/** Parse a plain decimal (e.g. an interest rate %), comma/$/space tolerant. null when not a number. */
export const parseDecimal = (s: string): number | null => _cleanNum(s);

export const BUCKET_LABEL: Record<string, string> = {
  payg: "PAYG",
  company: "Company",
  property_rented: "Property · rented",
  property_vacant: "Property · vacant",
  income_business: "Income · business",
  income_property: "Income · rent",
  income_personal: "Income · personal",
  refund: "Refund",
  asset: "Asset · capital",
  unknown: "Unknown",
};

export function BucketPill({ bucket }: { bucket: string | null }) {
  if (!bucket) return <span className="text-muted text-sm">uncategorised</span>;
  const tone =
    bucket === "company"
      ? "bg-ink/5 text-ink"
      : bucket === "property_rented"
        ? "bg-safe/10 text-safe"
        : bucket === "property_vacant"
          ? "bg-danger/10 text-danger"
          : bucket === "unknown"
            ? "bg-surface text-muted"
            : "bg-surface text-ink";
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>{BUCKET_LABEL[bucket] ?? bucket}</span>;
}

export function ConfidencePill({ value }: { value: number | null }) {
  if (value == null) return <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-muted">no score</span>;
  const pct = Math.round(value * 100);
  const tone = value >= 0.85 ? "bg-safe/10 text-safe" : value >= 0.5 ? "bg-warn/10 text-warn" : "bg-danger/10 text-danger";
  const label = value >= 0.85 ? "auto" : value >= 0.5 ? "review" : "low";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{label} · {pct}%</span>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-card shadow-card ${className}`}>{children}</div>;
}

// Shared button language with the public landing page: pill-shaped, primary = forest,
// ghost = bordered, highlight = the signature sage accent (forest text for contrast).
export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: {
  children: ReactNode;
  variant?: "primary" | "ghost" | "highlight";
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const base =
    "inline-flex h-10 items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold transition disabled:opacity-50";
  const tone =
    variant === "ghost"
      ? "border border-ink/25 bg-transparent text-ink hover:bg-ink/5"
      : variant === "highlight"
        ? "bg-sage text-ink hover:bg-moss"
        : "bg-ink text-cream hover:bg-green";
  return (
    <button className={`${base} ${tone} ${className}`} {...props}>
      {children}
    </button>
  );
}

// Shared text-field language. Forest focus ring, no blue.
export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`rounded-lg border border-line bg-card px-3 py-2 text-sm outline-none transition focus:border-ink/40 focus:ring-2 focus:ring-ink/10 ${className}`}
      {...props}
    />
  );
}

export function Spinner() {
  return <div className="mx-auto my-16 h-6 w-6 animate-spin rounded-full border-2 border-line border-t-ink" />;
}

// ============================================================================
// Green "Organic-Brutalist" primitives — shared by the Dashboard and other pages.
// ============================================================================

/** A raised content panel (the green system's main surface). */
export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-line bg-card p-6 ${className}`}>{children}</section>;
}

/** Panel header: Anton uppercase title, optional subtitle + a right-aligned slot (link/button). */
export function PanelHead({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <h2 className="font-display text-xl tracking-wide text-forest">{title}</h2>
      {sub ? <span className="text-xs text-ink-3">{sub}</span> : null}
      <span className="flex-1" />
      {right}
    </div>
  );
}

/** A KPI tile. `feature` = forest fill (cream text); `accent` = sage fill (forest text). */
export function KpiCard({
  label,
  value,
  foot,
  variant = "default",
  tone,
  className = "",
}: {
  label: ReactNode;
  value: ReactNode;
  foot?: ReactNode;
  variant?: "default" | "feature" | "accent";
  tone?: "warn";
  className?: string;
}) {
  const surface =
    variant === "feature"
      ? "bg-forest border-forest text-cream"
      : variant === "accent"
        ? "bg-sage border-sage text-forest"
        : "bg-card border-line text-ink";
  const labelTone =
    variant === "feature" ? "text-cream/60" : variant === "accent" ? "text-forest/60" : "text-ink-3";
  return (
    <div className={`overflow-hidden rounded-2xl border p-5 ${surface} ${className}`}>
      <div className={`text-[10px] font-bold uppercase tracking-[0.16em] ${labelTone}`}>{label}</div>
      <div className={`mt-2.5 font-display text-4xl leading-none tnum ${tone === "warn" ? "text-warn" : ""}`}>
        {value}
      </div>
      {foot ? (
        <div className={`mt-3 text-[12.5px] ${variant === "default" ? "text-ink-2" : "opacity-70"}`}>{foot}</div>
      ) : null}
    </div>
  );
}

/** Small status pill: ok (green) / warn (ochre) / info (blue) / neutral. */
export function Pill({ tone = "neutral", children }: { tone?: "ok" | "warn" | "info" | "neutral"; children: ReactNode }) {
  const cls =
    tone === "ok"
      ? "bg-safe/10 text-safe"
      : tone === "warn"
        ? "bg-warn/10 text-warn"
        : tone === "info"
          ? "bg-info/10 text-info"
          : "bg-surface text-muted";
  return (
    <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${cls}`}>
      {children}
    </span>
  );
}

/** Horizontal proportion meter (e.g. share of total). `frac` is 0..1. */
export function Meter({ frac, className = "bg-green" }: { frac: number; className?: string }) {
  const pct = Math.max(0, Math.min(1, frac)) * 100;
  return (
    <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface">
      <div className={`h-full rounded-full ${className}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ============================================================================
// Educational "What's this?" tooltips (Radix — accessible on hover AND keyboard
// focus). Copy is the single source of truth in content/glossary.ts. Provider is
// mounted once in App.tsx. Tooltips are an ENHANCEMENT: never the only path to
// essential info, and every deductibility-adjacent tip defers to the year-end
// review + a registered agent (the softener lives in the glossary copy).
// ============================================================================

/** Resolve a tip body from an explicit node or a glossary key. */
function tipBody(k?: GlossaryKey, tip?: ReactNode): ReactNode | null {
  return tip ?? (k ? GLOSSARY[k].short : null);
}

/** The floating bubble — shared by InfoTip and Term. Card surface, ink text, above everything.
 * `onDismiss` closes the controlled tip when the user taps/clicks outside it (the touch-dismiss path). */
function TipBubble({ children, onDismiss }: { children: ReactNode; onDismiss?: () => void }) {
  return (
    <Tooltip.Portal>
      <Tooltip.Content
        side="top"
        align="center"
        sideOffset={6}
        collisionPadding={12}
        onPointerDownOutside={onDismiss}
        className="z-[70] max-w-[18rem] select-none rounded-xl border border-line bg-card px-3 py-2.5 text-xs leading-relaxed text-ink-2 shadow-card"
      >
        {children}
        <Tooltip.Arrow className="fill-card" width={11} height={6} />
      </Tooltip.Content>
    </Tooltip.Portal>
  );
}

/**
 * A small ⓘ trigger that reveals an educational snippet on hover/focus. Use next to headings,
 * stat labels and table headers. Pass a glossary `k` (preferred — keeps copy central) or an
 * explicit `tip`. Renders nothing if neither resolves, so call sites stay clean.
 */
export function InfoTip({ k, tip, label, className = "" }: { k?: GlossaryKey; tip?: ReactNode; label?: string; className?: string }) {
  const body = tipBody(k, tip);
  // Controlled so the tip also opens on TAP: Radix Tooltip only reacts to hover/focus, neither of
  // which fires on touch devices, so the ⓘ was dead on mobile/tablet. We keep hover/focus (via
  // onOpenChange) for desktop and add an explicit tap toggle + outside-tap dismiss.
  const [open, setOpen] = useState(false);
  if (!body) return null;
  return (
    <Tooltip.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          aria-label={label ?? (k ? `What's this? ${GLOSSARY[k].term}` : "What's this?")}
          // Many tips sit inside a <label>; preventDefault stops the ⓘ from activating the label's
          // control (e.g. toggling a checkbox). Open (don't toggle) on tap: Android focuses the button
          // on tap which already opens it via onOpenChange, so a toggle would race-close it; dismissal is
          // handled by outside-tap (TipBubble onDismiss) + Escape instead.
          onClick={(e) => { e.preventDefault(); setOpen(true); }}
          className={`inline-grid h-[15px] w-[15px] flex-none translate-y-[-1px] place-items-center rounded-full border border-ink-3/40 align-middle text-[10px] font-bold leading-none text-ink-3 transition hover:border-ink/50 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/25 ${className}`}
        >
          i
        </button>
      </Tooltip.Trigger>
      <TipBubble onDismiss={() => setOpen(false)}>{body}</TipBubble>
    </Tooltip.Root>
  );
}

/**
 * Inline dotted-underline term for jargon mid-sentence. Children are the visible text (defaults
 * to the glossary term); the tip body comes from `k` or an explicit `tip`. Falls back to plain
 * text when no tip resolves, so it never breaks a sentence.
 */
export function Term({ k, tip, children }: { k?: GlossaryKey; tip?: ReactNode; children?: ReactNode }) {
  const body = tipBody(k, tip);
  const text = children ?? (k ? GLOSSARY[k].term : null);
  // Controlled for tap-to-open on touch (see InfoTip) — keeps hover/focus for desktop.
  const [open, setOpen] = useState(false);
  if (!body) return <>{text}</>;
  return (
    <Tooltip.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          // Open (not toggle) on tap — see InfoTip; dismissal is outside-tap + Escape.
          onClick={(e) => { e.preventDefault(); setOpen(true); }}
          className="cursor-help rounded-sm underline decoration-dotted decoration-ink-3/60 underline-offset-2 transition hover:decoration-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/25"
        >
          {text}
        </button>
      </Tooltip.Trigger>
      <TipBubble onDismiss={() => setOpen(false)}>{body}</TipBubble>
    </Tooltip.Root>
  );
}
