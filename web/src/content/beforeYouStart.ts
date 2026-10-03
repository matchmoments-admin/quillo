// Copy for the public, no-account "Before you start" screen (/start, flag ft_journey; spec
// docs/first-timer/spec.md A10, #584). One content map so the screen reads in one voice.
//
// COMPLIANCE (owner rulings, 2026-10-03):
//   • Whether someone has to lodge is the ATO's call, made with the ATO's own tool. This screen
//     points to that tool and NEVER states a verdict of its own.
//   • No outcome estimates, no money figures, no comparisons with other people.
//   • General information only.
// Every string here is scanned by the tax-advice denylist in scripts/check-units.ts.
//
// ATO links verified live 2026-10-03.

export interface ExtLink {
  label: string;
  url: string;
}

export const ATO_LINKS = {
  lodgeTool: { label: "Do I need to lodge? (ATO tool)", url: "https://www.ato.gov.au/calculators-and-tools/tax-return-do-i-need-to-lodge" },
  nonLodgment: {
    label: "Lodge a non-lodgment advice (ATO)",
    url: "https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return/lodge-a-non-lodgment-advice",
  },
  firstReturn: {
    label: "Lodge your first tax return (ATO)",
    url: "https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return/lodging-your-first-tax-return",
  },
  tfn: { label: "Apply for a tax file number (ATO)", url: "https://www.ato.gov.au/individuals-and-families/tax-file-number/apply-for-a-tfn" },
  mygov: {
    label: "Create a myGov account and link it to the ATO",
    url: "https://www.ato.gov.au/online-services/online-services-for-individuals-and-sole-traders/ato-online-services-and-mygov/create-a-mygov-account-and-link-it-to-the-ato",
  },
  residency: { label: "Your tax residency (ATO)", url: "https://www.ato.gov.au/individuals-and-families/coming-to-australia-or-going-overseas/your-tax-residency" },
  mytax: {
    label: "Lodge online with myTax (ATO)",
    url: "https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return/lodge-your-tax-return-online-with-mytax",
  },
  records: { label: "Records you need to keep (ATO)", url: "https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/records-you-need-to-keep" },
  claimingDeductions: {
    label: "Claiming deductions (ATO)",
    url: "https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/deductions-you-can-claim/claiming-deductions",
  },
  taxAgent: {
    label: "Lodge with a registered tax agent (ATO)",
    url: "https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return/lodge-your-tax-return-with-a-registered-tax-agent",
  },
} as const satisfies Record<string, ExtLink>;

export const BEFORE_YOU_START = {
  title: "Before you start",
  lede: "Is Quillo right for you? A quick look at who it suits, what it does and what it doesn't, before you make an account.",

  fitHeading: "Who Quillo suits",
  fits: [
    "Your first job, paid through payroll",
    "Students and part-timers",
    "A side hustle with an ABN, like delivery or freelance work",
    "Newcomers to Australia, including working holiday makers and international students",
  ],

  doesHeading: "What it does",
  does: [
    "Reads your bank lines and documents, and finds the ones that may matter at tax time",
    "Explains why, in plain language, with links to the ATO's own guidance",
    "Keeps your receipts and records together in one place",
    "Prepares a worksheet in myTax order, so you can lodge it yourself in myTax",
  ],

  doesntHeading: "What it doesn't do",
  doesnt: [
    "It isn't a registered tax agent, and it gives general information only, not tax advice",
    "It never estimates or predicts your tax outcome",
    "It doesn't lodge for you: you lodge your own return in myTax",
    "It doesn't decide what you can claim: you confirm every item, and a registered tax agent has the final say",
  ],

  lodgeHeading: "Who has to lodge?",
  // The two lines the owner ruling requires, verbatim from the spec.
  lodgeLine: "Not everyone has to lodge. Check with the ATO's 'Do I need to lodge?' tool.",
  lodgeEvenIf: "Even if you don't have to, lodging can get back tax your employer withheld.",
  // ATO fact (Lodge your first tax return, checked 2026-10-03): a non-lodgment advice is still expected.
  lodgeNonLodgment: "If the ATO's tool says a return isn't needed, the ATO asks for a non-lodgment advice instead.",

  linksHeading: "Useful ATO links",

  ctaPrimary: "Sign up",
  ctaSecondary: "Already have an account? Sign in",

  footnote:
    "General information only, not tax advice. Quillo is not a registered tax agent. Check anything you'll act on with the ATO or a registered tax agent.",
} as const;

/** Links shown in the "Useful ATO links" list, in order. */
export const BEFORE_YOU_START_LINKS: readonly ExtLink[] = [
  ATO_LINKS.tfn,
  ATO_LINKS.mygov,
  ATO_LINKS.residency,
  ATO_LINKS.firstReturn,
];
