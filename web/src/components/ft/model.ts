// Pure logic behind the first-timer component library (spec A12 ticket b, #583). Kept free of React
// and the DOM so scripts/check-units.ts can test it directly (the repo has no browser test runner).
// Copy here is scanned by the tax-advice denylist like every other file under components/ft/.

import { STEP_ORDER, type StepKey } from "../../content/stepGuides";

/** Load state every ft/ component accepts. `ready` renders the content; the rest render the shared states. */
export type FtStatus = "ready" | "loading" | "empty" | "error";

/** A journey step (Home is not a numbered step). */
export type JourneyStep = Exclude<StepKey, "home">;

/** The numbered steps, in order, derived from the one step list in content/stepGuides.ts. */
export const JOURNEY_STEPS: readonly JourneyStep[] = STEP_ORDER.filter((k): k is JourneyStep => k !== "home");

/** How many numbered steps the journey has (4 since spec §0). */
export const STEP_TOTAL = JOURNEY_STEPS.length;

export type SegmentState = "done" | "current" | "todo";

/**
 * Progress segments for the step header: everything before `current` is done, `current` is current,
 * the rest are to do. `current` is 1-based and clamped into range, so a bad value never renders an
 * empty or overflowing bar.
 */
export function segmentStates(current: number, total: number = STEP_TOTAL): SegmentState[] {
  const t = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0));
  const c = Math.min(Math.max(1, Math.floor(Number.isFinite(current) ? current : 1)), Math.max(1, t));
  return Array.from({ length: t }, (_, i) => (i + 1 < c ? "done" : i + 1 === c ? "current" : "todo"));
}

/**
 * "Step n of 4 · N more after this" (pattern P3: says how much is left, not only where you are), or
 * "Step 4 of 4 · Last step". Clamped like segmentStates.
 */
export function stepLabel(current: number, total: number = STEP_TOTAL): string {
  const segs = segmentStates(current, total);
  const n = segs.indexOf("current") + 1;
  const left = segs.length - n;
  return `Step ${n} of ${segs.length} · ${left > 0 ? `${left} more after this` : "Last step"}`;
}

export interface Completeness {
  done: number;
  total: number;
  /** 0..1 */
  frac: number;
  /** 0..100, rounded */
  pct: number;
  label: string;
}

/**
 * The completeness meter's numbers. It measures how many items are ready, never money: the inputs
 * are counts, the output is a count and a proportion. Negative, fractional or non-finite inputs are
 * floored and clamped; `done` never exceeds `total`; zero items is 0%, not NaN.
 */
export function completeness(done: number, total: number): Completeness {
  const t = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0));
  const d = Math.min(t, Math.max(0, Math.floor(Number.isFinite(done) ? done : 0)));
  const frac = t === 0 ? 0 : d / t;
  return { done: d, total: t, frac, pct: Math.round(frac * 100), label: `${d} of ${t} ready` };
}

/**
 * The text the worksheet line's copy button puts on the clipboard: a plain number in dollars and
 * cents, no currency symbol and no thousands separators, which is what a myTax amount field accepts.
 * Negative amounts keep their sign. Null (no figure yet) copies nothing.
 */
