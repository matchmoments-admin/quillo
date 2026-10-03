# First-timer personas: what does the engine already cover?

> Findings for wayfinder ticket #531 on map #529 (*Ship-it-yourself: Quillo for first-time
> taxpayers*). Researched 2026-10-03 against the code on `main` (`e441af4`) and primary ATO sources.
> General information only, not tax advice. The goldens and `docs/personas.md` are **not** edited
> here; the proposed additions are a draft at the end.

## Verdict

**Persona FT1 (first-job PAYG) is mostly covered. FT2 (student) and FT3 (gig side hustle) are
partly covered. FT4 (newcomer, WHM or international student) is not covered.** The engine leaves
these cohorts short for three reasons. None of them is missing tax arithmetic.

1. **Bank-only income never reaches the position.** Bank credits are shown beside the position but
   are never counted in it (`src/lib/report.ts:444-450`). Income counts only once it is in the
   `income` table. For a first-timer that means an uploaded income statement or a manual entry. When
   the Sort queue groups credits, it offers rental, business, transfer or gift (`src/lib/clarify.ts:189-198`).
   It has **no "wages" answer**. Nothing tells the user that their income is missing: no readiness
   finding and no checklist item. So a first-timer who connects a bank and stops sees income of $0 and
   their deductions, which gives a negative "position".
2. **Residency is a single AU/foreign switch, and only the deduction-suggestion path reads it**
   (`schema.sql:381`, `web/src/components/SituationFields.tsx:296-299`). Nothing in the model can say
   temporary resident, WHM visa, part-year resident, study loan or Medicare entitlement. Foreign-sourced
   income counts in the position whatever residency the person has.
3. **No persona exercises any of this.** No golden sets `tax_residency`, and no fixture uses
   government payments, a study loan or a side-hustle loss (`scripts/check-personas.ts`).

The headline numbers people expect for these cohorts are WHM 15% rates, the tax-free threshold,
LITO, the Medicare levy and HELP repayments. **Quillo deliberately computes none of them**, and that
is a product invariant: "NEVER tax payable / refund / rates" (`src/lib/readiness.ts:8`,
`src/lib/report.ts:202`). That is the right call for these cohorts, since every one of those figures
is applied by the ATO at assessment. So the gaps are about **capture, labelling and general-info
nudges**, not rate scales. Building a WHM rate scale or a HELP calculator would break the invariant
and should not be ticketed.

## The general mechanisms the gaps reduce to

The owner's constraint is no cohort forks. Every gap below fits into one of six general mechanisms,
and each also serves at least one of the existing 10 personas:

