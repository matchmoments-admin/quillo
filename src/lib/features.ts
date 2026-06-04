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
