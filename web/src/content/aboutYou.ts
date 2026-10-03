// About you copy (first-timer spec A2, #585; flag ft_journey). Questions in myTax Personalise order
// (owner ruling #536: about six questions; the rest is derived or asked in context).
//
// TONE + COMPLIANCE: general information, never advice. Questions ask about facts; they never say what
// the answer means for the reader's return, never quote a figure or rate, and judgement calls defer with
// "confirm with a registered tax agent". Scanned by the tax-advice denylist in scripts/check-units.ts.
// The stored VALUES are the rule pack's situation_facts tokens (the server validates them); these are
// only the words shown for them.

import { DEFER_TO_AGENT } from "./stepGuides";
import type { AbnKind, ResidencyChoice, TickKey, VisaChoice } from "../lib/aboutYou";

export const ABOUT_Q = {
  residency: {
    title: "Were you an Australian resident for tax for the whole year?",
    help: "Residency for tax isn't the same as your visa. The ATO's residency tests decide it. " + DEFER_TO_AGENT,
  },
  spouse: {
    title: "Did you have a spouse during the year?",
    help: "A spouse includes a de facto partner. myTax asks this because some parts of the return look at family details.",
  },
  state: {
    title: "Which state or territory do you live in?",
    help: "Used for local information only; your return is federal.",
  },
  occupation: {
    title: "What's your main job?",
    help: "Your occupation tailors the ATO guide Quillo points you to. Pick the closest match or type your own.",
  },
  ticks: {
    title: "Tick what applies to your year",
    help: "Tick everything that fits. You can change these later.",
  },
  confirm: {
    title: "Check your answers",
    help: "Quillo only fills gaps with these answers. Anything you've already told it stays as it is.",
  },
} as const;

export const RESIDENCY_CHOICES: readonly { key: ResidencyChoice; label: string }[] = [
  { key: "all_year", label: "Yes, all year" },
  { key: "part_year", label: "Part of the year" },
  { key: "not_resident", label: "No, not a resident" },
  { key: "unsure", label: "I'm not sure" },
];

export const VISA_CHOICES: readonly { key: VisaChoice; label: string }[] = [
  { key: "whm", label: "Working holiday visa" },
  { key: "student", label: "Student visa" },
  { key: "other", label: "Another visa" },
];

export const TICK_CHOICES: readonly { key: TickKey; label: string }[] = [
  { key: "job", label: "A job" },
  { key: "study", label: "Study" },
  { key: "abn", label: "Side income or an ABN" },
  { key: "wfh", label: "Worked from home" },
  { key: "car", label: "Used my own car for work" },
  { key: "foreign", label: "Money from overseas" },
];

export const STUDY_LOAN_LABEL = "I have a HELP or other study loan";

export const ABN_KIND_CHOICES: readonly { key: AbnKind; label: string }[] = [
  { key: "rideshare", label: "Rideshare" },
  { key: "delivery", label: "Delivery" },
  { key: "freelance", label: "Freelance" },
  { key: "other", label: "Something else" },
];

/** Words for each fact (profile cards) and its stored values. */
export const FACT_LABEL: Record<string, string> = {
  residency: "Residency for tax",
  spouse: "Spouse",
  state: "State or territory",
  employment: "Jobs",
  study: "Study",
  study_loan: "Study loan",
  abn_activity: "Side income or ABN",
  wfh: "Worked from home",
  car_for_work: "Own car for work",
  foreign_income: "Money from overseas",
  private_hospital_cover: "Private hospital cover",
};

export const VALUE_LABEL: Record<string, Record<string, string>> = {
  residency: { resident: "Resident", foreign: "Not a resident", temporary: "Temporary resident (student visa)", whm: "Working holiday maker", unsure: "Not sure" },
  spouse: { yes: "Yes", no: "No" },
  study: { yes: "Yes" },
  study_loan: { yes: "Yes, I have one" },
  abn_activity: { rideshare: "Rideshare", delivery: "Delivery", freelance: "Freelance", other: "Something else" },
  wfh: { yes: "Yes" },
  car_for_work: { yes: "Yes" },
  foreign_income: { yes: "Yes" },
  private_hospital_cover: { yes: "Yes", no: "No" },
};

/** Profile-mode card order: myTax order first, then the facts asked in context. */
export const PROFILE_FACTS = [
  "residency",
  "spouse",
  "state",
  "employment",
  "study",
  "study_loan",
  "abn_activity",
  "wfh",
  "car_for_work",
  "foreign_income",
  "private_hospital_cover",
] as const;

export const CONSENT_COPY = {
  title: "Before we start: how your data is processed",
  body:
    "Quillo uses AI to read and sort your records. Today that runs on servers in the USA (Anthropic), which is a cross-border disclosure under Australian Privacy Principle 8. You can withdraw any time in Settings, or switch to Australian processing.",
  done: "Consent recorded. You're good to go.",
  bedrock: "You're on Australian processing, so no overseas consent is needed.",
};

export const CARRY_INS_COPY = {
  title: "From last year's return",
  intro: "Carried-forward capital losses and opening depreciation values from last year. They're kept for your registered tax agent; Quillo never applies them to your position by itself.",
};

export const PEOPLE_COPY = {
  title: "People in this return",
  intro: "You, and a spouse or dependant only if their tax affairs sit alongside yours.",
};
