import auV1RulePack from "../rulepacks/au-v1.json";

/**
 * The ONE place a rule pack is resolved from KV (`rulepack:<id>`) against the bundled default.
 *
 * KV used to SHADOW the bundle wholesale: a stale KV copy pushed before newer top-level sections
 * existed (`state_education`, `situation_facts`, `grow_detection`, `mytax_*`, …) silently hid them —
 * in owner testing the Get set up page said "No states to show right now" while `npm test` (which
 * reads the bundle) stayed green. Now a top-level key the KV pack lacks falls back to the bundled
 * pack's value; a key the KV pack HAS still wins, so a pushed edit overrides as before.
 *
 * The fill-in only applies when the requested id IS the bundled pack's id (au-v1): a different
 * jurisdiction's KV pack (e.g. uk-2025) is never back-filled with AU content.
 */

type Pack = Record<string, unknown>;

export const BUNDLED_RULE_PACK_ID = "au-v1";
const BUNDLED = auV1RulePack as unknown as Pack;

export interface MergedRulePack {
  pack: Pack;
  /** Top-level keys the KV pack lacked and were filled from the bundle (sorted). */
  missing: string[];
  /** Set when both packs carry a `version` and they differ. */
  versionMismatch: { kv: unknown; bundled: unknown } | null;
}

/** Pure: overlay a KV override on a bundled pack at the top level. KV wins for keys it has. */
export function mergeRulePack(kv: Pack, bundled: Pack): MergedRulePack {
  const missing = Object.keys(bundled).filter((k) => !Object.prototype.hasOwnProperty.call(kv, k)).sort();
  const pack = missing.length === 0 ? kv : { ...bundled, ...kv };
  const versionMismatch =
    "version" in kv && "version" in bundled && kv.version !== bundled.version ? { kv: kv.version, bundled: bundled.version } : null;
  return { pack, missing, versionMismatch };
}

// One warning per isolate per distinct drift (key names + versions only — never pack content).
const warned = new Set<string>();
function warnOnce(id: string, m: MergedRulePack): void {
  if (m.missing.length === 0 && !m.versionMismatch) return;
  const vm = m.versionMismatch ? ` version kv=${String(m.versionMismatch.kv)} bundled=${String(m.versionMismatch.bundled)};` : "";
  const line = `rulepack:${id} KV copy is stale;${vm} missing top-level keys filled from bundle: ${m.missing.join(", ") || "(none)"} — run npm run rulepack:push`;
  if (warned.has(line)) return;
  warned.add(line);
  console.warn(line);
}

/**
 * Resolve a KV-read override for pack `id`. `override` is whatever `RULES.get(key, "json")` returned.
 * null / non-object ⇒ null (caller falls back to its bundled default, exactly as before).
 */
export function applyRulePackOverride(id: string, override: unknown): Pack | null {
  if (!override || typeof override !== "object" || Array.isArray(override)) return null;
  if (id !== BUNDLED_RULE_PACK_ID) return override as Pack;
  const merged = mergeRulePack(override as Pack, BUNDLED);
  warnOnce(id, merged);
  return merged.pack;
}

/** Read `rulepack:<id>` from KV (if bound) and merge it over the bundle. null ⇒ no usable override. */
export async function readRulePackOverride(rules: KVNamespace | undefined, id: string): Promise<Pack | null> {
  if (!rules) return null;
  try {
    return applyRulePackOverride(id, await rules.get(`rulepack:${id}`, "json"));
  } catch {
    return null; // KV unavailable ⇒ caller's bundled default
  }
}
