# H&R Block Australia: online return review, and what Quillo should take from it

> Research note, 2026-10-06. Prompted by four screenshots the owner shared of H&R Block Australia's
> 2024-25 online-return onboarding: *"review everything they do and see if we can compete, or make our
> experience and UI as clean. Not saying we need an ID or anything, just the inputs and screens look
> very tidy."*
>
> **Scope and the brand rule.** Every recommendation here is a **layout, form-pattern, copy or flow**
> change inside production's look: forest/sage/cream, Anton display headings and Inter body, the
> existing icons, and `ui.tsx`'s `BUTTON_TONE` / `CARD_CLASS` / `INPUT_CLASS` (via the `ft/` primitives).
> No new colours, fonts, icons or controls that need a new visual language. See the owner preference
> in `memory/MEMORY.md` and the "journey visual parity" check in `scripts/check-units.ts`.
>
> **The structural difference.** H&R Block is a **registered tax agent**. It can verify identity, use
> the TFN to pull ATO prefill into its own software, review the return, and lodge it. Quillo is not an
> agent: it prepares evidence and a myTax worksheet, and **the user lodges in myTax themselves**.
> Quillo gives general information only, never advice.

---

## (a) H&R Block's journey, stage by stage

H&R Block runs three online products next to its 400+ offices
([hrblock.com.au/tax-return](https://www.hrblock.com.au/tax-return)):

| Product | What it is | Price (as published) |
|---|---|---|
| **Online Tax Express** (DIY) | You fill it in; ATO auto-fill; occupation deduction prompts; then lodged by H&R Block | Starter **free** (income up to $30k, deductions up to $300), Standard from $19, Deluxe from $69 (shares, CGT, crypto), Premier from $99 (rental, sole trader) ([/lodge](https://www.hrblock.com.au/lodge)) |
| **Online Tax Adviser** ("with an expert") | Answer 4 questions, upload documents, get matched to an expert who prepares and lodges | From $109, same tiers as in-office: Streamline $109, Standard $179, Rental $354, Business $404, plus add-ons; Fee From Refund $30 ([pricing](https://www.hrblock.com.au/tax-return-fees-and-pricing)) |
| **In office / by phone** | Classic agent appointment | As above |

The stages below come from H&R Block's public pages and the owner's screenshots. The signed-in
dashboard, income and deduction screens aren't publicly documented, and no first-party walkthrough
video turned up. Where a stage is inferred from marketing copy rather than seen, it's marked *(copy)*.

1. **Sign up.** "Create your free account. Register with Online Tax Express and securely verify your
   account to get started." ([/lodge](https://www.hrblock.com.au/lodge)). The Adviser path starts with
   "Answer 4 simple questions to get started immediately"
   ([/tax-return](https://www.hrblock.com.au/tax-return)).
2. **Onboarding (screenshots 1-4).**
   - *Pre-flight screen* ("Before we dive in" with a waving-hand emoji): eyebrow "2024-25 TAX RETURN",
     a one-line intro, a bordered **numbered list of what's coming** (1 Your basic details, 2 Your TFN
     & date of birth, 3 A quick identity check), a tinted callout ("Once you're verified, we can
     automatically import available tax information"), **"you'll need one of:" chips** (Passport /
     Driver's Licence / Medicare Card / Birth Certificate), a full-width pill primary "Let's go", and a
     "Skip for now" text link.
   - *Step 1 of 3* ("2 more steps after this", thin progress bar): one white card centred on a light
     grey page, centred H1 "Let's get started" plus subtitle, **labels above inputs** in a grid (Title
     select; First, Middle, Last name; TFN; Date of birth with a calendar), required fields marked `*`,
     invalid fields outlined red. **Footer row outside the card**: outlined pill "Back" on the left,
     filled pill "Save and Continue" on the right, **disabled until valid**.
   - *Step 2 of 3* ("1 more step after this"): "Where do you live? Enter the address known by the
     ATO." Address **autocomplete** (lines 1 and 2, postcode, suburb select, state select, country) and
     two **yes/no toggles**.
   - *Step 3 of 3* ("Almost there!"): ID verification as two numbered sub-cards with selects, plus an
     escape hatch: "Not ready to verify yet? Continue to your dashboard".
3. **Dashboard** *(copy)*: "Create a new tax return and manage all your previous returns from one
   easy-to-use portal" ([/lodge](https://www.hrblock.com.au/lodge)).
4. **Income** *(copy)*: "Auto-fill your income direct from the ATO" and "Your income details
   automatically added to your tax return" ([/tax-return](https://www.hrblock.com.au/tax-return),
   [/tax-return/online/lodge-online](https://www.hrblock.com.au/tax-return/online/lodge-online)). This
   is ATO prefill through agent access, which only works because identity is verified and H&R Block is
   the tax agent.
5. **Deductions** *(copy)*: "Occupation specific deduction prompts" and "Occupation deduction
   suggestions". The occupation-based approach goes back to their 2009 $49 online check
   ([iTWire, 2009](https://itwire.com/business-it-news/business-technology/tax-agent-offers-online-check-before-you-lodge)).
6. **Help and chat** *(copy)*: "Tax consultants are available to answer your questions at any time
   during the process via phone or messenger"
   ([myTax vs H&R Block](https://www.hrblock.com.au/tax-academy/mygov-tax-vs-hrblock)). On the DIY tiers,
   expert help is paid ("Access to expert help if you need" at additional cost,
   [/lodge](https://www.hrblock.com.au/lodge)).
7. **Review and lodge** *(copy)*: "your tax return will be reviewed for errors and sent off for
   lodgement … reviewed by experienced online tax consultants & validated by registered tax agents"
   ([myTax vs H&R Block](https://www.hrblock.com.au/tax-academy/mygov-tax-vs-hrblock)). Returns
   expecting a refund over $10,000 are pushed to the Adviser product as "higher-variance"
   ([/lodge](https://www.hrblock.com.au/lodge)).
8. **Pay** *(copy)*: "no upfront payment and your 100% tax deductible fee is deducted from your refund"
   (Fee From Refund, $30 on assisted tiers) ([pricing](https://www.hrblock.com.au/tax-return-fees-and-pricing)).
   There's also a Tax Refund Advance of up to 50% of the estimated refund, capped at $1,000
   ([Canstar Blue](https://www.canstarblue.com.au/hr-block-2/)).
9. **After lodging** *(copy)*: "the ATO typically processes and issues your refund within 2 weeks"
   ([/tax-return](https://www.hrblock.com.au/tax-return)). Through the agent lodgement program they can
   offer lodging "any time up to May the following year"
   ([myTax vs H&R Block](https://www.hrblock.com.au/tax-academy/mygov-tax-vs-hrblock)).
10. **Year-round** *(copy)*: a free app for receipts, a work-from-home tracker, a car logbook and a refund
    calculator ([Accountants Daily, 2015](https://www.accountantsdaily.com.au/business/8298-h-r-block-launches-new-mobile-app);
    [Canstar Blue](https://www.canstarblue.com.au/hr-block-2/)), and a web
    [tax calculator](https://www.hrblock.com.au/tax-calculator).

### What they do well
- **The onboarding is tidy.** Each screen has one job, there's a plain progress cue, and the user
  always knows what's coming and what they'll need.
- **A free entry tier and Fee From Refund** take away the upfront price objection.
- **Prefill plus occupation prompts** keep most data entry away from the user.
- **Escape hatches everywhere** ("Skip for now", "Not ready to verify yet?"), so nobody gets trapped
  in onboarding.

### What they do badly (public reviews)
- **Trustpilot TrustScore of about 1.5 to 2.0 out of 5**
  ([Trustpilot](https://www.trustpilot.com/review/hrblock.com.au?page=2)). Online complaints repeat
  three themes: slow or absent replies from offshore online advisers (two days or more between
  messages), **document upload errors**, and surprise fees "despite advertised lower starting
  prices". Some reviewers say errors in their return were things they caught themselves.
- **Upsell pressure.** "From $0" becomes $19, $69 or $99 once you have more than $300 of deductions,
  shares or rental, and expert help costs extra.
- **Fear-based positioning against myTax**: "you are 100% responsible", "the ATO's main job is to
  collect taxes" ([myTax vs H&R Block](https://www.hrblock.com.au/tax-academy/mygov-tax-vs-hrblock)).
- **Refund-maximising framing** everywhere ("maximise your refund", a refund calculator, "maximum
  refund guarantee").

---

## (b) Why their screens feel tidy: the concrete patterns

| # | Pattern | What it does | Quillo today |
|---|---|---|---|
| P1 | **Pre-flight screen**: a numbered list of what's coming, "you'll need" chips, one primary, a "Skip for now" link | Sets expectations once, so later screens can stay terse | Get set up's intro **stacks three cards** (`SetupIntro`, the myTax check, `TaxHelpCard`) with long prose; no numbered "what's coming"; no "you'll need" |
| P2 | **One centred card per screen** on the page ground, heading inside the card | One focal object, generous whitespace | Question screens use a left-aligned `max-w-2xl` column; `StepHeader` sits above the card; Connect, Review and Lodge stack many cards and sections |
| P3 | **"Step n of 3 · N more steps after this"** plus a thin bar | Says how much is left, not only where you are | `StepHeader` shows segments and "Step n of 4"; sub-progress ("Question 2 of 6") is buried in the intro sentence |
| P4 | **Labels above inputs**, in a grid | Scannable, accessible | Already done (`label.block space-y-1`) |
| P5 | **Required `*`, red outline on invalid fields** | Errors are located, not just announced | Errors are a `text-warn` line under the question; the offending input isn't marked (`aria-invalid` and border missing) |
| P6 | **Primary disabled until valid** | No dead-end submits | Done for consent and invalid answers (`blocked`); optional questions stay skippable, which is right for Quillo |
| P7 | **Footer row outside the card: outlined Back left, filled primary right** | A predictable, two-button rhythm | `StepFooter` has **three** buttons (Back, Why?, primary), so the middle one crowds the row |
| P8 | **Yes/no as a binary control** | One tap, no reading | Yes/No are two `Chip`s in a wrapping row, so they read like a multi-select |
| P9 | **Autocomplete** for known lists (address, suburb, state) | Less typing, valid values | Occupation uses a `<datalist>`; state is about 8 chips (fine) |
| P10 | **Escape hatch on gating screens** ("Not ready? Continue to your dashboard") | Nobody is trapped | The myTax check already says "You can keep going in Quillo meanwhile", but as prose, not a link |
| P11 | **Short, verb-first CTAs** ("Let's go", "Save and Continue") | Momentum | Mostly good ("Next", "Save and connect") |
| P12 | **An eyebrow with the year** ("2024-25 TAX RETURN") | Anchors which year this is | The FY sits in the intro sentence or the rail's FY switcher, not as an eyebrow |

The emoji, the blue and white palette and the red error colour are H&R Block's brand. They aren't
what makes the screens tidy. **P1 to P3, P5, P7, P8 and P10 are.**

---

## (c) Where Quillo can compete, or win, without being an agent

**Where Quillo wins**
- **Free lodgement in myTax.** H&R Block's DIY tier is free only up to $30k income and $300 of
  deductions. myTax is always free, and Quillo never takes a fee from the refund.
- **Finds claims from the bank feed all year**, not from a tax-time occupation checklist. The Review
  queue proposes claims from real bank lines and matches receipts. H&R Block's prompts are generic to
  an occupation, and its app is a manual logbook.
- **Records that hold up**: receipts matched to bank lines, records completeness, retention counted
  from the lodge date. H&R Block's reviews complain about documents going missing in upload.
- **Honest framing**: no refund prediction, no "maximise", no fear of myTax. That matters most to the
  first-timers Quillo targets.
- **Teaches as it goes**: the Why? drawer, the glossary, myTax banner names in myTax order. The user
  ends the year able to use myTax, rather than dependent on an agent.
- **No queue for a human.** Answers come straight away (Ask Quillo, consent-gated), unlike the two-day
  replies in H&R Block's reviews.

**Where Quillo loses, and how to soften it**
| Gap | Why it can't be copied | How to soften it |
|---|---|---|
| ATO prefill import | Needs agent access, verified ID and the TFN | Say so up front: "myTax fills your income in from late July". Show the income statement as a waiting item (already done). The worksheet tells the user to check prefill (already done) |
| Lodging for the user | Not a registered agent | Make the myTax hand-off feel like a guided checklist (Lodge step) |
| Agent review and validation | Not an agent | Readiness blockers plus "confirm with a registered tax agent" on judgement calls; Tax Help named as the free ATO option |
| Extended deadline (to May) | Agent lodgement program only | State 31 October plainly; point to a registered agent if the user needs more time |
| Human chat | No tax professionals on staff | Ask Quillo and the Why? drawer; the general-information framing stays |
| Trust from a brand with 400 offices | — | Tidy, calm screens (this document) and the privacy lines Quillo already has |

---

## (d) Prioritised UI changes per Quillo step (each one PR, within the brand)

Priorities: **P1** has the most visible tidiness gain for the least risk. All of these are web-only
copy and layout under `ft_journey`, with no data-model or money-path change, so the persona goldens are
unaffected. Run the web gate (`cd web && npx tsc --noEmit && npm run lint`) plus `npm test`, which
includes the journey visual parity check.

### Shell and shared components (every step benefits)
1. **P1 · `StepFooter` becomes two buttons** (`web/src/components/ft/StepFooter.tsx`). Back (`ghost`)
   on the left and the primary on the right. Move **Why?** out of the footer into `StepHeader` as a
   small `FtLink`-style text button next to "Step n of 4" (`web/src/components/ft/StepHeader.tsx`,
   via its `right` slot or a new `onWhy` prop). Pattern P7.
2. **P1 · "N more steps after this"** in `StepHeader`. Change `stepLabel` in
   `web/src/components/ft/model.ts` to "Step 2 of 4 · 2 more after this", "Step 3 of 4 · 1 more after
   this" and "Step 4 of 4 · Last step". Add an optional `sub` prop ("Question 2 of 6") rendered on its
   own muted line under the segments, and take it out of the intro sentence in `AboutYou.tsx`. Add
   a unit test for the label. Pattern P3.
3. **P2 · Field error states** in `web/src/components/ft/primitives.tsx`. `FtInput` and `FtSelect`
   take an `invalid` prop that sets `aria-invalid` and adds `border-danger` (an existing production
   token). `SituationQuestion` links its `problem` to the field with `aria-describedby`. Use it for the
   residency date and the spouse dates in `AboutYou.tsx`. Pattern P5.
4. **P2 · Binary questions laid out as a pair.** In `web/src/components/ft/SituationQuestion.tsx`,
   when there are exactly two options, render the existing `Chip`s in a `grid grid-cols-2` at full
   width, so they read as one either/or control (no new switch control). This applies to Spouse and
   the part-year direction. Pattern P8.

### Step 1, Get set up (`web/src/pages/AboutYou.tsx`, `web/src/components/ft/GetSetUp.tsx`)
5. **P1 · One pre-flight card replaces the three stacked intro cards.** A new `SetupPreflight` in
   `GetSetUp.tsx`, built from one `FtCard` with:
   - an eyebrow with the FY (`text-xs uppercase tracking-wide text-muted`, e.g. "FY 2025-26 return");
   - the Anton H1 and the one-line lede ("Quillo helps you get ready. You lodge in myTax.");
   - a bordered **numbered list of the four steps** (Get set up · Connect · Review · Lodge in myTax)
     with one line each;
   - a **"You'll need" chip row**: your myGov sign-in · your internet banking login · receipts, if you
     have them (static `Badge`s, not toggles);
   - a primary "Start" and a "Skip for now" text link to Home.

   "What Quillo doesn't do", the non-lodgment line and Tax Help move into a collapsed "Before you
   start: the fine print" `<details>` under the card, with the copy unchanged. Patterns P1 and P12.
6. **P1 · The myTax check gets its own screen.** Make "Can you get into myTax?" a screen in
   `aboutScreens` after the intro (`web/src/lib/aboutYou.ts`), so the intro stays short. Keep the
   three ticks and fix links, and add an escape-hatch line: "Not set up yet? Keep going. You'll need
   it before you lodge." Pattern P10.
7. **P2 · Question screens as one centred card.** In `FirstRun`, narrow to `max-w-xl`, centre it, and
   put the question title and help inside the card (as today). The footer sits **under** the card
   rather than at page width. Pattern P2.
8. **P3 · An Edit link on each confirm-summary row** (`ConfirmSummary`). Each `<dt>/<dd>` row gets an
   "Edit" text button that jumps back to that question's screen index, as review screens do in Xero,
   MYOB and H&R Block's own flow.

### Step 2, Connect (`web/src/components/connect/ConnectPage.tsx`)
9. **P1 · The connect hero becomes a pre-flight card.** Wrap the primary action in one `FtCard`:
   - a numbered "what happens": 1 Sign in at your bank (never in Quillo) · 2 Choose the accounts to
     share · 3 Quillo imports the year you're lodging;
   - a "You'll need" chip: your internet banking login;
   - a full-width-on-mobile primary "Connect your bank";
   - "Upload a statement instead" as a text link rather than a second button.

   The existing prose lines become the numbered items, so no copy is lost. Patterns P1 and P7.
10. **P2 · A "Waiting on" row for the income statement.** Render `IncomeWaiting` as a single checklist
    row (status `Badge` "Waiting: Tax ready from late July") rather than a full section, so the page
    reads as connect → progress → accounts → waiting. Keep "Advanced: manage accounts" collapsed (as
    today).

### Step 3, Review (`web/src/pages/ReviewQueue.tsx`)
11. **P2 · A slimmer queue header.** One line of counts ("6 to look at · 3 claims need a record"), the
    `CompletenessMeter`, then the filter chips. Move the "Your estimate" disclosure out of the header
    to the bottom of the page next to "Done". It's an estimate of taxable position, never a refund,
    and kept behind a disclosure, but it doesn't belong in the first thing a novice reads. Also drop
    the `-ml-5 underline` ghost-button hack for a plain `FtLink`-style toggle.
12. **P3 · One card anatomy across the queue.** Audit `ClaimCard`, `NoticedCard`, `RecordRow`,
    `MatchProposalRow` and `CheckItem` (`web/src/components/ft/`) so each has a title, then one muted
    line, then actions right-aligned (primary filled, secondary ghost), with the same padding (`p-4`).
    This copies H&R Block's sameness from screen to screen, not its colours.

### Step 4, Lodge in myTax (`web/src/pages/ShipIt.tsx`)
13. **P2 · The Tax-ready gate becomes a pre-flight card.** `TaxReadyGate` turns into a "Before you
    open myTax" card with a numbered list in myTax order (1 Contact & bank details · 2 Personalise ·
    3 Income · 4 Deductions · 5 Medicare & PHI · 6 Spouse), "You'll need" chips (myGov sign-in · this
    worksheet, printed or on a second screen), the existing self-attest ticks, and the escape hatch
    "Not Tax ready yet? You can still look through the worksheet" (the gate stays soft). Patterns P1
    and P10.
14. **P3 · Section progress on the worksheet.** Put "Section n of 7 · N lines left to tick" on each
    `WorksheetSectionCard` heading, so the long page reads like H&R Block's step cadence.

---

## (e) What Quillo must NOT copy

- **Identity verification, TFN or date-of-birth collection.** Quillo isn't an agent, and collecting
  TFNs brings Privacy (Tax File Number) Rule obligations for no benefit. Quillo never asks for myGov or
  myID details (rule (c)6 in `ato-lodgement-process.md`). The **"Title" select** and legal-name fields
  aren't needed either.
- **"We'll automatically import your tax information."** Prefill import is agent-only. Quillo's
  equivalent claim is the bank feed, which needs the user's consent at their bank.
- **Refund estimates, refund calculators, refund advances, "maximise your refund", "maximum refund
  guarantee", the $10,000 refund cap.** Quillo never predicts a refund (CLAUDE.md invariant, enforced
  by the `check-units.ts` denylist).
- **Fee From Refund.** It needs the refund to flow through the agent's trust account.
- **Extended lodgement deadline to May.** That's the agent lodgement program, so Quillo says
  31 October.
- **"Reviewed and validated by registered tax agents"** or any claim of professional review.
- **Fear framing against myTax.** Quillo's whole route is myTax, and the copy is general information
  only.
- **Emoji in headings** ("Before we dive in" with a wave). The brand uses Anton headings, no emoji.
- **H&R Block's blue and white palette, red error colour, font or icons.** Take the patterns only.
- **"Save and Continue" where nothing is saved yet.** Get set up writes answers only on the confirm
  screen (fill-only), so intermediate buttons say "Next" or "Continue", and only the last one says
  "Save".

---

## Sources

- H&R Block: [Tax return](https://www.hrblock.com.au/tax-return) ·
  [DIY online platform (/lodge)](https://www.hrblock.com.au/lodge) ·
  [Lodge online](https://www.hrblock.com.au/tax-return/online/lodge-online) ·
  [Fees and pricing](https://www.hrblock.com.au/tax-return-fees-and-pricing) ·
  [myTax vs H&R Block](https://www.hrblock.com.au/tax-academy/mygov-tax-vs-hrblock) ·
  [Fastest tax refund](https://www.hrblock.com.au/tax-academy/fastest-tax-refund) ·
  [Tax calculator](https://www.hrblock.com.au/tax-calculator)
- Third party: [Canstar Blue review](https://www.canstarblue.com.au/hr-block-2/) ·
  [Trustpilot, H&R Block Australia](https://www.trustpilot.com/review/hrblock.com.au?page=2) ·
  [Accountants Daily, app launch (2015)](https://www.accountantsdaily.com.au/business/8298-h-r-block-launches-new-mobile-app) ·
  [iTWire, online check (2009)](https://itwire.com/business-it-news/business-technology/tax-agent-offers-online-check-before-you-lodge) ·
  [AusTaxAI, H&R Block vs myTax (Sept 2026)](https://austaxai.com.au/guides/hr-block-vs-mytax-australia)
- The owner's four onboarding screenshots (2024-25 return), described in the brief for this note.
- Quillo: `docs/first-timer/spec.md` §0, `docs/first-timer/ato-lodgement-process.md`,
  `docs/first-timer/design-system.md` (superseded look; token architecture kept).

*General information only. Not tax advice, and not an endorsement or assessment of any provider's
tax work.*
