// Occupation deduction content layer (#143) — pure lookup over the versioned rule pack. NO I/O.
// Keyed by income_activities.occupation_scope. Returns suggested claims + anti-pattern warnings for an
// occupation. GENERAL INFO ONLY — suggestions surface as suggested_deductible (never auto-counted; the
// deny-by-default invariant holds), warnings pre-empt the ATO's top occupation errors (conventional
// clothing, self-education-for-a-new-role, WFH double-dipping).
import auV1RulePack from "../rulepacks/au-v1.json";

export interface OccupationGuide {
  scope: string;
  label: string;
  suggest: string[];
  warn: string[];
}

type OccBlock = { label?: string; suggest?: string[]; warn?: string[] };

// Stored → canonical scope aliases. The pack's guide key was historically 'tradie' while the picklist
// token is 'tradesperson' (the guide silently never fired for a picklist tradesperson — audit wave 1);
// the pack now keys 'tradesperson', and legacy stored values resolve through here.
const SCOPE_ALIASES: Record<string, string> = { tradie: "tradesperson" };

/** The occupation guide for a scope (e.g. 'nurse', 'tradesperson'), or null when the scope isn't covered. */
export function occupationGuide(scope: string | null | undefined): OccupationGuide | null {
  if (!scope) return null;
  const key = SCOPE_ALIASES[scope] ?? scope;
  const occupations = (auV1RulePack as unknown as { occupations?: Record<string, OccBlock> }).occupations;
  const block = occupations?.[key];
  if (!block) return null;
  return { scope: key, label: block.label ?? key, suggest: block.suggest ?? [], warn: block.warn ?? [] };
}

/** Every occupation scope the rule pack covers (excludes the leading '_note' metadata key). */
export function occupationScopes(): string[] {
  const occupations = (auV1RulePack as unknown as { occupations?: Record<string, unknown> }).occupations ?? {};
  return Object.keys(occupations).filter((k) => !k.startsWith("_"));
}
