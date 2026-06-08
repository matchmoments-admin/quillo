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
import { deductionGroupForRow } from "./report";
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
  // "excluded" = captured but NOT in the indicative position (private/non-deductible, capital, or
  // unresolved); "company" = a separate taxpayer's spend, tracked apart from the individual position.
  group: "income" | "deduction" | "depreciation" | "property" | "excluded" | "company";
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
  capitalLossCarryinCents: number; // prior-year capital losses captured at Set-up (0 if none)
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
    case "business": return "Net income of your sole-trader / ABN business (generally item 15). Your business expenses are captured separately and reduce your individual position.";
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
    case "payg": return "Work-related deductions you recorded (the D-labels). Each still needs to satisfy its own deductibility test.";
    case "company": return "Business expenses recorded against your company's books.";
    case "property_rented": return "Expenses on a currently-let property — generally deductible while it's genuinely available for rent.";
    case "property_vacant": return "Holding costs on a property not currently let — often NOT deductible; confirm it was genuinely available for rent.";
    default: return "Categorised spend for this year.";
  }
}

// Why a captured row is EXCLUDED from the indicative position (or tracked as company). GENERAL-INFO.
function excludedWhy(bucket: string, deductibility: string | null | undefined): string {
  if (bucket === "asset") return "Capital purchase — claimed over time as decline in value (Div 40 / Div 43), not as an immediate deduction, so it isn't counted here.";
  switch (deductibility) {
    case "likely_not":
    case "confirmed_not":
      return "Private or non-deductible spend (e.g. groceries, personal living costs, entertainment) — generally not deductible under s8-1(2)(b), so it's excluded from your position.";
    case "needs_apportionment":
      return "Work-related but needs an apportionment (e.g. work-use %, or your hours for working-from-home) before any amount can be claimed — excluded until you resolve it.";
    case "suggested_deductible":
      return "Looks like a deductible work/charity expense (e.g. union fees, tax-agent fees, a DGR donation) — suggested only, and excluded until you confirm it. General information, not tax advice.";
    default:
      return "Not yet confirmed as work-related — excluded by default until you confirm it relates to earning your income. Review it in the Inbox.";
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
  excludeNonDeductible?: boolean; // mirrors the `position_excludes_nondeductible` flag (default off = legacy)
}): FilingReadiness {
  const { report, situation, claimMatches, signals, generatedAt } = input;
  const excludeNonDeductible = input.excludeNonDeductible ?? false;
  const findings: ReadinessFinding[] = [];

  // ── (1) position with reasoning — straight from the report, no new maths ──
  const lines: PositionLine[] = [];
  for (const it of report.income.by_type) {
    lines.push({ group: "income", label: it.income_type, amount_cents: it.gross_cents, basis: `${it.n} income record(s)`, why: incomeTypeWhy(it.income_type) });
  }
  // Phase #138: net capital gain is assessable income — buildReport added it to taxable_position, so it
  // renders as an "income" line to keep the lines-sum == headline invariant. Present only when the
  // cgt_engine flag is on with CGT events, so the legacy reconciliation is intact.
  if (report.capital_gains && report.capital_gains.net_capital_gain_cents > 0) {
    const cg = report.capital_gains;
    lines.push({ group: "income", label: "net_capital_gain", amount_cents: cg.net_capital_gain_cents,
      basis: `gains ${money(cg.gross_capital_gains_cents)} − losses ${money(cg.capital_losses_cents)} − 50% discount ${money(cg.discount_applied_cents)}`,
      why: "Net capital gain on assets you disposed of this year (shares, crypto, property): total gains, less capital losses, less the 50% CGT discount on assets held 12+ months. This is assessable income — CGT is fact-specific, so confirm with a registered tax agent." });
  }
  // Deduction lines come from the deductibility-split breakdown so the SAME classifier that computed
  // the headline routes each row to its section ("deduction" sums to the headline; "excluded"/"company"
  // are shown apart). This both fixes the number AND explains what dropped out and why.
  let paygUnresolvedCents = 0;
  let paygUnresolvedN = 0;
  for (const b of report.deduction_breakdown) {
    if (b.bucket === "unknown") continue; // surfaced via the unknown_bucket blocker, not as a line
    const group = deductionGroupForRow(b.bucket, b.deductibility, excludeNonDeductible, b.reimbursed, b.use_status_denied);
    const label = b.ato_label ? `${b.bucket} · ${b.ato_label}` : b.bucket;
    const why = group === "deduction" ? bucketWhy(b.bucket) : group === "company" ? bucketWhy("company") : excludedWhy(b.bucket, b.deductibility);
    lines.push({ group, label, amount_cents: b.total_cents, basis: `${b.n} countable transaction(s)`, why });
    if (excludeNonDeductible && b.bucket === "payg" && (b.deductibility ?? "undetermined") === "undetermined") {
      paygUnresolvedCents += b.total_cents;
      paygUnresolvedN += b.n;
    }
  }
  // Computed work-use deductions (WFH fixed-rate + car cents-per-km). These count toward the headline
  // (buildReport added them to total_deductions), so they render as "deduction" lines and keep the
  // lines-sum == headline invariant. The itemised running costs they cover stay in "excluded"
  // (needs_apportionment) — the `why` says so — so nothing is double-claimed. Absent unless the
  // wfh_car_methods flag is on and the user supplied hours/km, so the legacy reconciliation is intact.
  const wm = report.work_method;
  if (wm && wm.wfh_cents > 0) {
    lines.push({ group: "deduction", label: "Working from home (fixed rate)", amount_cents: wm.wfh_cents,
      basis: `${wm.wfh_hours} hrs × ${wm.rates.wfh_cents_per_hour}c/hr`,
      why: "Home-office running costs claimed using the ATO fixed-rate method for the hours you worked from home. This method already covers electricity, internet, phone and stationery, so those individual receipts are not also claimed (they stay excluded below)." });
  }
  if (wm && wm.car_cents > 0) {
    lines.push({ group: "deduction", label: "Car (cents per km)", amount_cents: wm.car_cents,
      basis: `${Math.min(wm.car_work_km, wm.rates.car_km_cap)} km × ${wm.rates.car_cents_per_km}c/km (max ${wm.rates.car_km_cap} km)`,
      why: "Work-related car expenses claimed using the cents-per-kilometre method, capped at the ATO kilometre limit. This method already covers running costs (fuel, servicing, rego, insurance), so actual car receipts are not also claimed." });
  }
  // Phase B / G2: attribution deductions (payer≠claimant). buildReport added the individual + rental-
  // property amounts to gross_deductions, so they render as "deduction" lines to keep lines-sum ==
  // headline; the company amount sits in the company track (its own group). Present only when the
  // attribution_engine flag is on with attribution rows, so the legacy reconciliation is intact.
  const at = report.attribution;
  if (at && at.individual_cents + at.property_cents > 0) {
    lines.push({ group: "deduction", label: "Attributed deductions", amount_cents: at.individual_cents + at.property_cents,
      basis: "your share of costs you paid but split by entitlement (e.g. a co-owned property)",
      why: "Where you paid a cost but only part of it is yours to claim — for example a co-owned rental where the deduction follows legal ownership share, regardless of who paid the bill." });
  }
  if (at && at.company_cents > 0) {
    lines.push({ group: "company", label: "Attributed (company)", amount_cents: at.company_cents,
      basis: "costs you paid personally that belong to your company",
      why: "Costs you paid personally that are the company's expense (e.g. its cloud subscriptions). These reduce the company's position, not your salary, and are typically recorded as a loan from you to the company." });
  }
  if (report.depreciation_cents > 0) {
    lines.push({ group: "depreciation", label: "Decline in value", amount_cents: report.depreciation_cents, basis: "from your depreciation schedule (Div 40 / Div 43)", why: "Capital allowances carried forward from your asset schedule for this year." });
  }
  for (const p of report.per_property) {
    lines.push({ group: "property", label: p.label ?? p.property_id, amount_cents: p.net_cents, basis: `rent ${money(p.income_cents)} − deductions ${money(p.deduction_cents)} − depreciation ${money(p.depreciation_cents)}`, why: "Per-property position. A net loss generally offsets your other income (negative gearing)." });
  }
  // Phase C / G4: the company position is a SEPARATE taxpayer — render it in its own group so it never
  // reads as reducing the individual's salary. A pre-revenue company nets to a carried-forward loss.
  for (const cp of report.company_positions ?? []) {
    lines.push({ group: "company", label: `${cp.name ?? "Company"} — position`, amount_cents: -cp.current_year_loss_cents,
      basis: `income ${money(cp.assessable_income_cents)} − deductions ${money(cp.deductions_cents)} = ${cp.current_year_loss_cents > 0 ? "loss " + money(cp.current_year_loss_cents) : money(cp.assessable_income_cents - cp.deductions_cents)}`,
      why: "Your company is a separate taxpayer — its costs don't reduce your salary. A pre-revenue company's costs carry forward as a tax loss it can use against future company income (subject to the continuity-of-ownership / same-business tests — confirm with a registered tax agent)." });
    if (cp.shareholder_loan_balance_cents > 0) {
      lines.push({ group: "company", label: `${cp.name ?? "Company"} — shareholder loan`, amount_cents: cp.shareholder_loan_balance_cents,
        basis: "costs you paid personally on the company's behalf", why: "Money you put into the company (paying its costs personally) is a loan from you TO the company. This direction is not a Division 7A deemed dividend (that risk runs the other way — company lending to you). Keep a loan agreement and confirm with a registered tax agent." });
    }
    if (cp.rd_eligible) {
      lines.push({ group: "company", label: `${cp.name ?? "Company"} — R&D offset (check eligibility)`, amount_cents: 0,
        basis: "turnover under the R&D offset cap", why: "If the company conducts eligible, registered R&D activities it may access the R&D tax incentive offset. This is specialist territory — flagged for a registered tax agent, never auto-claimed." });
    }
  }

  // ── (2) deterministic "things to double-check" findings ──
  // Nothing captured at all → the page must say "start here", NOT present an empty $0 return as
  // "ready". A brand-new user (or an empty FY) otherwise saw a green "Nothing flagged" banner over a
  // $0.00 position, reading as "your return is done" when they'd captured nothing (#74). A blocker so
  // `ready` is false; Filing renders a dedicated start-capturing card for this finding.
  const hasAnyData =
    report.income.gross_cents > 0 ||
    report.income.by_type.length > 0 ||
    report.deduction_breakdown.length > 0 ||
    report.depreciation_cents > 0 ||
    report.per_property.length > 0 ||
    report.undated.n > 0 ||
    !!report.work_method ||
    // any captured activity (even if it only surfaced as a signal/claim) means the FY isn't blank
    signals.unknownBucketN > 0 ||
    signals.lowConfidenceN > 0 ||
    signals.needsReviewIncomeN > 0 ||
    signals.needsReviewAssetsN > 0 ||
    signals.disposedAssetsN > 0 ||
    claimMatches.length > 0;
  if (!hasAnyData) {
    findings.push(f("nothing_captured", "completeness", "blocker", `Nothing captured for FY ${report.fy} yet`,
      `Your return for this year is empty, so there's nothing to hand off. Import a bank statement or snap a receipt to get started, then come back here.`, false, []));
  }
  // BLOCKERS: these materially distort the indicative position (money silently left out), so they
  // must drop `ready` to false — the old engine only ever emitted review/info, so a user with
  // uncategorised + undated spend was told they were ready (review Medium). Severity is now "blocker".
  if (signals.unknownBucketN > 0) {
    findings.push(f("unknown_bucket", "completeness", "blocker", `${signals.unknownBucketN} transaction(s) aren't categorised yet`,
      `These total ${money(signals.unknownBucketCents)} and are excluded from the indicative position until you categorise them — so the position is incomplete. Categorise them in the Inbox before relying on the numbers.`, false,
      [{ kind: "transaction", count: signals.unknownBucketN }]));
  }
  // Deny-by-default: payg spend we couldn't positively classify is excluded from the position until
  // the user confirms it's work-related. Surface it with a clear path so the headline isn't silently
  // understated. Only meaningful (and only emitted) when the exclusion is actually in effect.
  if (excludeNonDeductible && paygUnresolvedN > 0) {
    findings.push(f("payg_unresolved", "classification", "review", `${paygUnresolvedN} personal/work transaction(s) need a deductibility decision`,
      `These total ${money(paygUnresolvedCents)} and are excluded from the indicative position by default until you confirm they relate to earning your income (work-related). Private spend stays excluded; mark the work-related ones in the Inbox.`, false,
      [{ kind: "transaction", count: paygUnresolvedN }]));
  }
  if (report.undated.n > 0) {
    findings.push(f("undated_receipts", "completeness", "blocker", `${report.undated.n} receipt(s) have no usable date`,
      `Without a date these can't be placed in a financial year, so they're left out of this year's totals — the position is incomplete. Add a date so they land in the right year.`, false,
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

  // Trust entities lodge their own return and must resolve distributions before 30 June — surfaced
  // for the agent (no trust position is modelled in the personal headline, so this is the one place
  // a trust is flagged at hand-off).
  for (const e of situation.entities) {
    if (e.kind === "trust") {
      findings.push(f(`trust_resolution:${e.id}`, "judgement", "review", `Trust "${e.name ?? "trust"}" — resolve distributions before 30 June`,
        `A trust generally must resolve how its income is distributed to beneficiaries before 30 June; an unresolved distribution can leave the trustee assessed at the highest rate of tax. This isn't reflected in your personal position — confirm the trust's distribution resolution and its own lodgment with a registered tax agent.${DEFER}`, true, []));
    }
  }
  // Prior-year capital loss captured at Set-up → a defer finding. CAPTURE-ONLY: it is NOT applied to
  // the indicative position (capital losses offset capital GAINS only — never ordinary income — and
  // there is no CGT-gain line in this position to net against). The agent applies it on the CGT schedule.
  if (signals.capitalLossCarryinCents > 0) {
    findings.push(f("capital_loss_carryin", "judgement", "info", `Prior-year capital loss carried forward (${money(signals.capitalLossCarryinCents)})`,
      `You've recorded a carried-forward capital loss. It is NOT applied to the position shown here — a capital loss can only offset a capital gain (never your salary, rental or other income), and is applied on the CGT schedule. Hand this figure to your registered tax agent to apply against any capital gains.${DEFER}`, true, []));
  }

  // (Super Notice-of-intent is surfaced via the year-end checklist (generateChecklist), not here, to
  // keep a clean PAYG-only return finding-free. PAYG-balance / Div 35 non-commercial-loss prompts are
  // deferred until sole-trader P&L is modelled — flagging them now would be noise or guesswork.)

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
