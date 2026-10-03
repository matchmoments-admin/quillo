// Occupation deduction content layer (#143) — pure lookup over the versioned rule pack. NO I/O.
// Keyed by income_activities.occupation_scope. Returns suggested claims + anti-pattern warnings for an
// occupation. GENERAL INFO ONLY — suggestions surface as suggested_deductible (never auto-counted; the
// deny-by-default invariant holds), warnings pre-empt the ATO's top occupation errors (conventional
// clothing, self-education-for-a-new-role, WFH double-dipping).
import auV1RulePack from "../rulepacks/au-v1.json";

export interface OccupationGuide {
  scope: string;
  label: string;
  /** The ATO occupation & industry guide this content follows (A4 ticket b, #579) — the "read the
   *  ATO's own guide" link A10 renders. null when the pack carries none. */
  ato_url: string | null;
  suggest: string[];
  warn: string[];
}

type OccBlock = { label?: string; ato_url?: string; suggest?: string[]; warn?: string[] };

// Stored → canonical scope aliases. The pack's guide key was historically 'tradie' while the picklist
// token is 'tradesperson' (the guide silently never fired for a picklist tradesperson — audit wave 1);
// the pack now keys 'tradesperson', and legacy stored values resolve through here.
const SCOPE_ALIASES: Record<string, string> = { tradie: "tradesperson" };

/** The canonical claim-rule scope for a stored occupation token (lower-cased, legacy aliases resolved), or
 *  null for an empty value. The relevance scan matches claimability rules on this. */
export function canonicalOccupationScope(token: string | null | undefined): string | null {
  const t = (token ?? "").trim().toLowerCase();
  if (!t) return null;
  return SCOPE_ALIASES[t] ?? t;
}

/** The occupation guide for a scope (e.g. 'nurse', 'tradesperson'), or null when the scope isn't covered. */
// `pack` defaults to the bundled pack (every existing caller); #591's /api/education passes the KV-loaded
// pack so its whole payload comes from one source. Own-property lookups only, so a stored occupation like
// "constructor" can't resolve to an Object.prototype member.
export function occupationGuide(scope: string | null | undefined, pack: unknown = auV1RulePack): OccupationGuide | null {
  if (!scope) return null;
  const key = Object.prototype.hasOwnProperty.call(SCOPE_ALIASES, scope) ? SCOPE_ALIASES[scope]! : scope;
  const occupations = (pack as { occupations?: Record<string, OccBlock> } | null)?.occupations;
  if (!occupations || key.startsWith("_") || !Object.prototype.hasOwnProperty.call(occupations, key)) return null;
  const block = occupations[key];
  if (!block || typeof block !== "object") return null;
  return { scope: key, label: block.label ?? key, ato_url: block.ato_url ?? null, suggest: block.suggest ?? [], warn: block.warn ?? [] };
}

/** Every occupation scope the rule pack covers (excludes the leading '_note' metadata key). */
export function occupationScopes(): string[] {
  const occupations = (auV1RulePack as unknown as { occupations?: Record<string, unknown> }).occupations ?? {};
  return Object.keys(occupations).filter((k) => !k.startsWith("_"));
}
