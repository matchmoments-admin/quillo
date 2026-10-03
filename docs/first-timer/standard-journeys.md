# How do the established players guide a first-timer from signup to lodged?

> Findings for wayfinder ticket #533 on map #529 (*Ship-it-yourself — Quillo for first-time
> taxpayers*). Researched 2026-10-03 against primary pages: product, pricing and help-centre
> pages, plus ato.gov.au. This follows on from [`docs/ux/journey-research-248.md`](../ux/journey-research-248.md).
> That doc set the general principles (lead with WHY, one next step, right data in first, honest
> numbers) but had no citations. This one adds the sourced, product-by-product detail and a
> first-timer step skeleton, and it doesn't repeat #248's screen-level recommendations. Lodgement
> routes are already settled in [`lodgement-routes.md`](lodgement-routes.md). General information
> only. Anything marked **[unverified]** must be re-checked before it is quoted publicly.

## Verdict

**Every established player runs the same spine:** identity (TFN/myGov) → prefill → situation
questions or occupation → deductions → estimate → review → lodge. Where they differ is **who carries
the liability**, and that decides how much they are allowed to *say*:

- **The agents** (Etax, H&R Block, Hnry) give advice and put a human review in front of lodgement.
- **The non-agents** (TaxTank, Taxfox, myDeductions) keep a "general information / not a
  registered tax agent" line. They stop at a record pack, and the user lodges in myTax or hands it
  to an accountant.

Quillo is a non-agent, so it follows the second pattern. Nobody in the market combines four
things: **bank-transaction discovery** (only Taxfox and TaxTank do this, and only as a list of
likely deductions), **a WHY for each claim**, an **evidence check before lodge**, and **a myTax
worksheet laid out label by label**. That combination is where Quillo can be clearly better.

## Product by product

### ATO myTax (+ myDeductions in the ATO app). The reference journey every self-lodger ends in.

