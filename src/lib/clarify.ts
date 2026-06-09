// Stage B — Clarify-by-pattern engine (pure + unit-tested). The accountant pass asks the user ONE
// question per recurring *pattern*, never per transaction. This module does the deterministic work:
// normalise a noisy bank description into a stable group_key, group the leftovers, and propose
// direction-aware suggested answers. No I/O — the DO does the D1 reads/writes around it.

import { classifyMovement, movementTreatment } from "./statements";

/**
 * The SQL predicate that defines a clarify "leftover": a bank line still worth a question —
 * uncategorised / unknown-bucket / low-confidence and not already finalised. Exported as ONE
 * constant so the scan, the answer resolver and apply-to-siblings interpolate the identical WHERE
 * (they MUST act on the same set of rows, or a pattern answer would touch rows the user never saw).
 */
export const CLARIFY_LEFTOVER_WHERE =
  "status NOT IN ('ignored','duplicate','matched_receipt','corrected') AND (bucket IS NULL OR bucket = 'unknown' OR confidence IS NULL OR confidence < 0.85)";

/**
 * True when a row is a clarify leftover the dedicated movement steps DON'T own — i.e. its movement
 * treatment is "skip" (not an internal transfer / card payment / loan repayment / investment
 * deposit). Centralised so the scan, the answer resolver and apply-to-siblings can never disagree on
 * which rows a pattern answer touches (the previous duplicate inline predicates risked drift).
 */
export function isClarifyLeftover(row: { raw_description?: string | null; merchant?: string | null; direction?: string | null }): boolean {
  return movementTreatment(classifyMovement(row.raw_description ?? row.merchant ?? "").klass, row.direction ?? null) === "skip";
}

// Channel / noise tokens that carry no merchant identity — stripped before grouping so the SAME
// payee phrased different ways ("Transfer From X", "Direct Credit X", "OSKO X") collapses to one key.
const NOISE = new Set([
  "transfer", "transfers", "deposit", "deposits", "withdrawal", "payment", "payments", "pmt",
  "direct", "credit", "debit", "osko", "payid", "payto", "bpay", "eftpos", "netbank", "commbank",
  "anytime", "internet", "mobile", "online", "visa", "mastercard", "purchase", "pos", "ref",
  "reference", "receipt", "from", "the", "and", "pty", "ltd", "aus", "australia", "value", "date",
  "tfr", "dep", "rcv", "received", "send", "sent", "auspost",
]);

// A date-ish token: dd/mm, dd/mm/yy(yy), dd-mm, or a bare 6-8 digit run (refs). Removed before tokenising.
const DATEY_RE = /\b\d{1,4}([/\-.]\d{1,4}){1,2}\b/g;

/**
 * Normalise a raw bank description into a stable grouping key, or null when it has no usable
 * merchant identity (→ never forms a junk group; falls to the normal review queue instead).
 *
 * Spec: lowercase → strip date/ref tokens → split on non-letters → drop noise/short (<4-char)
 * tokens → take the TWO LONGEST remaining tokens (robust to extra descriptor words like a trailing
 * "rent" or "deposit") → sort them alphabetically (order-independent) → join. A single significant
 * token stands alone; zero significant tokens → null.
 */
export function groupKey(raw: string | null | undefined): string | null {
  const s = (raw ?? "").toLowerCase().replace(DATEY_RE, " ");
  const tokens = s
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 4 && !NOISE.has(t));
  if (tokens.length === 0) return null;
  // Two longest (ties broken alphabetically), then sorted alphabetically for order-independence.
  const top = [...tokens].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, 2);
  return top.sort().join(" ");
}

/**
 * The substring to use as a user_rule pattern for an answered group. The group_key is two tokens
 * sorted ALPHABETICALLY ("energy origin"), which would never substring-match the raw "...origin
 * energy..." line — so a learned rule must instead use a single real token. We pick the LONGEST
 * token of the stem (most distinctive), which IS a substring of every raw line in the group.
 */
export function rulePatternForStem(groupKeyStem: string): string {
  return groupKeyStem.split(" ").reduce((a, b) => (b.length > a.length ? b : a), "");
}

export type ClarifyAnswerKind =
  | "income_property" // → recordIncome(income_property, property_id) + exclude the bank credit
  | "income_business" // → recordIncome(income_business)
  | "income_personal" // → recordIncome(income_personal)
  | "ignore" // → status='ignored' (own-account transfer, loan repayment, personal/gift — not spend, not income)
  | "capital" // → status='ignored' + ato_label='capital:investment' (a share/brokerage deposit — not deductible, not income, but CGT-relevant)
  | "bucket"; // → re-bucket the group (payg/property_*/asset…) with an optional ato_label

export interface ClarifySuggestion {
  label: string;
  kind: ClarifyAnswerKind;
  bucket?: string; // for kind 'bucket'
  ato_label?: string; // optional default label for kind 'bucket'
  needs_property?: boolean; // UI must attach a property_id (income_property)
}

