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
function heldMoreThan12Months(acquired: string, disposal: string): boolean {
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