| # | General mechanism | Closes for | Also serves |
|---|---|---|---|
| **M1** | **Income completeness.** A readiness finding plus a checklist item for "the bank shows income credits but no income is recorded", and a wages answer on credits that points to the income statement and never records net pay as gross. | FT1–FT4 | P1, P3, P7 (every PAYG persona) |
| **M2** | **A situation profile with residency periods.** Residency as dated periods (resident / foreign resident / temporary resident), plus visa subclass and flags: study loan, Medicare entitlement statement, ABN holder. The same period mechanism as the property `use_status` gap (the owner's FY26-27 move, recorded on the dogfood map #464). Jurisdiction-neutral because the status values come from the pack. | FT2, FT4 | P6 (expat landlord), any person leaving Australia |
| **M3** | **Residency-aware assessability.** Foreign-sourced `income_type`s are excluded (captured but not in the position, with a defer nudge) when the person is a foreign or temporary resident for that period. Reuses the `NON_ASSESSABLE_INCOME_TYPES` / `excluded_by_type` path (`src/lib/ledger-totals.ts:102,146-149`). | FT4 | P10 (foreign pension) |
| **M4** | **Income-test passthrough.** Show the inputs to the ATO's income tests (repayment income, Medicare) without computing the result. `reportable_amounts` already does this for RFBA/RESC (`src/lib/report.ts:184-188`). Extend it to "your study-loan repayment is worked out by the ATO from these figures". | FT2, FT1 | P2, P7 |
| **M5** | **More income types.** Add `government_payment` (Youth Allowance, Austudy, JobSeeker; taxable, myTax items 5/6) and `foreign_employment`. Today these fall into `other` (`web/src/pages/Income.tsx:22-35`). | FT2, FT4 | P10 |
| **M6** | **Business-loss nudge (Div 35).** When a business activity's expenses exceed its income, show a defer nudge about the non-commercial-loss tests. Deferred on purpose "until sole-trader P&L is modelled" (`src/lib/readiness.ts:799`). Attribution now gives per-activity expenses, so that precondition is close. | FT3 | P4, P5, Erin (TS) |

## Persona FT1: Jess, first-job PAYG employee

| | |
|---|---|
| **Shape** | 19–24, one employer for part or all of the year (started mid-year), salary paid into one bank account, small work deductions (uniform, phone, a course), may work from home. Resident. Tax-free threshold claimed with that one employer. |
| **Overlaps** | P1 Maya (PAYG, WFH, small deductions). Jess's difference is that **she brings a bank feed, not an income statement**. |

| Capability | Engine | UI in | Display | Evidence |
|---|:---:|:---:|:---:|---|
| Salary from an income statement (gross, tax withheld) | ✓ | ✓ | ✓ | Upload: `web/src/pages/Income.tsx:61-79` (`income_statement_upload` ON); type `salary_payg` |
| Salary from the bank feed | ✗ | ◑ | ◑ | Credits are shown but never counted (`report.ts:444-450`). Sort offers no wages answer (`clarify.ts:189-198`). |
| Occupation-tailored deductions (retail, hospitality, apprentice, cleaner, etc.) | ✓ | ✓ | ✓ | `src/rulepacks/au-v1.json` `occupations` (17 keys) + `au-occ-*` rules |
| WFH fixed rate | ✓ | ✓ | ✓ | Onboarding WFH days (`web/src/pages/Onboarding.tsx:258-268`); `wfh_fixed_rate_cents_per_hour` 70 |
| Simplified single-PAYG surface | ✓ | ✓ | ✓ | `payg_express` (`src/lib/db.ts:175-187`) |
| "Upload your income statement" on the year-end checklist | ✗ | ✗ | ✗ | `generateChecklist` lists 7 PAYG deduction items and **no income item** (`src/agent.ts:4325-4347`) |
| Tax-free threshold claimed with two payers (a second job started) | ✗ | ✗ | ✗ | No signal. Two `salary_payg` rows are aggregated (P7) but never flagged. |
| Super guarantee for under-18s (the 30-hour rule) | n/a | | | Out of scope: an employer obligation, not part of the return. |

**Gaps:**
- **G1 (M1, defect class).** Bank-only income is silently absent. There is no readiness finding
  (the `assessReadiness` finding ids at `src/lib/readiness.ts:429-792` include no income-completeness
  check) and no checklist item. The `nothing_captured` blocker (`readiness.ts:410-431`) does not fire
  when only credits exist and they have been categorised.
- **G2 (M1).** No wages answer on a credit group. The only income answers are "Rental income" and
  "Business income" (`clarify.ts:189-192`). A salary deposit is pushed towards "Business income"
  (wrong: it triggers PSI/GST nudges at `readiness.ts:636-675`) or towards "Personal / gift (not
  income)" (wrong: it ignores the credit). The server already has an `income_personal` answer kind
  (`clarify.ts:126`, `src/agent.ts:5363-5364`), but it records the credit **net** as an untyped
  `personal` income row, with no withholding and no label (`incomeTypeWhy` falls through to its
  default at `readiness.ts:123-137`). If the user later uploads their income statement, the
  `salary_payg` row would count **on top of** the `personal` row. The credit was already marked
  `matched_income_id` + `ignored` (`agent.ts:5286`), so no dedup suggestion will ever pair them.
  The UI doesn't offer this answer for groups today, so it's latent rather than live. It's still the
  first thing a "derive from bank data" design would reach for, so record it now.
- **G3 (M4-adjacent).** A "two payers" nudge: two or more `salary_payg` payers in a year leads to a
  general-info note that the tax-free threshold is generally claimed from one payer only, and that
  claiming it from more than one can lead to too little being withheld. It never predicts the outcome.

## Persona FT2: Mia, student working part-time

| | |
|---|---|
| **Shape** | 18–23, a casual retail or hospitality job (income possibly under $18,200), Youth Allowance or Austudy, a HELP debt, textbooks, a laptop for uni. Resident. |
| **Overlaps** | P1 (PAYG), P7 Nadia (self-education rule). Nothing else. |

