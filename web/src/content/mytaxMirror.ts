// The myTax mirror's screen copy (#790, flag mytax_mirror). One entry per myTax screen, in myTax's own order:
// the contact and bank steps, Personalise return, then Prepare return (Income banners → Deductions →
// Adjustments → Medicare and private health insurance → Other: spouse details and income tests).
//
// Titles are myTax's banner / screen names as recorded in docs/first-timer/ato-lodgement-process.md §3
// (ATO 2026 myTax instructions) and the rule pack's mytax_income_items names. The ones not confirmed against a
// live myTax session are marked `unverified` and listed in the PR (#790) for the owner to check while lodging.
//
// GENERAL INFORMATION ONLY. Copy here is scanned by the tax-advice denylist (scripts/check-units.ts): no
// figures, no outcome promises, nothing about what the ATO will pay or charge. Jurisdiction content: a second
// jurisdiction gets its own file beside this one.

import type { AnyGlossaryKey } from "./glossary";

/** How the screen gets its figures: myTax fills them in (check), the person types them (type), or it asks questions (answer). */
export type MirrorScreenMode = "prefilled" | "type_in" | "answer";

export interface MirrorScreenCopy {
  /** myTax's own name for the screen or banner. */
  title: string;
  /** Where it sits in myTax, so the person can find it ("Prepare return › Income"). */
  where: string;
  mode: MirrorScreenMode;
  /** The "check this matches what myTax pre-filled" line. */
  check: string;
  /** What to do if myTax shows something different. */
  ifDiffers: string;
  /** Explain tip on the screen title, where a glossary entry exists. */
  term?: AnyGlossaryKey;
  /** True when the title wasn't confirmed against a live myTax screen (owner checks it while lodging). */
  unverified?: boolean;
}

const INCOME = "Prepare return › Income";
const DEDUCTIONS = "Prepare return › Deductions";

const TYPE_IN_CHECK = "myTax doesn't usually prefill this. If it already shows a figure (for example, carried from last year), compare it with Quillo's before you type over it.";
const TYPE_IN_DIFFERS = "If myTax's figure differs from Quillo's, open See records to check which one matches your records. Keep the one your records support, and if you're unsure, confirm with a registered tax agent.";
const PAYER_DIFFERS = "check the statement says \"Tax ready\" in myGov. If it still differs, contact the payer so they correct it with the ATO. Changing a prefilled figure yourself can lead to an ATO query.";

