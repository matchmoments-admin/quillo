import type { UserRule } from "./db";

// A user rule's natural direction follows its bucket: income/refund buckets are money-IN (credits);
// the expense/asset buckets are money-OUT (debits); 'unknown' is unconstrained. The direction guard
// means a "Stripe → income_business" rule can't tag a Stripe *debit* as income (and an expense rule
// can't tag a refund credit as a deduction) — mirroring the guard merchant-hints already have.
export const RULE_CREDIT_BUCKETS = new Set(["income_business", "income_property", "income_personal", "refund"]);
const RULE_DEBIT_BUCKETS = new Set(["payg", "company", "property_rented", "property_vacant", "asset"]);

/** Whether a rule with `bucket` may fire on a line of `direction` (unconstrained when direction is unknown). */
export function ruleAppliesToDirection(bucket: string, direction?: string | null): boolean {
  if (!direction) return true; // direction-less caller → unconstrained
  if (RULE_CREDIT_BUCKETS.has(bucket)) return direction === "credit";
  if (RULE_DEBIT_BUCKETS.has(bucket)) return direction === "debit";
  return true; // 'unknown' (or any future bucket) applies either way
}

/**
 * First user rule whose pattern matches `merchant` (case-insensitive; substring unless
 * match_type='merchant_exact') AND whose bucket is compatible with `direction`. Rules are assumed
 * pre-sorted by priority. Returns null when none match.
 */
export function applyUserRules(merchant: string, rules: UserRule[], direction?: string | null): UserRule | null {
  const m = (merchant ?? "").toLowerCase();
  for (const r of rules) {
    if (!ruleAppliesToDirection(r.bucket, direction)) continue;
    const p = r.pattern.toLowerCase();
    const hit = r.match_type === "merchant_exact" ? m === p : m.includes(p);
    if (hit) return r;
  }
  return null;
}
