// The filing-readiness engine — PURE (no I/O), deterministic, unit-testable. Mirrors the design of
// claimability.ts / depreciation.ts: the Durable Object does all the impure work (buildReport, D1
// counts, rule matching) and hands plain values to assessReadiness(), which classifies them into a
// FilingReadiness object.
//
// HARD INVARIANTS (this is a tax-evidence product, not a tax agent):
//  - GENERAL-INFO only, never tax advice. Judgement calls defer to a registered tax agent.
//  - NEVER tax payable / refund / rates. We surface only the INDICATIVE taxable position that the
//    report already computes (income − deductions − depreciation). No bracket maths anywhere.
//  - Rules-first: findings derive from the computed Report + matched claimability rules + the
//    deterministic checks below. Nothing here invents a deduction.
// `assessReadiness` is the only export that produces user-facing text; check-units.ts asserts none of
// it trips the tax-advice denylist.

import type { Report } from "./report";
import type { Situation } from "./db";
import { suggestionText, type ClaimRule } from "./claimability";

export const READINESS_DISCLAIMER =
  "General information only — not tax advice. Quillo is not a registered tax or BAS agent. Confirm everything with a registered tax agent before lodging.";

export type FindingSeverity = "blocker" | "review" | "info";
export type FindingCategory = "completeness" | "evidence" | "classification" | "depreciation" | "income" | "threshold" | "judgement";

export interface EvidenceRef {
  kind: "transaction" | "income" | "asset" | "property" | "document";
  id?: string;
  label?: string;
  count?: number;
}

export interface ReadinessFinding {
  id: string;                 // stable key, e.g. "unknown_bucket"
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  general_info_note: string;  // always GENERAL-INFO framing
  defer_to_agent: boolean;    // true ⇒ note already carries the "confirm with a registered tax agent" suffix
  evidence_refs: EvidenceRef[];
}

// One explained line of the indicative position. `why` is template/rulepack-sourced, never a freely
// authored per-number assertion.
export interface PositionLine {
  group: "income" | "deduction" | "depreciation" | "property";
  label: string;
  amount_cents: number;
  basis: string;
  why: string;
}

export interface FilingReadinessSignals {
  unknownBucketCents: number;
  unknownBucketN: number;
  lowConfidenceN: number;
  needsReviewIncomeN: number;
  needsReviewAssetsN: number;
  hasDividendStatementDoc: boolean;
  rentalPropsMissingSummary: { property_id: string; label: string | null }[];
  disposedAssetsN: number;
  instantAssetWriteOffCentsThisFy: number | null;
  instantAssetWriteOffCentsPrevFy: number | null;
}

export interface FilingReadiness {
  fy: string;
  generated_at: string; // stamped by the caller (Date is unavailable in some runtimes/tests)
  position: {
    indicative_taxable_position_cents: number; // NEVER tax payable
    caption: string;
    lines: PositionLine[];
    credits: {
      withholding_cents: number;
      franking_credit_cents: number;
      foreign_tax_paid_cents: number;
      gst_credits_cents: number;
    };
    per_property: Report["per_property"];
  };
  findings: ReadinessFinding[];
  handoff: {
    abn: string | null;
    situation_summary: string;
  };
  readiness_score: { blockers: number; review: number; info: number; ready: boolean };
  narrative: { position_plain_english: string; accountant_notes: string[] } | null; // v2; null in v1
  disclaimer: string;
}

function incomeTypeWhy(incomeType: string): string {
  switch (incomeType) {
    case "salary_payg": return "Salary/wages you recorded (generally item 1). PAYG withheld is shown as a credit, not a deduction.";
    case "rent": return "Rent received on a let property (generally item 13). Agent-deducted expenses are captured separately as deductions.";
    case "foreign_rent": return "Rent received on a foreign property (generally item 20). Foreign tax paid is shown as a credit.";
    case "dividend": return "Dividends you recorded (generally item 11). Franking credits are shown as a credit.";
    case "interest": return "Interest you recorded (generally item 10).";
    case "managed_fund_distribution": return "Managed-fund distribution components you recorded (generally item 13U/20).";
    case "foreign_pension": return "Foreign pension income you recorded (generally item 20).";
    default: return "Income you recorded for this year.";
  }
}

function bucketWhy(bucket: string): string {
  switch (bucket) {
    case "payg": return "Work-related / personal deductions you recorded (the D-labels). Each still needs to satisfy its own deductibility test.";
    case "company": return "Business expenses recorded against your company's books.";
    case "property_rented": return "Expenses on a currently-let property — generally deductible while it's genuinely available for rent.";
    case "property_vacant": return "Holding costs on a property not currently let — often NOT deductible; confirm it was genuinely available for rent.";
    default: return "Categorised spend for this year.";
  }
}

