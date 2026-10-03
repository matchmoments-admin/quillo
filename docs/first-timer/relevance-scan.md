# What can be derived from bank transactions + onboarding to find a first-timer's claims?

> Findings for wayfinder ticket #532 on map #529 (*Ship-it-yourself: Quillo for first-time
> taxpayers*). Researched 2026-10-03 against ato.gov.au, the repo at `e441af4`, and aggregate
> (count-only, no PII) queries on prod D1. General information only. This is not tax advice.
> Feeds #534 (bank data minimisation), #535/#536 (onboarding questions) and #540.

## Verdict

**A feed tells Quillo *where to look*. It cannot tell Quillo *what is claimable*.** For a
first-timer, roughly three-quarters of what the return needs is either in the ATO prefill already
or stated by the user. The feed's real job is narrower, and more valuable than it sounds:

1. **Detect the income shapes that change the return.** A second payer, platform payouts (ABN /
   GST from the first dollar for rideshare), foreign inflows, interest from a bank the user forgot.
   The ATO prefill catches salary, Centrelink and interest. It does **not** prefill sharing-economy
   income. SERR data is used to cross-check, not to prefill.
2. **Surface the few debit lines that match the user's occupation profile** (uniform, registration,
   union, tools, course fees) and let deny-by-default bury the rest.
3. **Prompt for the facts no feed can carry**: WFH hours, work km, self-education nexus, residency
   dates, reimbursement status. These come from onboarding and continued configuration.

Most of the engine exists: the occupation token set, 17 occupation guides, 32 claimability rules,
the deny-by-default stamp and the situational "Find My Claims" sweep. Three seams stop it working
as a **relevance scan** today:

- the occupation rules never run on bank lines;
- the deny list is occupation-blind and substring-matched, so it buries a nurse's AHPRA renewal;
- the situation profile has no slot for residency type, ABN activity or HELP.

**Manual-sort estimate:** today's pipeline makes a user touch about **8–15% of lines**. A
profile-driven relevance scan should cut that to about **3–6%**: roughly 40–70 lines on a typical
first-timer year of ~1,200 lines, grouped into 10–20 merchant decisions. The working is in §6.

## 1. Sources

**ATO (primary).** Pages were reached via search, because ato.gov.au returns 403 to automated
fetches. Figures are as published for 2025–26.

