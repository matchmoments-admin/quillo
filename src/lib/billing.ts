import type { Env } from "../env";
import { featureOn } from "./features";

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
  fxRate: number; // measured cost is in USD (the rate cards); the wallet + Stripe top-ups are AUD. 1 = pass-through
}

/** Read the (env-global for now) pricing policy. Per-tenant overrides can replace this later. */
export function billingPolicy(env: Env): BillingPolicy {
  const markupPct = Number(env.COST_MARKUP_PCT ?? 0);
  const appFeeCents = Number(env.APP_FEE_CENTS ?? 0);
  const fxRate = Number(env.USD_TO_AUD_RATE ?? 1);
  return {
    markupPct: Number.isFinite(markupPct) && markupPct > 0 ? markupPct : 0,
    appFeeCents: Number.isFinite(appFeeCents) && appFeeCents > 0 ? appFeeCents : 0,
    // Never below 1: a garbage or sub-1 rate would bill users under our real cost.
    fxRate: Number.isFinite(fxRate) && fxRate > 1 ? fxRate : 1,
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

// ── Why an AI call was refused (#699 QA) ───────────────────────────────────────
// TaxAgent.withinBudget refuses for two different reasons and callers only see "ai_budget_reached":
// an EMPTY WALLET (billing ON, balance ≤ 0 after the one-off grant), which the user fixes in Billing, or a
// DAILY CAP (per-tenant or platform), which resets on its own. Telling an out-of-credit user "AI is paused
// for today, try again after the reset" sends them to wait for a reset that never helps.
export const OUT_OF_CREDIT_MESSAGE = "You're out of AI credits. Top up in Billing to keep using AI features.";
export const DAILY_PAUSE_MESSAGE = "AI is paused for today (daily limit reached) — try again after the reset.";

/** Pure: the refusal text for a tenant whose AI call was refused. */
export function budgetRefusalMessage(billingOn: boolean, balanceE4: number | null | undefined): string {
  return billingOn && Number(balanceE4 ?? 0) <= 0 ? OUT_OF_CREDIT_MESSAGE : DAILY_PAUSE_MESSAGE;
}

/** The refusal text for `ai_budget_reached`, read after the refusal (one indexed read; billing OFF ⇒ no read). */
export async function budgetRefusal(env: Env, userId: string): Promise<string> {
  if (!featureOn(env, "billing")) return DAILY_PAUSE_MESSAGE;
  const row = await env.DB.prepare(`SELECT credit_balance_e4 AS b FROM profiles WHERE user_id = ?`).bind(userId).first<{ b: number | null }>();
  return budgetRefusalMessage(true, row?.b ?? 0);
}
