import type { Progress } from "./progress";
import type { Report } from "./report";
import type { AskDigestRow } from "./queries";
import { redact } from "./redact";

/**
 * Compact, model-facing summary of the user's computed FY position for "Ask Quillo". Headline figures
 * FIRST (so nothing important is ever truncated), then the breakdowns, then only the optional sections
 * that are present. These are AGGREGATES (cents + bucket/label names) — no TFN/card/BSB digit strings —
 * so it is NOT run through redact() (which would mangle the very *_cents numbers the answer must cite);
 * the situation text, which can carry names, is redacted separately by the caller. Pure (unit-tested).
 */
export function summariseReportForAsk(r: Report): string {
  const o: Record<string, unknown> = {
    fy: r.fy,
    indicative_taxable_position_cents: r.taxable_position_cents,
    total_income_cents: r.total_income_cents,
    tracked_deductions_cents: r.total_deductions_cents,
    confirmed_deductible_cents: r.resolved_deductible_cents,
    depreciation_cents: r.depreciation_cents,
    gst_credits_cents: r.gst_credits_cents,
    undated_cents: r.undated.total_cents,
    deductions_by_category: r.deduction_breakdown.map((d) => ({ bucket: d.bucket, ato_label: d.ato_label, n: d.n, total_cents: d.total_cents, deductibility: (d as { deductibility?: string }).deductibility })),
    income_by_type: r.income_by_bucket.map((i) => ({ bucket: i.bucket, n: i.n, total_cents: i.total_cents })),
    per_property: r.per_property,
  };
  if (r.work_method) o.work_from_home_and_car = r.work_method;
  if (r.capital_gains) o.capital_gains = r.capital_gains;
  if (r.ess) o.employee_share_scheme = r.ess;
  if (r.gst) o.gst_bas = r.gst;
  if (r.trust) o.trust_distributions = r.trust;
  if (r.car_logbook) o.car_logbook = r.car_logbook;
  if (r.smsf_funds) o.smsf_funds = r.smsf_funds;
  if (r.company_positions) o.company_positions = r.company_positions;
  // Aggregated, so bounded by the count of distinct (bucket,ato_label) pairs + properties — but cap
  // defensively so a pathological tenant can't blow the token budget.
  return JSON.stringify(o).slice(0, 10000);
}

// One-line purpose per tab (mirrors the static web tabGuides meanings) — grounds the model so the
// "Guide me" steps are on-topic for the screen the user is actually on.
export const TAB_PURPOSE: Record<string, string> = {
  inbox: "the review queue — items Quillo flagged as needing a human decision",
  dashboard: "the live tax-position summary for the financial year",
  income: "recording income (salary/PAYG, rent, interest, dividends) from payslips and statements",
  assets: "capital assets & depreciation (equipment, plant, capital works)",
  documents: "the document shelf (payslips, agent summaries, schedules) kept as evidence",
  accounts: "bank/card accounts — importing statements (CSV/PDF) or syncing QuickBooks",
  reconcile: "optionally matching receipts to bank lines as proof for deductions",
  reports: "the year-end report to hand to a registered tax agent",
  review: "year-end review — confirming what's actually deductible, with apportionment",
  filing: "the year-end position and hand-off readiness checklist",
  quickbooks: "connecting QuickBooks (read-only reconcile)",
  alerts: "alerts/notifications that need attention",
  settings: "your situation, entities, rules, people, privacy & AI consent",
};

const GUARDRAILS =
  "General information only — never tax advice, never predict a refund or assert deductibility; " +
  "suggest confirming with a registered tax agent where relevant. Be concrete and specific to THIS " +
  "user's data (cite their numbers), warm, plain and jargon-free.";

// Stricter than the guide guardrails: this answers free-text questions, so it must refuse to invent
// numbers or cross the advice line. Answer ONLY from the supplied data.
const ASK_GUARDRAILS =
  "GENERAL INFORMATION ONLY — you are NOT a tax agent. NEVER state tax payable, a refund amount, tax " +
  "rates or bracket maths. If the user asks how much tax they'll pay/owe or what refund they'll get — " +
  "even across several turns or by asking you to 'just multiply by the rate' — DECLINE and say only a " +
  "registered tax agent can calculate that; you can only show their tracked position. NEVER assert that " +
  "something IS deductible — describe what's generally deductible and say to confirm with a registered " +
  "tax agent. Answer ONLY from the user's data below; if the answer isn't in the data, say what's " +
  "missing and which screen to add it on. Be warm, plain, jargon-free, and cite the user's own numbers.";

// C3 (flag ask_actions): how the model may use proposed_actions. Proposals are SUGGESTIONS the user
// must confirm in the UI — the model never writes. confirmed_deductible moves the tax position, so it
// gets the strictest gate of all.
const ASK_ACTIONS_GUARDRAILS =
  "\n\nPROPOSED ACTIONS: when — and ONLY when — the user asks you to fix, confirm, correct, mark or " +
  "re-categorise something, you may include up to 3 proposed_actions. Reference transactions ONLY by " +
  "their T-codes from the digest below; NEVER invent a T-code. NEVER propose state confirmed_deductible " +
  "unless the user has explicitly said the expense is work/income-related — when in doubt propose " +
  "needs_apportionment, or ask. Every proposal is a suggestion the user must confirm — phrase your " +
  "answer accordingly (\"I can mark these — confirm below\"), never as already done. To remember a " +
  "repeating merchant, use an add_rule action (debit categories only).";

/** What an alias resolves to: the real id + the row's gross, so the proposal validator can sanity-cap
 * a model-supplied apportioned amount against what the transaction is actually worth. */