- [Occupation and industry specific guides (index)](https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/guides-for-occupations-and-industries/occupation-and-industry-specific-guides)
- [Retail industry workers](https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/guides-for-occupations-and-industries/r-z/retail-industry-workers-income-and-work-related-deductions) · [Hospitality worker toolkit (PDF)](https://www.ato.gov.au/api/public/content/923415da-e500-4a07-8a65-b99f75d80ff5_TaxTimeToolkit_Hospitalityworker_pdf) · [IT professionals](https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/guides-for-occupations-and-industries/e-k/it-professionals-income-and-work-related-deductions) · [Office workers](https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/guides-for-occupations-and-industries/l-q/office-workers-income-and-work-related-deductions) · [Tradies](https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/tradies-be-certain-about-what-you-can-claim) · [Apprentice summary](https://www.ato.gov.au/api/public/content/0-54a4961a-006e-46cd-abd3-e647f83b3cce) · [Teacher summary](https://www.ato.gov.au/api/public/content/0-bccb512b-334c-415f-9104-1bde7902d5a1) · [Ride-sourcing income and deductions](https://www.ato.gov.au/businesses-and-organisations/income-deductions-and-concessions/sharing-economy-and-tax/ride-sourcing/income-and-deductions-for-ride-sourcing)
- [WFH fixed rate method (70c/hr, actual-hours record required)](https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/deductions-you-can-claim/work-related-deductions/working-from-home-expenses/fixed-rate-method) · [Cents per km (88c, 5,000 km cap)](https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/deductions-you-can-claim/work-related-deductions/cars-transport-and-travel/motor-vehicle-and-car-expenses/expenses-for-a-car-you-own-or-lease/cents-per-kilometre-method)
- [Clothing, laundry and dry-cleaning ($150 laundry exception)](https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/deductions-you-can-claim/work-related-deductions/clothes-and-items-you-wear-at-work/clothing-laundry-and-dry-cleaning-expenses) · [Records you need to keep ($300 total exception)](https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/records-you-need-to-keep)
- [Pre-filling 2026](https://www.ato.gov.au/tax-and-super-professionals/for-tax-professionals/prepare-and-lodge/pre-filling-service/pre-filling-reports/pre-filling-2026) (income statements, Centrelink/DVA, interest) · [What is the SERR?](https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/third-party-reporting/sharing-economy-reporting-regime/what-is-the-serr) (taxi/ride-sourcing from 1 Jul 2023, all other platforms from 1 Jul 2024, used for data matching, not prefill)
- [Working holiday makers](https://www.ato.gov.au/individuals-and-families/coming-to-australia-or-going-overseas/coming-to-australia/working-holiday-makers) (15% on $0–$45,000 in 2025–26) · [Studying in Australia](https://www.ato.gov.au/individuals-and-families/coming-to-australia-or-going-overseas/coming-to-australia/studying-in-australia) (a course of 6+ months may make you a resident) · [Australian resident for tax purposes](https://www.ato.gov.au/individuals-and-families/coming-to-australia-or-going-overseas/your-tax-residency/australian-resident-for-tax-purposes)

**Repo.** File:line references are at `e441af4`. `src/lib/report.ts` contains a NUL byte, so grep
it with `grep -a`.

**Data.**
- `evals/baseline.json`: 7/12, 58%. The 5 failures returned `unknown` for want of situation context.
- Prod D1 aggregates on 2026-10-03, for the single owner tenant (property-heavy, not a first-timer):
  2,393 bank lines, 206 answered clarify questions, 125 user rules.

## 2. What exists today

| Piece | Where | What it does | Relevance-scan role |
|---|---|---|---|
| Occupation token picklist (17) + aliases | `web/src/content/occupations.ts:7-25`, `normaliseOccupation` `:46` | Maps a typed label to a canonical token. Free text passes through lower-cased | ✅ the profile key |
| `persons.occupation` | `schema.sql:380`; written by `src/lib/situation-write.ts:41-64`; edited in `SituationFields.tsx:300-322` | One occupation per person | ✅, but single-valued (a student with two casual jobs has two) |
| `income_activities.occupation_scope` | `situation-write.ts:861-880` | Stored, explicitly *"not yet wired into claimability (persons.occupation still drives that — #156)"* | ⚠️ the second, unreconciled occupation field (EPIC #426 already lists it) |
| Occupation guides (17 × suggest/warn) | `src/rulepacks/au-v1.json:171+`; `src/lib/occupations.ts:23` | General-info "people commonly claim…" copy plus anti-pattern warnings | ✅ education copy for each profile |
| Claimability rules (32: 6 `all`-occupation generics, 21 occupation, 5 property/entity) | `au-v1.json:35-…`; matcher `src/lib/claimability.ts:48-73` | `matchClaimRules` = scope + merchant-hint substring | ⚠️ **receipt path only**: `agent.ts:2207` (`suggestClaims`). The statement categoriser (`agent.ts:1034-1110`) and the feed categoriser (`agent.ts:1894-1950`) call only `stampDeductibility` |
| Situational sweep "Find My Claims" | `agent.ts:3824-3926`; `claimability.ts:110-170` | Groups rules into capturing/check/defer by situation; merchant ignored | ✅ the profile-to-checklist engine. Capturing for occupation rules depends on fired suggestions, so it never sees bank lines |
| AI gap-fill for uncovered occupations | `extract.ts:1275-1376`, `agent.ts:3935` | Drafts candidate occupation rules for user confirmation | ✅ the long tail beyond 17 jobs |
| Deny-by-default stamp | `src/lib/deductibility.ts:84-110`; lists `au-v1.json:144-170` | payg lines: deny → apportion → allow_suggest → undetermined | ⚠️ occupation-blind, substring-matched (see D1) |
| Categoriser prompt | `agent.ts:6828-6857` + `renderSituation` `src/lib/db.ts:209-260` | Includes `occupation X` and residency per person, buckets and merchant hints | ✅ gets the occupation, but its bucket model has no "work-related candidate" signal; deductibility is decided later by rules |
| Movement classifier | `src/lib/statements.ts:155-250` | Card payments / own-account transfers auto-ignored; loans and investments go to review | ✅ the cheapest irrelevance filter |
| Pattern scan (`txn_scan_v2`, ON) | `agent.ts:4010-4030`; `src/lib/scan.ts:190-215` | Salary ≥ $50k with < $300 of deductions → quotes the occupation guide; salary with no WFH hours → prompt | ✅ the first "ask what the feed can't show" behaviour |
| Readiness: `occupation_missing`, `rideshare_gst_first_dollar` | `src/lib/readiness.ts:473`, `:671`; rideshare hint list `agent.ts:4142` | Completeness and GST nudges | ✅ |
| Feed sync (Basiq, flag `bank_feed_cdr` OFF) | `src/lib/basiq.ts:420-505`; DO insert `agent.ts:1783-1820` | Posted-only, per-account collection, provider `class` kept but **never used as a tax category** (`basiq.ts:347`) | Same categorise path as statements |
| WFH / car inputs | `work_use_inputs` `schema.sql:981-994` | Hours, days per week, km, record flag | ✅ the "must ask" store (#435 decides where it lives) |
| Residency | `SituationFields.tsx:296-298` | **Binary** AU / foreign | ❌ no WHM, no part-year, no student-visa dates |
| HELP / study loan | none | Not modelled anywhere in `src/` | ❌ (education only; the ATO computes the repayment) |

## 3. Occupation → deduction categories (first-timer jobs)

**How to read the coverage columns.**
- **Pack** = an occupation guide plus a claimability rule exist in `au-v1.json`.
- **Feed-visible** = whether the evidence typically shows up as a recognisable bank line.

Every category also needs the user to confirm it was not reimbursed (ATO golden rule 1). No feed
can show that.

| Cohort job (pack token) | ATO-published common categories | Pack | Feed-visible? | Must come from the user |
|---|---|---|---|---|
| Retail (`retail_worker`) | Compulsory/logo uniform + laundry; union (SDA); overnight work travel; self-education for the current role; phone work-use | ✅ | Union debits ✅ (SDA direct debit). Uniform 🟡 (merchant ≠ item). Laundry ❌ | Laundry loads (≤ $150 needs no written evidence); phone work-use % |
| Hospitality (`hospitality_worker`) | Protective items (non-slip shoes, aprons), chef whites, knives (> $300 set depreciates), RSA/RCG/food-safety renewals, union, training | ✅ | Renewals ✅ (state liquor regulator / RTO). Knives and shoes 🟡 (**denied today**, D1) | Was the item compulsory or protective; reimbursement |
| Nurse / health / aged care (`nurse`, `healthcare_worker`, `aged_care_worker`) | AHPRA annual registration, memberships, non-slip shoes, fob watch, stethoscope, PPE, self-education for the current role, travel between clients | ✅ | AHPRA ✅ (distinctive merchant, **denied today**, D1). Union ✅ (**HSU denied today**). Equipment 🟡 | Between-client km; course nexus |
| Office / admin (`office_professional`) | WFH running costs (fixed rate), phone/internet work-use, memberships, self-education, equipment depreciation | ✅ | Telco/NBN ✅ (apportion state). Laptop ✅ (`asset` bucket) | **WFH hours** (a feed never has them); work-use % |
| IT (`it_professional`) | As office, plus certifications and equipment | ✅ | Cert vendors 🟡; SaaS ✅ (merchant hints route to `company`, a wrong default for PAYG IT staff, see D5) | WFH hours; work-use % |
| Tradie / apprentice (`tradesperson`, `apprentice`) | Tools (≤ $300 immediate, sets depreciate), PPE, steel caps, sun protection, union, TAFE you paid, between-site car | ✅ | Bunnings / Total Tools / Sydney Tools ✅; TAFE ✅. **"safety footwear" denied today** (D1) | Work km (cents/km); whether TAFE was subsidised; tool-set grouping |
| Teacher (`teacher`) | Registration (VIT/NESA/QCT), WWCC, classroom supplies, excursions, union, self-education, WFH | ✅ | Registration ✅; Officeworks 🟡 (private or work?) | Reimbursement; WFH hours |
| Rideshare / delivery (`driver`, ABN) | **Business income, not PAYG.** Car via logbook or cents/km, platform fees, phone, cleaning; GST from the first dollar for ride-sourcing only | ✅ guide; GST nudge | Payouts ✅ (`UBER`, `DIDI`, `DOORDASH`, `MENULOG`); fuel ✅ | Logbook or km; ABN/GST status; gross fares vs net payout (fees are netted, so the platform statement is needed) |
| Student, no job yet | Usually nothing. Self-education is **not** deductible without current income-earning nexus | n/a | — | Course ↔ current-job link |

**What's missing from the pack for this cohort:** a `student` token, `childcare_worker`,
`warehouse/logistics`, `call_centre`, `fitness_instructor` and `delivery_rider`. The AI gap-fill
(`extract.ts:1348`) covers them as candidates, but a first-timer cohort justifies authoring them.

## 4. Income signals detectable in a feed

| Signal | Feed pattern (credit) | Also in the ATO prefill? | What it unlocks | Exists today? |
|---|---|---|---|---|
| Salary/wages | Same payer, fortnightly cadence, `SALARY`/`PAY`/`WAGES` + employer name | ✅ (income statement, finalised by 14 Jul) | The employer list, plus a **second-job** detection that drives occupation per job and a withholding check | Categoriser labels `income_personal:salary`; no cadence/payer detector |
| Multiple employers | ≥ 2 distinct payroll payers | ✅ | Prompt for a second occupation; tax-free threshold claimed twice → likely shortfall (education, never a refund figure) | ❌ |
| Platform payouts | `UBER B.V.`, `DIDI`, `DOORDASH`, `MENULOG`, `AIRTASKER`, `AIRBNB`, `MADPAW`, `HIPAGES` | ❌ **not prefilled** (SERR is data matching only) | ABN activity → business schedule, GST nudge (ride-sourcing), driver profile, logbook prompt | Rideshare hint only reads occupations and activity labels (`agent.ts:4142`), **not credits** |
| Centrelink | `SERVICES AUSTRALIA`, `CENTRELINK`, `DSS` (Youth Allowance, Austudy, JobSeeker) | ✅ (Centrelink/DVA feed) | Taxable government payment, which affects offsets; confirm the prefill | Labelled `income_personal:government-benefit` ad hoc |
| Interest | `INTEREST`, `CREDIT INTEREST`, bonus saver | ✅ (financial institutions) | Usually nothing to do; flags an account the user didn't connect (a completeness hint) | ❌ detector |
| Foreign transfers | `WISE`, `REMITLY`, `WESTERN UNION`, `INTL TFR`, FX-converted credits | ❌ | Residency question (newcomer/WHM/student); foreign income vs gift/family support | FX path exists (`fx.ts`); no residency prompt |
| Parental/family transfers | Person-name credits, `PAYID` from an individual | ❌ | Almost always **not income**: clarify `ignore` | Clarify flow (`clarify.ts:127,224`) |
| Refunds/reimbursements | Merchant reversal; employer non-payroll credit | — | Employer reimbursement **cancels** the matching deduction (golden rule 1) | `refund` bucket; no reimbursement ↔ expense link |
| Dividends | `CBA DIV`, share registry | ✅ (partially) | Grow path (capital tranche) | Categoriser label |

Prod evidence that credits are the hard part: 76 of 344 credit lines (22%) were bucket- or
label-corrected, against about 9% overall. Labels like `income_personal:transfer`,
`income_personal:rent-and-transfers` and `personal-reimbursement` show the model calling transfers
income. 60 credit lines sit in the expense bucket `payg` (see D6).

## 5. Claims never in a feed: these must come from onboarding or configuration

| Fact | Why the feed can't carry it | Store today | Asked when |
|---|---|---|---|
| WFH hours (fixed rate, actual-hours record since 1 Mar 2023) | Time, not money | `work_use_inputs.wfh_*` | Onboarding (WFH days, `Onboarding.tsx:262`) + `txn_scan_v2` prompt |
| Work km / logbook | Distance, not money; fuel ≠ km | `work_use_inputs.car_work_km`, `car-logbook.ts` | Only when the profile has a car-using job or a platform payout |
| Work-use % (phone, internet, laptop) | A split of a private bill | Inline claim/attribution | When an apportion-state line appears |
| Not reimbursed | Employer reimbursements are often netted into pay | — | At confirm (one checkbox per group) |
| Self-education nexus to the **current** job | The same TAFE fee is deductible for one person and not for another | — | When a course line appears and the profile has an occupation |
| Compulsory / protective nature of clothing | The merchant can't show it | — | When an occupation rule fires on a clothing line |
| Residency type + arrival/departure dates | Never in a ledger | `persons.tax_residency` (binary) | Onboarding (newcomer branch) |
| HELP/VSL/STSL debt | ATO-held; affects withholding only | none | Education only. No need to store (data minimisation) |
| Private health cover (MLS) | The statement, not the premium debit | PHI statement path | When a PHI debit is detected (merchant hint exists) |
| Laundry (≤ $150 without written evidence) | Home laundry has no transaction | — | Uniform-wearing occupations |
| Cash tips, cash side jobs | Never banked, or banked as an anonymous deposit | income records | Profile (hospitality, tradie side job, persona 3) |

## 6. Share of lines needing manual sorting

**Prod (owner tenant, 2,393 bank lines; property-heavy, so an upper bound for the bucket problem):**

| Measure | Lines | Share |
|---|---|---|
| Left `unknown` by the model (now-unknown 25 + corrected away from unknown ~150) | ~175 | ~7% |
| Genuine bucket change (746 bucket corrections minus 528 same-bucket "confirm as-is") | ~218 | ~9% (of which 38 are property routing a first-timer won't have) |
| Credits corrected | 76 / 344 | 22% of credits |
| Ignored (transfers / not spend) | 135 | 5.6% |
| Debits needing a **deductibility** decision (undetermined 164 + apportion 85 + suggested 10) | 259 / 1,957 | 13% of debits |
| Debits auto-buried by deny-by-default (`likely_not`) | 1,622 / 1,957 | **83% of debits** |
| Clarify questions answered | 206 | ≈ 1 question per 12 lines (groups amplify; 125 rules learned) |

**Eval:** 5/12 cases (42%) fail because a bare merchant without situation context correctly
returns `unknown`. Context, not model quality, is the limit.

**First-timer estimate.** Assume ~100 lines a month (~1,200 a year), a single PAYG job and no
property:

- **Today's pipeline: about 8–15% need a touch** (~100–180 lines). That is every unknown, every
  undetermined payg debit and every ambiguous credit, and the user wades through the whole review
  queue.
- **Relevance-first scan: about 3–6%** (~40–70 lines, ~10–20 grouped decisions). Only three kinds
  of line reach the user:
  - credits that aren't a confirmed payroll payer or an own-account transfer (~3% of lines);
  - debits that hit an occupation/generic rule or an apportion list (~2–4%);
  - true unknowns above a dollar floor.

  Everything denied or below the floor stays out of the queue, which is safe because deny-by-default
  already excludes it from the position.
- The **dominant residual is credits**, not debits. Income ambiguity (transfer vs income vs
  reimbursement) drives most of the effort for a first-timer. A side-hustler (platform payouts plus
  fuel) sits at the top of the range.

## 7. Defects found (verified with a probe against the live rule pack)

| # | Defect | Evidence | Direction | Build-ready? |
|---|---|---|---|---|
| D1 | **Deny list is substring-matched and occupation-blind.** `health` denies "AHPRA *Australian Health* Practitioner Regulation Agency" and "*Health* Services Union". `shoes/footwear` denies "safety footwear" and "non-slip work shoes". `bar` denies "*Bar*beques Galore". `pub` denies "*Pub*lic Transport Victoria". Deny also beats `allow_suggest` (union) | `deductibility.ts:54-60` (`haystack.includes(tok)`), precedence `:95-101`; `au-v1.json:154-155`. Probe: `verdictForTxn('payg', …)` → `likely_not` for all five | Under-claim: the top nurse/health deductions are buried and never surfaced | Partly. Word-boundary matching is a clear fix (rule-pack + eval gate). Deny-vs-occupation precedence changes what's surfaced (not the position), so the owner should confirm it |
| D2 | **Claimability merchant hints are substring-matched.** `ama` (AMA) matches **Amazon** → union-fee suggestion. `tal` (TAL insurer) matches **Total Tools**, hospi**tal**, digi**tal** → income-protection suggestion. `asu` matches **casu**al | `claimability.ts:28-36`; `au-v1.json:49,51`. Probe: `matchClaimRules` | Noise plus false "capturing" in Find My Claims (fired suggestion ids count as evidence, `claimability.ts:158-169`). Suggestions never count, so no over-claim | **Yes**: token/word-boundary matching in `merchantMatches` + a unit golden |
| D3 | **Occupation rules never run on bank lines.** `suggestClaims` is called only on the receipt path | `agent.ts:2207` vs `:1034-1110`, `:1894-1950` | A bank-only first-timer gets zero occupation-specific line suggestions | Needs a design decision (it is the core of the scan, §8), so not a drive-by fix |
| D4 | `income_business` is defined as **Pty Ltd** revenue, and the SaaS merchant hints route to `company` | `au-v1.json:3-14,16-30`; sole-trader income is `income.income_type='business'` (`taxonomy.ts:50`) | Gig payouts and PAYG IT staff's subscriptions get mis-framed for a first-timer with no company | Rule-pack wording change + eval; part of the scan ticket |
| D5 | Credits sitting in expense buckets (60 `payg` and 19 `property_rented` credits in prod; labels like `payg:personal-spend`) | prod aggregate | Direction-inconsistent data. #341 fixed Clarify, but the categoriser can still emit them | Low; fold into the scan's credit triage |
| D6 | Residency is binary; no WHM/part-year/student; HELP unmodelled | `SituationFields.tsx:296-298` | Newcomer cohort unsupported | Spec decision (#536 onboarding) |
| D7 | No persona for a student/first-job/WHM taxpayer | `docs/personas.md:16-25` | The coverage contract doesn't test the launch cohort | Needs a new golden alongside the profile work |

## 8. Proposed model: situation profile → scan

One **situation profile** per person, derived from onboarding and refined over time. It **drives**
scanning and education. It does **not** fork the model by cohort. Everything is additive to today's
`persons` row plus `income_activities`.

```
SituationProfile (per person, per FY where it can change)
  jobs[]          : { occupation_token, payer_hint?, wfh: bool, uses_own_car: bool }   ← replaces single persons.occupation
  abn_activities[]: { kind: rideshare|delivery|freelance|other, gst_registered }      ← income_activities (exists)
  residency       : { type: resident|foreign|whm|student, from?, to? }               ← extends tax_residency
  flags           : { help_debt: bool (education only, not stored if declined), private_health: bool }
  state           : AU state (education content only; return math stays federal)
```

**The scan (deterministic, rules-first; the LLM only explains):**

1. **Movement filter** (exists, `statements.ts:199`): card payments and own transfers out.
2. **Credit triage.** Classify each credit as `payroll(payer)` | `platform(kind)` | `government` |
   `interest` | `foreign` | `person-to-person` | `refund` | `unknown`. A deterministic payer/cadence
   detector runs first, then the categoriser.
   - New credit kinds **propose** profile changes (a new payer → "second job?"; a platform → "add an
     ABN activity?"). The user confirms each. The scan never asserts.
3. **Debit relevance.** Build the rule set:

   ```
   rule set = claimability rules where scope ∈ profile
              (occupation tokens + 'all' + abn kinds)
            + apportion lists
   ```

   - Run `matchClaimRules` on **bank lines**, not just receipts (D3), with word-boundary matching
     (D2).
   - An occupation rule hit overrides a generic deny (D1). It surfaces as `suggested`, never
     counted, so deny-by-default holds.
4. **Output three lists:**
   - **Relevant**: lines the user should sort, grouped by `groupKey`.
   - **Prompts**: facts to state (WFH hours if `wfh`, km if `uses_own_car` or a platform, residency
     dates if `foreign` credits).
   - **Irrelevant**: denied, or matched nothing below the floor. These are candidates for
     minimisation (#534).
5. **Re-scan on profile change.** A new job or a new ABN re-runs steps 3–4 over lines still inside
   the retention window. The window must therefore outlive the plausible "I forgot to say I drive
   Uber" lag.

Jurisdiction-neutral by construction: the profile fields are generic, and the occupation tokens,
rule sets and deny lists come from the jurisdiction's rule pack.

## 9. Input for the data-minimisation decision (#534)

- **Irrelevant is the majority.** In prod, 83% of debits are deny-by-default `likely_not`, plus
  5.6% are movements. For a first-timer, expect **≥ 85% of lines to be irrelevant** once the scan
  runs.
- **Relevance is not stable at ingest.** It depends on the profile, which the user refines after
  seeing the data (second job, platform payouts, WFH). So **"relevant-only at ingest" is unsafe**.
  The supported shape is **relevant + unsorted-pending, with a bounded window**. That window should
  run until lodgement for the FY, or ~60 days after the FY's lines arrive, whichever is later. After
  it, irrelevant lines collapse to aggregates.
- **What to keep per line:**
  - **Credits:** keep all (income completeness, ~14% of lines).
  - **Relevant debits:** keep the line plus evidence links.
  - **Irrelevant debits:** after the window, keep only a per-FY, per-account **tie-back aggregate**
    (count, sum, first/last date). Statement reconciliation needs the subtotals, not the rows. This
    composes with `assertCanonicalSource` because the account stays one source, only thinner.
- **CDR:** this matches ADR-0003's collection-side minimisation. The provider `class` is already
  discarded as a tax signal, and `postDateFilter` scopes by account (syntax still unverified,
  `basiq.ts:391`).

## 10. Proposed tickets / fog

**Candidate tickets.** Not created; the map owner decides.

1. **Relevance scan engine.** Run claimability on bank lines, credit triage, three-list output,
   flag-gated. Includes D3 and D4. Engine plus UI plus display, with a new persona golden.
2. **Word-boundary matching** for `merchantMatches` (D2) and `listHits` (D1 part a). Build-ready:
   rule-pack/matcher only, unit goldens, eval gate.
3. **Occupation overrides generic deny** (D1 part b). `needs-decision`, because it changes what's
   surfaced for review.
4. **Situation profile entity:** multi-job, residency type and dates, ABN activities. Reconcile
   `persons.occupation` with `occupation_scope` (overlaps EPIC #426 and the map's "data-model
   shape" fog).
5. **Payroll payer / cadence detector**, plus second-job and platform-payout prompts.
6. **First-timer persona golden(s):** student with two casual jobs; WHM; nurse grad; Uber
   side-hustle (D7).
7. **Author the missing occupation guides** (student, childcare, warehouse, call centre, delivery
   rider).

**Fog this resolves or sharpens on the map:**
- *"Data-model shape for the situation profile"*: answered in shape (§8). Placement (`Settings` vs
  a new entity) is still open.
- *"Grow path: what unlocks a layer"*: credit triage is the natural unlock trigger (a detected
  platform payout or dividend proposes the layer).