| Capability | Engine | UI in | Display | Evidence |
|---|:---:|:---:|:---:|---|
| Casual PAYG wages | ✓ | ✓ | ✓ | Same path as FT1, with the same G1/G2 bank gap |
| Youth Allowance / Austudy (taxable) | ◑ | ◑ | ◑ | Only as `other` (`Income.tsx:22-35`). It counts in the position, but no label and no item mapping (`readiness.ts:136`). |
| Self-education limited to current employment | ✓ | ✓ | ✓ | `au-gen-self-education` (defer, current-role wording) and the `payg_self_education` checklist item. Study for a future career is correctly framed as generally not deductible. |
| HELP balance | ◑ | ◑ (NOA only) | ◑ | Only from a prior-year NOA: `hecs_balance_cents` (`src/extract.ts:832`, `src/lib/noa.ts:13`), shown on Filing (`web/src/pages/Filing.tsx:326`). No current-year flag. |
| HELP repayment-income inputs | ◑ | ✗ | ◑ | RFBA/RESC are surfaced (`reportable_amounts`, `report.ts:184-188`), but nothing ties them to "your study-loan repayment" for a user known to have a loan. |
| Tax-free threshold, LITO, "may not need to lodge" | ✗ (by design) | | | The invariant says never compute tax or rates. A `non-lodgment advice` education note is a product decision (see open decisions). |

**Gaps:**
- **G4 (M5).** A `government_payment` income type, labelled for myTax items 5/6 and assessable. Today
  this taxable income can only be entered as `other`.
- **G5 (M2 + M4).** A study-loan flag on the situation profile. With the flag set, the position shows
  an info line: "your compulsory study-loan repayment is worked out by the ATO from your repayment
  income (taxable income plus these reportable amounts); Quillo doesn't calculate it". **No
  repayment figure.** 2025-26 brings the new marginal repayment system: nil to $67,000, then 15c per $
  over $67,000. A student under the threshold has nothing to see, but a first-job graduate does.

## Persona FT3: Sam, PAYG job plus a gig side hustle with an ABN

