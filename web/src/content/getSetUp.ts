// Copy for step 1, Get set up (spec §0 design review 2026-10-04, #585; flag ft_journey): #584's Before you
// start content as the intro, the "Can you get into myTax?" self-check, the non-lodgment line and Tax Help.
// Source: docs/first-timer/ato-lodgement-process.md rows 1, 2, 4, 6 and rules (c)3 and (c)6.
//
// COMPLIANCE: general information only. Whether someone has to lodge is the ATO's call (its own tool), so
// nothing here gives a verdict. The myTax check is the USER'S OWN check: Quillo can't see myGov, never asks
// for myGov or myID details or the linking answers, and never offers to "connect to myGov". No money figures
// (Tax Help's income limit is left to the ATO page). Scanned by the tax-advice denylist in check-units.ts.

import { ATO_LINKS, BEFORE_YOU_START, type ExtLink } from "./beforeYouStart";

export const SETUP_INTRO = {
  title: "Before you start",
  lede: "Quillo helps you get ready. You lodge your own return in myTax, through myGov.",
  doesntHeading: "What Quillo doesn't do",
  doesnt: BEFORE_YOU_START.doesnt,
  lodgeHeading: BEFORE_YOU_START.lodgeHeading,
  lodgeLine: BEFORE_YOU_START.lodgeLine,
  lodgeEvenIf: BEFORE_YOU_START.lodgeEvenIf,
  // Row 2: the ATO usually still expects a non-lodgment advice. Quoted as the ATO's ask, never a verdict.
  nonLodgment: "If the ATO's tool says a return isn't needed, the ATO usually still asks for a non-lodgment advice, which you lodge online in ATO online services.",
  lodgeLinks: [ATO_LINKS.lodgeTool, ATO_LINKS.nonLodgment] as readonly ExtLink[],
} as const;

export interface MyTaxCheckItem {
  key: "mygov" | "linked" | "myid";
  /** What the user ticks when it's true for them. */
  label: string;
  /** How to get there, in the ATO's terms. */
  help: string;
  /** The ATO page that fixes it. */
  fix: ExtLink;
}

export const MYTAX_CHECK = {
  title: "Can you get into myTax?",
  lede: "You reach myTax through a myGov account linked to the ATO. Tick what's true for you.",
  // Rule (c)6: the check is the user's own; Quillo never sees or asks for credentials.
  privacy: "This is your own check. Quillo can't see your myGov account and never asks for your myGov or myID details.",
  items: [
    {
      key: "mygov",
      label: "I have a myGov account",
      help: "myGov is the government's sign-in. You create the account yourself on the myGov site.",
      fix: ATO_LINKS.mygov,
    },
    {
      key: "linked",
      label: "My myGov account is linked to the ATO",
      help: "To link, you answer questions from your ATO records. A first-timer can often use a recent payslip or their tax file number application receipt number. If you can't confirm online, the ATO tells you what to do next.",
      fix: ATO_LINKS.mygovLinkInfo,
    },
    {
      key: "myid",
      label: "I can sign in with myID at Standard or Strong",
      help: "The ATO recommends myID at Standard or Strong identity strength. A passkey, an authenticator app or an SMS code to an Australian mobile also works, but a secret question can't be used to link the ATO.",
      fix: ATO_LINKS.myid,
    },
  ] as readonly MyTaxCheckItem[],
  allTicked: "You're set to open myTax when it's time to lodge.",
  notYet: "You can keep going in Quillo meanwhile. You'll need this before you lodge, and linking can take a few tries.",
} as const;

// Row 6: Tax Help named as the ATO's free option, its exclusions stated as information (no income figure).
export const TAX_HELP = {
  title: "Want free help?",
  body: "The ATO's Tax Help program has trained volunteers, from July to October, who help people with simple tax affairs and a lower income lodge in myTax. It doesn't cover sole traders, contractors, rental property, capital gains or foreign income. A registered tax agent can help with anything else.",
  link: ATO_LINKS.taxHelp,
} as const;
