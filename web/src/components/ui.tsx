import type { ReactNode } from "react";

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
      ? "bg-accent/10 text-accent"
      : bucket === "property_rented"
        ? "bg-safe/10 text-safe"
        : bucket === "property_vacant"
          ? "bg-danger/10 text-danger"
          : bucket === "unknown"
            ? "bg-slate-100 text-muted"
            : "bg-slate-100 text-ink";
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>{BUCKET_LABEL[bucket] ?? bucket}</span>;
}

export function ConfidencePill({ value }: { value: number | null }) {
  if (value == null) return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-muted">no score</span>;
  const pct = Math.round(value * 100);
  const tone = value >= 0.85 ? "bg-safe/10 text-safe" : value >= 0.5 ? "bg-warn/10 text-warn" : "bg-danger/10 text-danger";
  const label = value >= 0.85 ? "auto" : value >= 0.5 ? "review" : "low";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{label} · {pct}%</span>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-white shadow-card ${className}`}>{children}</div>;
}

export function Spinner() {
  return <div className="mx-auto my-16 h-6 w-6 animate-spin rounded-full border-2 border-line border-t-accent" />;
}
