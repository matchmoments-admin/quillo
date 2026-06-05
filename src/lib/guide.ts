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
  filing: "the year-end position and lodge-readiness checklist",
  quickbooks: "connecting QuickBooks (read-only reconcile)",
  alerts: "alerts/notifications that need attention",
  settings: "your situation, entities, rules, people, privacy & AI consent",
};

const GUARDRAILS =
  "General information only — never tax advice, never predict a refund or assert deductibility; " +
  "suggest confirming with a registered tax agent where relevant. Be concrete and specific to THIS " +
  "user's data (cite their numbers), warm, plain and jargon-free.";

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
