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

export type ScanCategory = "missed" | "over_claim" | "check";

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

// ── txn_scan_v2 (audit #387/#288): pattern-aware facts the DO supplies when the flag is on. ──────
// All OPTIONAL: facts absent ⇒ the v1 scan output is byte-identical. Pattern findings are category
// "check" — completeness prompts with NO dollar impact (the user must enter data; nothing one-taps).
export interface ScanRentalFacts {
  property_id: string;
  label: string | null;
  rent_cents: number;             // rent income recorded this FY
  deduction_cents: number;        // deductions counted against the property this FY
  has_loan: boolean;              // a loans_properties link exists
  loan_interest_present: boolean; // a loan_interest_summaries row exists for this FY
}

export interface ScanPatternFacts {
  salary_income_cents: number;    // salary_payg gross this FY
  wfh_hours_present: boolean;     // any work_use_inputs hours recorded for the FY
  // Authored occupation guides for the tenant's occupation(s) — drives the proactive prompt.
  occupation_guides: { scope: string; label: string; suggest: string[] }[];
  rentals: ScanRentalFacts[];
}

// The $300 no-receipt work-expense threshold is the anchor for "essentially no deductions": below it a
// salary earner hasn't even reached the record-free band. The salary floor keeps the prompt away from
// low/part-year incomes where near-zero claims are entirely plausible.
const PATTERN_SALARY_FLOOR_CENTS = 5_000_000; // $50,000
const PATTERN_LOW_DEDUCTION_CENTS = 30_000;   // $300

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
  facts?: ScanPatternFacts | null,
): ScanResult {
  const findings: ScanFinding[] = [];
  let paygCountingCents = 0; // counting payg deductions, for the low-deduction pattern below

  for (const r of rows) {
    const counts =
      deductionGroupForRow(r.bucket, r.deductibility, opts.excludeNonDeductible, r.reimbursed, r.use_status_denied, r.property_undetermined) === "deduction";

    if (counts && r.bucket === "payg") paygCountingCents += r.amount_cents;

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

  // ── txn_scan_v2 pattern + completeness checks (category "check", $0 impact — prompts, not claims). ──
  if (facts) {
    const dollars = (c: number) => `$${Math.round(c / 100).toLocaleString()}`;
    // High salary, essentially no work deductions: the audit's "biggest refund lever" pattern. The
    // occupation guides (when authored) make the prompt concrete without ever asserting a claim.
    if (facts.salary_income_cents >= PATTERN_SALARY_FLOOR_CENTS && paygCountingCents < PATTERN_LOW_DEDUCTION_CENTS) {
      const g = facts.occupation_guides[0];
      const occLine = g && g.suggest.length
        ? ` As a ${g.label.toLowerCase()}, people commonly claim things like: ${g.suggest.slice(0, 3).map((t) => t.replace(/\.$/, "")).join("; ")}.`
        : "";
      findings.push({
        key: "check:pattern:low_work_deductions",
        category: "check",
        severity: "review",
        sign: "+",
        dollar_impact_cents: 0,
        reason: `You've recorded ${dollars(facts.salary_income_cents)} of salary but under $300 of work-related deductions are counting. That can be exactly right — but most salary earners have SOME legitimate work costs.${occLine} Nothing is claimed automatically — only add costs you actually incurred and can substantiate. ${GENERAL_INFO}`,
        affected_txn_ids: [],
      });
    }
    // WFH hours: the fixed-rate method needs a contemporaneous record of actual hours — prompt when
    // salary exists and no hours are recorded (working from home is the single most common claim).
    if (facts.salary_income_cents > 0 && !facts.wfh_hours_present) {
      findings.push({
        key: "check:pattern:wfh_hours",
        category: "check",
        severity: "info",
        sign: "+",
        dollar_impact_cents: 0,
        reason: `No working-from-home hours are recorded for this year. If you genuinely worked from home, the fixed-rate method needs a record of your actual hours — add them under the work-methods card. If you didn't, ignore this. ${GENERAL_INFO}`,
        affected_txn_ids: [],
      });
    }
    for (const p of facts.rentals) {
      if (p.deduction_cents > 0 && p.rent_cents === 0) {
        findings.push({
          key: `check:rental:no_rent:${p.property_id}`,
          category: "check",
          severity: "review",
          sign: "-",
          dollar_impact_cents: 0,
          reason: `"${p.label ?? p.property_id}" has ${dollars(p.deduction_cents)} of deductions counting but NO rent income recorded this year. Rent must be declared — add the income stream (holding costs are only deductible while the property earns or is genuinely available to earn rent). ${GENERAL_INFO}`,
          affected_txn_ids: [],
        });
      }
      if (p.rent_cents > 0 && p.deduction_cents === 0) {
        findings.push({
          key: `check:rental:no_expenses:${p.property_id}`,
          category: "check",
          severity: "info",
          sign: "+",
          dollar_impact_cents: 0,
          reason: `"${p.label ?? p.property_id}" has rent income but no expenses recorded. Rates, insurance, agent fees and repairs are commonly claimable on a rental — bring in the statements that show them. ${GENERAL_INFO}`,
          affected_txn_ids: [],
        });
      }
      if (p.has_loan && !p.loan_interest_present) {
        findings.push({
          key: `check:rental:no_loan_interest:${p.property_id}`,
          category: "check",
          severity: "info",
          sign: "+",
          dollar_impact_cents: 0,
          reason: `"${p.label ?? p.property_id}" has a linked loan but no interest recorded for this year. Loan interest is usually the biggest rental deduction — add the lender's interest summary or statement. ${GENERAL_INFO}`,
          affected_txn_ids: [],
        });
      }
    }
  }

  // Rank: over-claims first (the dangerous direction), then missed, then completeness checks; within
  // each, biggest $ impact first.
  const order = (c: ScanCategory) => (c === "over_claim" ? 0 : c === "missed" ? 1 : 2);
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
