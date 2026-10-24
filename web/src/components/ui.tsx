import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import * as Tooltip from "@radix-ui/react-tooltip";
import { ANY_GLOSSARY, glossaryShort, type AnyGlossaryKey } from "../content/glossary";
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

// The production surface / control class strings, exported so the first-timer journey (components/ft,
// FtShell, the step pages) renders with exactly the same look instead of re-typing (and drifting from)
// them. The components below use these constants verbatim, so their output is unchanged.

/** Card surface (Card). */
export const CARD_CLASS = "rounded-2xl border border-line bg-card shadow-card";
/** Button geometry + type (Button). */
export const BUTTON_BASE =
  "inline-flex h-10 items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold transition disabled:opacity-50";
/** Button colour tones (Button's `variant`). */
export const BUTTON_TONE = {
  primary: "bg-ink text-cream hover:bg-green",
  ghost: "border border-ink/25 bg-transparent text-ink hover:bg-ink/5",
  highlight: "bg-sage text-ink hover:bg-moss",
} as const;
/** Text-field look (Input). */
export const INPUT_CLASS =
  "rounded-lg border border-line bg-card px-3 py-2 text-sm outline-none transition focus:border-ink/40 focus:ring-2 focus:ring-ink/10";
/** Keyboard focus ring for custom controls (InfoTip / Term). */
export const FOCUS_RING_CLASS = "focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/25";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`${CARD_CLASS} ${className}`}>{children}</div>;
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
  return (
    <button className={`${BUTTON_BASE} ${BUTTON_TONE[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}

// Shared text-field language. Forest focus ring, no blue.
export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`${INPUT_CLASS} ${className}`}
      {...props}
    />
  );
}

export function Spinner() {
  return <div className="mx-auto my-16 h-6 w-6 animate-spin rounded-full border-2 border-line border-t-ink" />;
}

/**
 * Persistent inline error surface for a FAILED data load. Use it wherever a component would otherwise
 * render nothing (or a misleading empty state) when a query errors — a silent `return null` hides
 * backend failures and makes "couldn't load" look like "nothing here / all done", which is the single
 * most common defect in this app. Pairs a plain explanation with an optional Retry. For transient
 * ACTION (mutation) failures, prefer a sonner `toast.error` instead — those don't leave a hole in the UI.
 */
export function QueryError({
  error,
  onRetry,
  what = "this",
  className = "",
}: {
  error?: unknown;
  onRetry?: () => void;
  what?: string;
  className?: string;
}) {
  const msg = error instanceof Error ? error.message : typeof error === "string" && error ? error : "something went wrong";
  return (
    <Card className={`flex flex-wrap items-center justify-between gap-3 p-4 text-sm ${className}`}>
      <span className="text-danger">Couldn't load {what}: {msg}</span>
      {onRetry && (
        <button onClick={onRetry} className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold transition hover:bg-surface">
          Retry
        </button>
      )}
    </Card>
  );
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
// Educational "What's this?" Explain tips (Radix — hover/focus preview, click/tap for the full card). Copy is the single source of truth in content/glossary.ts. Provider is
// mounted once in App.tsx. Tooltips are an ENHANCEMENT: never the only path to
// essential info, and every deductibility-adjacent tip defers to the year-end
// review + a registered agent (the softener lives in the glossary copy).
// ============================================================================

/** Resolve a tip body from an explicit node or a glossary key. */
function tipBody(k?: AnyGlossaryKey, tip?: ReactNode): ReactNode | null {
  return tip ?? (k ? glossaryShort(k, ANY_GLOSSARY[k].short) : null); // qbo_retired-aware; OFF ⇒ .short
}

// Explain tips (#698, map #692; owner decision 2026-10-24). One trigger, two presentations:
//   - touch / narrow screens: a bottom SHEET (thumb-reachable, room for the why, links that work);
//   - desktop: a hover preview bubble (the short copy) and, on click, an anchored CARD with
//     What it is / Why it matters for your tax / the official page / related terms.
// A tooltip can't hold links (it isn't interactive), so the card and sheet are Radix Popover/Dialog.
const COARSE_QUERY = "(pointer: coarse), (max-width: 639px)";
function subscribeCoarse(cb: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(COARSE_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
const getCoarse = () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(COARSE_QUERY).matches;
function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribeCoarse, getCoarse, () => false);
}

const EXPLAIN_LABEL = "text-[10px] font-semibold uppercase tracking-wider text-muted";

/** The shared Explain content: what / why / official page / related terms. `onHop` swaps the term in place. */
function ExplainBody({ k, tip, onHop, sheet }: { k?: AnyGlossaryKey; tip?: ReactNode; onHop: (k: AnyGlossaryKey) => void; sheet?: boolean }) {
  const e = k ? ANY_GLOSSARY[k] : undefined;
  const related = (e?.related ?? []).filter((r): r is AnyGlossaryKey => r in ANY_GLOSSARY);
  return (
    <div className={sheet ? "text-sm leading-relaxed text-ink-2" : "text-xs leading-relaxed text-ink-2"}>
      <div className={EXPLAIN_LABEL}>What it is</div>
      <p className="mt-0.5">{tipBody(k, tip)}</p>
      {e?.why && (
        <>
          <div className={`mt-2.5 ${EXPLAIN_LABEL}`}>Why it matters for your tax</div>
          <p className="mt-0.5">{e.why}</p>
        </>
      )}
      {e?.ato && (
        <a href={e.ato.url} target="_blank" rel="noreferrer" className="mt-2.5 inline-block font-semibold text-forest underline underline-offset-2">
          {e.ato.label} ↗
        </a>
      )}
      {related.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {related.map((r) => (
            <button key={r} type="button" onClick={() => onHop(r)} className="min-h-[28px] rounded-full border border-line px-2.5 text-[11px] text-ink-2 transition hover:border-ink/40 hover:text-ink">
              {ANY_GLOSSARY[r].term}
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-muted">
        <span>General information only, not tax advice.</span>
        {k && <a href={`/glossary#${k}`} className="underline underline-offset-2">Glossary</a>}
      </div>
    </div>
  );
}

