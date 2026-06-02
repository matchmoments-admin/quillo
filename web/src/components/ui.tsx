import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export const money = (cents: number | null): string =>
  cents == null ? "—" : `$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const BUCKET_LABEL: Record<string, string> = {
  payg: "PAYG",
  company: "Company",
  property_rented: "Property · rented",
  property_vacant: "Property · vacant",
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
  return <div className={`rounded-2xl border border-line/70 bg-white shadow-card ${className}`}>{children}</div>;
}

// Shared button language with the public landing page: pill-shaped, primary = bg-ink,
// ghost = bordered, highlight = the signature yellow (CTAs/emphasis only — ink text for
// contrast). Pages can adopt this incrementally; it keeps the app and the marketing site
// speaking the same visual dialect.
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
      ? "border border-line bg-transparent text-ink hover:bg-surface"
      : variant === "highlight"
        ? "bg-yellow text-ink hover:bg-yellow-d"
        : "bg-ink text-white hover:bg-ink/90";
  return (
    <button className={`${base} ${tone} ${className}`} {...props}>
      {children}
    </button>
  );
}

// Shared text-field language — extracted from the inline patterns repeated across pages
// (TxnDetail, Settings, Onboarding, Accounts). Ink focus ring, no blue. Adopt incrementally.
export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none transition focus:border-ink/40 focus:ring-2 focus:ring-ink/10 ${className}`}
      {...props}
    />
  );
}

export function Spinner() {
  return <div className="mx-auto my-16 h-6 w-6 animate-spin rounded-full border-2 border-line border-t-ink" />;
}
