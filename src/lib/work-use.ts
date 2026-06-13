// Computed work-use deductions that are NOT a percentage of tracked spend — they're calculated from
// a per-FY input the user supplies, and they REPLACE the itemised running costs they cover (so those
// receipts stay excluded from the position, never double-claimed):
//   • Working-from-home, fixed-rate method: hours × c/hr (PCG 2023/1). Covers electricity, internet,
//     phone and stationery.
//   • Car, cents-per-kilometre method: min(work_km, cap) × c/km (capped, e.g. 5,000 km). Covers all
//     running costs (fuel, servicing, rego, insurance).
// PURE + deterministic (no I/O), like deductibility.ts / depreciation.ts — the DO reads the inputs +
// FY rates and hands plain values here. GENERAL INFO ONLY; never asserts tax payable or a refund.

import { AU_DESCRIPTOR, fyBoundsFor, type JurisdictionDescriptor } from "./jurisdiction";

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

// Deriving WFH hours from "days a week" (Phase D / G5). The ATO fixed-rate method counts actual hours
// worked from home; a standard workday is ~7.6 hours, and there are ~48 working weeks once leave/public
// holidays are removed. These are sensible DEFAULTS the user can override by editing the hours directly —
// hours stay authoritative. GENERAL INFO ONLY; the ATO requires a contemporaneous record of actual hours.
export const DEFAULT_WFH_HOURS_PER_DAY = 7.6;
export const DEFAULT_WFH_WEEKS = 48;

/** Estimate annual WFH hours from days/week × ~7.6h × working weeks. null when no days are given. */
export function deriveWfhHours(daysPerWeek: number | null | undefined, weeks: number | null | undefined): number | null {
  if (daysPerWeek == null || daysPerWeek <= 0) return null;
  const w = weeks != null && weeks > 0 ? weeks : DEFAULT_WFH_WEEKS;
  return Math.round(Math.max(0, daysPerWeek) * DEFAULT_WFH_HOURS_PER_DAY * w);
}

/** True when the inputs would produce a non-zero computed deduction. */
export function hasWorkMethodInput(inputs: WorkUseInputs | null | undefined): boolean {
  if (!inputs) return false;
  return (inputs.wfh_hours ?? 0) > 0 || (inputs.car_work_km ?? 0) > 0;
}

// ── WFH diary generator (Part 1) ───────────────────────────────────────────────────────────────
// From 2022-23 the ATO fixed-rate method requires a record of the TOTAL ACTUAL hours worked from home
// for the whole year (a 4-week estimate is no longer accepted). This builds a contemporaneous-style
// diary from the user's declared WFH weekdays and leave periods so they have a per-day record to review
// and adjust. PURE + deterministic. GENERAL INFO ONLY — it's a starting record, not a claim of actual hours.

/** Short Mon-first weekday names; index 0=Mon … 6=Sun (matches the diary's weekday field + UI order). */
export const WFH_WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export interface WfhDiaryDay { date: string; weekday: number; hours: number }
export interface WfhLeaveRange { start: string; end: string; label?: string }
export interface WfhDiaryInputs {
  fyStartYear: number;                  // matches buildReport(startYear)
  weekdays: number[];                   // 0=Mon … 6=Sun — the days normally worked from home
  leaveRanges: { start: string; end: string }[]; // inclusive ranges NOT worked from home
  hoursPerDay?: number;                 // default DEFAULT_WFH_HOURS_PER_DAY (7.6)
  descriptor?: JurisdictionDescriptor;  // FY bounds source (defaults to AU — Jul 1 .. Jun 30)
}
export interface WfhDiary { days: WfhDiaryDay[]; total_days: number; total_hours: number }

/**
 * Build a per-day WFH diary for an FY: every date whose weekday is a declared WFH day and which is NOT
 * inside any (inclusive) leave range contributes `hoursPerDay`. Walks the real FY bounds via
 * `fyBoundsFor` (jurisdiction-aware — never hard-codes Jul 1 – Jun 30) so it's leap-year and UK safe.
 * `total_hours` (= total_days × hoursPerDay) is the authoritative WFH figure when the diary is used.
 */
export function generateWfhDiary(inputs: WfhDiaryInputs): WfhDiary {
  const hoursPerDay = inputs.hoursPerDay != null && inputs.hoursPerDay > 0 ? inputs.hoursPerDay : DEFAULT_WFH_HOURS_PER_DAY;
  const wanted = new Set((inputs.weekdays ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  const days: WfhDiaryDay[] = [];
  if (wanted.size === 0) return { days, total_days: 0, total_hours: 0 };
  const { start, end } = fyBoundsFor(inputs.descriptor ?? AU_DESCRIPTOR, inputs.fyStartYear);
  // Inclusive leave ranges. ISO YYYY-MM-DD strings compare lexicographically, so no Date maths needed.
  const ranges = (inputs.leaveRanges ?? []).filter((r) => r && r.start && r.end);
  const onLeave = (iso: string) => ranges.some((r) => iso >= r.start && iso <= r.end);
  // Iterate in UTC to avoid any local-timezone day drift.
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`).getTime();
  for (; cursor.getTime() <= last; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const weekday = (cursor.getUTCDay() + 6) % 7; // JS 0=Sun..6=Sat → 0=Mon..6=Sun
    if (!wanted.has(weekday)) continue;
    const iso = cursor.toISOString().slice(0, 10);
    if (onLeave(iso)) continue;
    days.push({ date: iso, weekday, hours: hoursPerDay });
  }
  const total_days = days.length;
  const total_hours = Math.round(total_days * hoursPerDay * 10) / 10; // 1dp — keeps 7.6 sums honest
  return { days, total_days, total_hours };
}
