// SMSF / super-pension / ECPI (#140) — pure, deterministic. NO I/O. GENERAL INFO ONLY.
// An SMSF is a separate taxpayer. Exempt Current Pension Income (ECPI) is the proportion of fund
// earnings that supports retirement-phase pensions — those earnings are tax-exempt. The simplified
// (segregated-proportion) method: ECPI fraction = pension-phase balance / total balance. Account-based
// pension payments are tax-free from age 60 (handled at the member level — they don't touch the personal
// position). Transfer balance cap, minimum drawdown and the actuarial certificate are defer-to-agent.

export interface SmsfMemberInput {
  pension_balance_cents: number;
  accumulation_balance_cents: number;
}

/** ECPI exempt fraction (0..1) = pension balance / total balance across members. 0 when no assets. */
export function ecpiExemptFraction(members: SmsfMemberInput[]): number {
  let pension = 0;
  let total = 0;
  for (const m of members) {
    const p = Math.max(0, m.pension_balance_cents ?? 0);
    const a = Math.max(0, m.accumulation_balance_cents ?? 0);
    pension += p;
    total += p + a;
  }
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, pension / total));
}

export interface SmsfPosition {
  assessable_income_cents: number;     // the fund's gross investment earnings this FY
  ecpi_exempt_fraction: number;        // 0..1 supporting retirement-phase pensions
  ecpi_exempt_cents: number;           // the exempt portion
  fund_taxable_income_cents: number;   // assessable × (1 − ECPI fraction)
}

/** Fund taxable income after ECPI. fund_taxable = round(assessable × (1 − ecpiFraction)). */
export function computeSmsfPosition(assessableIncomeCents: number, ecpiFraction: number): SmsfPosition {
  const assessable = Math.max(0, assessableIncomeCents);
  const frac = Math.max(0, Math.min(1, ecpiFraction));
  const exempt = Math.round(assessable * frac);
  return {
    assessable_income_cents: assessable,
    ecpi_exempt_fraction: frac,
    ecpi_exempt_cents: exempt,
    fund_taxable_income_cents: assessable - exempt,
  };
}