- **Getting in (first-timer):**
  1. Check whether you need to lodge at all.
  2. Get a TFN (free, through Australia Post).
  3. Create a myGov account and link it to the ATO with two identity questions, or ring for a
     linking code.
  4. Lodge after late July, once prefill has landed.
  ([ATO: first-time lodgers](https://www.ato.gov.au/media-centre/attention-first-time-lodgers-your-steps-to-tax-success);
  hub at ato.gov.au/NewToTax)
- **Question order:** **Personalise return** comes first. It asks (1) were you an Australian
  resident for the whole year (dates if only part), (2) did you have a spouse, (3) tick the items
  that apply. Prefill, last year's return and myDeductions **pre-tick items, and the user can't
  untick them** (salary auto-selects work-related expenses). Next is **Prepare return**, a set of
  sections: Income, Deductions, Losses, Offsets, Adjustments, Medicare/PHI, Spouse/income tests.
  ([How to personalise your return 2025](https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2025/how-to-personalise-your-tax-return);
  [myTax 2025 instructions](https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2025))
- **Prefill:** comes from employers, banks (interest only, not transactions), government agencies,
  health funds and dividend payers. It arrives "from 1 July, with most data finalised by the end
  of July". The ATO warns "don't rely solely on pre-fill", and a change to a prefilled figure can
  draw an ATO query.
  ([Pre-fill availability](https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return/lodge-your-tax-return-online-with-mytax/pre-fill-availability))
- **myDeductions:** a free record keeper that stores data on the device. It can be uploaded
  **once a year** from 1 July, and the records lock after upload. Upload before you start and the
  data prefills; otherwise use "Get myDeductions" on Personalise.
  ([myDeductions](https://www.ato.gov.au/online-services/online-services-for-individuals-and-sole-traders/ato-app/mydeductions);
  [upload](https://www.ato.gov.au/online-services/online-services-for-individuals-and-sole-traders/ato-app/mydeductions/using-mydeductions/how-to-upload-mydeductions-data))
- **Education:** each item links to its instructions, there are how-to videos, and the
  [occupation guides](https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/guides-for-occupations-and-industries)
  are built around the "3 golden rules" (you spent it, it's for work and not reimbursed, you have a
  record).
- **Advice line and human help:** the ATO is the regulator, not an adviser ("seek professional
  advice"). Free volunteer [Tax Help](https://ato.gov.au/taxhelp) runs Jul–Oct for incomes of about
  $70k or less, or the user can find a registered agent.
- **Price:** free.
- **What feels safe:** a live "estimate and breakdown of your refund or debt", explicitly
  labelled "an estimate only… may differ"
  ([estimate](https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2025/mytax-2025-estimate)),
  review and print before lodging, an email receipt, and refunds in about 2 weeks
  ([lodge with myTax](https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return/lodge-your-tax-return-online-with-mytax)).

### H&R Block Australia. DIY tiers with forced escalation to an expert.

- **Flow:** register and verify → create a return → guided forms with "deduction tips tailored to
  your situation" → submit. Income is auto-filled from the ATO, with occupation-specific tips
  ([/lodge](https://www.hrblock.com.au/lodge)). "Online with an Expert" starts with **4 simple
  questions**, and an expert replies within a business day
  ([/tax-return/online](https://www.hrblock.com.au/tax-return/online)).
- **Price ladder (the most instructive thing here):**
  - Starter **$0** (income ≤$30k, deductions ≤$300)
  - Standard $19
  - Deluxe $69 (deductions over $300, foreign income, CGT, crypto)
  - Premier $99 (rental, self-employed)
  - Returns with an **expected refund over $10k are pushed to an adviser**, as "higher likelihood of
    ATO scrutiny"
  - Assisted service from $109; under-21s and students $89; fee-from-refund +$30
  ([pricing](https://www.hrblock.com.au/tax-return-fees-and-pricing))
- **Handoff:** online expert, phone, or 400+ offices. Lodgement appears to go through H&R Block as
  the agent ("extended tax agent deadlines") **[unverified]**.
- **What feels safe:** brand and offices, plus a maximum-refund guarantee (fee back + a free
  amendment for errors H&R Block made) **[wording unverified on the primary page]**.

### Etax. The agent-reviewed model.

- **Flow:**
  1. Free account, ID, TFN and bank details. **Etax then prefills your ATO data.**
  2. Employer(s) and **occupation**, then a **Deduction Finder** suggests claims from the job title.
  3. Live chat as you go, then sign.
  4. An accountant reviews and lodges, usually within a business day.
  ([how it works](https://etax.com.au/finish-your-tax-return-in-minutes); [FAQ](https://www.etax.com.au/faq/))
- **Price:** from **$87.49**; $44.90 for Centrelink-only recipients and under-18s; fee-from-refund
  +$27.50; rental and CGT schedules $59.90 each ([fees](https://www.etax.com.au/etax-fees/)).
- **Advice line:** Etax Accountants Pty Ltd is the registered agent (TPB #69399005,
  [about](https://www.etax.com.au/about-etax/)). It **offers advice** over chat because it *is*
  the agent.
- **What feels safe:** a live refund estimate pinned at the top of the screen, autosave, an
  accuracy re-check, and a human review on every return.

### TaxTank. The non-agent "tax-ready all year" tool. Closest to Quillo's posture.

- **Onboarding:** a welcome video → a free trial of one "Tank" → a **checklist** for that Tank
  (link data, key details, how it works) with tooltips and videos. You can also book an onboarding
  consult ([onboarding checklist](https://support.taxtank.com.au/en/articles/8889273-get-started-with-the-onboarding-checklist)).
- **Bank data:** Open Banking feeds, and the user allocates transactions
  ([bank feeds](https://support.taxtank.com.au/en/collections/2742816-bank-feeds-open-banking)).
  No ATO prefill.
- **Education:** a live tax-position estimate, an AI chat, "You don't need to know tax"
  ([home](https://taxtank.com.au)).
- **Advice line:** "not a registered tax agent… general nature only"; "Does TaxTank provide tax
  advice? No." ([pricing](https://taxtank.com.au/pricing/))
- **Handoff:** it doesn't lodge. You self-lodge in myTax from its reports, or invite your accountant
  onto the data or export schedules ([how TaxTank helps](https://support.taxtank.com.au/en/articles/11772319-how-taxtank-helps-with-tax-returns)).
- **Price:** Work Tank (wage earner) **A$108/yr**; other Tanks A$72–180; 14-day trial.

### Hnry. The agent *is* the product (sole traders only).

- **Who it's for:** ABN holders only. Clients pay into a Hnry account, which pays the tax, GST and
  Medicare as money comes in. **No bank feeds by design.** Hnry lodges returns and BAS as the agent.
  ([home](https://hnry.com.au))
- **Price:** **1% + GST** of self-employed income, capped at A$1,500 + GST a year
  ([pricing](https://hnry.com.au/pricing/)).
- **Unverified:** the AU onboarding question order (the AU help centre redirects to the NZ one) and
  its TPB number, which only appears on third-party pages.
- **Lesson:** "you never deal with the ATO", which only works if you are the agent. Not a fit for
  wage-only first-timers.

### Taxfox. Bank-linked deduction discovery. The nearest feature analogue.

- **Flow:** link a bank → an "AI Smart Finder" scans transactions for possible deductions → the
  user marks what to claim. A "TaxReady Inbox" prompts about deductions you may have missed. You
  pick an **occupation** for role tips and a **benchmark against peers** (third-party pages say it
  warns about claims above the average). ([home](https://taxfox.com.au);
  [Canstar](https://www.canstar.com.au/superannuation/tax-apps-to-make-your-life-easier/))
- **Advice line:** "general in nature only… consult with a tax professional". No TPB registration.
- **Handoff:** a PDF summary + a ZIP of receipts, to take to myTax or an accountant.
- **Price:** Basic free (A$1,000 of claims, 1 bank link); Smart A$8/mo; Genius A$13/mo
  ([pricing](https://taxfox.com.au/pricing)).

### AusTax AI. Now a directory, not a lodging service. **This corrects `lodgement-routes.md`.**

- **What it is now:** "a directory and matching platform, not a registered tax agent", listing about
  61k TPB-registered agents. Agents pay A$29 per unlocked request or A$39–99/mo; taxpayers pay
  nothing ([home](https://austaxai.com.au); [request form](https://austaxai.com.au/tax-agents/request)).
  **The `/tax-agent-service` page cited in #530 (A$129 "Complete Tax Service") now redirects to
  `/tax-agents`** (checked 2026-10-03). The A$129 benchmark and the "AusTax AI model" in
  `lodgement-routes.md` are out of date. The partner-agent route still stands (Etax is the live
  example).
- **Request form order:** what you need → state → contact preference → optional language/timing.
- **Education:** guides for 49 occupations, plus first-return, international-student (500/485/408)
  and WFH hubs ([guides](https://austaxai.com.au/guides)). The refund calculator asks income →
  deductions → tax withheld → HELP/PHI/visa/non-resident ticks
  ([calculator](https://austaxai.com.au/tax-refund-calculator)).
- **Anti-pattern:** its first-return hub says "most people lodging for the first time receive a
  refund of $1,000–$3,000" ([first tax return](https://austaxai.com.au/topics/first-tax-return-australia)).
  That is exactly the refund prediction Quillo's invariant forbids.

### TurboTax / Cash App Taxes (US). Pattern reference only.

- **Interview model:** life-situation checkboxes up front ("changed jobs, had a baby, went back to
  school") decide which sections appear: "everything you enter tells us which questions to ask
  next" ([TurboTax](https://turbotax.intuit.com/tax-tips/brand/video-how-turbotax-is-customized-to-fit-your-own-situation/L5UDTeP7i);
  [first-time filer](https://ttlc.intuit.com/community/tax-articles-34/help-it-s-my-first-time-filing-taxes-1004642)).
  The order is documents → about you → income → deductions/credits → review → file.
- **Capture first:** photograph a W-2 or auto-import from employers
  ([Free Edition](https://turbotax.intuit.com/personal-taxes/online/free-edition.htm)).
- **Escalation ladder:** Free → Expert Assist (chat/video, plus "a final… review of your entire
  return before you file") → Full Service → office
  ([Live](https://turbotax.intuit.com/personal-taxes/online/live/)).
- **AI:** Intuit Assist + the CompleteCheck scan
  ([online](https://turbotax.intuit.com/personal-taxes/online/)). In 2024 the Washington Post
  found its first chatbot wrong or unhelpful on more than half of the questions tested
  ([NYSSCPA](https://www.nysscpa.org/news/publications/the-trusted-professional/article/tech-columnist-turbotax-and-hrblock-chatbots-are-unhelpful-or-wrong-much-of-the-time-030724)).
- **The running refund meter was removed** "for accuracy and simplicity"; totals now show after
  data entry ([support](https://ttlc.intuit.com/turbotax-support/en-us/help-article/customer-complaints/dont-see-tracker-shows-refund-taxes-owed/L55VbCDh0_US_en_US)).
- **"Free" that wasn't:** the FTC found about two-thirds of filers didn't qualify, and people found
  out only after entering everything
  ([FTC 2024](https://consumer.ftc.gov/consumer-alerts/2024/01/ftc-finds-turbotax-free-not-free-most)).
  The order was vacated on separation-of-powers grounds on 2026-03-20
  ([Public Citizen](https://www.citizen.org/litigation/intuit-inc-v-ftc/)), but the UX lesson still
  stands.
- **Cash App Taxes** (formerly Credit Karma Tax, divested in 2020 as a condition of Intuit buying
  Credit Karma): free federal and state, "not a tax advisor", no expert tier
  ([cash.app/taxes](https://cash.app/taxes)).

## Comparison

| | Who lodges | Bank txns | ATO prefill | Occupation-led | Human in loop | Simple-return price | Estimate shown |
|---|---|---|---|---|---|---|---|
| myTax | taxpayer | — | yes (source) | guides only | Tax Help volunteers | free | live, "estimate only" |
| H&R Block | H&R Block (agent) [unverified] | — | yes | tips | expert, escalated | $0–$19 (DIY) / $109 assisted | [unverified] |
| Etax | Etax (agent) | — | yes | Deduction Finder | review on every return | $87.49 | live, top of screen |
| TaxTank | taxpayer / own accountant | feeds | — | Tank per income type | invite accountant | A$108/yr | live tax position |
| Hnry | Hnry (agent) | none by design | n/a | industry teams | always | 1% (cap A$1,500) | n/a |
| Taxfox | taxpayer / accountant | feeds + AI finder | — | yes + peer benchmark | — | free–A$13/mo | refund calculator |
| AusTax AI | matched agent | — | — | 49 guides | directory match | free (agents pay) | calculator point estimate |
| TurboTax (US) | taxpayer / expert | — | doc import | life checkboxes | ladder, expert final review | $0 simple | meter removed |

## What novices find reassuring (across all of them)

1. **Prefill as proof**: "we already know your salary" shows the system knows them.
2. **A visible, short sequence** with autosave and resume.
3. **A named human in reserve**, even if few people use it (Etax chat, H&R Block offices, TurboTax ladder).
4. **A review before lodge** that checks something (CompleteCheck, the Etax re-check, myTax review/print).
5. **An honest estimate label** ("estimate only… may differ"). Products that show a live refund
   number all hedge it, and TurboTax dropped its meter altogether.

## What Quillo should copy

1. **myTax's Personalise model:** a few situation questions (residency for the full year, spouse,
   tick what applies) that **decide which sections exist**, plus items **auto-ticked from data**
   that the user can see but not silently drop. Our bank feed plays the part of their prefill: a
   detected employer deposit ticks "salary", a detected ABN-style inflow ticks "side income".
2. **Occupation as the deduction lens** (Etax Deduction Finder, Taxfox, ATO occupation guides): ask
   for the job title early, use it to select what to look for, and link the ATO occupation guide.
3. **The "3 golden rules" as the WHY scaffold** for every claim. It is the ATO's own language, so it
   stays general information.
4. **TaxTank/Taxfox's TPB posture word for word:** "not a registered tax agent / general
   information", with lodgement by the user in myTax or by an agent.
5. **The visible escalation ladder** (TurboTax, H&R Block): explain (agent chat) → "confirm with a
   registered tax agent" → partner-agent lodges. The human option sits **right before lodge**, not
   buried in help.
6. **Prefill timing:** tell first-timers to lodge after late July and that most income will already
   be in myTax.
7. **Say price and fit up front** (the FTC lesson): before data entry, tell the user whether Quillo
   fits their situation and what the free path covers.

## Where Quillo can be clearly better

1. **Evidence before claims.** Every DIY competitor lists likely deductions. None checks that the
   golden-rule record exists. Quillo can link each claim to its receipt or bank line and show
   "claim ready / needs a record" (the evidence-vault strength turned to first-timer use).
2. **A myTax worksheet laid out label by label.** TaxTank and Taxfox export PDFs organised their
   own way. Quillo can follow myTax's Prepare-return sections and labels (D1–D10 etc.) so typing it
   in is mechanical. It should lead with what myTax *won't* know, plus a "check this matches the
   prefill" list (per `lodgement-routes.md`).
3. **Completeness instead of a refund number.** Others pin a refund estimate; we show "evidence
   complete: 6 of 8", with an indicative position only after review, labelled like myTax's
   estimate. This keeps the never-predict-a-refund invariant and is more honest (TurboTax's own
   reason for dropping the meter).
4. **No price tiers for a simple return.** H&R Block's $0/$19/$69/$99 ladder charges more as a
   situation gets more complex. Quillo's grow path should add layers (ABN, property) without making
   the user re-enter what they've given.
5. **Deterministic maths, AI only explains.** TurboTax's chatbot accuracy problems show why the
   agent should only *explain* (golden rules, the ATO links) and never compute or assert a
   conclusion. Every figure comes from the engine and the user confirms it (TPB boundary).
6. **Newcomer and residency content built into the flow** (AusTax has it only as guides):
   residency is myTax's first question, so it should be ours too, with WHM/student-visa education.

## Recommended first-timer step skeleton

Feeds #535 (journey + IA), #536 (onboarding), #537 (education) and #538 (ship it). This is a
proposal, not a decision.

0. **Before you start (no account needed):** "Is Quillo right for me?" Who it fits and what's free,
   plus the general-information / not-an-agent line. Links: do I need to lodge, TFN, myGov. Defaults
   to the FY being lodged (the map's open default-FY fog).
1. **About you (myTax Personalise order):** residency for the full year (with dates; newcomer
   branch), spouse, state (education only), **occupation**, then "tick what applies" (salary, study
   + HELP, side income/ABN, WFH, car, foreign income). About 6 questions.
2. **Bring in your money:** connect a bank (CDR) or upload a statement. Quillo **auto-ticks** items
   from the transactions (employer deposits, ABN-like inflows, HELP repayments), shown as "we
   noticed…" for the user to confirm, never silently asserted.
3. **What you might claim, and why:** a list driven by occupation and transactions. Each item
   shows golden-rule WHY + the ATO occupation-guide link + matched transactions. The user confirms
   or dismisses each one, and this is the only place a claim becomes theirs.
4. **Get the records:** for each confirmed claim, "record ✓ / missing → snap a receipt / log WFH
   hours". A completeness meter replaces any refund number.
5. **Check:** an evidence and consistency review (CompleteCheck pattern): missing employer, WFH
   method double-ups, claims with no record. Then an indicative position labelled "estimate only,
   general information".
6. **Ship it, your choice:** (a) **myTax worksheet**, ordered by myTax's Prepare sections, with a
   "matches prefill?" check list, lodge after late July; or (b) **have a registered agent lodge it**
   (partner hand-off pack, #542). The agent option is offered right here, priced up front.
7. **After lodge:** NOA arrives → carry-forwards; nudge "start next year's records" (TaxTank's
   all-year loop, without its per-Tank pricing).

The agent chat sits alongside every step to answer "why?" and never drives the flow (owner's
interaction decision).

## Consequences for the map

- **Correction to #530's findings:** the AusTax AI A$129 agent-service benchmark is gone (the page
  now redirects to a directory). `lodgement-routes.md` should drop or annotate it. Etax
  ($87.49 + agent review) and H&R Block assisted ($109; $89 for students) are now the current
  benchmarks for the partner-agent path in #542.
- **#536 Onboarding** gets a concrete starting set: residency, spouse, state, occupation,
  tick-what-applies, ordered like myTax Personalise.
- **#537 Education** gets a scaffold: the ATO 3 golden rules + occupation guides as the general-info
  WHY source, with peer benchmarking (Taxfox) as an open question, because benchmark warnings
  come close to advice.
- **#538 Ship it** gets a worksheet layout rule: mirror myTax Prepare sections and labels, and put
  the non-prefilled items first.
- **Pricing fog:** market anchors for a simple first-timer return are $0 (myTax, H&R Block
  Starter, Taxfox Basic), about $87–109 agent-reviewed, and about A$108/yr for an all-year tool.

## Not verified

- Hnry's AU onboarding order and TPB number; whether H&R Block DIY lodges as the agent; H&R Block's
  guarantee wording and AU app features; the exact Etax tab names; the current TurboTax screen
  wording and paid-tier prices; and the Taxfox app-store listings and benchmark warnings (third-party
  pages only).
- No screenshots were captured. The links are the assets. ato.gov.au blocks automated fetch for
  some tools and its pages were read with curl.
