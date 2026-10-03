# Can a first-timer's return be lodged automatically, and by whom?

> Findings for wayfinder ticket #530 on map #529 (*Ship-it-yourself — Quillo for first-time
> taxpayers*). Researched 2026-10-03 against primary sources (sbr.gov.au, ato.gov.au, tpb.gov.au)
> plus competitor pages. General information only — not legal or tax advice; the TPB conclusions
> still need the lawyer review the launch map's legal ticket (#524) already requires.

## Verdict

**Quillo cannot lodge an individual's return itself, and no software vendor can either.** The ATO's
only machine channel for an individual income tax return (the SBR **IITR** service, the same one the
Practitioner Lodgment Service runs on) accepts exactly one initiating party: a **registered tax
agent**. That includes *reading* the ATO prefill. Xero, MYOB and QuickBooks give Quillo no way round
this: their tax products are practice software that lodges on the *agent's* credentials.

The closest lawful thing to "automatic" is a **partner registered tax agent**. Quillo hands over a
structured pack, the agent reviews and signs off, and lodges through PLS. To the user it feels like
one button ("Have an agent lodge it"), usually within a business day. That is how Etax and AusTax AI
work.

**Recommended ship-it paths for the spec:**

1. **Self-lodge in myTax (default, free path).** Quillo produces a myTax worksheet. The user types
   it in. Quillo stays a non-customised software tool under TPB(GS) 14/2011.
2. **Partner agent lodges it (paid path, the "automatic" option).** A registered agent partner
   receives the pack, reviews it, gets the signed declaration and lodges through PLS. Needs a partner
   and a commercial model. That decision graduated to a new ticket.
3. **Quillo becomes a registered agent: not now.** It stays out of scope unless the owner redraws the
   destination (see "Route 4" below for what it would take).

## The route table

| # | Route | Who is the lodging party | What Quillo would need | Lead time / cost | TPB position |
|---|---|---|---|---|---|
| 1 | **myTax self-lodge**, with the user retyping Quillo's worksheet | The taxpayer, via myGov | Nothing from the ATO. A worksheet keyed to myTax labels (`accountant-schedule.ts` already maps deductions to D-labels) | Build effort only | Fine *if* the worksheet stays non-customised and every figure is the user's own confirmed assertion (GS 14/2011 Ex 5) |
| 2 | **Partner registered agent** lodges through PLS/SBR | The agent | A partner agreement. Agent–client relationship linked in ATO systems (client update relationship service). The taxpayer's signed declaration to the agent (e-sign). A structured hand-off pack. A fee flow | Weeks (find the partner, agree terms, wire the hand-off). The agent fee is the user's cost (current benchmarks: Etax from $87.49, H&R Block assisted $109 / students $89 — see `standard-journeys.md`) | The agent provides the tax agent service. Quillo stays the tool. A referral commission must be disclosed by the agent under Code item 5 |
| 3 | **Quillo lodges directly via SBR IITR** (as a "self-lodger" DSP) | N/A, because **it doesn't exist** | — | — | The IITR initiating-party table lists *Tax agent: Y; BAS agent, Business, Business Intermediary: N* for every interaction, including `IITR.get` (prefill), `IITR.validate` and `IITR.submit` |
| 4 | **Quillo registers as a company tax agent** and lodges via SBR | Quillo | TPB company registration: a "sufficient number" of registered individual tax agents to supervise (a question of fact, no fixed minimum, an ongoing requirement). PI insurance. The Code of Professional Conduct. ATO DSP Operational Security Framework for the software. A signed declaration per lodgment | Months, plus qualified staff on payroll | Removes the boundary, but every customised output then carries agent liability. Turns a software company into a tax practice |
| 5 | **Via Xero / MYOB / QuickBooks APIs** | The agent using that software | — | — | Same as route 2: their lodgment features only work for a registered agent's PLS/SBR credentials. Using them would just be route 2 with extra steps |

## Evidence