/** Fixed screens. Deduction screens beyond the work-related banner are built per label (see deductionScreenCopy). */
export const MIRROR_SCREENS = {
  contact: {
    title: "Contact details",
    where: "Before Personalise return",
    mode: "prefilled",
    check: "myTax shows the contact details the ATO holds. Check your address, phone and email are current.",
    ifDiffers: "If something is out of date, update it on this screen in myTax before you continue.",
    unverified: true,
  },
  bank: {
    title: "Financial institution details",
    where: "Before Personalise return",
    mode: "prefilled",
    check: "Check the account myTax shows is yours and still open. It's where the ATO pays any money owed to you.",
    ifDiffers: "If the account is closed or isn't yours, change it here in myTax. Quillo never asks for your bank details.",
  },
  personalise: {
    title: "Personalise return",
    where: "Personalise return",
    mode: "answer",
    check: "myTax may already have ticked some items from prefilled information, and you can't untick those. That's normal.",
    ifDiffers: "If myTax ticked something Quillo doesn't list, leave it ticked and check that section's figures when you reach it. If Quillo lists a tick myTax hasn't made, tick it yourself.",
    term: "tax_residency",
  },
  salary: {
    title: "Salary, wages, allowances, tips, bonuses etc.",
    where: INCOME,
    mode: "prefilled",
    check: "myTax prefills this from each employer's income statement. Compare each gross amount with Quillo's.",
    ifDiffers: `If a gross amount differs, ${PAYER_DIFFERS}`,
    term: "income_statement",
  },
  government: {
    title: "Australian Government allowances and payments",
    where: INCOME,
    mode: "prefilled",
    check: "myTax usually prefills payments from Services Australia. Compare the amount with Quillo's.",
    ifDiffers: "If it differs, check your payment summary in myGov (Centrelink). If it still differs, contact Services Australia so they correct it with the ATO.",
    term: "prefill",
  },
  interest: {
    title: "Interest",
    where: INCOME,
    mode: "prefilled",
    check: "myTax usually prefills interest from your banks. Compare the total with Quillo's.",
    ifDiffers: "If it differs, compare it with each bank's interest summary for the year. An account missing from myTax can be added on this screen.",
    term: "prefill",
  },
  dividends: {
    title: "Dividends",
    where: INCOME,
    mode: "prefilled",
    check: "myTax usually prefills dividends and franking credits from share registries. Compare them with Quillo's.",
    ifDiffers: "If they differ, compare them with your dividend statements. A missing statement can be added on this screen.",
    term: "franking_credit",
  },
  rent: {
    title: "Rent",
    where: INCOME,
    mode: "type_in",
    check: `${TYPE_IN_CHECK} myTax asks for each property separately.`,
    ifDiffers: TYPE_IN_DIFFERS,
    term: "negative_gearing",
  },
  managed_funds: {
    title: "Managed fund distributions",
    where: INCOME,
    mode: "prefilled",
    check: "myTax usually prefills distributions from your fund's annual tax statement. Compare the amount with Quillo's.",
    ifDiffers: "If it differs, compare it with the fund's annual tax statement. If you're unsure, confirm with a registered tax agent.",
    term: "prefill",
    unverified: true,
  },
  business: {
    title: "Sole trader and business",
    where: INCOME,
    mode: "type_in",
    check: `${TYPE_IN_CHECK} myTax asks for business income and expenses in the business and professional items schedule.`,
    ifDiffers: TYPE_IN_DIFFERS,
    term: "sole_trader",
    unverified: true,
  },
  foreign: {
    title: "Foreign income",
    where: INCOME,
    mode: "type_in",
    check: TYPE_IN_CHECK,
    ifDiffers: TYPE_IN_DIFFERS,
    term: "tax_residency",
  },
  other_income: {
    title: "Other income",
    where: INCOME,
    mode: "type_in",
    check: TYPE_IN_CHECK,
    ifDiffers: TYPE_IN_DIFFERS,
  },
  work_expenses: {
    title: "Work-related expenses",
    where: DEDUCTIONS,
    mode: "type_in",
    check: "myTax shows these headings when you tick salary on Personalise return. It doesn't prefill your expenses, but a myDeductions upload from the ATO app can fill some in.",
    ifDiffers: "If myTax already shows an amount (from myDeductions), don't add Quillo's on top: check it covers the same expenses, so nothing is counted twice. If you're unsure, confirm with a registered tax agent.",
    term: "deduction",
  },
  adjustments: {
    title: "Adjustments",
    where: "Prepare return › Adjustments",
    mode: "answer",
    check: "myTax shows these when your situation needs them. Answer from what you told Quillo.",
    ifDiffers: "If myTax asks something Quillo doesn't list, answer it from your own records. If you're unsure, confirm with a registered tax agent.",
  },
  medicare: {
    title: "Medicare and private health insurance",
    where: "Prepare return › Medicare and private health insurance",
    mode: "answer",
    check: "myTax always shows this section, and usually prefills your private health insurance policy details.",
    ifDiffers: "If a policy line is missing or wrong, check your insurer's statement and contact the insurer to correct it. Quillo doesn't work out any levy.",
    term: "mls",
  },
  spouse_tests: {
    title: "Spouse details and income tests",
    where: "Prepare return › Other",
    mode: "answer",
    check: "The last part of Prepare return. Some income-test answers are prefilled from your income statement.",
    ifDiffers: "If a prefilled answer looks wrong, check the income statement it came from. Answer the rest from your own records.",
  },
} as const satisfies Record<string, MirrorScreenCopy>;

export type FixedMirrorScreenKey = keyof typeof MIRROR_SCREENS;

/** A deduction screen beyond the work-related banner (D6 onward): titled by myTax's own label name. */
export function deductionScreenCopy(label: string, name: string): MirrorScreenCopy {
  return {
    title: name,
    where: DEDUCTIONS,
    mode: "type_in",
    check: label === "D9" || label === "D10" || label === "D7" || label === "D8"
      ? "myTax always shows this heading. It doesn't prefill your expenses, but a myDeductions upload from the ATO app can fill some in."
      : "Tick this heading on Personalise return if myTax doesn't show it. It doesn't prefill your expenses.",
    ifDiffers: "If myTax already shows an amount (from myDeductions), don't add Quillo's on top: check it covers the same expenses, so nothing is counted twice.",
    term: "deduction",
  };
}

/** Explain tips on individual lines (by line key), where a glossary entry exists. */
export const MIRROR_LINE_TERM: Partial<Record<string, AnyGlossaryKey>> = {
  residency: "tax_residency",
  private_hospital_cover: "mls",
  whm_net_income: "working_holiday_maker",
  study_loan: "help_debt",
  decline_in_value: "depreciation",
  occupation: "income_statement",
};

/** The card's tick when a screen has no figure to tick line by line. */
export const SCREEN_TICK_LABEL = "Done this screen in myTax";