export interface ClarifyGroup {
  group_key: string;
  sample_desc: string;
  n: number;
  total_cents: number;
  direction: "debit" | "credit" | "mixed";
  suggestions: ClarifySuggestion[];
}

export interface ClarifyRow {
  raw_description: string | null;
  merchant: string | null;
  amount_cents: number | null;
  amount_aud_cents: number | null;
  direction: string | null;
}

export interface ClarifyThresholds {
  minCount: number; // K — emit a question once a pattern recurs this many times …
  minTotalCents: number; // … OR its FY total reaches this, whichever comes first
}

export const DEFAULT_CLARIFY_THRESHOLDS: ClarifyThresholds = { minCount: 3, minTotalCents: 25_000 };

/** Optional context that tailors the suggestions to the tenant's situation. */
export interface SuggestionContext {
  isRentLike?: boolean;     // the group's stem looks like rent/lease
  hasTenantHome?: boolean;  // the tenant has a renting_residence (own-home rental) property
}

/** True when a group's stem/description reads like rent or a lease payment. */
export function isRentLikeStem(s: string | null | undefined): boolean {
  return /\b(rent|lease|tenancy|landlord)\b/i.test(s ?? "");
}

/** Direction-aware suggested answers — one tap each. Concrete fields are filled in by the UI/server. */
export function suggestionsFor(direction: "debit" | "credit" | "mixed", ctx: SuggestionContext = {}): ClarifySuggestion[] {
  if (direction === "credit") {
    return [
      { label: "Rental income (choose property)", kind: "income_property", needs_property: true },
      { label: "Business income", kind: "income_business" },
      { label: "Transfer between my own accounts (ignore)", kind: "ignore" },
      { label: "Personal / gift (not income)", kind: "ignore" },
    ];
  }
  // debit (or mixed — treat as spend by default; the user can still pick ignore)
  const out: ClarifySuggestion[] = [];
  // Tenant paying rent on their OWN home: lead with the correct answer — it's private, not deductible.
  // (Only WFH running costs are claimable, separately — never the rent itself.) Reuses the existing
  // payg/personal-spend bucket; no new answer kind. Business-premises rent is deliberately NOT offered
  // here (it turns on entity structure + apportionment — deferred).
  if (ctx.isRentLike && ctx.hasTenantHome) {
    out.push({ label: "Rent I pay on my home (private — not deductible)", kind: "bucket", bucket: "payg", ato_label: "personal-spend" });
  }
  out.push(
    { label: "Private / personal (not deductible)", kind: "bucket", bucket: "payg", ato_label: "personal-spend" },
    { label: "Loan repayment / transfer (ignore)", kind: "ignore" },
    { label: "Work-related deduction (choose category)", kind: "bucket", bucket: "payg" },
    { label: "Rental-property expense", kind: "bucket", bucket: "property_rented" },
    // A deposit into a share/brokerage app (Stake, CommSec, Pearler…) is a CAPITAL movement — not a
    // deduction and not income, but CGT-relevant. Parks it excluded + tagged for a future CGT feature.
    { label: "Investment / shares (capital — not deductible)", kind: "capital" },
  );
  return out;
}

/**
 * Group leftover rows by normalised stem and keep only the recurring patterns worth ONE question
 * (count ≥ minCount OR total ≥ minTotalCents). Singletons and sub-threshold stems are NOT returned —
 * they stay in the normal review queue (the caller must not drop them). Rows with no usable stem
 * (groupKey === null) are skipped here for the same reason.
 */
export function groupForClarify(rows: ClarifyRow[], thresholds: ClarifyThresholds = DEFAULT_CLARIFY_THRESHOLDS, ctx: SuggestionContext = {}): ClarifyGroup[] {
  const groups = new Map<string, { rows: ClarifyRow[]; sample: string; total: number; debits: number; credits: number }>();
  for (const r of rows) {
    const key = groupKey(r.raw_description ?? r.merchant ?? "");
    if (!key) continue;
    const g = groups.get(key) ?? { rows: [], sample: r.merchant ?? r.raw_description ?? key, total: 0, debits: 0, credits: 0 };
    g.rows.push(r);
    g.total += Math.abs(r.amount_aud_cents ?? r.amount_cents ?? 0);
    if (r.direction === "credit") g.credits++;
    else g.debits++;
    groups.set(key, g);
  }
  const out: ClarifyGroup[] = [];
  for (const [key, g] of groups) {
    if (g.rows.length < thresholds.minCount && g.total < thresholds.minTotalCents) continue;
    const direction: "debit" | "credit" | "mixed" = g.credits > 0 && g.debits > 0 ? "mixed" : g.credits > 0 ? "credit" : "debit";
    out.push({
      group_key: key,
      sample_desc: g.sample,
      n: g.rows.length,
      total_cents: g.total,
      direction,
      suggestions: suggestionsFor(direction, { ...ctx, isRentLike: isRentLikeStem(g.sample) || isRentLikeStem(key) }),
    });
  }
  // Biggest-dollar patterns first — that's where the position correction matters most.
  return out.sort((a, b) => b.total_cents - a.total_cents);
}
