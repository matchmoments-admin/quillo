// #256 — pre-handoff "double-check my transactions" scan. PURE + deterministic (no I/O), like
// deductibility.ts / advisory.ts: the Durable Object loads the FY ledger + rule pack + report and hands
// plain rows here; runScan returns a ranked list of PROPOSALS the user confirms. It NEVER mutates the
// position and NEVER auto-claims — every finding is a suggestion. GENERAL INFORMATION ONLY; dollar impacts
// are DEDUCTION DELTAS ($ that would enter/leave the position), never a refund or tax figure.
//
// Core (Slices 1–4) covers the two highest-value, reliably-deterministic directions from the founder E2E:
//   (B) OVER-CLAIM — personal merchants / transfers sitting in a deductible bucket and COUNTING (~$15k in
//       the test). The dangerous direction: it over-states the position.
//   (A) MISSED — clearly-suggestible work deductions (union/tax-affairs/donations/income-protection) and
//       apportionable spend (self-education, WFH, car) sitting uncounted.
// Completeness (C) + substantiation (D) + recurring-SaaS + Ask-Quillo intent + LLM augmentation are
// deferred follow-ups (see #256).

import { deductionGroupForRow } from "./report";
import { verdictForTxn, denyNoteFor, type DeductibilitySection } from "./deductibility";
import { looksLikePersonalTransfer } from "./depreciation";
import type { ProposedAction } from "../extract";

/** One transaction the scan reasons over — a thin projection of the FY ledger (AUD cents). */
export interface ScanTxn {
  id: string;
  txn_date: string | null;
  merchant: string | null;
  ato_label: string | null;
  bucket: string;
  deductibility: string | null;
  amount_cents: number;                  // AUD, positive magnitude
  reimbursed: number | null;
  use_status_denied: number | null;      // 1 when the row's property is rent-free/renovating (#031)
  property_undetermined: number | null;  // 1 when a property row can't land in an income-producing property (#254)
}

export type ScanCategory = "missed" | "over_claim";

export interface ScanFinding {
  key: string;                  // stable natural key (dedupe + idempotency), e.g. "over_claim:personal:<id>"
  category: ScanCategory;
  severity: "high" | "review" | "info";
  sign: "+" | "-";              // +$ could be added (missed) · −$ should be removed (over-claim)
  dollar_impact_cents: number;  // deduction delta — NOT a tax/refund figure
  reason: string;               // GENERAL-INFO copy
  affected_txn_ids: string[];
  proposed_action?: ProposedAction;  // one-tap fix (reuses the Ask-Quillo action plumbing); omitted when the user must enter data
}

export interface ScanSummary {
  finding_count: number;
  missed_upside_cents: number;       // Σ +$ (could add if confirmed)
  overclaim_downside_cents: number;  // Σ −$ (should remove)
  position_confirmed_cents: number;  // #255 confirmed (defensible) end
  position_tracked_cents: number;    // #255 tracked (optimistic) end
}

export interface ScanResult {
  summary: ScanSummary;
  findings: ScanFinding[];
}

export interface ScanReportFacts {
  taxable_position_cents: number;
  taxable_position_confirmed_cents?: number;
}

// Buckets whose rows reduce the INDIVIDUAL position (where an over-claim does damage). company = separate
// taxpayer; asset = capital (depreciation engine); unknown = unsanctioned — none belong here.
const DEDUCTIBLE_BUCKETS = new Set(["payg", "property_rented", "property_vacant"]);

const GENERAL_INFO = "General information only — confirm with a registered tax agent.";

/**
 * Run the deterministic double-check. `excludeNonDeductible` mirrors the position_excludes_nondeductible
 * flag so "is this row counting?" matches the real headline exactly.
 */
