import type { Env } from "../env";

/**
 * Env-driven feature flags. `FEATURES` (wrangler.toml [vars]) is a comma-separated list of
 * enabled keys, e.g. "refund_netting,bulk_import". A behaviour ships behind a flag so it can be
 * disabled with one var edit + redeploy (instant rollback) with no data change. Single tenant
 * today, so flags are env-global; per-tenant gating can move to `profiles` later without changing
 * call sites (they only see `featureOn(env, key)`).
 */
export const FEATURE_KEYS = [
  "refund_netting",
  "income_dedupe",
  "asset_defaults",
  "bulk_import",
  "deductibility_review",
  "guide_me",
  "claim_review",
  "position_excludes_nondeductible",
  "accountant_pass",
  "wfh_car_methods",
  "loan_split",
  "attribution_engine", // 0032-0034: sum transaction_attributions for the position (payer≠claimant, ownership split). OFF in prod until validated.
  "cgt_engine",         // 0037 (#138): add net capital gain (shares/crypto/property disposals; 50% discount; loss offset) to the position. OFF in prod until validated.
  "ess_engine",         // 0038 (#141): add assessable ESS discount (taxed-upfront / deferral) to the position; startup concession defers to CGT. OFF in prod until validated.
  "gst_bas",            // 0039 (#137): indicative BAS position (output GST − input credits) for GST-registered businesses. SEPARATE from income tax. OFF in prod until validated.
  "car_logbook",        // 0040 (#142): logbook-method car deduction vs cents-per-km (informational). OFF in prod until validated.
  "trust_distributions",// 0041 (#139): add assessable trust distributions (character retained) to the beneficiary's position. OFF in prod until validated.
  "smsf_engine",        // 0042 (#140): per-SMSF fund position after ECPI (separate taxpayer); keeps fund income out of the member's personal headline. OFF in prod until validated.
  "apply_to_siblings",  // Sort epic S1: "edit one line → update its look-alikes" (+ learn a rule) off the normal edit path. No position math. OFF until the S2 UI ships.
  "loan_interest_v2",   // Sort epic S4/S5 (#157): evidence-first loan interest (lender/statement actual → property position), retiring the per-line loan_split. Capture-only in S4; report wiring in S5. OFF until validated.
  "ask_quillo",         // C1: single-turn grounded tax-Q&A — answers a free-text question from the user's OWN ledger (consent + budget gated, GENERAL-INFO, no refund/rates). Multi-turn chat is a later epic.
  "accountant_schedule",// #179/#181: itemised accountant schedule CSV (per-txn lines, engine schedules, NOT-CLAIMED, substantiation) replaces the thin summary CSV at format=csv. OFF in prod until validated.
  "ask_actions",        // Ask Quillo C3: FY txn digest in the Ask prompt + model-PROPOSED one-click fixes (set_deductibility / recategorise / add_rule). Propose→confirm→execute via the EXISTING write endpoints — never autonomous. Applying a deductibility card needs deductibility_review ON. OFF ⇒ Ask byte-identical.
  "advisory_layer",     // Savings & Opportunities (#182–184): annualised spend run-rate + deterministic recurring-bill/subscription detection + FACTUAL opportunity nudges + the "Save" surface. No LLM, no partners, no PII egress, no projections/benchmarks (src/lib/advisory.ts). OFF ⇒ no read/write path, byte-identical.
  "advisory_partners_energy", // Advisory Phase 2 (docs/advisory-phase2-partners.md): the Tier-1 energy partner CTA on advisory opportunities + the create-referral path. Identity/data-model scaffold ships flag-OFF (Slice 1); no consumer CTA, no live partner, no PII egress until this is ON *and* legal sign-off (§5) lands. OFF ⇒ byte-identical.
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

function enabledSet(env: Env): Set<string> {
  return new Set(
    (env.FEATURES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** True when `key` is listed in the FEATURES var. */
export function featureOn(env: Env, key: FeatureKey): boolean {
  return enabledSet(env).has(key);
}

/** The subset of known feature keys that are enabled — sent to the SPA so it can gate UI. */
export function enabledFeatures(env: Env): FeatureKey[] {
  const on = enabledSet(env);
  return FEATURE_KEYS.filter((k) => on.has(k));
}

/**
 * How statement categorisation should run. `live` = synchronous Claude calls (instant, full price);
 * `batch` = the async Message Batches API (~50% cheaper, applied by the cron); `auto` = today's
 * size-based routing (>BATCH_THRESHOLD lines → batch, else live). Resolution order, narrowest first:
 * per-tenant `profiles.categorise_mode` → env `CATEGORISE_MODE` → `auto`. Same single-call-site shape
 * as `featureOn`, so the per-tenant override lands with no churn at the call site (it already passes
 * the profile). An unrecognised value degrades safely to `auto`.
 */
export const CATEGORISE_MODES = ["auto", "live", "batch"] as const;
export type CategoriseMode = (typeof CATEGORISE_MODES)[number];

export function categoriseMode(env: Env, profile?: { categorise_mode?: string | null }): CategoriseMode {
  const raw = (profile?.categorise_mode ?? env.CATEGORISE_MODE ?? "auto").trim().toLowerCase();
  return (CATEGORISE_MODES as readonly string[]).includes(raw) ? (raw as CategoriseMode) : "auto";
}
