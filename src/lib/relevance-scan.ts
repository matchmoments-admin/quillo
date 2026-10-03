// Relevance scan — PURE (no I/O), deterministic, no model calls (first-timer spec A4, #578, flag
// `relevance_scan`). docs/first-timer/relevance-scan.md §8.
//
// A bank feed tells Quillo WHERE to look, not what is claimable. For each debit bank line this sorts the
// line into one of three lists from the person's situation profile + the rule pack:
//
//   worth_a_look — an OCCUPATION-SPECIFIC claimability rule in the profile matched a payg line. This is the
//                  owner's ruling on #555: an occupation match overrides the not-deductible default and the
//                  line surfaces as a card WITH a why. The user confirms every claim; the scan never changes
//                  deductibility, so the position does not move until they do.
//   relevant     — worth sorting: a generic ('all') rule hit, an apportion / suggest stamp, an uncategorised
//                  line that matched a job rule, or an unmatched line at or above the pack's dollar floor.
//   irrelevant   — denied by the generic deny list (which keeps winning for every non-occupation rule), the
//                  user said not deductible, reimbursed, or matched nothing below the floor.
//
// Precedence, in order: user decision → occupation rule → generic deny → generic rule / stamp → floor.
// Jurisdiction-neutral by construction: tokens, rules, deny lists and the floor all come from the pack.

import { matchClaimRules, ruleKey, type ClaimRule } from "./claimability";
import { verdictForTxn, type DeductibilitySection } from "./deductibility";

export type Relevance = "relevant" | "worth_a_look" | "irrelevant";

/** One debit bank line as the scan sees it. `amount_cents` is the base-currency magnitude. */
export interface ScanLine {
  id: string;
  bucket: string | null;
  ato_label: string | null;
  merchant: string | null;
  amount_cents: number;
  deductibility: string | null;
  reimbursed?: number | null;
}

/** The occupation tokens in scope for one FY, each with the person it came from (self first). */
export interface ScanProfile {
  occupations: { token: string; person_id: string }[];
  entity_kinds?: string[];
}

export interface ScanResult {
  id: string;
  relevance: Relevance;
  rule_id: string | null;
  /** worth_a_look only: the matched rule + the person whose job put it in scope (for the card). */
  rule?: ClaimRule;
  person_id?: string | null;
  occupation?: string | null;
}

/** Buckets the scan sorts. Other expense buckets are already routed by bucket (company, property, asset). */
export const SCANNED_BUCKETS = ["payg", "unknown"] as const;
export function isScannedBucket(bucket: string | null | undefined): boolean {
  return bucket == null || (SCANNED_BUCKETS as readonly string[]).includes(bucket);
}

/** The pack's floor (cents) — a missing / malformed value falls back to $20, the spec's starting point. */
export function relevanceFloorCents(pack: unknown): number {
  const v = (pack as { relevance?: { floor_cents?: unknown } } | null)?.relevance?.floor_cents;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 2000;
}

/**
 * #587: the items the work-from-home fixed rate per hour already covers (energy, internet, phone, stationery
 * in AU), from the pack (`relevance.wfh_fixed_rate_covers`). Once the person has stated WFH hours, a line for
 * one of these isn't claimed again on its own — the fixed-rate claim already includes it.
 */
export function wfhFixedRateCovers(pack: unknown): string[] {
  const v = (pack as { relevance?: { wfh_fixed_rate_covers?: unknown } } | null)?.relevance?.wfh_fixed_rate_covers;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.toLowerCase()) : [];
}

