// The deductibility matcher — PURE (no I/O), deterministic, unit-testable. Mirrors the design of
// claimability.ts / readiness.ts: the Durable Object does the impure work (loads the rule pack,
// reads/writes D1) and hands plain values to verdictForTxn(), which returns a deny-by-default
// deductibility verdict for a single transaction.
//
// HARD INVARIANTS:
//  - GENERAL-INFO only — this assigns a *capture state*, never asserts a claim or a $ figure.
//  - DENY BY DEFAULT (s8-1): a payg/individual line is not treated as a deduction in the indicative
//    position until a rule (or the user) establishes nexus to assessable income. Anything we can't
//    positively classify stays 'undetermined' and is excluded from the headline by deny-by-default.
//  - The LLM never sets deductibility. Only this rules-first matcher and explicit user review do.
//
// SCOPE (Phase 1): we only stamp the 'payg' bucket, because that is the catch-all where private
// living spend lands and pollutes the indicative position. Other buckets keep today's behaviour:
//  - company  → excluded from the individual position by BUCKET (separate taxpayer) — left undetermined.
//  - asset    → capital, flows through the depreciation engine — excluded by BUCKET, left undetermined.
//  - property_rented / property_vacant → left undetermined so they keep counting (capture-now); a
//    vacant *dwelling* between tenants is genuinely available and stays deductible (s8-1), so we do
//    NOT auto-deny it. The "genuinely available for rent" judgement is surfaced as a defer finding.

import type { DeductibilityState } from "./taxonomy";

/** One match list in the rule pack's payg_deductibility section. */
export interface DeductibilityList {
  /** comma-separated substrings matched (case-insensitive) against `${ato_label} ${merchant}`. */
  match: string;
  /** GENERAL-INFO note explaining the verdict (shown in the "excluded" breakdown / review copy). */
  note: string;
}

/**
 * The payg_deductibility section of the rule pack (au-v1.json). All lists optional → safe defaults.
 * The matcher only ever DENIES (private/domestic) or flags APPORTIONMENT — it never auto-asserts a
 * positive deduction. Clearly-deductible payg spend (union fees, tax-affairs, donations) is left
 * 'undetermined' on purpose: it's excluded from the position by deny-by-default and surfaced for the
 * user to confirm, so we never auto-claim a deduction (and resolved_deductible_cents stays ~$0 until
 * a real year-end review, as the Reports page promises).
 */
export interface DeductibilitySection {
  deny?: DeductibilityList[];
  apportion?: DeductibilityList[];
  /** Positive SUGGESTIONS (union/tax-affairs/donations/income-protection). Stamped 'suggested_deductible'
   *  — excluded from the position (deny-by-default holds) and surfaced for the user to confirm. Never auto-claimed. */
  allow_suggest?: DeductibilityList[];
}

export interface DeductibilityVerdict {
  deductibility: DeductibilityState;
  /** the matched list's GENERAL-INFO note, or null when nothing matched (undetermined). */
  note: string | null;
}

/** True when any comma-separated token in `list.match` is a substring of `haystack`. */
function listHits(list: DeductibilityList, haystack: string): boolean {
  return list.match
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((tok) => haystack.includes(tok));
}

/**
 * Resolve a deny-by-default deductibility verdict for one transaction. Pure: same inputs → same
 * output. Only the 'payg' bucket is classified; every other bucket returns 'undetermined' (the
 * report handles them by bucket). Within payg the precedence is deny → apportion → allow → default.
 */
/**
 * #256: does this line match a DENY (private/domestic) pattern, regardless of bucket? verdictForTxn only
 * classifies the payg bucket, but the double-check scan needs to spot personal merchants that landed in a
 * PROPERTY bucket too (the founder's ~$15k of pub/groceries/pharmacy filed as property_rented). Returns
 * the matched GENERAL-INFO note, or null when nothing denies. Pure.
 */
export function denyNoteFor(
  atoLabel: string | null | undefined,
  merchant: string | null | undefined,
  section: DeductibilitySection | null | undefined,
): string | null {
  if (!section) return null;
  const haystack = `${atoLabel ?? ""} ${merchant ?? ""}`.toLowerCase();
  for (const l of section.deny ?? []) if (listHits(l, haystack)) return l.note;
  return null;
}

export function verdictForTxn(
  bucket: string | null | undefined,
  atoLabel: string | null | undefined,
  merchant: string | null | undefined,
  section: DeductibilitySection | null | undefined,
): DeductibilityVerdict {
  if (bucket !== "payg" || !section) return { deductibility: "undetermined", note: null };
  const haystack = `${atoLabel ?? ""} ${merchant ?? ""}`.toLowerCase();

  // Deny first — private/domestic spend (groceries, personal living, loan repayments, entertainment)
  // is the costliest to get wrong, so it wins over any weaker signal.
  for (const l of section.deny ?? []) if (listHits(l, haystack)) return { deductibility: "likely_not", note: l.note };
  // Apportioned — work-related but needs a work-use % / WFH hours before any amount can be claimed.
  for (const l of section.apportion ?? []) if (listHits(l, haystack)) return { deductibility: "needs_apportionment", note: l.note };
  // Positively suggest clearly-deductible categories (union/tax-affairs/donations/income-protection).
  // 'suggested_deductible' is EXCLUDED from the position until the user confirms it → confirmed_deductible,
  // so this never auto-asserts a deduction (deny-by-default + "never over-state" both hold).
  for (const l of section.allow_suggest ?? []) if (listHits(l, haystack)) return { deductibility: "suggested_deductible", note: l.note };

  // No match → stays undetermined. Deny-by-default excludes it from the headline until the user
  // confirms it's work-related (we never auto-assert a deduction here).
  return { deductibility: "undetermined", note: null };
}
