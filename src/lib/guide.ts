import type { Progress } from "./progress";

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
  "rates or bracket maths. NEVER assert that something IS deductible — describe what's generally " +
  "deductible and say to confirm with a registered tax agent. Answer ONLY from the user's data below; " +
  "if the answer isn't in the data, say what's missing and which screen to add it on. Be warm, plain, " +
  "jargon-free, and cite the user's own numbers.";

/** Build the system + user prompt for "Ask Quillo" — a grounded answer from the user's own ledger. Pure (unit-tested). */
export function buildAskPrompt(question: string, situationText: string, positionText: string): { system: string; user: string } {
  const system =
    "You are Quillo, an Australian tax-evidence assistant answering a question about THIS user's own " +
    "records. " +
    ASK_GUARDRAILS +
    " Call give_answer exactly once.";
  const user =
    `Their question:\n${question}\n\n` +
    `What we know about them:\n${situationText || "(situation not set up yet)"}\n\n` +
    `Their tracked tax position this year (their actual figures, JSON):\n${positionText}\n\n` +
    `Answer using the data above. If it depends on something not captured, say so and name the screen to add it.`;
  return { system, user };
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