/**
 * Classify a computed Report + matched rules + pre-counted D1 signals into a FilingReadiness object.
 * Pure: same inputs → same output. The caller stamps `generated_at` and persists/audits.
 */
export function assessReadiness(input: {
  report: Report;
  situation: Situation;
  claimMatches: ClaimRule[];
  signals: FilingReadinessSignals;
  generatedAt: string;
}): FilingReadiness {
  const { report, situation, claimMatches, signals, generatedAt } = input;
  const findings: ReadinessFinding[] = [];

  // ── (1) position with reasoning — straight from the report, no new maths ──
  const lines: PositionLine[] = [];
  for (const it of report.income.by_type) {
    lines.push({ group: "income", label: it.income_type, amount_cents: it.gross_cents, basis: `${it.n} income record(s)`, why: incomeTypeWhy(it.income_type) });
  }
  for (const b of report.by_bucket) {
    if (b.bucket === "unknown") continue; // not a sanctioned deduction; excluded from the position
    lines.push({ group: "deduction", label: b.ato_label ? `${b.bucket} · ${b.ato_label}` : b.bucket, amount_cents: b.total_cents, basis: `${b.n} countable transaction(s)`, why: bucketWhy(b.bucket) });
  }
  if (report.depreciation_cents > 0) {
    lines.push({ group: "depreciation", label: "Decline in value", amount_cents: report.depreciation_cents, basis: "from your depreciation schedule (Div 40 / Div 43)", why: "Capital allowances carried forward from your asset schedule for this year." });
  }
  for (const p of report.per_property) {
    lines.push({ group: "property", label: p.label ?? p.property_id, amount_cents: p.net_cents, basis: `rent ${money(p.income_cents)} − deductions ${money(p.deduction_cents)} − depreciation ${money(p.depreciation_cents)}`, why: "Per-property position. A net loss generally offsets your other income (negative gearing)." });
  }

  // ── (2) deterministic "things to double-check" findings ──
  if (signals.unknownBucketN > 0) {
    findings.push(f("unknown_bucket", "completeness", "review", `${signals.unknownBucketN} transaction(s) aren't categorised yet`,
      `These total ${money(signals.unknownBucketCents)} and are excluded from the indicative position until you categorise them. Review them in the Inbox.`, false,
      [{ kind: "transaction", count: signals.unknownBucketN }]));
  }
  if (report.undated.n > 0) {
    findings.push(f("undated_receipts", "completeness", "review", `${report.undated.n} receipt(s) have no usable date`,
      `Without a date these can't be placed in a financial year, so they're left out of this year's totals. Add a date so they land in the right year.`, false,
      [{ kind: "transaction", count: report.undated.n }]));
  }
  if (signals.needsReviewIncomeN > 0) {
    findings.push(f("income_needs_review", "income", "review", `${signals.needsReviewIncomeN} income record(s) flagged for review`,
      `Some income was captured with low confidence or didn't reconcile. Check the amounts before relying on the position.`, false,
      [{ kind: "income", count: signals.needsReviewIncomeN }]));
  }
  if (signals.needsReviewAssetsN > 0) {
    findings.push(f("assets_needs_review", "depreciation", "review", `${signals.needsReviewAssetsN} asset(s) flagged for review`,
      `Some depreciating assets need confirmation (cost, date or effective life) before their decline-in-value is reliable.`, false,
      [{ kind: "asset", count: signals.needsReviewAssetsN }]));
  }
  if (signals.lowConfidenceN > 0) {
    findings.push(f("low_confidence_txns", "classification", "info", `${signals.lowConfidenceN} transaction(s) were categorised with low confidence`,
      `Worth a quick scan to confirm the category is right before lodging.`, false,
      [{ kind: "transaction", count: signals.lowConfidenceN }]));
  }
  if (report.income.franking_credit_cents > 0 && !signals.hasDividendStatementDoc) {
    findings.push(f("franking_no_doc", "evidence", "review", "Franking credits recorded, but no dividend statement on file",
      `You've recorded ${money(report.income.franking_credit_cents)} of franking credits. Upload the dividend/distribution statement so the claim is substantiated.`, false,
      [{ kind: "document", label: "dividend_statement" }]));
  }
  for (const rp of signals.rentalPropsMissingSummary) {
    findings.push(f(`rental_no_summary:${rp.property_id}`, "evidence", "review", `Rental income recorded for "${rp.label ?? rp.property_id}" but no agent summary on file`,
      `Upload the agent's EOFY rental summary so the rent and agent-deducted expenses are substantiated and split correctly.`, false,
      [{ kind: "property", id: rp.property_id, label: rp.label ?? undefined }]));
  }
  if (report.income.foreign_tax_paid_cents > 0) {
    findings.push(f("foreign_tax_fito", "income", "info", "Foreign tax paid recorded",
      `You've recorded ${money(report.income.foreign_tax_paid_cents)} of foreign tax paid, which may give rise to a Foreign Income Tax Offset. The offset limit is worked out by your registered tax agent.${DEFER}`, true,
      [{ kind: "income", label: "foreign tax paid" }]));
  }
  if (signals.disposedAssetsN > 0) {
    findings.push(f("disposed_assets", "depreciation", "review", `${signals.disposedAssetsN} asset(s) were disposed this year`,
      `A disposal can trigger a balancing adjustment and/or a capital gain. Your registered tax agent will confirm the treatment.${DEFER}`, true,
      [{ kind: "asset", count: signals.disposedAssetsN }]));
  }
  // Rental property earning income but with nothing depreciating → likely a missed QS schedule.
  for (const p of report.per_property) {
    if (p.income_cents > 0 && p.depreciation_cents === 0) {
      findings.push(f(`no_depreciation:${p.property_id}`, "depreciation", "info", `No decline-in-value captured for "${p.label ?? p.property_id}"`,
        `A quantity-surveyor depreciation schedule may unlock Div 40 / Div 43 deductions on a let property. Upload one from Documents if you have it.`, false,
        [{ kind: "property", id: p.property_id, label: p.label ?? undefined }]));
    }
  }
  // FY policy drift: the instant-asset-write-off threshold changing between years is an easy miss.
  if (
    signals.instantAssetWriteOffCentsThisFy != null &&
    signals.instantAssetWriteOffCentsPrevFy != null &&
    signals.instantAssetWriteOffCentsThisFy !== signals.instantAssetWriteOffCentsPrevFy
  ) {
    findings.push(f("iawo_threshold_changed", "threshold", "info", "The instant asset write-off threshold changed this year",
      `This year's threshold (${money(signals.instantAssetWriteOffCentsThisFy)}) differs from last year (${money(signals.instantAssetWriteOffCentsPrevFy)}). Check which assets qualify before writing any off.${DEFER}`, true,
      []));
  }

  // ── (3) judgement passthrough — matched defer-to-agent rules for this situation ──
  for (const r of claimMatches) {
    if (!r.defer_to_agent) continue;
    findings.push(f(`rule:${r.id ?? `${r.scope_type}:${r.scope_value}`}`, "judgement", "review", noteTitle(r),
      suggestionText(r), true, []));
  }

  const blockers = findings.filter((x) => x.severity === "blocker").length;
  const review = findings.filter((x) => x.severity === "review").length;
  const info = findings.filter((x) => x.severity === "info").length;

  return {
    fy: report.fy,
    generated_at: generatedAt,
    position: {
      indicative_taxable_position_cents: report.taxable_position_cents,
      caption: "Indicative taxable position (income − deductions − depreciation). This is NOT your tax payable or refund.",
      lines,
      credits: {
        withholding_cents: report.income.withholding_cents,
        franking_credit_cents: report.income.franking_credit_cents,
        foreign_tax_paid_cents: report.income.foreign_tax_paid_cents,
        gst_credits_cents: report.gst_credits_cents,
      },
      per_property: report.per_property,
    },
    findings,
    handoff: { abn: report.abn, situation_summary: situationSummary(situation) },
    readiness_score: { blockers, review, info, ready: blockers === 0 },
    narrative: null,
    disclaimer: READINESS_DISCLAIMER,
  };
}