export function copyValue(cents: number | null | undefined): string | null {
  if (cents == null || !Number.isFinite(cents)) return null;
  const c = Math.round(cents);
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Claim card badges. Labels are prompts to look, never a statement that something is claimable. */
export type ClaimBadge = "worth_a_look" | "confirmed" | "not_work" | "needs_record";
export const CLAIM_BADGE_LABEL: Record<ClaimBadge, string> = {
  worth_a_look: "Worth a look",
  confirmed: "You confirmed",
  not_work: "Not work-related",
  needs_record: "Needs a record",
};

/** Record row statuses. */
export type RecordStatus = "recorded" | "needs_record" | "exception";
export const RECORD_STATUS_LABEL: Record<RecordStatus, string> = {
  recorded: "Recorded",
  needs_record: "Needs a record",
  exception: "Record-keeping exception",
};

/** Check item tones (spec: warn / info). */
export type CheckTone = "warn" | "info";

/**
 * The ATO's three golden rules for a work-related deduction (spec A10 ticket b, #591; owner ruling
 * #537: the inline "why" on every claim card and step intro). Order and wording are fixed here, once.
 */
export type GoldenRuleKey = "spent" | "earning" | "record";
export const GOLDEN_RULES: readonly { key: GoldenRuleKey; label: string; hint: string }[] = [
  { key: "spent", label: "You spent it", hint: "You paid for it yourself and weren't paid back." },
  { key: "earning", label: "It's for earning your income", hint: "It's directly related to the work you're paid for." },
  { key: "record", label: "You have a record", hint: "A receipt, invoice or diary backs it up." },
];

/**
 * What a card knows about each rule. `hasBankLine` (and not `reimbursed`): spent; `workUseConfirmed`:
 * the user confirmed work use; `recordStatus`: the A7 record status. Unknown ⇒ not yet.
 */
export interface GoldenRuleInput {
  hasBankLine?: boolean | null;
  reimbursed?: boolean | null;
  workUseConfirmed?: boolean | null;
  recordStatus?: RecordStatus | null;
}

export interface GoldenRuleState {
  key: GoldenRuleKey;
  label: string;
  hint: string;
  /** true ⇒ ticks green; false ⇒ grey ("not yet"), never red: it's a prompt, not a ruling. */
  met: boolean;
}

/**
 * Pure: the three rule states for one card. A reimbursed spend doesn't meet "you spent it"; a
 * record-keeping exception counts as a record (the ATO's own exception), a missing record doesn't.
 */
export function goldenRuleStates(input: GoldenRuleInput = {}): GoldenRuleState[] {
  const met: Record<GoldenRuleKey, boolean> = {
    spent: input.hasBankLine === true && input.reimbursed !== true,
    earning: input.workUseConfirmed === true,
    record: input.recordStatus === "recorded" || input.recordStatus === "exception",
  };
  return GOLDEN_RULES.map((r) => ({ ...r, met: met[r.key] }));
}

/** "2 of 3": how many rules a card meets (a count, never money). */
export function goldenRulesMet(states: readonly GoldenRuleState[]): string {
  return `${states.filter((s) => s.met).length} of ${states.length}`;
}

/** Starter questions the Why? drawer offers (one tap asks Ask Quillo). Item questions lead when there's an item. */
export function whyStarterQuestions(step: StepKey, hasItem: boolean): string[] {
  if (hasItem) return ["Why is this item here?", "Which of the three golden rules does it still need?", "What record would back this up?"];
  return [step === "home" ? "What's left to do, and why?" : "Why does this step matter for my return?", "What do the three golden rules mean for me?"];
}

// ── "We noticed…" card copy (#577) — pure so check-units can scan it ──
/** What a card needs from a "We noticed…" signal (flag wages_payer, #577) — counts, dates and a total only. */
export interface NoticedCardSignal {
  kind: string;
  evidence: { n: number; first_date: string | null; last_date: string | null; total_cents: number; label: string; second_payer?: boolean };
}

/**
 * The card copy per signal kind (spec A3 table). Proposes, never asserts: a bank credit says where to look,
 * never what to record. Payroll in particular never becomes income (#554) — Yes marks the employer and asks
 * for the income statement.
 */
export function noticedCopy(s: NoticedCardSignal): { title: string; why: string } {
  const who = s.evidence.label || "this payer";
  switch (s.kind) {
    case "payroll":
      return s.evidence.second_payer
        ? { title: `A second employer? ${who} pays you too.`, why: "Regular deposits from the same payer usually mean a job. Saying yes marks them as an employer. The deposits are your take-home pay, so Quillo never counts them as income: your income statement carries the gross pay and tax withheld." }
        : { title: `Looks like pay from ${who}. Is this your wages?`, why: "Regular deposits from the same payer usually mean a job. Saying yes marks them as your employer. The deposits are your take-home pay, so Quillo never counts them as income: your income statement carries the gross pay and tax withheld." };
    case "platform":
      return { title: `Payouts from ${who}. Do you have an ABN for this?`, why: "Payouts from a gig or sharing platform are usually business income. Saying yes sets up a business activity and records these payouts as business income, counted once each. Whether fees are deducted before the payout is something to check in your records." };
    case "government":
      return { title: `Payments from ${who}. These are usually prefilled in myTax.`, why: "Government payments such as Youth Allowance are usually taxable and prefilled in myTax. Saying yes adds a line to check on your myTax worksheet. Nothing is recorded from the bank deposits." };
    case "interest":
      return { title: `Interest from ${who}. Usually prefilled.`, why: "Bank interest is usually prefilled in myTax. Saying yes adds a line to check on your myTax worksheet. Nothing is recorded from the bank deposits." };
    case "foreign":
      return { title: "Money from overseas. Is any of it income?", why: "A transfer from overseas isn't income by itself: it could be savings, a gift or pay. Saying yes notes that you have foreign income to enter. Nothing is recorded from the transfers." };
    default:
      return { title: `We noticed payments from ${who}.`, why: "Quillo spotted a pattern in your bank deposits. Nothing is recorded until you confirm." };
  }
}
