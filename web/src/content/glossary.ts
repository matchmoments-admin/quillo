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
  /** Short tooltip body — keep to ~2–4 short sentences. */
  short: string;
}

export const GLOSSARY = {
  // ── Buckets (mirror BUCKET_LABEL keys in components/ui.tsx) ───────────────────────────────
  payg: {
    term: "PAYG",
    short: `Spending in your personal/individual context — you're an employee taxed under PAYG (Pay As You Go) withholding. ${DEFER}`,
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

  // ── Categorisation mechanics ──────────────────────────────────────────────────────────────
  confidence: {
    term: "Confidence",
    short:
      "How sure the AI was about this categorisation. 'review' or 'low' means a human should check it — the AI never finalises anything on its own.",
  },
  bucket: {
    term: "Bucket",
    short: `The tax context a transaction belongs to (PAYG, company, a property…). It groups your spending by where it broadly sits — it doesn't decide deductibility on its own. ${DEFER}`,
  },
  ato_label: {
    term: "ATO label",
    short: `A finer category within the bucket (e.g. company:office-supplies) — roughly where this would sit on a tax return. It's an organising label, not a claim. ${DEFER}`,
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
  },
  itc: {
    term: "GST credits (ITC)",
    short: `Input Tax Credits — the GST a GST-registered business paid on purchases and can generally claim back on its BAS. Only relevant if you're GST-registered. ${DEFER}`,
  },
  abn: {
    term: "ABN",
    short: "Australian Business Number — your business's public identifier. It appears on the report header so your accountant knows which entity it's for.",
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
  entities: {
    term: "Entities",
    short:
      "The separate tax 'hats' you wear — employee (PAYG), company owner, and so on. Each is taxed differently, so we keep them apart from the start.",
  },
  novated_lease: {
    term: "Novated lease",
    short:
      "A car salary-packaged through your employer. Its costs are part of that arrangement — not company expenses — so they're treated separately.",
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
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof GLOSSARY;

/** Look up a tooltip body by key; returns undefined for an unknown key (caller renders nothing). */
export function tipFor(key: GlossaryKey): string {
  return GLOSSARY[key].short;
}