| | |
|---|---|
| **Shape** | Part-time or full-time PAYG, plus food delivery or Airtasker work under an ABN. Turnover well under $75,000, not GST-registered (it isn't ride-sourcing). The first year may show a **loss** (bike or phone bought, low income). Platforms report to the ATO under the Sharing Economy Reporting Regime. |
| **Overlaps** | P4 Priya (full-time rideshare, GST from the first dollar), P3 Lukas (cash side job). Sam is the **sub-threshold, side-scale** case that neither persona exercises. |

| Capability | Engine | UI in | Display | Evidence |
|---|:---:|:---:|:---:|---|
| Business income as its own type | ✓ | ✓ | ✓ | `business` (P4 golden) |
| Business income from bank credits | ✓ | ✓ | ✓ | Sort's "Business income" answer leads to `recordCreditAsIncome` (`agent.ts:5271-5287`, `5363-5366`) |
| Sole-trader activity + expense attribution | ✓ | ✓ (Settings only) | ◑ | `attribution_engine` ON. Onboarding has **no sole-trader/ABN path**: the entities step offers company/employment/novated lease (`Onboarding.tsx:288-306`), and the activity is created in Settings. |
| Rideshare GST from the first dollar | ✓ | | ✓ | `rideshare_gst_first_dollar` (`readiness.ts:671-675`). Heuristic: occupation `driver` or a business-activity label (`agent.ts:4142-4148`). |
| GST threshold nudge | ✓ | | ✓ | `gst_registration_threshold` (`readiness.ts:663-669`) |
| PSI check | ✓ | ✓ | ✓ | `psi_check` (`readiness.ts:636-645`) |
| Business loss against salary (Div 35) | ✗ | ✗ | ✗ | An individual business activity's expenses reduce the individual position without limit. The Div 35 deferral is unmodelled (`readiness.ts:799`). |
| Platform payout net of fees | ◑ | | | A bank credit is the **net** payout. Income tax nets out the same, but turnover (GST threshold, the ≥$20k Div 35 test) is understated. |
| Platform annual statement ingest (SERR) | ✗ | ✗ | ✗ | Nothing extracts an Uber/DoorDash/Airtasker earnings summary |

**Gaps:**
- **G6 (M6).** Div 35 non-commercial-loss defer nudge when an individual business activity runs at a
  loss. ATO rule: the loss is deferred unless income for the year is under $250k **and** one test is
  passed: ≥$20k assessable business income, profit in 3 of 5 years, ≥$500k real property, or ≥$100k
  other assets. A first-year side hustle typically passes none of them. A nudge has no effect on money.
  Applying the deferral to the position would change a money output, which makes it a decision.
- **G7.** A "side business / ABN" path in onboarding. This belongs to the onboarding/IA spec (map
  fog), not this ticket. The vocabulary also misleads: the `income_business` bucket is described to
  the categoriser as "business revenue received by the **Pty Ltd**" (`src/rulepacks/au-v1.json:8`),
  so a sole trader's payouts are described wrongly to the model. That's a rule-pack wording fix, and
  it needs the eval gate.
- **G8.** Platform statement ingest, the gross-fares source. It generalises with broker/registry
  statement ingest (#456): one "third-party annual statement" extractor family.

## Persona FT4: Lena, newcomer (WHM visa 417/462 or international student)

| | |
|---|---|
| **Shape** | Arrives mid-year. WHM: farm or hospitality work, an employer that may or may not be a registered WHM employer, a foreign bank account, leaves before 30 June and claims DASP. International student (>6-month course): usually a resident, but a **temporary resident** whose foreign income isn't assessable. May hold a Medicare Entitlement Statement. |
| **Overlaps** | **None.** No golden sets a non-AU residency. |

| Capability | Engine | UI in | Display | Evidence |
|---|:---:|:---:|:---:|---|
| Residency captured | ◑ | ◑ | ◑ | `persons.tax_residency` (`schema.sql:381`). Values are `AU`/`foreign` only (`SituationFields.tsx:296-299`). The type comment says `AU\|UK\|...` (`src/lib/db.ts:49`), so the value space is undefined. |
| Temporary-resident status | ✗ | ✗ | ✗ | Not modelled |
| WHM visa (rates, employer registration) | ✗ | ✗ | ✗ | Not modelled. Rates are out of scope by design, but the **WHM label in myTax** and the 15%-vs-30% withholding check aren't. |
| Part-year residency (arrival/departure dates) | ✗ | ✗ | ✗ | Not modelled. It drives the part-year tax-free threshold in myTax ($13,464 + $4,736 × months/12), which the ATO applies. |
| Foreign income for a foreign or temporary resident | ✗ (wrong) | ✓ | ✓ | `foreign_*` income types count in the position whatever the residency (`ledger-totals.ts:146`). A temporary resident generally doesn't declare foreign income, so the position is **overstated**. |
| Deduction suggestions for a non-resident | ◑ | | ◑ | Every rule is forced to "defer" with "confirm whether Australian deductions apply to you" (`agent.ts:3843-3846`, `3887-3897`). Safe, but too broad: work deductions against Australian employment income still apply to foreign residents and WHMs. |
| CGT discount | ✓ (partial) | | | Denied when `tax_residency !== 'AU'` (`src/agent.ts:3675`, `src/lib/cgt.ts:68`). Temporary residents aren't distinguished. A rare case for this cohort. |
| Medicare levy exemption | ✗ | ✗ | ✗ | No capture of the Medicare Entitlement Statement. Education only, since the ATO applies the levy. |
| DASP on departure | n/a | | | Outside the return: a super-fund claim. Education only. |

**Gaps:**
- **G9 (M2).** Residency periods plus a visa field. This is the structural gap, and it is the same
  shape as the property `use_status` periods the owner's own FY26-27 move needs. Build one dated-period
  primitive and use it for both.
- **G10 (M3).** Residency-aware assessability of `foreign_*` income. **Changes a money output**, so it
  needs owner sign-off. The safe first step is a **review finding** when foreign income exists for a
  non-AU-resident person. That's a nudge with no money effect.
- **G11.** Narrow the blanket non-resident defer, so that a non-resident with Australian employment
  income still sees occupation suggestions (with a residency caveat). This changes copy and grouping,
  not money.
- **G12 (M5).** A `foreign_employment` income type. Also the WHM income label, once M2 knows the visa.

## Ranked gap list

Ranked by how many of the four personas a gap blocks, weighted by money risk:

| Rank | Gap | Mechanism | Personas | Money effect | Status |
|---|---|---|---|---|---|
| 1 | G1: bank-only income silently absent, with no finding or checklist item | M1 | FT1–4 | Position understated, unflagged | **build-ready** (nudge + checklist item only) |
| 2 | G2: no wages answer; latent net-as-gross + double-count path | M1 | FT1–4 | Latent double count | Answer shape needs a decision. The "never record net pay as gross" guard is build-ready. |
| 3 | G9: residency periods + visa + flags (situation profile) | M2 | FT2, FT4 | Enables G10 | Waits on the map's situation-profile fog |
| 4 | G10: foreign income counted for non-residents | M3 | FT4 | Overstated position | Review nudge **build-ready**; the exclusion needs a decision |
| 5 | G6: Div 35 business-loss nudge | M6 | FT3 | Loss offsets salary unflagged | **build-ready** (nudge only) |
| 6 | G4/G12: `government_payment`, `foreign_employment` types | M5 | FT2, FT4 | None (they already count as `other`) | **build-ready** (additive type + label, golden) |
| 7 | G5: study-loan flag + repayment-income passthrough | M2+M4 | FT2, FT1 | None | Waits on M2 |
| 8 | G3: two-payer tax-free-threshold nudge | M1/M4 | FT1, FT2 | None | build-ready (nudge) |
| 9 | G11: non-resident blanket defer too broad | M2 | FT4 | None | Small; best done with M2 |
| 10 | G7: `income_business` rule-pack wording; sole-trader onboarding | — | FT3 | Categorisation quality | Wording build-ready (eval gate); onboarding waits on the spec |
| 11 | G8: platform statement ingest (SERR) | — | FT3 | Turnover accuracy | Pair with #456 |

## Open decisions for the owner (not resolved here)

1. **G2: what does "this is my wages" do to a bank credit?** (a) It records nothing and asks for the
   income statement. Recommended: a bank credit can't evidence gross pay or tax withheld. (b) It
   records a provisional row that the income statement supersedes. (c) It records net pay as income
   (today's latent behaviour: wrong).
2. **G10: exclude foreign income from the position for foreign or temporary residents?** It's the
   correct ATO treatment, but residency is itself a judgement call (four tests), so Quillo would be
   acting on a self-declared status. Alternatively: show only a review finding.
3. **G6: apply the Div 35 deferral to the position, or only nudge?**
4. **"You may not need to lodge" (non-lodgment advice) education for income under the tax-free
   threshold.** Does a threshold comparison on the indicative position break the "never predict" line?

## Primary sources (ato.gov.au, read 2026-10-03)

- Resident rates 2025-26 / 2026-27 (16% → 15% first bracket from 2026-27): <https://www.ato.gov.au/tax-rates-and-codes/tax-rates-australian-residents>
- Foreign-resident rates (no tax-free threshold): <https://www.ato.gov.au/tax-rates-and-codes/tax-rates-foreign-residents>
- WHM rates (15% to $45,000), which apply mostly regardless of residency: <https://www.ato.gov.au/tax-rates-and-codes/tax-rates-working-holiday-makers>
- WHM employer registration (unregistered employer → 30% withholding): <https://www.ato.gov.au/individuals-and-families/coming-to-australia-or-going-overseas/coming-to-australia/working-holiday-makers>
- Residency tests (resides, domicile, 183-day, Commonwealth super; students on >6-month courses): <https://www.ato.gov.au/individuals-and-families/coming-to-australia-or-going-overseas/your-tax-residency/australian-resident-for-tax-purposes>, TR 2023/1
- Temporary residents (foreign income generally not declared): <https://www.ato.gov.au/individuals-and-families/coming-to-australia-or-going-overseas/your-tax-residency/foreign-and-temporary-residents>
- Part-year tax-free threshold ($13,464 + $4,736 × months/12): <https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/adjustments/part-year-tax-free-threshold>
- Medicare levy low-income thresholds 2025-26 (singles $28,011 / $35,013): <https://www.ato.gov.au/individuals-and-families/medicare-and-private-health-insurance/medicare-levy/medicare-levy-reduction/medicare-levy-reduction-for-low-income-earners>; exemption: <https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/medicare-and-private-health-insurance/medicare-levy-reduction-or-exemption>
- MLS thresholds 2025-26 (singles $101,000): <https://www.ato.gov.au/individuals-and-families/medicare-and-private-health-insurance/medicare-levy-surcharge/medicare-levy-surcharge-income-thresholds-and-rates>
- Study-loan repayment 2025-26 (marginal: nil to $67,000, then 15c per $; repayment income definition): <https://www.ato.gov.au/tax-rates-and-codes/study-and-training-support-loans-rates-and-repayment-thresholds>
- Tax-free threshold with multiple payers: <https://www.ato.gov.au/individuals-and-families/jobs-and-employment-types/tax-free-threshold/multiple-jobs-or-change-of-job>
- LITO (residents only): <https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/tax-offsets/low-income-tax-offset>
- Ride-sourcing ABN + GST from the first trip: <https://www.ato.gov.au/businesses-and-organisations/income-deductions-and-concessions/sharing-economy-and-tax/ride-sourcing/registrations>
- Sharing Economy Reporting Regime: <https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/third-party-reporting/sharing-economy-reporting-regime/what-is-the-serr>
- Business and professional items schedule: <https://www.ato.gov.au/individuals-and-families/your-tax-return/instructions-to-complete-your-tax-return/mytax-instructions/2026/income/sole-trader-and-business-income-or-losses-and-partnership-distributions/business-and-professional-items>
- Non-commercial losses (individuals): <https://www.ato.gov.au/businesses-and-organisations/income-deductions-and-concessions/losses/non-commercial-losses/offset-or-defer-the-loss-individuals-or-sole-traders>
- Government payments (Youth Allowance / Austudy taxable): <https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/income-you-must-declare/government-payments-and-allowances>
- Self-education (current employment; $250 reduction removed from 2022-23): <https://www.ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/deductions-you-can-claim/work-related-deductions/education-training-and-seminars/self-education-expenses/self-education-reduction-in-expenses>
- DASP (WHM 65%): <https://www.ato.gov.au/individuals-and-families/super-for-individuals-and-families/super/temporary-residents-and-superannuation/departing-australia-superannuation-payment-dasp>
- Non-lodgment advice: <https://www.ato.gov.au/individuals-and-families/your-tax-return/how-to-lodge-your-tax-return/lodge-a-non-lodgment-advice>

**Unconfirmed:** whether the 2021 proposal to reform the individual residency tests has been
legislated (the ATO page still lists the four tests); the exact apportionment of a WHM's income from
outside the visa period.

---

## Proposed `docs/personas.md` additions (draft, not merged)

> Draft for the coordinator. Adopting it means adding these rows to the persona table and new
> fixtures to `scripts/check-personas.ts` **in the same PR as the mechanism each one exercises**
> (the persona-contract invariant). Until then these personas are a coverage lens, not goldens.

### First-timer personas (launch cohort, map #529)

| # | Persona | Core tax shape |
|---|---------|----------------|
| FT1 | **Jess**, first-job PAYG | one employer, started mid-year, **bank feed instead of income statement**, small work deductions |
| FT2 | **Mia**, student, part-time | casual wages possibly under the tax-free threshold, Youth Allowance, HELP debt, self-education for the current role only |
| FT3 | **Sam**, PAYG + gig side hustle | PAYG + sub-threshold ABN food delivery/Airtasker work, **first-year business loss**, not GST-registered |
| FT4 | **Lena**, newcomer (WHM / international student) | part-year arrival, **temporary/foreign residency**, WHM visa, foreign bank income, Medicare entitlement statement |

### Coverage rows to add

| Capability | Engine | UI in | Display | Flag | Personas |
|---|:---:|:---:|:---:|---|---|
| Income completeness (bank credits vs recorded income) | ✗ | ✗ | ✗ | — | FT1–4, 1, 3, 7 |
| Wages answer on a credit (never net-as-gross) | ✗ | ✗ | ✗ | — | FT1–4 |
| Government-payment income type | ◑ (`other`) | ◑ | ◑ | — | FT2 |
| Study-loan flag + repayment-income passthrough | ◑ (NOA balance) | ✗ | ◑ | `reportable_amounts` (ON) | FT2, FT1 |
| Residency periods / temporary resident / visa | ✗ (AU/foreign only) | ◑ | ◑ | — | FT4 |
| Residency-aware foreign income | ✗ | ✓ | ✓ | — | FT4, 10 |
| Div 35 business-loss nudge | ✗ | — | ✗ | — | FT3, 4, 5 |

### Proposed goldens (one per mechanism PR)

- **`pft1`** (M1): bank salary credits plus an income statement for the same job. The position
  counts gross salary **once**. With no income statement, an income-completeness finding fires and
  income stays $0.
- **`pft2`** (M5 + M4): $14k casual wages plus $6k Youth Allowance as `government_payment`. Both are
  assessable and labelled. With the study-loan flag on, the info line appears and **no repayment
  figure** appears anywhere in the report.
- **`pft3`** (M6): $40k PAYG plus $3k delivery income against $5k bike and phone costs. The Div 35
  nudge fires, and no rideshare or GST-threshold nudge does. Flag OFF gives byte-identical output.
- **`pft4`** (M2 + M3): a temporary resident with Australian wages and a foreign-income row. The
  foreign income is excluded or flagged per the owner's G10 decision, and occupation suggestions still
  appear with a residency caveat (G11).