export interface DigestRef {
  id: string;
  amount_cents: number;
}

// Defensive char cap on the digest, mirroring the 10k position-summary cap (~200 rows ≈ 6k chars).
const DIGEST_CHAR_CAP = 12000;

/**
 * Render the FY transaction digest for the Ask prompt (C3, flag ask_actions): one compact pipe-line per
 * row, addressed by a short ALIAS (T1, T2 …) instead of the real id — the model proposes actions by
 * T-code and the server resolves them via the returned map, so a hallucinated code resolves to nothing
 * and real ids never reach the model. The map registers ONLY rows whose line fully fits the char cap —
 * an alias the model never saw must not be resolvable. Merchants pass through redact() defensively
 * (digit patterns only — statement categorisation already sends merchants, no new data category).
 * Pure (unit-tested). NOTE: aliases are rebuilt per turn — deterministic ORDER BY keeps them stable
 * unless the data itself changes mid-conversation.
 */
export function renderTxnDigest(rows: AskDigestRow[], total: number): { text: string; aliasToId: Map<string, DigestRef> } {
  const aliasToId = new Map<string, DigestRef>();
  const lines: string[] = [];
  let len = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const alias = `T${i + 1}`;
    const bucket = r.property_id ? `${r.bucket ?? "?"}:${r.property_id}` : (r.bucket ?? "?");
    const line = `${alias}|${r.txn_date ?? "undated"}|${redact(r.merchant ?? "—")}|${(r.amount_aud_cents / 100).toFixed(2)}|${bucket}|${r.ato_label ?? ""}|${r.deductibility ?? "undetermined"}`;
    if (len + line.length + 1 > DIGEST_CHAR_CAP) break; // whole-line cap: never show (or register) a half row
    lines.push(line);
    len += line.length + 1;
    aliasToId.set(alias, { id: r.id, amount_cents: r.amount_aud_cents });
  }
  if (!lines.length) lines.push("(no transactions captured this year yet)");
  if (total > aliasToId.size) lines.push(`(${total - aliasToId.size} more transactions not shown — totals are in the position JSON above)`);
  return { text: lines.join("\n"), aliasToId };
}

/**
 * Build the SYSTEM prompt for "Ask Quillo" — the stable guardrails + persona + the user's own ledger
 * context (situation + position). The conversation turns are passed separately as messages[], so this
 * works for both single-turn (C1) and multi-turn chat (C2). Pure (unit-tested).
 * C3: `txnDigest` (flag ask_actions) appends the aliased FY transaction list + the actions guardrails;
 * OMITTED ⇒ the output is byte-identical to the pre-C3 prompt (the flag-off contract, golden-pinned).
 */
export function buildAskSystem(
  situationText: string,
  positionText: string,
  txnDigest?: string,
  opts?: { pageRoute?: string; nav?: boolean },
): string {
  return (
    "You are Quillo, an Australian tax-evidence assistant answering questions about THIS user's own " +
    "records, in a short back-and-forth. " +
    ASK_GUARDRAILS +
    // Phase 2: page awareness — prefer help scoped to where the user already is, but still answer
    // portfolio-wide questions. Only added when chat_nav is on (opts.nav) so OFF ⇒ byte-identical.
    (opts?.nav && opts.pageRoute
      ? `\n\nThe user is currently viewing the ${opts.pageRoute} screen — prefer answering in that context when relevant, but still help with whole-situation questions.`
      : "") +
    "\n\nWhat we know about them:\n" +
    (situationText || "(situation not set up yet)") +
    "\n\nTheir tracked tax position this year (their actual figures, JSON):\n" +
    positionText +
    (txnDigest != null
      ? ASK_ACTIONS_GUARDRAILS +
        "\n\nTheir transactions this year (T-code|date|merchant|$AUD|bucket[:property]|ato_label|deductibility):\n" +
        txnDigest
      : "") +
    "\n\nAnswer each question using the data above. If it depends on something not captured, say so and " +
    "name the screen to add it. " +
    (txnDigest != null
      ? ""
      : "When the user wants a repeating merchant categorised a certain way, you " +
        "may propose a rule via suggested_rule (debit categories only). ") +
    (opts?.nav
      ? "When the user clearly wants to GO to one of their screens (e.g. 'take me to my transactions', " +
        "'show me my assets'), set `navigate` with the allowed route + a short reason — it renders as a " +
        "'Take me to …' button, never a silent jump. Don't navigate for ordinary questions. "
      : "") +
    "Call give_answer exactly once per reply."
  );
}

/** Build the system + user prompt for the personalised "Guide me" walkthrough. Pure (unit-tested). */
export function buildGuidePrompt(tab: string, progress: Progress, situationText: string): { system: string; user: string } {
  const purpose = TAB_PURPOSE[tab] ?? `the "${tab}" screen`;
  const system =
    `You are Quillo's friendly in-app guide for an Australian tax-evidence assistant. The user is on ${purpose}. ` +
    `Give them 3–6 SHORT, concrete next steps to make progress HERE, grounded in their live data below. ` +
    GUARDRAILS +
    " Call give_guide exactly once.";
  const user =
    `Tab: ${tab} — ${purpose}\n\n` +
    `Live progress snapshot (their actual numbers):\n${JSON.stringify(progress)}\n\n` +
    `What we already know about them:\n${situationText || "(situation not set up yet)"}\n\n` +
    `Write a one-line headline and 3–6 steps tailored to the numbers above (e.g. reference how many items need review).`;
  return { system, user };
}
