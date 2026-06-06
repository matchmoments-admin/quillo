// Phase 3 — "Find & attach claim" auto-matcher (pure + unit-tested). Given a claim RULE (a possible
// deduction the situational sweep surfaced) and the tenant's transactions, score which transactions
// are plausible EVIDENCE for that claim, so the user can attach them in one tap. The matcher never
// asserts a deduction or writes a dollar figure — it only ranks candidates; the user confirms.

import { merchantMatches, type ClaimRule } from "./claimability";

export interface ClaimMatchTxn {
  id: string;
  merchant: string | null;
  bucket: string | null;
  ato_label: string | null;
  direction: string | null;
  amount_cents: number | null;
  amount_aud_cents: number | null;
  txn_date: string | null;
}

export interface ScoredTxn extends ClaimMatchTxn {
  score: number;
  reasons: string[];
}

// Signal weights — a candidate accrues points for each independent match signal. merchant_hint is
// the strongest (a named biller), then the bucket, then the exact ATO label.
const W_MERCHANT = 0.45;
const W_BUCKET = 0.35;
const W_LABEL = 0.25;
const MIN_SCORE = 0.3; // below this the candidate is too weak to surface

/**
 * Score the tenant's transactions as evidence for one claim rule. Debit-only (a claim is a
 * deduction = money out). A rule's merchant_hint, bucket scope and ato_label each contribute when
 * they match; candidates below MIN_SCORE are dropped. Returns the survivors, highest score first.
 * Pure — no I/O. The DO supplies the txns and persists the user's attach choices.
 */
export function scoreClaimMatches(rule: ClaimRule, txns: ClaimMatchTxn[]): ScoredTxn[] {
  const ruleBucket = rule.scope_type === "bucket" ? rule.scope_value : null;
  const out: ScoredTxn[] = [];
  for (const t of txns) {
    if ((t.direction ?? "debit") !== "debit") continue; // a deduction is a debit
    let score = 0;
    const reasons: string[] = [];
    // merchant_hint: only credit a HINTED rule that actually matches (an un-hinted rule earns no
    // merchant points — it would otherwise match every txn and flood the candidate list).
    if (rule.merchant_hint && merchantMatches(rule.merchant_hint, t.merchant ?? "")) {
      score += W_MERCHANT;
      reasons.push("merchant");
    }
    if (ruleBucket && t.bucket === ruleBucket) {
      score += W_BUCKET;
      reasons.push("bucket");
    }
    if (rule.ato_label && t.ato_label && t.ato_label === rule.ato_label) {
      score += W_LABEL;
      reasons.push("label");
    }
    if (score >= MIN_SCORE) out.push({ ...t, score: Math.round(score * 100) / 100, reasons });
  }
  return out.sort((a, b) => b.score - a.score || (b.amount_aud_cents ?? b.amount_cents ?? 0) - (a.amount_aud_cents ?? a.amount_cents ?? 0));
}
