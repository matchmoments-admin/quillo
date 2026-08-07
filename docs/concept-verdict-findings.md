# Concept verdict: pivot or persevere

> Wayfinder ticket #515 (map #514 — route to production launch). Researched 2026-08-07 by two
> primary-source passes: one external (ato.gov.au / tpb.gov.au / competitor pricing pages, fetched
> and verified directly), one internal (this repo's ADRs, schema, pricing code, all cited
> file:line). General information only — nothing here is tax or legal advice.

## Verdict at a glance

| Pillar | Verdict | One line |
|---|---|---|
| (a) Value vs the free path & competitors | **PERSEVERE** | Quillo sits exactly in the gap the ATO says it will not fill, and the market already pays $60–$800/yr for adjacent slices of it. |
| (b) Buyer & positioning | **PERSEVERE — repositioned** | Lead with "evidence vault + accountant pack" (serves the 62% who use agents); self-lodge help is the secondary message, not the headline. |
| (c) Scale & unit economics | **PERSEVERE** | ~$2/user-yr inference COGS; single-D1 ceiling is hundreds of heavy users to low thousands of light ones, with a sharding path already sketched in ADR-0001. |
| (d) The missed thing: TASA/TPB boundary | **PERSEVERE, with conditions** | An LLM saying "this looks deductible" for a fee walks near the registered-agent line (s50-5 penalties: $82,500 / $412,500). Manageable — the review workflow is literally TPB's prescribed safeguard — but it must become explicit, launch-gating work. |

Net: **persevere**. The destination of map #514 (public, paid, AU-resident launch) stands. Three
things change shape: positioning (b), pricing (fed into the pricing ticket), and the legal ticket
inherits a concrete TPB safeguard checklist (d).

---

## (a) Value vs the free path and paid competitors — PERSEVERE

**What the free path actually covers.** myTax pre-fills the *income* side — employers/STP, bank
interest (single accounts from 2022, joint from 2024), dividends, health funds, managed funds —
and now locks high-confidence prefill behind "adjustment reasons"
([pre-filling your online return](https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return/lodge-your-tax-return-online-with-mytax/pre-filling-your-online-tax-return)).
The income side of tax prep is commoditised; competing there is pointless.

