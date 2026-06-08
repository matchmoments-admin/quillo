// Motor-vehicle logbook method (#142) — pure, deterministic. NO I/O. GENERAL INFO ONLY.
// The logbook method claims business-use % × actual running costs (incl. car decline-in-value), with no
// km cap — usually beating cents-per-km (capped at 5,000 km) for high-business-use drivers. You may
// claim only ONE car method, so the report compares both and recommends the higher.

/** Business-use % from a logbook (business_km / total_km), clamped to [0,100]. 0 when total is 0. */
export function businessUsePct(businessKm: number | null | undefined, totalKm: number | null | undefined): number {
  const b = Math.max(0, businessKm ?? 0);
  const t = Math.max(0, totalKm ?? 0);
  if (t <= 0) return 0;
  return Math.max(0, Math.min(100, (b / t) * 100));
}

/** Logbook deduction = business-use % × (running costs + car decline-in-value). Whole cents. */
export function logbookDeductionCents(runningCostsCents: number, carDepCents: number, pct: number): number {
  const base = Math.max(0, runningCostsCents) + Math.max(0, carDepCents);
  return Math.round((base * Math.max(0, Math.min(100, pct))) / 100);
}

export interface CarMethodChoice {
  method: "logbook" | "cents_per_km";
  deduction_cents: number;
}

/** The higher of the two car methods (you can claim only one). Ties favour cents-per-km (simpler). */
export function chooseCarMethod(logbookCents: number, centsPerKmCents: number): CarMethodChoice {
  return logbookCents > centsPerKmCents
    ? { method: "logbook", deduction_cents: logbookCents }
    : { method: "cents_per_km", deduction_cents: centsPerKmCents };
}