- **SBR IITR service, 2025 Business Implementation Guide (ATO IITR.0012).** "This document defines
  the interactions that are available to a tax agent … to lodge an IITR". Table 31 (*Initiating
  parties Access Manager permissions*): LDG.List, LDG.get, IITR.get (pre-fill), IITR.validate,
  IITR.submit, IITRPRFL.get and ELSTagFormat.submit are all **Y for Tax agent only, N for BAS agent,
  Business and Business Intermediary**. §4.1: "The tax practitioner to taxpayer relationship is a
  fundamental precondition to interacting with SBR for all IITR interactions". The intermediary must
  first receive "a signed written declaration from that taxpayer".
  [sbr.gov.au — ATO_IITR.0012_2025 BIG](https://www.sbr.gov.au/sites/default/files/2025-04/ATO_IITR.0012_2025_Business_Implementation_Guide.docx)
- **PLS is for registered agents.** [ATO — Practitioner lodgment service](https://www.ato.gov.au/tax-and-super-professionals/digital-services/practitioner-lodgment-service)
- **Self-lodgers use myTax** (or phone or paper). The self-preparer due date is 31 October; an agent
  client gets the later program date if registered with the agent before 31 October.
  [ATO — Lodge your tax return online with myTax](https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return/lodge-your-tax-return-online-with-mytax)
- **The Etax model.** A TPB-registered practice (#69399005): "a registered tax agent reviews it
  before lodging with the ATO, usually within one business day".
  [etax.com.au/about-etax](https://www.etax.com.au/about-etax/)
- **The AusTax AI model** (closest analogue to Quillo). "AusTax AI is the technology platform; the
  assigned Tax Agent holds the TPB registration". *(Correction 2026-10-03: the A$129 agent service
  page now redirects to a directory — the offer appears withdrawn; see `standard-journeys.md`.)*
  [austaxai.com.au/tax-agent-service](https://austaxai.com.au/tax-agent-service)
- **Hnry** is itself a registered agent; its accountants review and lodge.
  [ATO — lodge with a registered tax agent](https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return/lodge-your-tax-return-with-a-registered-tax-agent)
- **Company registration.** It must have "a sufficient number of individuals, being registered tax
  agents, to provide tax agent services to a competent standard, and to carry out supervisory
  arrangements". This is a question of fact and an ongoing requirement.
  [TPB — tax agent registration](https://www.tpb.gov.au/tax-agent-registration);
  [TPB(GS) 53/2024 Supervision, competency and quality management](https://www.tpb.gov.au/sites/default/files/2026-04/TPB%28GS%29%2053_2024_Supervision%2C%20competency%20and%20quality%20management%20under%20the%20Tax%20Agent%20Services%20Act%202009.pdf)
- **Commissions and conflicts.** Code item 5 requires the agent to manage conflicts, with specific,
  timely disclosure of commissions and preferably written client consent.
  [TPB(GS) 24/2014 Managing conflicts of interest](https://www.tpb.gov.au/tpb-gs-24-2014-managing-conflicts-interest)
- **Unregistered provision for a fee** is a civil penalty (s50-5), and a fee can be indirect or
  bundled. [TPB(GS) 45/2023 What is a fee or other reward](https://www.tpb.gov.au/tpb-gs-45-2023-what-is-fee-or-other-reward).
  Software boundary: [TPB(GS) 14/2011](https://www.tpb.gov.au/tpb-gs-14-2011-digital-service-providers-and-tax-agent-services-act-2009)
  (already analysed in `docs/concept-verdict-findings.md` §d).

## What myTax prefill already gives a first-timer, so Quillo doesn't duplicate it

myTax prefills from third-party reports. For the four first-timer cohorts that is most of the
*income* side: employer income statements (salary, PAYG withheld, RFBA/RESC), bank interest,
dividends, Centrelink and government payments, private health insurance statements, HELP balance,
and, for gig workers, sharing-economy platform reporting where it applies. Prefill is generally
complete by late July. A worksheet that makes a first-timer retype prefilled income adds error
risk for no value.

**Implication for the ship-it step:** the myTax worksheet should be organised around **what myTax
will NOT know**: deductions (work-related D1–D10, WFH and car methods, self-education), ABN
business income and expenses, foreign income for newcomers, and the evidence for each. For the
prefilled lines it should show a short **"check this matches myTax"** list (e.g. "your income
statement from ACME should show ~$X gross"). That catches a missing employer or an un-finalised
income statement, which is the commonest first-timer error. Quillo cannot read the prefill
itself (route 3). It can only infer the expected figures from the bank feed and onboarding.

## Owner decision after this research (2026-10-03)

**Scope narrowed:** the first-timer build delivers the **guided myTax self-lodge path end to end
first**. The partner-agent hand-off (and any automation) comes after, as a later effort. If and when
it lands, **the user pays the agent directly** — Quillo takes no fee tied to the tax agent service
(cleanest TASA position). Partner selection is deferred.

## Consequences for the rest of map #529

- **"Ship it: the myTax worksheet and the agent hand-off" (#538)** can now treat auto-lodgement as
  settled: the partner-agent path *is* the automatic option. Design both paths, not three.
- **New decision, graduated:** which partner agent, and on what commercial terms (user pays the
  agent directly, Quillo resells, or referral fee with disclosure). This is the sharpest open
  question, so it becomes its own ticket.
- **The launch map's legal ticket (#524)** gains a concrete item: the referral or commission
  arrangement with a partner agent must be reviewed alongside the GS 14/2011 safeguards.
- **The positioning pivot holds.** First-timers can "ship it themselves" through myTax for free,
  with an agent lodging as the paid convenience. That matches the market (Etax, AusTax AI, H&R
  Block) without Quillo becoming a tax practice.

## Not verified

- I didn't open Xero Tax, MYOB AE/AO and QBO lodgment docs individually. The conclusion for route 5
  follows from the IITR permission table (any software lodging an IITR does so as a Tax agent
  initiating party), not from each vendor's page.
- The prefill source list above comes from general ATO knowledge, not a single fetched page.
  Confirm it against the ATO's current "pre-filling your tax return" page when the worksheet is
  specified.
- Whether Quillo *receiving* a referral fee from a partner agent makes Quillo's own service "for a
  fee or reward" in TASA terms. That question is for the lawyer (#524).