**What the ATO explicitly does not do.** The ATO states it cannot pre-fill or automatically verify
most *deduction* items
([tax and individuals not in business](https://www.ato.gov.au/about-ato/research-and-statistics/in-detail/research-for-individuals-and-families/tax-and-individuals-not-in-business)).
Written evidence must be kept 5 years from lodgment — for CGT assets, 5 years after no CGT event
can happen, i.e. hold-period + 5 for property — and "a bank or credit card statement on its own
isn't written evidence"
([records you need to keep](https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/records-you-need-to-keep)).
The free myDeductions tool has no rental-property category (verified by omission across the ATO's
category lists), stores records on a single device only, and uploads to myTax once per year
([myDeductions](https://www.ato.gov.au/online-services/online-services-for-individuals-and-sole-traders/ato-app/using-mydeductions/mydeductions)).

**Quillo's build is the complement of that list**: bank-line deduction mining, receipt-to-evidence
linking, per-property schedules, CGT records with third-element costs, a 5-year substantiation
vault, and an accountant pack with a substantiation-gaps section (src/lib/accountant-schedule.ts:592-1275).
That is not a me-too myTax; it is the half of the job the ATO has said stays with the taxpayer.

**The paid market validates the price of that half:**

| Product | Price | Bank feeds |
|---|---|---|
| TaxTank Property Tank (closest analogue) | $15/mo annual (~$180/yr), ≤5 properties, +$36/yr each extra ([pricing](https://taxtank.com.au/pricing/)) | Yes — CDR via Basiq as ADR (same architecture Quillo chose) |
| Etax | from $87.49 + **$59.90 per rental schedule** ([fees](https://www.etax.com.au/etax-fees/)) | No |
| H&R Block | $334 package incl. **one** rental ([fees](https://www.hrblock.com.au/tax-return-fees-and-pricing)) | No |
| Sharesight | Tax Pack from $59/yr; Standard $29/mo ([pricing](https://www.sharesight.com/au/pricing/)) | Registry feeds, not CDR |
| Accountant, individual + 2–3 rentals | ~$300–$800+ (secondary sources only — flag) | — |

A three-rental investor pays roughly $180 (TaxTank) to $500+ (agent) per year today. Quillo's
current pricing is cost-plus-30% on ~$2/yr of inference (see (c)) — i.e. **~$0.60/yr of margin for
a job the market prices in hundreds of dollars**. The value proposition is validated; the pricing
shape is wrong. → Fed into ticket #523 (Pricing and Stripe live-mode).

## (b) Buyer & positioning — PERSEVERE, repositioned

- Lodgment split, 2023-24: **agent 62.1% / myTax 37.5%** — stable for years ([ATO taxation statistics 2023-24](https://www.ato.gov.au/about-ato/research-and-statistics/in-detail/taxation-statistics/taxation-statistics-2023-24/statistics-in-taxation-statistics-2023-24/individuals-statistics-for-taxation-statistics-2023-24)).
- **2,335,540 individuals hold rental interests; ~663k hold 2+ properties; 54.2% are negatively geared** (same source, Table 8). This is the beachhead segment, and it matches the owner's own data shape (property-heavy, prod-data-shape memory).
- ATO tax-gap commentary: incorrect claims concentrate in work-related and **rental** expenses, and mistakes are *more* prevalent in agent-prepared returns than self-prepared ([source](https://www.ato.gov.au/about-ato/research-and-statistics/in-detail/research-for-individuals-and-families/tax-and-individuals-not-in-business)) — evidence quality is the problem, and it is upstream of who lodges.

**Implication.** Positioning Quillo as a DIY-filing helper fights for the 37.5% and competes with
free myTax on its strongest ground. Positioning it as the **year-round evidence vault whose output
is either a myTax-ready position or an accountant pack** serves the whole market — including the
62% who will never self-lodge but still bear the record-keeping burden. The product already built
the accountant pack (accountant-schedule.ts); this is a marketing-surface pivot, not a product
pivot. Deduction-evidence quality is also the tax-gap story the ATO itself tells, which is a
credible launch narrative.

## (c) Scale & unit economics — PERSEVERE

**Ceiling.** ADR-0001 is explicit: the per-tenant DO is a write-coordinator/audit façade; the
single shared D1 is the store and the ceiling (docs/adr-0001, decision section). At the owner's
shape (~2,355 txns/FY, ~1.5 KB/row all-in with 10 indexes on `transactions`, 5-year retention)
a steady-state user costs ~25–30 MB ⇒ **~330–400 owner-shaped users, or ~2,000–3,000 light users,
per 10 GB D1 database**. First bottleneck is D1 size, second is single-DB write throughput —
exactly what the ADR says to monitor, and it already sketches the shard-by-tenant migration path
behind the `env.DB`/`queries.ts` seam.

**Unit economics.** Categorisation is batched (~40 lines/call, src/agent.ts:1022,1086-1087), only
`needs_review` lines reach Claude, and the rule-pack system prompt is ephemeral-cached
(src/extract.ts:119,502). On the coded `au.` Bedrock Haiku rates (src/lib/usage.ts:25-31), a
~2,400-txn + ~200-receipt year costs roughly **$1.60–$2.60 of inference** (upper bound; Bedrock
gets no batch discount, src/agent.ts:1052-1056). Guardrails already exist: $5/day/user,
$25/day and $200/month platform-wide (wrangler.toml:83-90) — note the $200/month global cap is
the *actual* growth ceiling today and must be raised deliberately at launch.

**Revenue shape today**: usage-based wallet, cost × 1.30, no subscription (wrangler.toml:106-107;
src/lib/billing.ts:40-44). Safe — the wallet gate means usage can't run negative-margin and the
worst-case exposure is the $5 signup grant — but it monetises Quillo like an API proxy, not like
a $180–$500/yr job-to-be-done. Pricing decision belongs to ticket #523; the input from this pillar
is that **COGS is a rounding error, so price on value, not cost**.

## (d) The missed thing — the TASA/TPB regulatory boundary — PERSEVERE, WITH CONDITIONS

The biggest risk to the concept is not competitive or technical; it is that Quillo, charging a fee
while an LLM tells an identified user "this looks deductible", drifts into providing an
unregistered **tax agent service** under the Tax Agent Services Act 2009:

- The definition needs (advising about liabilities/entitlements under a taxation law) + (circumstances where the client can reasonably be expected to **rely** on it) + fee or reward — and a bundled/subscription fee counts ([TPB(GS) 44/2023](https://www.tpb.gov.au/tpbi-392023-what-tax-agent-service); [TPB(GS) 14/2011](https://www.tpb.gov.au/tpb-gs-14-2011-digital-service-providers-and-tax-agent-services-act-2009)).
- Penalties for unregistered provision for a fee: up to **$82,500 (individual) / $412,500 (body corporate)** under s50-5 (figures as cited by TPB, GS 44/2023).
- **Non-customised software is explicitly fine** ("merely a tool which assists the user to meet their own requirements", GS 14/2011 Ex 5) — but customised, circumstance-specific advice where reliance is reasonable is a tax agent service (Ex 3–4), and **a disclaimer alone is not determinative** (GS 14/2011).
- TPB's July 2026 AI guidance (TPB(GS) 55/2026) governs *registered agents* using AI; there is no regime yet for consumer AI tax tools — the operative boundary for Quillo remains GS 14/2011 + GS 44/2023.

**Why this is survivable, not fatal.** GS 14/2011 names the safeguards an unregistered provider
should have: present the collated data to the client, provide **mechanisms to review and verify
correctness** before use, retain evidence of that verification, and carry an appropriately worded
declaration. Quillo's architecture is *already* shaped like that list — every suggestion carries
GENERAL-INFO framing, `defer_to_agent` rules route judgement calls to a registered agent, refunds
are never predicted, and the entire review workflow exists so the **user confirms every
categorisation** (the confirm/ignore triage flow). The hash-chained audit log is retained evidence
of user verification. The gap is that none of this has been deliberately mapped against the TPB
guidance or reviewed by a lawyer.

**Conditions attached to the persevere:**
1. Ticket #524 (Legal and privacy) inherits a concrete checklist: map each GS 14/2011 safeguard to
   its implementation; tighten copy so suggestions read as "candidate for your review", never
   conclusions; the not-a-registered-agent declaration; and put the boundary question itself to a
   human lawyer before public launch.
2. Product invariant going forward: **no feature may auto-assert a tax conclusion without user
   confirmation.** (`quillo_fee_deduction` auto-asserting its own fee as deductible — flagged in
   the 2026-07 audit as the only self-assertion in the product — should be reviewed under this
   lens in #524.)
3. Marketing surface (#new launch-surface ticket) must sell the vault and the evidence, not "AI
   does your deductions".

## What this changes on map #514

- **Destination: unchanged.** Public, paid, AU-resident, owner-gated launch stands.
- **Positioning decided**: evidence vault + accountant pack first; self-lodge support second. Unblocks #522 (onboarding audit — "first value" = evidence captured and position visible, not "return filed") and #523 (pricing — value-based, benchmarked against TaxTank/Etax/agent fees, not cost-plus).
- **#524 (Legal and privacy)** inherits the TPB safeguard checklist above and becomes unambiguously launch-gating.
- **Fog graduated**: the public launch surface (landing, waitlist, first users) is now specifiable under the decided positioning.

## Verification notes

Flagged as unverifiable on primary sources despite attempts: POP Tax pricing (JS-only site;
secondary sources say $14–$94 tiers); the literal s50-5 text on legislation.gov.au (rate-limited;
penalty figures verified via TPB's own guidance); "myDeductions does not support rental" as an
explicit ATO sentence (true by category-list omission on two current ATO pages plus the App Store
description); market-wide accountant-fee averages (secondary only). Internal estimates (users-per-
10GB, per-user inference cost) are derived from schema shapes and coded rates — the coded rates
themselves carry a "VERIFY against current pricing" caveat (src/lib/usage.ts:17-18).
