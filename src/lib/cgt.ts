// Capital gains tax (CGT) — pure, deterministic helpers for a disposed property. NO I/O.
// Golden-tested in scripts/check-units.ts. GENERAL-INFO only — CGT is fact-specific and the
// claimability brain always defers the judgement calls (main residence, residency) to a
// registered tax agent.

export interface CgtInputs {
  cost_base_cents: number;          // purchase price + incidental capital costs (stamp duty, legals)
  proceeds_cents: number;           // disposal proceeds (capital proceeds)
  div43_claimed_cents?: number;     // capital works deductions claimed — REDUCE the cost base
  acquired_date: string;            // ISO
  disposal_date: string;            // ISO
  is_resident_individual?: boolean; // 50% discount eligibility
  main_residence_exempt?: boolean;  // full exemption (subject to fact-specific rules)
}

export interface CgtResult {
  cost_base_cents: number;          // adjusted (after Div 43 reduction)
  gross_gain_cents: number;         // proceeds − adjusted cost base (0-floored for a gain)
  is_capital_loss: boolean;
  discount_applied: boolean;
  discount_cents: number;
  net_gain_cents: number;           // assessable net capital gain (after the 50% discount)
}

/** True when the disposal is strictly after the 12-month anniversary of acquisition (date-based,
 *  so it doesn't wobble with leap years the way a 365-day count does). */
export function heldMoreThan12Months(acquired: string, disposal: string): boolean {
  const [ay, am, ad] = acquired.split("-").map(Number);
  const anniversaryUtc = Date.UTC((ay ?? 1970) + 1, (am ?? 1) - 1, ad ?? 1);
  const [dy, dm, dd] = disposal.split("-").map(Number);
  const disposalUtc = Date.UTC(dy ?? 1970, (dm ?? 1) - 1, dd ?? 1);
  return disposalUtc > anniversaryUtc;
}

/**
 * Compute the CGT position on a disposal. Div 43 capital-works deductions reduce the cost base
 * (increasing the gain). The 50% discount applies to a resident individual who held the asset
 * more than 12 months. A main-residence-exempt disposal returns a zero net gain. Losses are
 * surfaced (not discounted) so they can offset other capital gains.
 */
export function computeCapitalGain(i: CgtInputs): CgtResult {
  const adjustedCostBase = i.cost_base_cents - (i.div43_claimed_cents ?? 0);

  if (i.main_residence_exempt) {
    return { cost_base_cents: adjustedCostBase, gross_gain_cents: 0, is_capital_loss: false, discount_applied: false, discount_cents: 0, net_gain_cents: 0 };
  }

  const raw = i.proceeds_cents - adjustedCostBase;
  if (raw < 0) {
    // Capital loss — carried forward / offsets other gains; the discount never applies to a loss.
    return { cost_base_cents: adjustedCostBase, gross_gain_cents: raw, is_capital_loss: true, discount_applied: false, discount_cents: 0, net_gain_cents: raw };
  }

  const discountEligible = !!i.is_resident_individual && heldMoreThan12Months(i.acquired_date, i.disposal_date);
  const discount = discountEligible ? Math.round(raw * 0.5) : 0;
  return {
    cost_base_cents: adjustedCostBase,
    gross_gain_cents: raw,
    is_capital_loss: false,
    discount_applied: discountEligible,
    discount_cents: discount,
    net_gain_cents: raw - discount,
  };
}

// ── Portfolio aggregation (#138) ───────────────────────────────────────────────
// computeCapitalGain above is per-DISPOSAL. A taxpayer has MANY disposals across shares/crypto/property
// in an FY, plus carried-forward losses, and the loss-offset ORDER changes the result. This aggregates
// the cgt_events of an FY into the single "net capital gain" line that feeds taxable income.
//
// Method (ATO, taxpayer-optimal ordering): gains net of their cost base; capital losses (this-FY +
// carried-forward) offset gains BEFORE the discount, applied to NON-discountable gains first (they
// aren't halved), then to discountable gains; the 50% discount applies to what remains discountable.
// net capital gain = remaining-non-discountable + round(remaining-discountable × keep-fraction), ≥ 0.

export interface CgtEventInput {
  proceeds_cents: number;
  cost_base_used_cents: number;
  /** Explicit override; when null/undefined, derive from acquired→event being > 12 months. */
  discount_eligible?: boolean | null;
  acquired_date?: string | null;
  event_date?: string | null;
}

export interface CgtRules {
  /** Fraction of a discountable gain that stays assessable (0.5 ⇒ 50% discount). */
  discount_keep_fraction: number;
}

export const DEFAULT_CGT_RULES: CgtRules = { discount_keep_fraction: 0.5 };

/** Resolve FY CGT rules from a thresholds_by_fy[fy] block (missing field falls back to default). */
export function cgtRulesForFy(threshold: { cgt_discount_keep_fraction?: number } | undefined | null): CgtRules {
  return { discount_keep_fraction: threshold?.cgt_discount_keep_fraction ?? DEFAULT_CGT_RULES.discount_keep_fraction };
}

export interface CgtPortfolioResult {
  gross_capital_gains_cents: number;  // sum of positive gains (pre-loss, pre-discount)
  capital_losses_cents: number;       // total losses available (this-FY + carried-in)
  discount_applied_cents: number;     // dollar value of the discount granted
  net_capital_gain_cents: number;     // the assessable line (≥ 0) that feeds taxable income
  loss_carried_forward_cents: number; // unused capital losses to carry forward
}

/**
 * Aggregate an FY's disposals into the net capital gain. `priorLossCents` are carried-forward capital
 * losses (capital_loss_carryins). Pure: same inputs ⇒ same output.
 */
export function computeNetCapitalGain(events: CgtEventInput[], rules: CgtRules, priorLossCents = 0): CgtPortfolioResult {
  let gainsDiscountable = 0;
  let gainsOther = 0;
  let losses = Math.max(0, priorLossCents);

  for (const ev of events) {
    const gain = (ev.proceeds_cents ?? 0) - (ev.cost_base_used_cents ?? 0);
    if (gain < 0) { losses += -gain; continue; }
    if (gain === 0) continue;
    const eligible =
      ev.discount_eligible != null
        ? ev.discount_eligible
        : !!(ev.acquired_date && ev.event_date && heldMoreThan12Months(ev.acquired_date, ev.event_date));
    if (eligible) gainsDiscountable += gain;
    else gainsOther += gain;
  }

  const grossGains = gainsDiscountable + gainsOther;
  const lossesAvailable = losses;

  const toOther = Math.min(losses, gainsOther);
  gainsOther -= toOther;
  losses -= toOther;
  const toDisc = Math.min(losses, gainsDiscountable);
  gainsDiscountable -= toDisc;
  losses -= toDisc;

  const discountedDisc = Math.round(gainsDiscountable * rules.discount_keep_fraction);
  const net = gainsOther + discountedDisc;
  return {
    gross_capital_gains_cents: grossGains,
    capital_losses_cents: lossesAvailable,
    discount_applied_cents: gainsDiscountable - discountedDisc,
    net_capital_gain_cents: Math.max(0, net),
    loss_carried_forward_cents: losses,
  };
}
