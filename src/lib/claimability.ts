// The claimability brain — rules-first, LLM-second. PURE matcher (no I/O), so it is
// deterministic and unit-testable. The DO calls matchClaimRules() and writes the resulting
// claim_suggestions; the LLM is only ever used to EXPLAIN a rule's output, never to assert a
// deduction the rules don't sanction. Pipeline order: extract → user_rules (bucket) →
// claimability (claim_type / deductibility / defer). GENERAL-INFO only.

export interface ClaimRule {
  scope_type: string;   // bucket|property_status|entity_kind|occupation
  scope_value: string;
  merchant_hint?: string | null;
  requires_entity_kind?: string | null; // optional AND-gate: rule only fires if the tenant has this entity kind
  ato_label?: string | null;
  claim_type: string;   // immediate|div40|div43|apportioned|not_deductible
  default_method?: string | null;
  general_info_note: string;
  defer_to_agent?: number;
  id?: string;          // present for D1-sourced per-tenant rules
}

export interface ClaimContext {
  bucket?: string | null;
  merchant?: string | null;
  property_status?: string | null;
  occupations?: string[];
  entity_kinds?: string[];
}

function merchantMatches(hint: string | null | undefined, merchant: string): boolean {
  if (!hint) return true; // no merchant constraint on this rule
  const m = merchant.toLowerCase();
  return hint
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((t) => m.includes(t));
}

// Optional AND-gate: a rule may additionally require the tenant to have a given entity kind (e.g. a
// 'renting_business' rule that only applies when a 'company' is registered). Absent ⇒ always passes,
// so existing rules are unaffected.
function entityGate(required: string | null | undefined, kinds: string[]): boolean {
  if (!required) return true;
  return kinds.includes(required);
}

/**
 * Return every rule whose scope (and optional merchant hint) matches the context. Deterministic;
 * order-preserving. The caller decides what to do with multiple matches (typically surface all).
 */
export function matchClaimRules(rules: ClaimRule[], ctx: ClaimContext): ClaimRule[] {
  const merchant = ctx.merchant ?? "";
  return rules.filter((r) => {
    if (!merchantMatches(r.merchant_hint, merchant)) return false;
    if (!entityGate(r.requires_entity_kind, ctx.entity_kinds ?? [])) return false;
    switch (r.scope_type) {
      case "bucket":
        return !!ctx.bucket && ctx.bucket === r.scope_value;
      case "property_status":
        return !!ctx.property_status && ctx.property_status === r.scope_value;
      case "entity_kind":
        return (ctx.entity_kinds ?? []).includes(r.scope_value);
      case "occupation":
        return (ctx.occupations ?? []).includes(r.scope_value);
      default:
        return false;
    }
  });
}

/** Build the GENERAL-INFO suggestion text for a matched rule (defer rules append the disclaimer). */
export function suggestionText(rule: ClaimRule): string {
  const base = rule.general_info_note;
  return rule.defer_to_agent ? `${base} Confirm with a registered tax agent before relying on this.` : base;
}
