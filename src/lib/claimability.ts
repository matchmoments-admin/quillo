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
        // scope_value 'all' is a cross-occupation wildcard (generics like WFH / donations / tax-agent
        // fees) — it applies to everyone; here it still only fires when the rule's merchant_hint matches.
        return r.scope_value === "all" || (ctx.occupations ?? []).includes(r.scope_value);
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

// ── "Find My Claims" pure helpers ─────────────────────────────────────────────
// Situational eligibility, NOT per-transaction: these answer "what could this user claim given
// who they are" (occupation/entities/properties), so they DELIBERATELY ignore merchant_hint —
// a rule is in scope for the situation even before any matching transaction has been ingested.
// All deterministic + side-effect-free; the DO orchestrates I/O around them. GENERAL-INFO only.

/** The minimal situation shape these helpers reason over (a projection of the tenant's profile). */
export interface ClaimSituation {
  occupations: string[];
  entity_kinds: string[];
  property_statuses: string[];
}

/**
 * Stable identity for a rule across runs: prefer the D1 id (per-tenant rows), else the scope pair.
 * Used to de-dupe enumerated rules and to reconcile against fired/dismissed suggestion ids.
 */
export function ruleKey(rule: ClaimRule): string {
  return rule.id ?? `${rule.scope_type}:${rule.scope_value}`;
}

/** The bucket a rule pertains to, where it is bucket-scoped (else null — occupation/status/entity rules
 *  are not bound to a single spend bucket, so "has spend" is decided by their fired suggestion id). */
function ruleBucket(rule: ClaimRule): string | null {
  return rule.scope_type === "bucket" ? rule.scope_value : null;
}

/**
 * Every rule whose SCOPE matches the situation across ALL of its occupations, entity_kinds and
 * property_statuses — merchant_hint ignored (situational, not transactional). Honours the optional
 * requires_entity_kind AND-gate. De-duped by ruleKey, order-preserving (first occurrence wins).
 */
export function enumerateSituationClaims(rules: ClaimRule[], situation: ClaimSituation): ClaimRule[] {
  const occupations = situation.occupations ?? [];
  const entity_kinds = situation.entity_kinds ?? [];
  const property_statuses = situation.property_statuses ?? [];
  const seen = new Set<string>();
  const out: ClaimRule[] = [];
  for (const r of rules) {
    if (!entityGate(r.requires_entity_kind, entity_kinds)) continue;
    let inScope = false;
    switch (r.scope_type) {
      case "bucket":
        // Bucket rules aren't situational on their own (they fire on a transaction's bucket); a
        // situation can't pre-establish them, so they're excluded from the situational sweep.
        inScope = false;
        break;
      case "property_status":
        inScope = property_statuses.includes(r.scope_value);
        break;
      case "entity_kind":
        inScope = entity_kinds.includes(r.scope_value);
        break;
      case "occupation":
        // 'all' is the cross-occupation wildcard (WFH / self-education / donations / tax-agent fees /
        // income protection / union fees) — situationally in scope for every tenant.
        inScope = r.scope_value === "all" || occupations.includes(r.scope_value);
        break;
      default:
        inScope = false;
    }
    if (!inScope) continue;
    const key = ruleKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Bucket a single rule into one of the three "Find My Claims" groups. Deterministic:
 *   - defer            → the rule needs an agent's judgement (defer_to_agent set).
 *   - capturing        → there's already evidence for it: its bucket has FY spend OR its rule id
 *                        already fired a suggestion (the user is on top of this one).
 *   - check            → eligible for the situation but no evidence yet → "worth checking".
 * Dismissed filtering is the CALLER's job — a dismissed rule should be dropped before this is called
 * (so it never resurfaces as 'check'); we accept dismissedRuleIds only to keep the contract explicit
 * and let the caller assert it. A dismissed id present in firedRuleIds still reads as 'capturing'.
 */
export function classifyClaim(
  rule: ClaimRule,
  opts: { bucketsWithSpend: Set<string> | string[]; firedRuleIds: Set<string> | string[]; dismissedRuleIds: Set<string> | string[] },
): "capturing" | "check" | "defer" {
  if (rule.defer_to_agent) return "defer";
  const buckets = opts.bucketsWithSpend instanceof Set ? opts.bucketsWithSpend : new Set(opts.bucketsWithSpend);
  const fired = opts.firedRuleIds instanceof Set ? opts.firedRuleIds : new Set(opts.firedRuleIds);
  const bucket = ruleBucket(rule);
  const hasSpend = bucket !== null && buckets.has(bucket);
  if (hasSpend || fired.has(ruleKey(rule))) return "capturing";
  return "check";
}

/** Occupations the tenant has that NO occupation-scoped rule covers (→ candidates for AI gap-fill). */
export function uncoveredOccupations(rules: ClaimRule[], occupations: string[]): string[] {
  const covered = new Set(rules.filter((r) => r.scope_type === "occupation").map((r) => r.scope_value));
  return (occupations ?? []).filter((o) => !covered.has(o));
}
