// Single source of truth for the educational "What's this?" copy. Both the in-app tooltips
// (InfoTip / Term in components/ui.tsx) and the /glossary page read from here, so a term's
// explanation never drifts between two screens.
//
// TONE + COMPLIANCE: every entry is GENERAL INFORMATION, not tax advice. Anything that touches
// deductibility ends with the soft defer-to-review/agent line (DEFER below) and never asserts a
// definitive "you can claim $X" outcome — mirroring the disclaimers in App/TxnDetail/Reports.

/** Reusable softener appended to deductibility-adjacent tips. */
export const DEFER = "Whether it's actually claimable is confirmed in your year-end review — and a registered tax agent has the final say.";

export interface GlossaryEntry {
  /** Canonical display term (used as the /glossary heading + the Term default text). */
  term: string;
  /** Short tooltip body — keep to ~2–4 short sentences. Shown as "What it is" in the Explain card. */
  short: string;
  /** Optional "Why it matters for your tax": what this changes in the user's return or records.
   *  General information only (scanned by the tax-advice denylist). Absent ⇒ the card shows `short` alone. */
  why?: string;
  /** Optional official page to read more. Only https ato.gov.au / tpb.gov.au links (a unit test checks). */
  ato?: { label: string; url: string };
  /** Optional related glossary keys, shown as chips to hop between terms (each must resolve). */
  related?: readonly string[];
}

// Official pages reused by the Explain cards (same URLs the Before you start page and rule pack use).
const ATO = {
  mytax: { label: "Lodge online with myTax (ATO)", url: "https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return/lodge-your-tax-return-online-with-mytax" },
  agent: { label: "Lodge with a registered tax agent (ATO)", url: "https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return/lodge-your-tax-return-with-a-registered-tax-agent" },
  deductions: { label: "Claiming deductions (ATO)", url: "https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/deductions-you-can-claim/claiming-deductions" },
  records: { label: "Records you need to keep (ATO)", url: "https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/records-you-need-to-keep" },
  residency: { label: "Your tax residency (ATO)", url: "https://www.ato.gov.au/individuals-and-families/coming-to-australia-or-going-overseas/your-tax-residency" },
  whm: { label: "Working holiday makers (ATO)", url: "https://www.ato.gov.au/individuals-and-families/coming-to-australia-or-going-overseas/coming-to-australia/working-holiday-makers" },
  foreign: { label: "Foreign and temporary resident income (ATO)", url: "https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/income-you-must-declare/foreign-and-worldwide-income/foreign-and-temporary-resident-income" },
  mygov: { label: "Link myGov to the ATO", url: "https://www.ato.gov.au/online-services/online-services-for-individuals-and-sole-traders/ato-online-services-and-mygov/create-a-mygov-account-and-link-it-to-the-ato" },
  amend: { label: "Amend your tax return (ATO)", url: "https://www.ato.gov.au/individuals-and-families/your-tax-return/amend-your-tax-return/how-to-request-an-amendment-to-your-tax-return" },
  incomeStatement: { label: "Access your income statement (ATO)", url: "https://www.ato.gov.au/individuals-and-families/jobs-and-employment-types/working-as-an-employee/income-statements/access-your-income-statement" },
  wfhFixedRate: { label: "Working from home: fixed rate method (ATO)", url: "https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/deductions-you-can-claim/work-related-deductions/working-from-home-expenses/fixed-rate-method" },
  mls: { label: "Medicare levy surcharge (ATO)", url: "https://www.ato.gov.au/individuals-and-families/medicare-and-private-health-insurance/medicare-levy-surcharge/medicare-levy-surcharge-income-thresholds-and-rates" },
  studyLoans: { label: "Study and training loan repayments (ATO)", url: "https://www.ato.gov.au/tax-rates-and-codes/study-and-training-support-loans-rates-and-repayment-thresholds" },
  businessItems: { label: "Business and professional items in myTax (ATO)", url: "https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/income/sole-trader-and-business-income-or-losses-and-partnership-distributions/business-and-professional-items" },
} as const;

