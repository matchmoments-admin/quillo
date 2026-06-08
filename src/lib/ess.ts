// Employee Share Scheme (#141) — pure, deterministic ESS-discount classification. NO I/O.
// GENERAL INFO ONLY; eligibility for the startup concession (unlisted, <10yr, turnover ≤$50m, employee
// ≤10%) is fact-specific and defer-to-agent. We never compute tax payable.
//
// Treatment by scheme:
//   • taxed_upfront — the discount is assessable income in the GRANT-year (employment income, item 12).
//   • deferral      — the discount is assessable at a DEFERRED taxing point (we use taxing_point_date).
//   • startup       — the discount is NOT taxed as income; CGT applies on later disposal with cost base
//                     = market value at acquisition. So $0 assessable income at grant; the CGT engine
//                     (#138) handles the eventual disposal. Founders >10% are usually ineligible — when
//                     ownership_gt_10pct is set we flag it (the discount would then be assessable).

export interface EssGrantInput {
  scheme_type: "taxed_upfront" | "deferral" | "startup" | string;
  discount_cents: number;
  ownership_gt_10pct?: boolean | null;
}

export interface EssAssessable {
  assessable_discount_cents: number;   // ESS discount that is assessable income this FY
  startup_deferred_to_cgt_cents: number; // discount NOT taxed now (startup) — flows to CGT on disposal
  ineligible_startup_flag: boolean;    // a 'startup' grant with >10% ownership — eligibility is doubtful
}

/**
 * Classify a set of ESS grants whose taxing point falls in the FY (the reader filters by date) into the
 * assessable discount for the position. Pure: same inputs ⇒ same output.
 */
export function essAssessable(grants: EssGrantInput[]): EssAssessable {
  let assessable = 0;
  let startupDeferred = 0;
  let ineligible = false;
  for (const g of grants) {
    const discount = Math.max(0, g.discount_cents ?? 0);
    if (g.scheme_type === "startup") {
      if (g.ownership_gt_10pct) {
        // >10% ownership → startup concession typically unavailable → the discount is assessable.
        assessable += discount;
        ineligible = true;
      } else {
        startupDeferred += discount;
      }
    } else {
      // taxed_upfront | deferral (and any unknown type) → assessable in the taxing-point FY.
      assessable += discount;
    }
  }
  return { assessable_discount_cents: assessable, startup_deferred_to_cgt_cents: startupDeferred, ineligible_startup_flag: ineligible };
}
