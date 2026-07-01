// Feature B1 (noa_capture, #71/#304): pure mapping from an ATO Notice of Assessment's extracted facts
// to the carry-over WRITE plan applied on user confirm. Kept pure (no env/DB) so it's unit-testable
// offline — the DO simply executes the plan (writes capital_loss_carryins / depreciation_opening_balances
// and stores the reference facts). GENERAL-INFO only: nothing here predicts a refund or applies tax.

export interface NoaFacts {
  assessed_fy: number; // FY start year the NOA assessed (e.g. 2024 = the 2024-25 year)
  taxable_income_cents: number; // ATO-assessed taxable income (used only for the reconciliation nudge)
  tax_assessed_cents: number;
  net_capital_losses_cf_cents: number; // net capital losses carried forward as at end of assessed_fy
  prior_year_tax_losses_cf_cents: number; // ordinary tax losses carried forward (captured now; applied by B2)
  opening_depreciation_cents: number; // optional — a NOA rarely states this; 0 when absent
  hecs_balance_cents: number | null; // reference facts (income-test / repayment context only)
  mls_debt_cents: number | null;
  franking_refund_cents: number | null;
  confidence: number;
}

export interface NoaCarryoverPlan {
  source_fy: number; // = assessed_fy
  target_fy: number; // = assessed_fy + 1 (the year the carry-overs first apply to)
  // Writes to perform on confirm (null ⇒ nothing to write for that facet):
  capital_loss: { prior_fy: number; loss_cents: number } | null; // → capital_loss_carryins (flows through cgt.ts)
  opening_depreciation: { fy: number; opening_adjustable_value_cents: number } | null; // → depreciation_opening_balances
}

// A NOA reports carried-forward losses as at the END of the assessed FY; they first offset gains in the
// FOLLOWING year. capital_loss_carryins.prior_fy is "the FY the loss was incurred" and the read path applies
// rows with prior_fy < reportFY — so prior_fy = source_fy makes the loss available from target_fy onward.
export function planNoaCarryovers(facts: NoaFacts): NoaCarryoverPlan {
  const source_fy = facts.assessed_fy;
  const target_fy = source_fy + 1;
  const capLoss = Math.max(0, Math.round(facts.net_capital_losses_cf_cents));
  const openDep = Math.max(0, Math.round(facts.opening_depreciation_cents));
  return {
    source_fy,
    target_fy,
    capital_loss: capLoss > 0 ? { prior_fy: source_fy, loss_cents: capLoss } : null,
    opening_depreciation: openDep > 0 ? { fy: target_fy, opening_adjustable_value_cents: openDep } : null,
  };
}
