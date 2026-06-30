// Deterministic depreciation engine — verbatim ATO formulas, exact cents, NO I/O.
// Golden-tested in scripts/check-units.ts. All dollar thresholds (IAWO, car limit) are passed
// in by the caller from the per-FY rule pack; this module never hardcodes a policy number.
//
// AU FY is Jul–Jun; a "start year" Y denotes the FY Y-07-01 .. (Y+1)-06-30.

import type { AssetClass } from "./taxonomy";
import { fyStartYearForDate, AU_DESCRIPTOR, type JurisdictionDescriptor } from "./jurisdiction";

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
  // Per-FY policy thresholds for the asset's FIRST-USE year, supplied by the caller from the rule
  // pack (this module never hardcodes a policy number). Both optional → when absent, no cap applies.
  instant_asset_write_off_cents?: number | null; // immediate write-off only if cost <= this
  is_car?: boolean;                   // a car (carries <1t / <9 passengers) → first-element cost base capped
  car_limit_cents?: number | null;    // Div 40 car cost limit for the first-use FY
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

/**
 * FY label for a start year, e.g. 2025 -> '2025-26'. The straddle-label form is jurisdiction-INVARIANT
 * (UK Apr 6 2025–Apr 5 2026 is also '2025-26'), so this stays local to keep the engine I/O-free; it
 * mirrors ledger-totals.fyLabel by construction (golden-locked in check-units.ts).
 */
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

/**
 * The FY start year that a date falls in. Delegates to the pure jurisdiction period maths; the optional
 * descriptor defaults to AU so the AU-golden'd engine is byte-identical. NOTE (UK epic): the multi-year
 * depreciation SCHEDULE math (computeFyDeduction/rollSchedule/daysHeldInFy) is AU-shaped and golden-locked;
 * full UK period-correctness for depreciation rides with the UK capital-allowance RULES (Phase 6), not
 * this period seam — internal callers intentionally keep the AU default for now.
 */
export function fyStartYearOf(dateIso: string, descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): number {
  return fyStartYearForDate(descriptor, dateIso);
}

/**
 * A low-cost depreciating asset (cost at/under the FY's immediate-deduction threshold, ~$300 for a
 * non-business individual) is written off in year one, NOT depreciated over its effective life — so
 * the auto-classifier should class it 'immediate' rather than div40_plant. Pure.
 */
export function isLowCostAsset(costCents: number, immediateThresholdCents: number | null | undefined): boolean {
  return immediateThresholdCents != null && costCents > 0 && costCents <= immediateThresholdCents;
}

/**
 * Heuristic: a line that reads like a person-to-person transfer (a bank "Transfer to <name>", Osko/
 * PayID/Pay-Anyone) is generally NOT a capital-asset purchase — it shouldn't be auto-depreciated.
 * Conservative on purpose (anchored payment-rail phrasing) so it won't swallow real shop names like
 * "JB Hi-Fi" or "IKEA". A bare "deposit" is intentionally NOT matched (rental bonds, term deposits…);
 * it only trips when it rides on a transfer phrase. Pure.
 */
export function looksLikePersonalTransfer(merchant: string | null | undefined): boolean {
  const m = (merchant ?? "").toLowerCase();
  if (!m) return false;
  return /\btransfer to\b|\bosko\b|\bpay\s?id\b|\bpay\s?anyone\b/.test(m);
}

/**
 * Whether an asset earns the taxpayer decline-in-value: Div 40 needs the taxpayer to OWN it and BEAR
 * the cost, so employer-owned or reimbursed gear depreciates to NOTHING. The single predicate
 * computeDepreciation uses to decide whether to write a schedule at all (D.3 — fix at source).
 */
export function assetDepreciatesForTaxpayer(asset: { owned_by?: string | null; reimbursed?: number | null }): boolean {
  return (asset.owned_by ?? "self") !== "employer" && !asset.reimbursed;
}

/**
 * The effective life to PERSIST for a new asset. A div40 (plant) asset MUST NOT be stored with a null
 * effective life: rollSchedule reads `life = effective_life_years ?? 0` and then `if (life <= 0) break`,
 * so a null silently produces a $0 depreciation schedule. When the user didn't supply a life, fall back
 * to the resolved default (rulepack/merchant-hinted, else the legacy 5y). Non-div40 classes keep null
 * (immediate write-off / div43 capital works don't use an effective life). A supplied life always wins.
 */
export function resolveDiv40Life(
  assetClass: string,
  providedLife: number | null | undefined,
  defaultLife: number,
): number | null {
  if (providedLife != null) return providedLife;
  return assetClass === "div40_plant" ? defaultLife : null;
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
 * The depreciable first-element cost base. For a car (Div 40), it's capped at the car cost limit for
 * the first-use FY — a $90k ute depreciates only on the ~$69k limit, not the full price. Non-cars
 * (or when no limit was supplied) use the full cost. This is the single place the cap is applied, so
 * every method (prime cost, diminishing value, the rolled opening value) sees the same base.
 */
export function depreciableCostCents(asset: DepAsset): number {
  return asset.is_car && asset.car_limit_cents != null
    ? Math.min(asset.cost_cents, asset.car_limit_cents)
    : asset.cost_cents;
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
  const cost = depreciableCostCents(asset); // car-limit-capped first-element cost base

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
        rawDeduction = (cost * days * 100) / (365 * 100 * life);
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
      rawDeduction = cost * rate * (days / 365);
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
      // Immediate write-off (e.g. <$300, or under the per-FY instant-asset-write-off threshold) is
      // only valid when the cost is AT OR UNDER that threshold. A pricier asset can't be expensed in
      // one year — it must decline over its effective life — so enforce the cap instead of writing
      // off the full cost regardless (the bug: a $50k asset expensed in year 1).
      const iawo = asset.instant_asset_write_off_cents;
      // Eligibility tests the asset's actual first-element cost (raw), not the car-limit-capped base.
      const eligible = iawo == null || asset.cost_cents <= iawo;
      if (eligible) {
        rawDeduction = firstYear ? cost : 0;
        method = "immediate";
      } else if (life > 0 && days > 0) {
        // Over threshold → can't expense in one year; decline over the effective life, honouring the
        // taxpayer's prime-cost election when they made one (otherwise diminishing value).
        if (asset.method === "prime_cost") {
          rawDeduction = (cost * days * 100) / (365 * 100 * life);
          method = "immediate_over_threshold_pc";
        } else {
          const ratePct = asset.dv_rate_pct ?? 200;
          rawDeduction = (openingCents * days * ratePct) / (365 * 100 * life);
          method = "immediate_over_threshold_dv";
        }
      } else {
        // Over threshold but no effective life to depreciate against → claim nothing and signal a
        // review (method label) rather than over-claim a full write-off the asset isn't entitled to.
        rawDeduction = 0;
        method = "immediate_over_threshold_review";
      }
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
  let opening = depreciableCostCents(asset); // first FY opens at the (car-limit-capped) cost
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
