import type { Env } from "../env";

// Pricing policy lives here and nowhere else. Today this only powers a DISPLAY figure ("what this
// tenant's AI usage would cost them"): we measure real inference cost per tenant in llm_usage
// (lib/usage.ts) and surface a marked-up "billable" number so the per-user, tax-time billing model
// (each user pays their own AI cost + our app fee) has a single, tested seam to grow into.
//
// TODO(billing): when we actually charge — likely a Stripe checkout at filing time — call
// billableCents() to compute the amount and verify the usage.ts pricing table against live Anthropic
// rates first (it is Haiku-only + flagged "VERIFY"). Nothing here moves money yet.

export interface BillingPolicy {
  markupPct: number; // % added over measured cost, e.g. 30 = +30%
  appFeeCents: number; // flat application fee added on top
}

/** Read the (env-global for now) pricing policy. Per-tenant overrides can replace this later. */
export function billingPolicy(env: Env): BillingPolicy {
  const markupPct = Number(env.COST_MARKUP_PCT ?? 0);
  const appFeeCents = Number(env.APP_FEE_CENTS ?? 0);
  return {
    markupPct: Number.isFinite(markupPct) && markupPct > 0 ? markupPct : 0,
    appFeeCents: Number.isFinite(appFeeCents) && appFeeCents > 0 ? appFeeCents : 0,
  };
}

/**
 * What a tenant would be billed for `rawCostCents` of measured AI usage:
 *   billable = round(rawCost × (1 + markupPct/100)) + appFeeCents
 * Pure + side-effect-free so it is trivially unit-testable and identical everywhere it's shown.
 * A flat fee is only added when there is real usage to bill (rawCost > 0).
 */
export function billableCents(rawCostCents: number, markupPct: number, appFeeCents: number): number {
  const raw = Math.max(0, rawCostCents || 0);
  if (raw <= 0) return 0;
  const marked = raw * (1 + (markupPct || 0) / 100);
  return Math.round(marked) + Math.max(0, appFeeCents || 0);
}

// ── Usage-based wallet billing (flag `billing`) ────────────────────────────────
// Pricing model (owner decision): free to join + a small free credit allowance, then the user pays
// their ACTUAL AI cost + a tiny margin (markupPct). The wallet balance is held in 1e-4-cent units
// (`credit_balance_e4`) to match the daily_cost ledger's sub-cent precision, so even a fraction-of-a-
// cent Haiku call debits its true cost+margin instead of rounding to free.

/** Free credit allowance granted once on signup (so new users can try AI features before paying).
 *  Env-overridable via FREE_CREDIT_GRANT_CENTS; default $2.00. Returned in 1e-4-cent units. */
export function freeCreditGrantE4(env: Env): number {
  const cents = Number(env.FREE_CREDIT_GRANT_CENTS ?? 200);
  return Math.max(0, Math.round((Number.isFinite(cents) ? cents : 200) * 10_000));
}

/** What a `rawE4` (1e-4-cent) call debits from the wallet: raw × (1 + margin%) + optional flat fee.
 *  Same shape as billableCents but in e4 units, so debits stay sub-cent-exact. */
export function billableE4(rawE4: number, markupPct: number, flatFeeE4 = 0): number {
  const raw = Math.max(0, rawE4 || 0);
  if (raw <= 0) return 0;
  return Math.round(raw * (1 + (markupPct || 0) / 100)) + Math.max(0, flatFeeE4 || 0);
}