export const GLOSSARY = {
  // ── Buckets (mirror BUCKET_LABEL keys in components/ui.tsx) ───────────────────────────────
  payg: {
    term: "PAYG",
    short: `Spending in your personal/individual context — you're an employee taxed under PAYG (Pay As You Go) withholding. ${DEFER}`,
    why: "Your employer already withholds tax from your pay, so your return mainly adds up your income and any deductions, then compares that with the tax already withheld.",
    ato: ATO.mytax,
    related: ["income_statement", "deduction"],
  },
  company: {
    term: "Company",
    short:
      "An expense belonging to your Pty Ltd's own books, kept separate from your personal tax. Keeping the two apart is what stops company and personal claims getting mixed up.",
  },
  property_rented: {
    term: "Property · rented",
    short: `A cost on an investment property that's rented or genuinely available for rent — the context where many property costs are commonly deductible. ${DEFER}`,
  },
  property_vacant: {
    term: "Property · vacant",
    short: `A holding cost on a property not currently available for rent. These are often not deductible, so it's flagged for a closer look. ${DEFER}`,
  },
  income_business: {
    term: "Income · business",
    short: "Money coming in to your business (a credit), tracked separately from spending so your income side is complete at tax time.",
  },
  income_property: {
    term: "Income · rent",
    short: "Rent received on an investment property. Recorded per property so each one's position is clear at year-end.",
  },
  income_personal: {
    term: "Income · personal",
    short: "Personal money in — e.g. a refund, reimbursement or interest. Captured so it isn't mistaken for spending.",
  },
  refund: {
    term: "Refund",
    short: "Money coming back to you (a return or reversal), not a fresh expense. Netted against spending so totals aren't overstated.",
  },
  asset: {
    term: "Asset · capital",
    short: `A capital purchase (something lasting, not consumed now) that's linked to a depreciating asset rather than claimed in full this year. ${DEFER}`,
  },
  unknown: {
    term: "Unknown",
    short: "We couldn't confidently place this one, so it isn't counted in any total until you categorise it. Clearing these keeps your numbers accurate.",
  },

  // ── Core tax concepts (the "learn tax" foundations) ───────────────────────────────────────
  deduction: {
    term: "Deduction",
    short: `A deduction is a work- or income-related cost you subtract from your income, so you're taxed on less (and often get more back). To claim one you generally must have paid it yourself, it must relate to earning your income, and you need a record (receipt/invoice). ${DEFER}`,
    why: "Deductions lower the income you are taxed on, so keeping the receipt and noting what each cost was for is what lets a claim stand up if the ATO asks.",
    ato: ATO.deductions,
    related: ["golden_rules", "record_keeping_exception", "depreciation"],
  },
  depreciation: {
    term: "Depreciation (decline in value)",
    short: `Instead of claiming a lasting item (a laptop, tools, rental fixtures) all in one year, you spread its cost over its effective life — a portion is deductible each year until it's written down. Items under the instant-write-off threshold can be claimed in full. ${DEFER}`,
    why: "A lasting item is spread over several returns rather than one, so Quillo keeps it on your asset list and carries the remaining value into next year.",
    ato: ATO.deductions,
    related: ["deduction", "asset"],
  },
  capital_gains: {
    term: "Capital gains tax (CGT)",
    short: `When you sell an asset — shares, crypto, an investment property — the profit (proceeds minus cost base) is added to your income. Hold it more than 12 months and generally only HALF the gain is taxed (the 50% CGT discount); capital losses offset capital gains and any excess carries forward. ${DEFER}`,
    why: "A sale can add to your income for the year, and the purchase records (cost base) decide how much. Keeping the buy and sell records together is what makes it straightforward.",
    related: ["franking_credit", "asset"],
  },
  franking_credit: {
    term: "Franking credit",
    short: `A franking (imputation) credit is company tax already paid on a franked dividend. You declare the dividend PLUS the credit as income, then the credit reduces your tax — so the profit isn't taxed twice, and it can even add to a refund. ${DEFER}`,
    why: "Both the dividend and its franking credit go on your return, so the dividend statement from the company or share registry is the record to keep.",
    related: ["capital_gains"],
  },
  home_office: {
    term: "Working-from-home costs",
    short: `As an employee, the rent or mortgage on your own home isn't deductible — but the extra RUNNING costs of working from home (electricity, internet, phone, some equipment) generally are, via the fixed-rate (per hour) or actual-cost method. You need a record of your actual hours. ${DEFER}`,
    why: "Working-from-home costs are claimed with a method that needs a record of your hours, so a diary or timesheet kept through the year matters more than any single receipt.",
    ato: ATO.deductions,
    related: ["deduction", "golden_rules"],
  },

  // ── Categorisation mechanics ──────────────────────────────────────────────────────────────
  confidence: {
    term: "Confidence",
    short:
      "How sure the AI was about this categorisation. 'review' or 'low' means a human should check it — the AI never finalises anything on its own.",
    why: "The category decides which part of your records a line counts toward, so the low-confidence lines are the ones worth checking first.",
    related: ["bucket", "reasoning"],
  },
  bucket: {
    term: "Bucket",
    short: `The tax context a transaction belongs to (PAYG, company, a property…). It groups your spending by where it broadly sits — it doesn't decide deductibility on its own. ${DEFER}`,
    why: "It decides which return or schedule a line counts toward (your own, a company's, or a property's), so a line in the wrong one shows up in the wrong total.",
    related: ["ato_label", "confidence"],
  },
  ato_label: {
    term: "ATO label",
    short: `A finer category within the bucket (e.g. company:office-supplies) — roughly where this would sit on a tax return. It's an organising label, not a claim. ${DEFER}`,
    why: "Labels group your costs the way the return asks for them, which makes each figure quicker to find when you enter it in myTax or hand it to a registered tax agent.",
    related: ["bucket", "mytax"],
  },
  reasoning: {
    term: "Why this bucket?",
    short: `The AI's one-line reasoning, shown so you can learn how it decided. It's general information — confirm anything you're unsure about. ${DEFER}`,
  },

  // ── Money / GST ─────────────────────────────────────────────────────────────────────────
  gst: {
    term: "GST",
    short:
      "Goods and Services Tax — the 10% included in most Australian prices (the GST portion is 1/11th of a GST-inclusive amount). Overseas purchases carry no Australian GST.",
    why: "If your business is registered for GST, the GST in your prices and purchases is reported on your BAS, separately from your income tax return.",
    related: ["abn", "bas", "itc", "gst_registered"],
  },
  itc: {
    term: "GST credits (ITC)",
    short: `Input Tax Credits — the GST a GST-registered business paid on purchases and can generally claim back on its BAS. Only relevant if you're GST-registered. ${DEFER}`,
  },
  abn: {
    term: "ABN",
    short: "Australian Business Number — your business's public identifier. It appears on the report header so your accountant knows which entity it's for.",
    why: "Income earned under an ABN is business income: you keep your own records of it and of the costs of earning it, because no employer reports it for you.",
    related: ["gst", "bas", "income_business"],
  },
  bas: {
    term: "BAS",
    short: "Business Activity Statement — how a business reports GST (and some other taxes) to the ATO, usually each quarter (Jul–Sep, Oct–Dec, Jan–Mar, Apr–Jun).",
  },
  non_aud: {
    term: "Foreign currency",
    short:
      "Shown in the original currency with an estimated AUD value from a daily exchange rate. Your bank's reconciled figure is the authoritative amount.",
  },

  // ── Privacy / setup ─────────────────────────────────────────────────────────────────────
  app8: {
    term: "APP 8 (cross-border)",
    short:
      "Australian Privacy Principle 8 covers sending personal data overseas. The AI runs in the US, so we ask your consent first — or you can switch to Australian-based processing instead.",
  },
  persons: {
    term: "People (taxpayers)",
    short:
      "The taxpayers in your situation — you, and a spouse if relevant. Your occupation tailors the deduction hints Quillo suggests; your tax residency affects which rules apply.",
  },
  entities: {
    term: "Entities",
    short:
      "The separate tax 'hats' you wear — employee (PAYG), company owner, and so on. Each is taxed differently, so we keep them apart from the start.",
  },
  novated_lease: {
    term: "Novated lease",
    short:
      "A car salary-packaged through your employer. Its costs are part of that arrangement — not company expenses — so they're treated separately.",
    why: "A novated lease can change what appears on your income statement (a reportable fringe benefit amount) and how your car costs are treated, so the lease statements are worth keeping with your tax records.",
    related: ["paid_via"],
  },
  gst_registered: {
    term: "GST registered",
    short: `Businesses over the GST turnover threshold (or that opt in) charge and claim GST. Ticking this changes how GST credits are handled for your company. ${DEFER}`,
  },
  property_status: {
    term: "Property status",
    short: `A property's status drives how its costs are treated: rented/available is where many are commonly deductible; vacant holding costs often aren't; your own home generally isn't. ${DEFER}`,
  },
  ownership_pct: {
    term: "Ownership %",
    short: "Your share of a property. Income and costs are generally split by ownership share, so we record it up front to keep per-owner totals right.",
  },
  user_rules: {
    term: "Your rules",
    short: "A shortcut you teach Quillo, e.g. 'Ray White → my rental agent'. Matching transactions then categorise automatically and consistently.",
  },
  devices: {
    term: "Device keys",
    short: "Secret keys that let a phone or script send receipts to your account securely. Revoke one any time without affecting the others.",
  },

  // ── Accounts / reconciliation ────────────────────────────────────────────────────────────
  account_type: {
    term: "Account type",
    short: "What kind of account this is (everyday, credit card, loan, investment). It helps us treat the transactions sensibly — e.g. loan interest vs everyday spending.",
  },
  account_source: {
    term: "Account source",
    short:
      "Where this account's data comes from: a connected QuickBooks bank feed, or statements you upload. Each account uses exactly one source, so nothing is counted twice.",
  },
  paid_via: {
    term: "Paid via",
    short:
      "Which card or account paid for this. It helps match receipts to your bank statement and decide whether to reconcile against a feed or push to QuickBooks.",
  },
  reconcile: {
    term: "Reconcile",
    short:
      "Checking the imported transactions add up to the statement's own opening/closing totals — proof the import is complete and accurate, with nothing missed or double-counted.",
    why: "A statement that reconciles shows nothing was missed or counted twice, so the totals your position is built from are complete.",
    related: ["account_source"],
  },

  // ── Year-end / reports ───────────────────────────────────────────────────────────────────
  fy: {
    term: "Financial year",
    short: "The Australian financial year runs 1 July to 30 June. Transactions are placed by date into the year they belong to.",
  },
  deductible_vs_claimable: {
    term: "Captured vs deductible",
    short: `Captured = everything tracked. Deductible = only what's been confirmed in your year-end review. They're deliberately different numbers. ${DEFER}`,
  },
  suggested_candidate: {
    term: "Suggested / candidate",
    short: `A possible deduction based on your situation — not a confirmed or claimable amount. ${DEFER}`,
  },
  ai_cost: {
    term: "AI cost",
    short:
      "What running the AI categorisation actually cost — measured from real token usage, not estimated. Shown for transparency; the 'billable' figure adds our fee but isn't charged yet.",
  },
  psi_status: {
    term: "PSI (Personal Services Income) status",
    short: `Whether the Personal Services Income rules (Division 86) apply to this business activity. If your sole-trader income is mainly a reward for your personal skills or labour — common for contractors, freelancers and many creators — the PSI rules can limit which expenses stay deductible (e.g. home occupancy costs and payments to family). It's a fact-specific judgement we don't decide for you; record the outcome here so we can tailor the guidance. ${DEFER}`,
  },

  // ── Private health extras (FACTUAL engagement; NOT deductibility — no DEFER) ──
  phi_extras: {
    term: "Extras (ancillary cover)",
    short:
      "The part of private health cover that pays toward services outside hospital — dental, optical, physio and similar. Each service usually has its own yearly benefit limit. Tracking it is general information to help you use your own cover; it's not health or financial advice and doesn't change your tax position.",
  },
  phi_cover_type: {
    term: "Cover type",
    short:
      "Whether a policy is hospital cover, extras (ancillary) cover, or combined. Only extras cover has the per-service yearly limits this tracker follows.",
  },
  phi_reset_basis: {
    term: "When limits reset",
    short:
      "The date your yearly extras limits return to zero and start fresh. Most Australian funds reset on the calendar year (1 Jan); some on the financial year (1 Jul); a few on your policy anniversary. After the reset, any unused balance doesn't carry over.",
  },
  phi_annual_limit: {
    term: "Annual limit",
    short:
      "The most a fund will pay toward a service in one reset period (e.g. $500 of physiotherapy). It's the fund's benefit cap, not what you paid.",
  },
  phi_benefit_used: {
    term: "Benefit used",
    short:
      "The amount your fund has already paid you back for a service this period, counted against that service's annual limit. Enter the rebate the fund paid — find it on your fund's app or statement — not the full amount you paid the clinic.",
  },
  phi_unused: {
    term: "Unused cover",
    short:
      "Annual limit minus the benefit used so far — what's still available before the limits reset. General information to help you use your own cover.",
  },
  phi_detected: {
    term: "Detected",
    short:
      "This policy was suggested from a private-health premium spotted in your transactions, rather than added by hand. Check the details and edit anything that's not right.",
  },
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof GLOSSARY;

/** Look up a tooltip body by key; returns undefined for an unknown key (caller renders nothing). */
export function tipFor(key: GlossaryKey): string {
  return GLOSSARY[key].short;
}

// ── First-timer terms (spec docs/first-timer/spec.md A10, #584; flag ft_journey) ─────────────
// Kept in a SEPARATE map so the /glossary page lists them only when ft_journey is ON (flag OFF ⇒
// the page renders exactly the entries above, byte-identical). <Term>/<InfoTip> resolve keys from
// ANY_GLOSSARY, so an existing key's tip is unchanged. Keys must not collide with GLOSSARY (a unit
// test asserts it). Scanned by the tax-advice denylist in scripts/check-units.ts: no money figures,
// no rates, no outcome estimates, no lodge verdicts.
export const FT_GLOSSARY = {
  prefill: {
    term: "Prefill",
    short:
      "When you lodge in myTax, the ATO fills in some details it already holds, like income from your employer and bank interest. Check each pre-filled item matches your own records before you lodge.",
    why: "Pre-filled figures can be incomplete early in the season. Checking each one against your own records before you lodge avoids having to amend your return later.",
    ato: ATO.mytax,
    related: ["income_statement", "mytax"],
  },
  income_statement: {
    term: "Income statement",
    short:
      "Your employer's year-end summary of what they paid you and the tax they withheld, reported to the ATO through payroll. You'll find it in ATO online services through myGov once it's marked tax ready.",
    why: "It is the main record of your wages and the tax already withheld. Waiting until it is marked tax ready means your return starts from final figures.",
    ato: ATO.mygov,
    related: ["prefill", "mytax"],
  },
  notice_of_assessment: {
    term: "Notice of assessment",
    short:
      "The ATO's letter after it processes your return, setting out how it assessed your tax for the year. Keep it: it's the starting point if anything needs correcting later.",
    why: "It confirms what the ATO assessed. If something on it looks wrong, it is the starting point for asking for an amendment.",
    ato: ATO.amend,
    related: ["mytax"],
  },
  tax_residency: {
    term: "Tax residency",
    short:
      "Whether you're an Australian resident for tax purposes. It isn't the same as your visa or citizenship, and it changes which income counts and how it's taxed. The ATO has a tool to help you work it out.",
    why: "Residency decides which of your income Australia taxes and which rates apply, so it is one of the first things to settle before you lodge.",
    ato: ATO.residency,
    related: ["temporary_resident", "working_holiday_maker"],
  },
  temporary_resident: {
    term: "Temporary resident",
    short:
      "Someone on a temporary visa who is generally treated as a temporary resident for tax. Some foreign income may not need to be declared in Australia. If you're unsure, confirm with a registered tax agent.",
    why: "As a temporary resident, some income earned overseas may be left out of your Australian return, which changes what you need to gather.",
    ato: ATO.foreign,
    related: ["tax_residency", "working_holiday_maker"],
  },
  working_holiday_maker: {
    term: "Working holiday maker",
    short:
      "Someone in Australia on a working holiday visa (subclass 417 or 462). The ATO applies its own working holiday maker rates to this income, so you don't work them out yourself.",
    why: "Working holiday income is taxed under its own rules, so your employer needs to know you are on this visa and your return reports that income on that basis.",
    ato: ATO.whm,
    related: ["tax_residency", "temporary_resident"],
  },
  help_debt: {
    term: "HELP debt",
    short:
      "A study loan from the Higher Education Loan Program. Once your income passes the ATO's repayment threshold, a compulsory repayment is worked out through your return.",
    why: "A HELP debt can change the result of your return once your income passes the repayment threshold, so it is worth knowing whether you have one before you lodge.",
    ato: ATO.studyLoans,
    related: ["income_statement", "rfba"],
  },
  golden_rules: {
    term: "The three golden rules",
    short:
      "The ATO's test for a work-related deduction: you spent the money yourself and weren't paid back, it's directly related to earning your income, and you have a record to prove it. Each claim needs all three.",
    why: "Every work-related claim is checked against these three tests. Quillo asks for the receipt or record because without it a claim usually cannot be supported.",
    ato: ATO.deductions,
    related: ["deduction", "record_keeping_exception"],
  },
  mytax: {
    term: "myTax",
    short:
      "The ATO's free online tool for lodging your own return, reached through myGov. Quillo prepares a worksheet in myTax order; you lodge in myTax yourself.",
    why: "It is where your return is actually lodged. Quillo gets your records ready in myTax order; you enter the figures and lodge it yourself.",
    ato: ATO.mytax,
    related: ["prefill", "registered_tax_agent"],
  },
  registered_tax_agent: {
    term: "Registered tax agent",
    short:
      "A professional registered with the Tax Practitioners Board who can give you tax advice and lodge for you. Quillo is not one: it gives general information only.",
    why: "Quillo gives general information only. If your situation is unusual, a registered tax agent can confirm what applies to you and can lodge for you.",
    ato: ATO.agent,
    related: ["mytax"],
  },
  record_keeping_exception: {
    term: "Record-keeping exception",
    short:
      "For a small total of work-related expenses, the ATO doesn't require written receipts, but you still need to show you spent the money and how you worked out the amount. The ATO sets the limit; check its records page.",
    why: "Even under the exception you still need to show how you worked out each amount, so a simple note of what you spent and why still matters.",
    ato: ATO.records,
    related: ["golden_rules", "deduction"],
  },
  taxable_position: {
    term: "Indicative taxable position",
    short:
      "Quillo's running estimate of your taxable income for the year: the income you've recorded, less the deductions you've confirmed so far. It's built only from the records in Quillo and it isn't the ATO's assessment.",
    why: "It shows where your records stand before you lodge. The figure that counts is the one on your notice of assessment, after the ATO processes your return.",
    related: ["deduction", "notice_of_assessment", "deductible_vs_claimable"],
  },
  payg_withholding: {
    term: "Tax withheld (PAYG withholding)",
    short:
      "The tax your employer or another payer took out of your pay and sent to the ATO before the money reached you. It's shown on your income statement next to your gross pay.",
    why: "Your return compares the tax worked out on your income with the tax already withheld, so the withheld figure you enter needs to match your income statement.",
    ato: ATO.incomeStatement,
    related: ["income_statement", "tax_ready", "payg"],
  },
  tax_ready: {
    term: "Tax ready",
    short:
      "The status your employer gives your income statement once they've finalised it for the year. Until it says tax ready, the figures on it can still change.",
    why: "Starting from a tax-ready income statement means the pay and tax withheld you enter are final, which avoids having to amend your return later.",
    ato: ATO.incomeStatement,
    related: ["income_statement", "prefill", "payg_withholding"],
  },
  wfh_fixed_rate: {
    term: "Fixed-rate method (working from home)",
    short:
      "One of the ATO's methods for working-from-home running costs: a set rate for each hour you worked from home, covering things like electricity, internet and phone. The ATO sets the rate for each year, and some costs, such as equipment, are worked out separately.",
    why: "The method relies on a record of the actual hours you worked from home through the year, such as a diary or timesheet. An estimate alone isn't accepted.",
    ato: ATO.wfhFixedRate,
    related: ["home_office", "golden_rules", "record_keeping_exception"],
  },
  cost_base: {
    term: "Cost base",
    short:
      "What an asset cost you for capital gains purposes: generally what you paid for it, plus costs such as brokerage, stamp duty and legal fees on buying and selling it. It's taken away from what you sold it for to work out a gain or loss.",
    why: "The cost base sets the size of the gain or loss when you sell, so the purchase records are worth keeping for as long as you own the asset, and for a while after you sell.",
    related: ["capital_gains", "cgt_discount"],
  },
  cgt_discount: {
    term: "CGT discount",
    short:
      "A reduction in the part of a capital gain that counts as income, generally available to an individual who sold an asset after holding it for at least 12 months. Some people, such as foreign residents, may not be able to use it, or only in part.",
    why: "The dates you bought and sold decide whether the discount can apply, so both dates belong in the records for each sale. If you're unsure, confirm with a registered tax agent.",
    related: ["capital_gains", "cost_base", "tax_residency"],
  },
  effective_life: {
    term: "Effective life",
    short:
      "How many years an asset is expected to be used to earn income. It sets how quickly the asset's cost is spread across your returns as decline in value. The ATO publishes the usual effective life for most kinds of asset.",
    why: "A longer effective life spreads the cost over more years, so the figure chosen for each asset changes how much counts in each year's return.",
    related: ["depreciation", "asset"],
  },
  negative_gearing: {
    term: "Negative gearing",
    short:
      "When an investment property's deductible costs (such as loan interest, repairs and council rates) are more than the rent it earns, the property makes a net rental loss for the year. That loss can generally reduce your other income.",
    why: "A property's net result feeds into your taxable income, so each property's rent and costs need to be recorded against that property. Confirm the treatment with a registered tax agent.",
    related: ["property_rented", "deduction", "taxable_position"],
  },
  rfba: {
    term: "Reportable fringe benefits amount (RFBA)",
    short:
      "The grossed-up value of certain fringe benefits your employer gave you, such as a car through a novated lease, shown on your income statement. It isn't taxed as income, but some income tests count it. Quillo doesn't calculate it.",
    why: "It can change income-tested results such as the Medicare levy surcharge and study-loan repayments, so it's copied from your income statement exactly as shown.",
    related: ["income_statement", "novated_lease", "mls"],
  },
  mls: {
    term: "Medicare levy surcharge",
    short:
      "An extra levy for people whose income for surcharge purposes is above the ATO's threshold and who didn't hold an appropriate level of private hospital cover for all or part of the year. The ATO works it out from your return; Quillo doesn't.",
    why: "Your return asks whether you held private hospital cover and for which days, so the statement from your health insurer is the record to keep.",
    ato: ATO.mls,
    related: ["rfba", "mytax"],
  },
  sole_trader: {
    term: "Sole trader",
    short:
      "Someone who runs a business as an individual, under their own ABN, rather than through a company or trust. The business's income and costs go in your own return.",
    why: "No employer reports this income for you, so your own records of what the business earned and spent are what your return relies on.",
    ato: ATO.businessItems,
    related: ["abn", "gst", "income_business"],
  },
  div7a: {
    term: "Division 7A (private company loans)",
    short:
      "Tax rules that can treat money a private company pays or lends to a shareholder or their associate, or a debt it forgives, as an unfranked dividend, unless it's set up in the required way, such as under a complying loan agreement.",
    why: "Taking money out of your own company other than as wages or dividends can have tax consequences for you personally. Confirm the arrangement with a registered tax agent.",
    related: ["company", "franking_credit"],
  },
} as const satisfies Record<string, GlossaryEntry>;

export type FtGlossaryKey = keyof typeof FT_GLOSSARY;

/** Every term <Term>/<InfoTip> can resolve. The /glossary page lists FT_GLOSSARY only when ft_journey is ON. */
export const ANY_GLOSSARY: Record<GlossaryKey | FtGlossaryKey, GlossaryEntry> = { ...GLOSSARY, ...FT_GLOSSARY };
export type AnyGlossaryKey = GlossaryKey | FtGlossaryKey;