const DEFER = " Confirm with a registered tax agent.";

function f(id: string, category: FindingCategory, severity: FindingSeverity, title: string, note: string, defer: boolean, evidence: EvidenceRef[]): ReadinessFinding {
  return { id, category, severity, title, general_info_note: note, defer_to_agent: defer, evidence_refs: evidence };
}

function noteTitle(r: ClaimRule): string {
  if (r.scope_type === "property_status") return `Property treatment to confirm (${r.scope_value})`;
  if (r.scope_type === "entity_kind") return `Entity treatment to confirm (${r.scope_value})`;
  if (r.scope_type === "occupation") return `Occupation deduction to confirm (${r.scope_value})`;
  return "Treatment to confirm";
}

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function situationSummary(s: Situation): string {
  const bits: string[] = [];
  const self = s.persons.find((p) => p.role === "self") ?? s.persons[0];
  if (self?.occupation) bits.push(`Occupation: ${self.occupation}`);
  if (self && self.tax_residency !== "AU") bits.push(`Tax residency: ${self.tax_residency}`);
  if (s.entities.length) bits.push(`Entities: ${s.entities.map((e) => e.kind).join(", ")}`);
  if (s.properties.length) bits.push(`Properties: ${s.properties.map((p) => `${p.label} (${p.status})`).join("; ")}`);
  return bits.join(" · ") || "No additional situation details recorded.";
}