export function runScan(
  rows: ScanTxn[],
  report: ScanReportFacts,
  section: DeductibilitySection | null | undefined,
  opts: { excludeNonDeductible: boolean },
): ScanResult {
  const findings: ScanFinding[] = [];

  for (const r of rows) {
    const counts =
      deductionGroupForRow(r.bucket, r.deductibility, opts.excludeNonDeductible, r.reimbursed, r.use_status_denied, r.property_undetermined) === "deduction";

    // ── (B) OVER-CLAIM: a counting deductible-bucket row that looks personal/private. ──
    if (counts && DEDUCTIBLE_BUCKETS.has(r.bucket)) {
      const denyNote = denyNoteFor(r.ato_label, r.merchant, section);
      const isTransfer = looksLikePersonalTransfer(r.merchant);
      if (denyNote || isTransfer) {
        const reason = isTransfer && !denyNote
          ? `This looks like a transfer or loan/credit-card repayment, not a deductible expense — it shouldn't reduce your position. ${GENERAL_INFO}`
          : `${denyNote} It's currently counting toward your deductions — review whether it belongs. ${GENERAL_INFO}`;
        findings.push({
          key: `over_claim:personal:${r.id}`,
          category: "over_claim",
          severity: "high",
          sign: "-",
          dollar_impact_cents: r.amount_cents,
          reason,
          affected_txn_ids: [r.id],
          proposed_action: {
            kind: "set_deductibility",
            title: "Mark as not deductible",
            rationale: reason,
            txn_ids: [r.id],
            state: "likely_not",
          },
        });
      }
      continue; // a counting row can't simultaneously be a "missed" one
    }

    // ── (A) MISSED: an uncounted payg row the rule pack positively suggests or flags for apportionment. ──
    if (!counts && r.bucket === "payg" && (r.deductibility ?? "undetermined") === "undetermined") {
      const v = verdictForTxn("payg", r.ato_label, r.merchant, section);
      if (v.deductibility === "suggested_deductible") {
        const reason = `${v.note ?? "This may be deductible."} ${GENERAL_INFO}`;
        findings.push({
          key: `missed:suggest:${r.id}`,
          category: "missed",
          severity: "review",
          sign: "+",
          dollar_impact_cents: r.amount_cents,
          reason,
          affected_txn_ids: [r.id],
          // One-tap CONFIRM — the user is asserting it's deductible (never auto-claimed). Single-txn so the
          // deductible amount is exact (setDeductibility stamps one amount across a batch).
          proposed_action: {
            kind: "set_deductibility",
            title: "Confirm this is deductible",
            rationale: reason,
            txn_ids: [r.id],
            state: "confirmed_deductible",
            deductible_amount_cents: r.amount_cents,
          },
        });
      } else if (v.deductibility === "needs_apportionment") {
        // Needs hours / a work-use % first — no one-tap; surface it and link to the txn.
        findings.push({
          key: `missed:apportion:${r.id}`,
          category: "missed",
          severity: "info",
          sign: "+",
          dollar_impact_cents: r.amount_cents,
          reason: `${v.note ?? "This may be partly deductible with a work-use portion."} ${GENERAL_INFO}`,
          affected_txn_ids: [r.id],
        });
      }
    }
  }

  // Rank: over-claims first (the dangerous direction), then missed; within each, biggest $ impact first.
  const order = (c: ScanCategory) => (c === "over_claim" ? 0 : 1);
  findings.sort((a, b) => order(a.category) - order(b.category) || b.dollar_impact_cents - a.dollar_impact_cents);

  const summary: ScanSummary = {
    finding_count: findings.length,
    missed_upside_cents: findings.filter((f) => f.category === "missed").reduce((s, f) => s + f.dollar_impact_cents, 0),
    overclaim_downside_cents: findings.filter((f) => f.category === "over_claim").reduce((s, f) => s + f.dollar_impact_cents, 0),
    position_confirmed_cents: report.taxable_position_confirmed_cents ?? report.taxable_position_cents,
    position_tracked_cents: report.taxable_position_cents,
  };
  return { summary, findings };
}