/** Does this merchant text name an item the WFH fixed rate covers? Whole-word match, case-insensitive. Pure. */
export function coveredByWfhFixedRate(merchant: string | null | undefined, covers: readonly string[]): boolean {
  const t = ` ${(merchant ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  return covers.some((k) => {
    const w = k.replace(/[^a-z0-9]+/g, " ").trim();
    return w !== "" && t.includes(` ${w} `);
  });
}

/** Only occupation-scoped rules take part (spec A4: occupation tokens + 'all'). Property / entity / bucket
 *  rules are routed by their own buckets and never by a bank line's merchant here. */
export function scanRules(rules: ClaimRule[]): ClaimRule[] {
  return rules.filter((r) => r.scope_type === "occupation");
}

/** Sort one line. Pure. */
export function scanLine(line: ScanLine, profile: ScanProfile, rules: ClaimRule[], section: DeductibilitySection | null, floorCents: number): ScanResult {
  const d = line.deductibility ?? null;
  const tokens = [...new Set(profile.occupations.map((o) => o.token))];
  const matched = matchClaimRules(scanRules(rules), { merchant: line.merchant ?? "", occupations: tokens, entity_kinds: profile.entity_kinds ?? [] });
  const occ = matched.find((r) => r.scope_value !== "all");
  const generic = matched.find((r) => r.scope_value === "all");

  // A user decision stands: confirmed claims stay visible, a "not deductible" answer is out of the way.
  if (d === "confirmed_not" || line.reimbursed) return { id: line.id, relevance: "irrelevant", rule_id: null };
  if (d === "confirmed_deductible") return { id: line.id, relevance: "relevant", rule_id: occ || generic ? ruleKey((occ ?? generic)!) : null };

  // The stored stamp is authoritative when present (it may reflect a re-resolve); else compute it.
  const verdict = d && d !== "undetermined" ? d : verdictForTxn(line.bucket, line.ato_label, line.merchant, section).deductibility;

  if (occ) {
    // Only a payg line can be confirmed into the position; an uncategorised line that hits a job rule still
    // needs sorting first, so it is relevant rather than a card.
    if (line.bucket === "payg") {
      const who = profile.occupations.find((o) => o.token === occ.scope_value) ?? null;
      return { id: line.id, relevance: "worth_a_look", rule_id: ruleKey(occ), rule: occ, person_id: who?.person_id ?? null, occupation: occ.scope_value };
    }
    return { id: line.id, relevance: "relevant", rule_id: ruleKey(occ) };
  }
  // The generic deny list keeps winning for every non-occupation rule (spec A4 "narrow nothing else").
  if (verdict === "likely_not") return { id: line.id, relevance: "irrelevant", rule_id: null };
  if (generic) return { id: line.id, relevance: "relevant", rule_id: ruleKey(generic) };
  if (verdict === "needs_apportionment" || verdict === "suggested_deductible" || verdict === "likely_deductible") return { id: line.id, relevance: "relevant", rule_id: null };
  return { id: line.id, relevance: Math.abs(line.amount_cents) >= floorCents ? "relevant" : "irrelevant", rule_id: null };
}

/** Sort every line. O(lines × rules in scope). Pure, order-preserving. */
export function scanLines(lines: ScanLine[], profile: ScanProfile, rules: ClaimRule[], section: DeductibilitySection | null, floorCents: number): ScanResult[] {
  const scoped = scanRules(rules);
  return lines.map((l) => scanLine(l, profile, scoped, section, floorCents));
}

/** The 'worth a look' card copy: why it surfaced + the rule's general-info note + the three golden rules.
 *  General information only; never a figure, never "you can claim". */
export function worthALookText(rule: ClaimRule, occupationLabel: string | null): string {
  const because = occupationLabel ? `Worth a look because you work as a ${occupationLabel.toLowerCase()}.` : "Worth a look because it matches your job.";
  const note = rule.general_info_note;
  const golden = "It only counts if you paid it yourself and weren't reimbursed, it relates to earning your income, and you have a record of it.";
  const defer = rule.defer_to_agent ? " Confirm with a registered tax agent before relying on this." : "";
  return `${because} ${note} ${golden}${defer}`;
}

/**
 * The single return labels a rule's `ato_label` allows (#587). A pack label may name alternatives
 * ("D3/D5": clothing OR other work expenses) because one occupation rule covers several kinds of spend;
 * a confirmed line must carry exactly ONE, or the worksheet groups it under a label that doesn't exist.
 * Pure; jurisdiction-neutral (the separator is the pack's convention, the labels are the pack's own).
 */
export function ruleLabelOptions(atoLabel: string | null | undefined): string[] {
  if (!atoLabel) return [];
  return [...new Set(atoLabel.split("/").map((s) => s.trim()).filter(Boolean))];
}

/**
 * Which single label a confirm writes (#587, the #578 deferral): the rule's label when it names one, the
 * user's pick when it names alternatives (the pick must be one of them), nothing when the rule has no
 * label. `needs_label` ⇒ the user must choose from `options` first.
 */
export function resolveConfirmLabel(ruleLabel: string | null | undefined, picked: string | null | undefined): { label: string | null; needs_label: boolean; options: string[] } {
  const options = ruleLabelOptions(ruleLabel);
  if (options.length === 0) return { label: null, needs_label: false, options };
  if (options.length === 1) return { label: options[0]!, needs_label: false, options };
  if (picked && options.includes(picked)) return { label: picked, needs_label: false, options };
  return { label: null, needs_label: true, options };
}

/**
 * A confirm puts the amount into the year as an immediate deduction. For a rule whose pack method is a
 * depreciation method (or a div40 rule), a line above the FY's immediate-deduction threshold is a
 * depreciating asset instead (claimed over its life), so it goes through Assets, never a confirm. Pure.
 */
export function confirmNeedsAsset(rule: Pick<ClaimRule, "claim_type" | "default_method">, amountCents: number, immediateThresholdCents: number | null): boolean {
  const depreciating = rule.claim_type === "div40" || !!rule.default_method;
  if (!depreciating || immediateThresholdCents == null) return false;
  return Math.abs(amountCents) > immediateThresholdCents;
}

/** A confirm on this line needs the user's work-use share first (a mixed-use stamp or a non-immediate rule). */
export function confirmNeedsShare(rule: Pick<ClaimRule, "claim_type">, deductibility: string | null | undefined): boolean {
  return deductibility === "needs_apportionment" || rule.claim_type !== "immediate";
}
