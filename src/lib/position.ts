/**
 * The ONE formula for the individual's indicative tax position.
 *
 * buildReport (report.ts) computes the position twice: the TRACKED end (captured spend pending review)
 * and, under `position_confirmed_range`, the CONFIRMED end (only reviewed-deductible spend). The two
 * endpoints differ ONLY in the discretionary deduction figure; every other summand — assessable income
 * from each life situation, depreciation, the super deduction, the carried-forward loss — is the same.
 * Before this module the formula was written out twice inline, so a new life situation added to one
 * endpoint but not the other would silently invert the range (confirmed < tracked) on a money surface.
 *
 * Pure: no env, no D1, no flags. The caller decides which summands exist (a flag-OFF summand is 0);
 * this module only owns the arithmetic. The summation order is the historical inline order, kept
 * exactly so the result is byte-identical.
 *
 * A NEW assessable or deductible life situation (novated lease, Div 7A deemed dividend, …) adds ONE
 * field here and supplies it from buildReport; both endpoints then pick it up together.
 */

/** Everything in the position except the endpoint-specific discretionary deductions. All cents. */
export interface PositionSummands {
  // ── assessable (added) ──
  /** Headline income from the `income` table (incomeTotals.gross_cents). */
  income_cents: number;
  /** Net capital gain (cgt_engine); 0 when off / no events. */
  net_capital_gain_cents: number;
  /** Assessable ESS discount (ess_engine). */
  ess_assessable_cents: number;
  /** Assessable trust distributions to this person (trust_distributions). */
  trust_assessable_cents: number;
  /** Partner's share of partnership net income — may be negative only under partnership_losses. */
  partnership_assessable_cents: number;
  /** Franking-credit gross-up (franking_gross_up). */
  franking_gross_up_cents: number;
  /** s 70-35 trading-stock adjustment (trading_stock); signed. */
  trading_stock_adjustment_cents: number;
  // ── calculation-substantiated reductions (subtracted, same in both endpoints) ──
  /** Decline in value (depreciationTotals.total_cents). */
  depreciation_cents: number;
  /** Claimed personal-deductible super (super_deduction). */
  super_deduction_cents: number;
}

export interface ComposedPosition {
  /** The position before any carried-forward tax loss. */
  pre_loss_cents: number;
  /** The carried loss actually used: it offsets only positive income, never pushes below zero. */
  tax_losses_applied_cents: number;
  /** pre_loss_cents − tax_losses_applied_cents. */
  position_cents: number;
}

/**
 * Compose one endpoint of the position.
 * @param s                      the shared summands
 * @param deductions_cents       this endpoint's deductions (tracked: refund-netted spend + work methods;
 *                               confirmed: reviewed spend capped at that, + work methods)
 * @param carried_tax_loss_cents prior-year ordinary loss from a confirmed NOA (0 when off)
 */
export function composePosition(s: PositionSummands, deductions_cents: number, carried_tax_loss_cents: number): ComposedPosition {
  const pre_loss_cents =
    s.income_cents + s.net_capital_gain_cents + s.ess_assessable_cents + s.trust_assessable_cents + s.partnership_assessable_cents
    + s.franking_gross_up_cents + s.trading_stock_adjustment_cents - deductions_cents - s.depreciation_cents - s.super_deduction_cents;
  const tax_losses_applied_cents = Math.min(carried_tax_loss_cents, Math.max(0, pre_loss_cents));
  return { pre_loss_cents, tax_losses_applied_cents, position_cents: pre_loss_cents - tax_losses_applied_cents };
}
