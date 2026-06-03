import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export const money = (cents: number | null): string =>
  cents == null ? "—" : `$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