/** The trigger + presentation shared by InfoTip and Term. `renderTrigger` gets the props the trigger needs. */
function Explain({ k, tip, label, trigger }: { k?: AnyGlossaryKey; tip?: ReactNode; label: string; trigger: (props: { onClick: (e: React.MouseEvent) => void; "aria-label"?: string }) => ReactNode }) {
  const coarse = useCoarsePointer();
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [cur, setCur] = useState<AnyGlossaryKey | undefined>(k);
  const show = (o: boolean) => { setOpen(o); if (o) { setCur(k); setHover(false); } };
  // Many tips sit inside a <label>; preventDefault stops the trigger activating the label's control.
  const onClick = (e: React.MouseEvent) => { e.preventDefault(); show(!open); };
  const term = cur ? ANY_GLOSSARY[cur].term : "What's this?";
  const body = <ExplainBody k={cur} tip={cur === k ? tip : undefined} onHop={setCur} sheet={coarse} />;

  if (coarse) {
    return (
      <Dialog.Root open={open} onOpenChange={show}>
        {/* Our onClick preventDefaults, so Radix's own toggle is skipped; Trigger still restores focus on close. */}
        <Dialog.Trigger asChild>{trigger({ onClick, "aria-label": label })}</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[70] bg-ink/30" />
          <Dialog.Content className="fixed inset-x-0 bottom-0 z-[71] max-h-[80vh] overflow-y-auto rounded-t-2xl border-t border-line bg-card px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 shadow-card">
            <div aria-hidden className="mx-auto mb-3 h-1 w-10 rounded-full bg-line" />
            <div className="flex items-start justify-between gap-3">
              <Dialog.Title className="font-display text-xl text-forest">{term}</Dialog.Title>
              <Dialog.Close className="min-h-[32px] rounded-full px-2 text-sm text-muted">Close</Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">Explanation of {term}</Dialog.Description>
            <div className="mt-2">{body}</div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }
  return (
    <Popover.Root open={open} onOpenChange={show}>
      <Tooltip.Root open={hover && !open} onOpenChange={setHover}>
        <Popover.Trigger asChild>
          <Tooltip.Trigger asChild>{trigger({ onClick, "aria-label": label })}</Tooltip.Trigger>
        </Popover.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content side="top" align="center" sideOffset={6} collisionPadding={12}
            className="z-[70] max-w-[18rem] select-none rounded-xl border border-line bg-card px-3 py-2.5 text-xs leading-relaxed text-ink-2 shadow-card">
            {tipBody(k, tip)}
            <span className="mt-1 block text-[10px] text-muted">Click for more</span>
            <Tooltip.Arrow className="fill-card" width={11} height={6} />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
      <Popover.Portal>
        <Popover.Content side="bottom" align="start" sideOffset={6} collisionPadding={12}
          className="z-[70] w-[20rem] max-w-[calc(100vw-24px)] rounded-xl border border-line bg-card p-3.5 shadow-card">
          <div className="mb-1.5 font-semibold text-ink">{term}</div>
          {body}
          <Popover.Arrow className="fill-card" width={11} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * A small ⓘ trigger next to headings, stat labels and table headers. Pass a glossary `k` (preferred —
 * keeps copy central) or an explicit `tip`. Renders nothing if neither resolves, so call sites stay clean.
 * The hit area is 24px (WCAG 2.5.8) while the visible circle stays 15px.
 */
export function InfoTip({ k, tip, label, className = "" }: { k?: AnyGlossaryKey; tip?: ReactNode; label?: string; className?: string }) {
  if (!tipBody(k, tip)) return null;
  return (
    <Explain k={k} tip={tip} label={label ?? (k ? `What's this? ${ANY_GLOSSARY[k].term}` : "What's this?")}
      trigger={(p) => (
        <button type="button" {...p}
          className={`relative inline-grid h-[15px] w-[15px] flex-none translate-y-[-1px] place-items-center rounded-full border border-ink-3/40 align-middle text-[10px] font-bold leading-none text-ink-3 transition before:absolute before:-inset-[5px] before:content-[''] hover:border-ink/50 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/25 ${className}`}>
          i
        </button>
      )} />
  );
}

/**
 * Inline dotted-underline term for jargon mid-sentence. Children are the visible text (defaults
 * to the glossary term); the tip body comes from `k` or an explicit `tip`. Falls back to plain
 * text when no tip resolves, so it never breaks a sentence.
 */
export function Term({ k, tip, children }: { k?: AnyGlossaryKey; tip?: ReactNode; children?: ReactNode }) {
  const text = children ?? (k ? ANY_GLOSSARY[k].term : null);
  if (!tipBody(k, tip)) return <>{text}</>;
  return (
    <Explain k={k} tip={tip} label={k ? `What's this? ${ANY_GLOSSARY[k].term}` : "What's this?"}
      trigger={(p) => (
        <button type="button" onClick={p.onClick}
          className="cursor-help rounded-sm underline decoration-dotted decoration-ink-3/60 underline-offset-2 transition hover:decoration-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/25">
          {text}
        </button>
      )} />
  );
}
