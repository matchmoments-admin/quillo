// Computed work-use deductions that are NOT a percentage of tracked spend — they're calculated from
// a per-FY input the user supplies, and they REPLACE the itemised running costs they cover (so those
// receipts stay excluded from the position, never double-claimed):
//   • Working-from-home, fixed-rate method: hours × c/hr (PCG 2023/1). Covers electricity, internet,
//     phone and stationery.
//   • Car, cents-per-kilometre method: min(work_km, cap) × c/km (capped, e.g. 5,000 km). Covers all
//     running costs (fuel, servicing, rego, insurance).
// PURE + deterministic (no I/O), like deductibility.ts / depreciation.ts — the DO reads the inputs +
// FY rates and hands plain values here. GENERAL INFO ONLY; never asserts tax payable or a refund.

export interface WorkUseInputs {
  wfh_hours: number | null;
  car_work_km: number | null;
}

export interface WorkUseRates {
  wfh_cents_per_hour: number;
  car_cents_per_km: number;
  car_km_cap: number;
}

export interface WorkMethodDeductions {
  wfh_cents: number;
  car_cents: number;
  total_cents: number;
  wfh_hours: number;
  car_work_km: number;
  rates: WorkUseRates;
}

// Fallbacks if a FY's threshold block is missing a rate. Order-of-magnitude ATO figures — the rule
// pack's thresholds_by_fy is the source of truth (read per-FY, never inline). Confirm against the ATO.
export const DEFAULT_WORK_USE_RATES: WorkUseRates = { wfh_cents_per_hour: 70, car_cents_per_km: 88, car_km_cap: 5000 };

/** Resolve the FY rates from a thresholds_by_fy[fy] block (any missing field falls back to default). */
export function workUseRatesForFy(
  threshold: { wfh_fixed_rate_cents_per_hour?: number; car_cents_per_km?: number; car_km_cap?: number } | undefined | null,
): WorkUseRates {
  return {
    wfh_cents_per_hour: threshold?.wfh_fixed_rate_cents_per_hour ?? DEFAULT_WORK_USE_RATES.wfh_cents_per_hour,
    car_cents_per_km: threshold?.car_cents_per_km ?? DEFAULT_WORK_USE_RATES.car_cents_per_km,
    car_km_cap: threshold?.car_km_cap ?? DEFAULT_WORK_USE_RATES.car_km_cap,
  };
}

/**
 * Compute the WFH (fixed-rate) and car (cents-per-km) deductions. Negative inputs are floored to 0;
 * km is capped at the FY km limit. Returns whole cents (rounded) plus the inputs/rates used so callers
 * can render an honest "X hrs × Yc/hr" basis without re-deriving anything.
 */
export function computeWorkMethodDeductions(inputs: WorkUseInputs, rates: WorkUseRates): WorkMethodDeductions {
  const hours = Math.max(0, inputs.wfh_hours ?? 0);
  const km = Math.max(0, inputs.car_work_km ?? 0);
  const wfh_cents = Math.round(hours * rates.wfh_cents_per_hour);
  const car_cents = Math.round(Math.min(km, rates.car_km_cap) * rates.car_cents_per_km);
  return { wfh_cents, car_cents, total_cents: wfh_cents + car_cents, wfh_hours: hours, car_work_km: km, rates };
}

/** True when the inputs would produce a non-zero computed deduction. */
export function hasWorkMethodInput(inputs: WorkUseInputs | null | undefined): boolean {
  if (!inputs) return false;
  return (inputs.wfh_hours ?? 0) > 0 || (inputs.car_work_km ?? 0) > 0;
}
