// Deterministic depreciation engine — verbatim ATO formulas, exact cents, NO I/O.
// Golden-tested in scripts/check-units.ts. All dollar thresholds (IAWO, car limit) are passed
// in by the caller from the per-FY rule pack; this module never hardcodes a policy number.
//
// AU FY is Jul–Jun; a "start year" Y denotes the FY Y-07-01 .. (Y+1)-06-30.

import type { AssetClass } from "./taxonomy";

export interface DepAsset {
  asset_class: AssetClass;
  cost_cents: number;                 // for Div43 this is the construction expenditure
  acquired_date: string;              // ISO YYYY-MM-DD ('days held' / placed-in-service start)
  effective_life_years?: number | null;
  method?: "diminishing_value" | "prime_cost" | null; // Div40 election (locked per asset)
  div43_rate?: number | null;         // 0.025 | 0.04
  dv_rate_pct?: number | null;        // 200 (post 10 May 2006) | 150 (pre); default 200
  is_second_hand?: boolean;           // post-9-May-2017 second-hand residential Div40 lockout
  business_use_pct?: number | null;   // apportionment applied to the deduction
  disposed_date?: string | null;
}

export interface ScheduleRow {
  fy: string;                         // '2025-26'
  start_year: number;
  opening_adjustable_value_cents: number;
  days_held: number;
  deduction_cents: number;
  closing_adjustable_value_cents: number;
  method_applied: string;
}

/** AU FY label for a start year, e.g. 2025 -> '2025-26'. */
export function fyLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in an AU FY: 366 when the FY spans a 29 Feb (i.e. calendar year startYear+1 is leap). */
export function daysInFy(startYear: number): number {
  return isLeapYear(startYear + 1) ? 366 : 365;
}

/** The AU FY start year that a date falls in. */
export function fyStartYearOf(dateIso: string): number {
  const [y, m] = dateIso.split("-").map(Number);
  return (m ?? 1) >= 7 ? (y ?? 0) : (y ?? 0) - 1;
}

function utcDays(dateIso: string): number {
  const [y, m, d] = dateIso.split("-").map(Number);
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

/**
 * Days the asset was held within a given FY (inclusive of both endpoints). Acquired mid-year
 * counts from the acquisition date; a disposal ends the count. Clamped to [0, daysInFy].
 */
export function daysHeldInFy(asset: DepAsset, startYear: number): number {
  const fyStart = utcDays(`${startYear}-07-01`);
  const fyEnd = utcDays(`${startYear + 1}-06-30`);
  const acquired = utcDays(asset.acquired_date);
  const disposed = asset.disposed_date ? utcDays(asset.disposed_date) : Infinity;
  const from = Math.max(fyStart, acquired);
  const to = Math.min(fyEnd, disposed);
  if (to < from) return 0;
  return Math.min(to - from + 1, daysInFy(startYear));
}

/** Apportion a raw deduction by business-use %, never below 0. */
function apportion(deductionCents: number, asset: DepAsset): number {
  const pct = asset.business_use_pct ?? 100;
  return Math.max(0, Math.round((deductionCents * pct) / 100));
}

/**
 * Decline in value for ONE FY given the opening adjustable value. Pure + deterministic.
 * Caps the deduction at the opening value (never depreciates below zero). Returns the
 * pre-apportionment closing value (CGT cost base tracks the full decline) and the
 * apportioned deduction (what's claimable).
 */
export function computeFyDeduction(
  asset: DepAsset,
  startYear: number,
  openingCents: number,
): { deduction_cents: number; closing_cents: number; days_held: number; method_applied: string } {
  const days = daysHeldInFy(asset, startYear);
  const acquiredFy = fyStartYearOf(asset.acquired_date);
  const firstYear = startYear === acquiredFy;
  const life = asset.effective_life_years ?? 0;

  // Second-hand residential plant: Div 40 decline is NOT deductible (applied at CGT instead).
  if (asset.is_second_hand && asset.asset_class === "div40_plant") {
    return { deduction_cents: 0, closing_cents: openingCents, days_held: days, method_applied: "div40_locked" };
  }

  let rawDeduction = 0;
  let method = asset.asset_class as string;

  switch (asset.asset_class) {
    case "div40_plant": {
      if (life <= 0 || days <= 0) break;
      if (asset.method === "prime_cost") {
        // Prime cost: cost × days/365 × 100%/life (constant on original cost).
        rawDeduction = (asset.cost_cents * days * 100) / (365 * 100 * life);
        method = "prime_cost";
      } else {
        // Diminishing value: base value × days/365 × rate%/life.
        const ratePct = asset.dv_rate_pct ?? 200;
        rawDeduction = (openingCents * days * ratePct) / (365 * 100 * life);
        method = "diminishing_value";
      }
      break;
    }
    case "div43_capital_works": {
      // Construction expenditure × rate × days/365.
      const rate = asset.div43_rate ?? 0.025;
      rawDeduction = asset.cost_cents * rate * (days / 365);
      method = "div43";
      break;
    }
    case "low_value_pool": {
      // 18.75% in the first year (half the pool rate), 37.5% diminishing thereafter.
      rawDeduction = openingCents * (firstYear ? 0.1875 : 0.375);
      method = "low_value_pool";
      break;
    }
    case "business_asset": {
      // Small business general pool: 15% first year, 30% diminishing thereafter.
      rawDeduction = openingCents * (firstYear ? 0.15 : 0.3);
      method = "small_business_pool";
      break;
    }
    case "immediate": {
      // Full write-off in the year first used (e.g. <$300 or instant asset write-off).
      rawDeduction = firstYear ? openingCents : 0;
      method = "immediate";
      break;
    }
  }

  let deduction = Math.round(rawDeduction);
  if (deduction > openingCents) deduction = openingCents; // never below zero
  const closing = openingCents - deduction;
  return { deduction_cents: apportion(deduction, asset), closing_cents: closing, days_held: days, method_applied: method };
}

/**
 * Roll the schedule deterministically from the acquisition FY up to (and including) `toStartYear`.
 * Opening value of each FY = prior FY's closing. The first FY opens at full cost. This is the
 * carry-forward ledger; one ScheduleRow per FY.
 */
export function rollSchedule(asset: DepAsset, toStartYear: number): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  const fromYear = fyStartYearOf(asset.acquired_date);
  let opening = asset.cost_cents;
  for (let y = fromYear; y <= toStartYear; y++) {
    const r = computeFyDeduction(asset, y, opening);
    rows.push({
      fy: fyLabel(y),
      start_year: y,
      opening_adjustable_value_cents: opening,
      days_held: r.days_held,
      deduction_cents: r.deduction_cents,
      closing_adjustable_value_cents: r.closing_cents,
      method_applied: r.method_applied,
    });
    opening = r.closing_cents;
    if (opening <= 0 && asset.asset_class !== "div40_plant") break; // pool/immediate exhausted
  }
  return rows;
}

/**
 * Balancing adjustment on disposal: termination value − adjustable value at disposal.
 * Positive = assessable balancing charge; negative = deductible balancing loss.
 */
export function balancingAdjustment(adjustableValueCents: number, terminationValueCents: number): number {
  return terminationValueCents - adjustableValueCents;
}
