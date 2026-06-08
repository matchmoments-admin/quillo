// Trust distributions + streaming (#139) — pure, deterministic. NO I/O. GENERAL INFO ONLY.
// A discretionary trust distributes net income to beneficiaries with CHARACTER RETAINED. For an
// individual beneficiary's INDICATIVE position: ordinary, franked-dividend and discount-capital-gain
// amounts are assessable; the franking credit rides along (surfaced, never grossed-up into the headline,
// matching how income.dividend is handled). franking-credit-only lines aren't separately assessable.
// Streaming, s100A and Div 7A/UPE judgement calls are defer-to-agent.

export interface TrustDistributionInput {
  character: "ordinary" | "franked_dividend" | "discount_capital_gain" | "foreign_income" | string;
  amount_cents: number;
  franking_credit_cents?: number | null;
}

export interface TrustTotals {
  assessable_cents: number;            // amount that feeds the beneficiary's taxable income
  franking_credit_cents: number;       // credits carried with franked distributions (surfaced, not grossed-up)
  by_character: Record<string, number>;
}

/** Summarise an individual beneficiary's trust distributions into the assessable amount + credits. */
export function summariseTrustDistributions(rows: TrustDistributionInput[]): TrustTotals {
  let assessable = 0;
  let franking = 0;
  const byChar: Record<string, number> = {};
  for (const r of rows) {
    const amt = Math.max(0, r.amount_cents ?? 0);
    byChar[r.character] = (byChar[r.character] ?? 0) + amt;
    franking += Math.max(0, r.franking_credit_cents ?? 0);
    // Every distributed-income character is assessable to the beneficiary (the discount on a
    // discount_capital_gain has already been applied at the trust level — the amount is the net gain).
    assessable += amt;
  }
  return { assessable_cents: assessable, franking_credit_cents: franking, by_character: byChar };
}
