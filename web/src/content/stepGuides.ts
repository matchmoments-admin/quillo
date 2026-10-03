// Per-step guide copy for the first-timer journey (spec docs/first-timer/spec.md A10, #584).
// Used as the step intro and as the static "Why?" explainer when Ask Quillo is off (the drawer
// wiring is ticket (b); the shell that mounts the steps is A11). Flag ft_journey.
//
// TONE + COMPLIANCE: general information, never advice. Explain what the step is for and why the
// ATO cares; never say what the user will get, never compare them with anyone else, never quote a
// money figure or rate, and never decide for them whether they must lodge. Judgement calls defer
// with "confirm with a registered tax agent". Scanned by the denylist in scripts/check-units.ts.

import { ATO_LINKS, type ExtLink } from "./beforeYouStart";
import type { AnyGlossaryKey } from "./glossary";

// FOUR steps since the design review of 2026-10-04 (spec §0, #585).
export type StepKey = "home" | "setup" | "connect" | "review" | "lodge";

export interface StepGuide {
  /** Step number in the journey (Home is 0). */
  n: number;
  title: string;
  /** One or two sentences: what this step is for. */
  intro: string;
  /** The "Why?" explainer: short points on why the step matters. */
  why: readonly string[];
  /** ATO pages for reading further. */
  links: readonly ExtLink[];
  /** Glossary terms worth knowing on this step (rendered as <Term>). */
  terms: readonly AnyGlossaryKey[];
}

/** The standard deferral line for judgement calls. */
export const DEFER_TO_AGENT = "If you're unsure, confirm with a registered tax agent.";

export const STEP_GUIDES: Record<StepKey, StepGuide> = {
  home: {
    n: 0,
    title: "Home",
    intro: "Home shows what's left to do for the year you're lodging, one step at a time.",
    why: [
      "Each step builds on the one before, in the same order myTax asks its questions.",
      "Nothing here is final until you lodge in myTax yourself.",
    ],
    links: [ATO_LINKS.firstReturn],
    terms: ["mytax", "golden_rules"],
  },
  setup: {
    n: 1,
    title: "Get set up",
    intro: "Check you can get into myTax, then answer a few questions about your year: where you lived for tax, how you earned money, and what changed.",
    why: [
      "You lodge in myTax, through myGov. Checking you can sign in early leaves time to sort out the ATO link before you need it.",
      "Your tax residency and your kind of work shape which parts of the return apply to you.",
      "Quillo only fills gaps with your answers; it never overwrites something you've already told it.",
      "Facts can change during the year, like starting a job or moving to Australia, so each answer can carry dates.",
      DEFER_TO_AGENT,
    ],
    links: [ATO_LINKS.mygov, ATO_LINKS.residency, ATO_LINKS.tfn],
    terms: ["mytax", "tax_residency", "temporary_resident", "working_holiday_maker", "help_debt", "abn"],
  },
  connect: {
    n: 2,
    title: "Connect",
    intro: "Connect a bank or upload a statement, and add your income statement when your employer marks it tax ready.",
    why: [
      "Your bank lines show where to look; they don't decide what counts.",
      "Your income statement is the ATO's record of what you were paid and the tax withheld, so it's the one to use for wages.",
      "If you lodge in myTax, the ATO pre-fills some details for you. Quillo helps you check they match.",
    ],
    links: [ATO_LINKS.firstReturn, ATO_LINKS.mygov],
    terms: ["income_statement", "prefill"],
  },
  review: {
    n: 3,
    title: "Review",
    intro: "One list to work through: spending that may relate to your work, records to match, and anything missing, doubled up or unmatched.",
    why: [
      "The ATO's three golden rules: you spent the money yourself, it's for earning your income, and you have a record.",
      "An item marked 'worth a look' is a prompt to check, not a claim. You confirm every item.",
      "A record is one of the golden rules: without one, the ATO can disallow the item. Some small claims have a record-keeping exception, but you still need to show how you worked the amount out.",
      "Catching a missed income source or a duplicate now is easier than fixing it after you lodge.",
      DEFER_TO_AGENT,
    ],
    links: [ATO_LINKS.claimingDeductions, ATO_LINKS.records],
    terms: ["golden_rules", "deduction", "record_keeping_exception", "prefill"],
  },
  lodge: {
    n: 4,
    title: "Lodge in myTax",
    intro: "A worksheet in myTax order with what you've confirmed, ready for you to copy into myTax and lodge.",
    why: [
      "Quillo can't lodge an individual return: only you, in myTax, or a registered tax agent can.",
      "Check the ATO's pre-filled figures match your worksheet before you lodge.",
      "After you lodge, the ATO sends a notice of assessment. Add it here to close the year.",
    ],
    links: [ATO_LINKS.mytax, ATO_LINKS.taxAgent],
    terms: ["mytax", "notice_of_assessment", "registered_tax_agent"],
  },
};

export const STEP_ORDER: readonly StepKey[] = ["home", "setup", "connect", "review", "lodge"];
