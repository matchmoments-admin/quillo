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
