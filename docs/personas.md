# Quillo persona coverage

The **10 Australian taxpayer personas** are Quillo's coverage contract. They are the lens for every
change to the data model, the tax-position pipeline, or the user workflow. This doc is the canonical
tracker; the executable counterpart is `scripts/check-personas.ts` (`npm run test:personas`), which
drives each persona through the real `buildReport` and asserts its position.

> **Invariant (see CLAUDE.md):** any change to the schema, the money/position pipeline, or the workflow
> must keep `npm run test:personas` green for all 10 and update this file if coverage changes. New tax
> features land **additive + feature-flag-gated**, and add or flip a persona golden in the same PR.

## The personas

| # | Persona | Core tax shape |
|---|---------|----------------|
| 1 | **Maya** — PAYG renter | single PAYG salary, WFH, small work deductions |
| 2 | **Daniel** — hybrid knowledge worker + investments | PAYG + shares/ETF dividends + RSUs + CGT |
| 3 | **Lukas** — tradesperson | PAYG + tools/PPE + ute + cash side job |
| 4 | **Priya** — rideshare / gig | ABN sole trader, **GST from $1**, high-km car |
| 5 | **Tom** — sole trader / freelancer | ABN business, GST, PAYG instalments, home studio |
| 6 | **Susan & Greg** — co-owned landlords | co-owned negatively-geared rentals, Div 40/43, CGT on sale |
| 7 | **Nadia** — nurse (multi-employer) | multiple PAYG, self-education, uniform, occupation claims |
| 8 | **James** — company + discretionary trust | trust streaming, bucket company, Div 7A, GST |
| 9 | **Aisha** — startup founder | pre-revenue Pty Ltd, R&D, s40-880, ESS |
| 10 | **Margaret** — self-funded retiree / SMSF + crypto | SMSF pension/ECPI, franking, crypto CGT |

## Workflow (the 6-stop happy path)

`Set up → Bring in → Sort → Check → Position → File`. Web pages map roughly:
Set up (Accounts, Income, Assets, Settings/entities), Bring in (Documents/import), Sort (Inbox),
Check (Reconcile, Review), Position (Dashboard, Reports), File (Filing).

## Coverage status (2026-06-10)

Legend — **engine**: backend computes it (✓ live behind flag); **UI**: a web surface to enter the data;
**display**: the result is rendered. A persona is "end-to-end" only when all three hold.

| Capability | Engine | UI in | Display | Flag | Personas |
|---|:---:|:---:|:---:|---|---|
| PAYG salary + WFH + deductions | ✓ | ✓ | ✓ | (live) | 1,3,7 |
| Negative-gearing rentals + Div 40/43 | ✓ | ✓ | ✓ | (live) | 6 |
| Multi-income aggregation | ✓ | ✓ | ✓ | (live) | all |
| Sole-trader `business` income | ✓ | ◑ income only | ✓ | — (additive) | 4,5 |
| Sole-trader activity + attribution | ✓ | ✓ activity-create form (Settings) + txn attribution | ◑ | `attribution_engine` (ON) | 4,5,8 |
| CGT (shares/crypto/property) | ✓ | ✓ units/owner, brokerage + cost-base elements, purchase→holding from a deposit, dividend↔holding link | ✓ derived position (units + cost base remaining), over-disposal + no-cost-base findings, closing-holdings carried forward on the accountant pack | `cgt_engine` + 6 × `capital_*` (all ON) | 2,6,8,9,10 |
| Employee Share Scheme | ✓ | ✓ | ✓ | `ess_engine` (ON) | 2,9 |
| GST registration flag | ✓ | ✓ | ✓ | — | 4,5,8 |
| Indicative BAS (from ledger) | ✓ | ✓ GST-registered toggle | ✓ | `gst_bas` (ON) | 4,5,8 |
| Manual BAS periods / PAYG instalments | ✓ | ✓ BAS-period + PAYG-instalment forms (Settings) | ✓ | `gst_bas` (ON) | 4,5,8 |
| Motor-vehicle logbook | ✓ | ✓ | ✓ | `car_logbook` (ON) | 3,4,5,7 |
| Occupation content (person-level) | ✓ | ✓ | ✓ | — | 3,7 |
| Occupation scope on an activity | ✓ | ✗ | ◑ | — | 3,7 |
| Trust distributions / streaming | ✓ | ✓ | ✓ | `trust_distributions` (ON) | 8 |
| SMSF / pension / ECPI | ✓ | ✓ entity kind + member balances (#171) | ✓ | `smsf_engine` (ON) | 10 |
| Accountant schedule export (itemised CSV: per-txn lines, engine schedules, NOT-CLAIMED, substantiation) | ✓ | ✓ Reports/Filing download | ✓ | `accountant_schedule` | all |
| Quillo fee → D10 "cost of managing tax affairs" deduction (auto-recorded on a paid Stripe top-up) | ✓ | ✓ Billing top-up | ✓ | `quillo_fee_deduction` (ON) | all (golden: pfeeon/pfeeoff) |

**Bottom line (2026-06-10).** The *engines* for all 10 personas are live and **every persona flag is
ON in prod** — `cgt_engine, ess_engine, car_logbook, trust_distributions, attribution_engine, gst_bas,
smsf_engine` — with their input UIs shipped (#170–#177: GST/BAS forms, SMSF entity + member balances,
super contributions, activity-create). So end-to-end in the app today:

- **Complete:** P1, P2, P3, P4, P5, P6, P7, P10 — enter the data, see the position, download the
  deliverable. The accountant handoff is the **itemised accountant schedule CSV** (#179/#181, flag
  `accountant_schedule`): per-transaction lines with substantiation, the engine schedules, and an
  EXPLICITLY-NOT-CLAIMED section with reasons — every section tied back to `buildReport` exactly
  (asserted per persona).
- **Nearly:** P8 (company + trust ✓; Div 7A depth thin), P9 (ESS ✓; R&D / s40-880 blackhole costs are
  engine-only — no auto-claim, and `rd_claims` has no writer, so there is no capture form. #126 was
  closed not-planned; a capture form is an open product decision for the grow path, see
  [`first-timer/persona-2-9-trace.md`](first-timer/persona-2-9-trace.md) D5).
- **Remaining (tracked):** xlsx skin (#180), occupation scope on activities (#156), advisory phases
  (#182–#184).

Verify flag state against `wrangler.toml` FEATURES (the source of truth) rather than trusting this prose.

### Audit wave 4 additions (2026-07)

- **Persona TS (Erin, e-commerce sole trader)** — trading stock (s 70-35, flag `trading_stock`,
  migration 0068): $90k goods sales + opening $8k / closing $12k stock ⇒ a +$4k assessable
  adjustment in the position; a company-scoped stock row is asserted to stay OUT of the personal
  headline (separate taxpayer); flag OFF asserted byte-identical. Engine ✓ (`tradingStockAdjustment`)
  + UI ✓ (Income → Trading stock card) + display ✓ (position, readiness nudge, accountant schedule).

### Capital tranche (2026-07) — coverage correction

Phase 0 of the capital/CGT brief ([`capital-cgt-findings.md`](capital-cgt-findings.md)) found the CGT
row above was **overstated**: the engine is live and correct, but the input UI could not capture
`cgt_assets.units`, `cgt_events.units_disposed`, a holding description, or the owning person — the
columns have existed since migration 0037 and no surface ever set them. Every user-entered holding in
prod therefore stored `units = NULL`, which makes a running units/cost-base position and a
part-disposal guard *uncomputable* rather than merely unbuilt.

- **C0 (flag `capital_holding_detail`, ON, no migration)** closes the capture gap: units, description
  and owner on the holding form; units sold on the disposal form; units + status rendered on the
  Capital & Equity table and in the accountant schedule's long-blank Units column. Units are
  **display-only** — the persona golden (`pc0on`/`pc0off`) pins that a units-recorded holding reports
  a byte-identical `capital_gains` block, taxable position and CGT subtotal versus a `units = NULL`
  one, with the schedule tie-back holding either way.
- **Persona 2 (Daniel) is now executable.** The gap this tranche opened by finding it: the `p2` fixture is
  a Pty-Ltd + co-owned-rental tenant with *no shares, dividends or CGT rows*, so the persona the capital
  brief names as its coverage lens was untestable while the table claimed it was complete. **`p2cap`** is
  that arm (sibling-tenant precedent: `pfeeon`/`pfeeoff`, `p14`/`p15`) and doubles as the **integration
  golden** for the whole tranche on one realistic return: $140k PAYG + a franked CBA dividend linked to its
  parcel + a Stake-deposit-seeded VAS holding + a company-held BHP parcel + a half-parcel CBA sale with
  brokerage in the cost base + vesting RSUs. 14 assertions, including that the company's $8k gain stays out
  of his headline, that brokerage makes the gain $9.98 smaller than the un-itemised figure, and that every
  accountant-schedule section ties back.
- **C-E (flag `capital_entity_scope`, ON, migration 0070)** fixes a live scoping bug. `cgtTotals` selected
  `cgt_events JOIN cgt_assets` on `user_id` + `fy` only and `cgt_assets` had no entity dimension at all, so
  a company/trust/SMSF parcel was inexpressible — and `addIncome` worked around it by *refusing* to
  materialise an entity distribution's AMMA capital gain, trading a leak for a silent under-count. Now
  `cgt_assets.entity_id` exists, the individual headline excludes **separate taxpayers only** (the precise
  `separateTaxpayerEntityIds` rule, so an `individual`-kind entity — P2's "Me" — keeps counting), the
  accountant schedule applies the *identical* shared predicate so its tie-back still reconciles, and an
  entity's gain is recorded against its own taxpayer instead of vanishing. Golden: persona `pce`.
- **C1 (flag `capital_from_txn`, ON, migration 0071)** closes the purchase→holding loop. Answering
  "Investment / shares (capital — not deductible)" parked the bank line and stamped
  `ato_label='capital:investment'` — a breadcrumb with **zero readers**, laid for "a future CGT cost-base
  feature" and never picked up — so a user tapped ~40 Stake deposits and then hand-typed all 40 again as
  holdings. Now the answer offers an explicit second step ("also start a holding record?"), and confirming
  seeds one `cgt_asset` per parked deposit via a `txn_id`-keyed idempotent rebuild (the 0054/0055 shape).
  A bank line cannot evidence units or a purchase price, so units stay NULL, the cost base is the amount
  *deposited* for the user to confirm, and three readiness findings chase what's missing. **Position-neutral
  by construction** — a `cgt_asset` with no `cgt_event` never reaches `cgtTotals` or the accountant
  schedule, asserted by the golden. Deleting the source transaction clears the parcel (`clearTxnCgt`), and
  a set-based `clearOrphanedTxnCgt` backstops the three bulk-delete paths. Golden: persona `pc1`.
- **C-L (flag `capital_income_link`, ON, migration 0072)** adds `income.cgt_asset_id` — the link the brief
  never created and that two later slices both need. `income` had no path to `cgt_assets`, which is why the
  AMIT cost-base amount isn't merely unapplied but **unattributable** (with no link you cannot know which
  units to adjust) and why a DRP dividend has no parcel to mint against. A holding picker appears on the
  dividend / managed-fund form and a holding lists the income recorded against it, so the association is
  visible from both ends. **Pure metadata** — the golden pins that the position, the income totals and the
  accountant CSV are identical linked vs unlinked. Deleting a holding with linked income is blocked rather
  than silently unlinked. Golden: personas `pclon`/`pcloff`.
- **C2 (flag `capital_cost_base_detail`, ON, migration 0073)** finally keeps migration 0037's promise.
  That migration documented `cost_base_cents` as "purchase + incidental costs (brokerage, stamp duty)" and
  nothing ever captured the incidental costs — no field, no extraction, no breakdown — so a share purchase's
  cost base was understated by exactly the brokerage paid (real money: ~$3–$10 per trade, both sides).
  The holding form now captures purchase / brokerage / other costs / evidence; `cost_base_cents` is
  **computed server-side** from the elements so the one figure every engine reads can never disagree with
  the itemisation; the breakdown lives in `cgt_assets.detail_json` under `cost_base_elements` (mirroring
  `income.detail_json`'s AMMA components blob); and the accountant schedule itemises the elements as
  indented sub-rows **with the subtotal unchanged**, so the tie-back keeps reconciling. Selling costs are
  deliberately excluded — they reduce capital proceeds, not the cost base, and counting them both ways would
  understate the gain. Golden: persona `pc2`.
- **Post-review fixes (`/code-review` on the tranche).** Two real defects the per-slice goldens missed:
  (1) the accountant CSV's cost-base element block described the **whole parcel** while the row above showed
  the cost base of the units **sold**, so on a part-disposal an accountant saw a breakdown that didn't add
  up ($20,000.00 + $19.95 under a $10,009.98 cost base). The block is now headed with the parcel total it
  actually sums to. The section tie-back cannot catch this class of error — it guards the subtotal, not a
  presentation block's internal consistency — so it is asserted directly. PC2 only ever exercised a *full*
  disposal, which is how it shipped; `p2cap` now covers the differing case.
  (2) `cgt_assets.units`/`status` were rendered raw, so a holding still read "200 units · held" after the
  taxpayer sold 100. The parcel row staying immutable is the right model (remaining is derived, the
  acquisition record is never rewritten) — the bug was displaying the acquired figure as the remaining one.
  Both are now derived in `CapitalEquity.tsx` from the disposal events the component already loads.
  Also corrected in the reference fixture: a company-held disposal no longer carries `discount_eligible=1`
  (a company gets no 50% discount), and a deposit-seeded cost base no longer exceeds the money that left the
  bank. Two assertions that could not fail were made discriminating.
- **C3 (flag `capital_position`, ON, no migration)** closes the display gap. The position is **derived**, not
  stored (owner decision): remaining units = acquired − sold, cost base remaining = parcel − the cost base the
  user said they used. Both are arithmetic over user input — **never a parcel selection**, because parcel
  choice changes the gain and is the taxpayer's decision. Derived **server-side** and shipped on the holdings
  payload so the SPA and the server share one definition rather than two that can drift. Three findings:
  over-disposal and over-used cost base are **review** (a missing earlier parcel is the usual cause — Quillo
  surfaces, the agent decides), and the missing-cost-base finding is promoted to **blocker** only when a
  disposal exists against it, which is the one materially-distorted case in the capital set. The accountant
  pack gains an *"Investment holdings at year end (carried forward)"* section — deliberately no `tie_back`,
  since a closing balance contributes to no report figure. Money-neutral: it reads the same `cgt_events` that
  already drive `cgtTotals`. `cgt_assets.status` remains dead-but-present (dropping a column is a destructive
  migration needing its own sign-off). Goldens: `p2cap` extended + `pc3bad`.
- **C3 hardening (multi-agent review on the shipped slice).** Two more live defects the green gates missed,
  both the same shape as #451's — an assertion that could not fail. (1) The closing-holdings section applied
  **no entity predicate**, so a company/trust/SMSF parcel the taxpayer still *held* was carried forward on
  the **individual's** pack and summed into its TOTAL. Its golden passed only because the one entity fixture
  happened to be fully disposed, and was filtered by its derived position rather than by ownership; a *held*
  entity parcel (`p2capCoRio`) is what makes the check able to fail. (2) A zero-cost-base holding *with* a
  disposal raised **two** findings — C3's blocker plus C1's review finding, whose copy ("it doesn't affect
  this year's figures while you still hold it") is false for something sold. Fixing that naively then opened
  the mirror hole: suppressing the review finding for *any* disposal while the blocker covered only
  *personal* parcels left an entity disposal surfaced **nowhere**. The suppression is now exactly as narrow
  as the promotion. Also: the section is now bounded to the report FY (a prior-year pack was showing today's
  position), and both signal queries moved to `src/lib/capital-signals.ts` so the goldens exercise the
  function the Durable Object calls instead of a re-typed copy of its SQL. Goldens: `pc3bad` gains an entity
  disposal and a flag-OFF case; `p2cap` gains a prior-FY pack assertion.
- Still open: DRP parcels (#455), the AMIT cost-base adjustment (#454), broker/registry statement ingest
  (#456), and the jurisdiction seam (#457). Epic #452; handoff `docs/capital-cgt-handoff.md`.

### First-timer personas (launch cohort, map #529) — income capture (#550, 2026-10)

Source findings: [`first-timer/personas-coverage.md`](first-timer/personas-coverage.md) (mechanisms
M1–M6). These four are a coverage lens for the self-lodging first-time taxpayer; goldens `pft1`–`pft4`
(+ `pft5` partial income gap, `pft6` company-income / household / credits-only guards) in `scripts/check-personas.ts` drive real D1 rows through `buildReport`
→ `firstTimerIncomeSignals` (`src/lib/first-timer-signals.ts`, the same function the Durable Object
calls) → `assessReadiness`, and assert that flag `first_timer_income` never moves
`taxable_position_cents` and that flag OFF adds none of the new findings. `pft7` / `pft7b` / `pft7c`
(#571, flag `situation_profile`) write dated situation periods through the real writer
(`upsertSituationPeriod`) and read them back through `profileForFy` / `situationProfileSignals`
(`src/lib/situation-profile.ts`), asserting the profile, the legacy mirrors and the same no-money-change rule.

**myTax worksheet (#575, flag `mytax_worksheet`):** golden `pft12` (FT1 Jess complete: income statement,
D3 uniform, D5 phone at 40%, WFH hours, one unlabelled work row) asserts the worksheet's sections follow
the pack's myTax order, each D-line equals the accountant schedule's per-label subtotal, D-lines + the
unlabelled amount equal the report's deductions, the unlabelled row raises `worksheet_unlabelled`, and
flag OFF ⇒ endpoint 404 + no finding. FT3 Sam (`pft3`) gets the business-items section with per-activity
totals, and a sweep asserts the worksheet's `tie_back` reconciles for every persona tenant. #590 re-ordered the pack to myTax's own order (Contact and bank → Personalise → Income incl. rent and
business → Deductions → Losses/offsets/adjustments → Medicare → Spouse and income tests): `pft12` now also asserts
that order, that the answer sections carry no figure, the occupation answer line, the ABN / contact-the-payer
notes, and that a managed fund distribution is a prefilled CHECK line that still ties back; `pft12p` (a WHM who
became a resident, with a spouse, a study loan and hospital cover; `situation_profile` ON) asserts Personalise
quotes the residency dates and spouse answer, the WHM net income adjustment, the Medicare entitlement question and
the spouse-details question — and that with the profile OFF nothing is read and the figures are identical.

**Relevance scan on bank lines (#578, flag `relevance_scan`):** golden `pft9` (FT nurse grad, bank-only:
AHPRA renewal, HSU dues, nursing shoes, Woolworths, Netflix) runs `runRelevanceScan`
(`src/lib/relevance-scan-run.ts`, the same function the DO's ingest hook calls) and asserts the three job
lines become **worth a look** with a `relevance_scan` card while their deductibility (and the position) is
unchanged; confirming AHPRA moves the position by exactly its amount (and the denied shoes by their full
amount); groceries / Netflix are irrelevant; `pft9r` (same lines, retail worker) gets no AHPRA card until a
nurse employment period is added (re-scan), and loses it again on delete; `pft9o` re-scans on a Settings
occupation edit; flag OFF writes nothing. **Claims step (#587):** a confirm writes the rule's single return
label (the nurse rule's D3/D5 needs the user's pick, refused with `needs_label` until given: AHPRA → D5, shoes →
D3); `pft9d` confirms the rider's fuel WITH a 60% work-use share (exactly $48 of $80, D15); `pft9a` (IT grad)
routes a $1,500 laptop on a depreciating rule to Assets (`needs_asset`), never an immediate claim.

**Residency assessability (#580, flag `residency_assessability`, spec A13):** golden `pft13` (FT4 Lena with
dated periods: `foreign` Jul–Oct, `whm` from November; AU wages, foreign employment dated in each period, an
undated foreign pension) asserts both foreign-employment rows are left out with reason `non_resident_foreign`,
the undated row stays in and raises `foreign_income_undated_part_year`, the readiness lines-sum / accountant
schedule / myTax worksheet tie-backs all hold, the #550 binary nudge is retired once the periods decide, a
`temporary` variant (`pft13t`) keeps foreign employment (pack carve-out), a spouse-only period (`pft13s`) excludes the spouse's foreign rows incl. foreign rent on a property (per-property rent + worksheet rental line follow) while the self person keeps the #550 nudge, binary `tax_residency` alone never
excludes (`pft4` unchanged), and flag OFF (or `situation_profile` alone) is byte-identical for `pft13` and P1–P10.

**We noticed / wages payer (#577, flag `wages_payer`; owner ruling #554):** golden `pft8` (FT1 Jess bank-only:
3 fortnightly "BIG RETAIL PTY LTD" credits + 2 DoorDash payouts) runs the real credit triage and confirm
handlers (`src/lib/credit-triage.ts`, `src/lib/noticed-signals.ts`) over D1 rows: one payroll + one platform
signal; "this is my wages" writes zero income rows, stamps `payer_entity_id` on exactly the 3 credits and
raises a per-employer `income_not_recorded` naming Big Retail; the income statement counts gross once and
clears it; platform confirm records the payouts once as business income; `income_personal` on a stamped
credit is refused; a dismissal survives re-import; flag OFF ⇒ no signal, no finding, no worksheet line.

**End-to-end first-timer journey (#595, all seven journey flags ON):** `scripts/e2e-first-timer.ts` (in `npm test`
after `test:e2e`) drives one fresh tenant (FTe, an apprentice tradesperson) through the four steps over the real
server functions — `ensureTenant` → About you periods through the SPA's `aboutYouWrites` + `fillSituationPeriod`
(re-run writes 0) → the committed fixture statement `evals/statements/westpac-sample.csv` imported twice (the next
fortnight's copy makes the pay recur) → the payroll "We noticed" card (wages marked, **no income from deposits**) →
the income statement (gross once) → the tradesperson tools rule's worth-a-look cards (claim one with its label,
"Not work-related" on the rest) → records (needs a record; WFH hours) → the receipt-match proposal → Match →
readiness 0 blockers → the myTax worksheet in myTax order with `tie_back.ok` → mark as lodged → the lodging-year
default advances. `GET /api/journey` is read at every stage through `readJourney` (the DO's own composition) and
the step statuses must move setup → connect → review → lodge, never backwards. The same year with every journey
flag OFF (legacy paths) must land on the same money and its report + readiness are diffed byte-for-byte against
`scripts/fixtures/first-timer-off-baseline.json` (re-capture with `UPDATE_SNAPSHOT=1`, as `check-au-snapshot`).
It found one bug, fixed with it: open "We noticed" cards were never counted in the Review step.

| # | Persona | Core tax shape | Golden |
|---|---------|----------------|--------|
| FT1 | **Jess**, first-job PAYG | one employer, started mid-year, **a bank feed instead of an income statement**, small work deductions | `pft1` (+ `pft8` bank-only, we-noticed payroll + platform; `pft11` receipt proposals; `pft12` myTax worksheet; `pftrec` records; `pft7a` About you; `pft7l` mark as lodged) |
| FT2 | **Mia**, student, part-time | casual wages from two payers, Youth Allowance, HELP debt, self-education for the current role only | `pft2` |
| FT3 | **Sam**, PAYG + gig side hustle | PAYG + a food-delivery ABN under the GST threshold, **first-year business loss** | `pft3` |
| FT4 | **Lena**, newcomer (WHM / international student) | residency set to non-AU, Australian wages + foreign employment income | `pft4` |
| FT2v | **Mia** variant (#571) | part-year resident (arrived 2026-02-01), two casual jobs with different occupations, HELP debt ticked | `pft7` (+ `pft7b` residency unsure + private hospital cover; `pft7a` About you first-run fill-only) |
| FTn | **Nurse grad**, bank-only (#578) | FT PAYG nurse, no receipts — occupation lines only in the bank feed | `pft9` (+ `pft9r` retail worker re-scan, `pft9o` Settings edit, `pft9d` work-use share, `pft9a` laptop → Assets, `pft9w` internet covered by WFH hours) |
| FT4p | **Lena** with residency periods (#580) | `foreign` then `whm` (variant: `temporary`), foreign employment dated in each period, an undated foreign pension | `pft13` / `pft13t` / `pft13s` |
| FTe | **Apprentice tradesperson**, fresh signup (#595) | statement only (the westpac fixture, twice): fortnightly pay from one employer, Bunnings + Officeworks spend, WFH ticked, one snapped receipt | `scripts/e2e-first-timer.ts` (4-step journey ON + flag-OFF baseline) |

| Capability | Engine | UI in | Display | Flag | Personas |
|---|:---:|:---:|:---:|---|---|
| Income completeness: bank income credits with no matching recorded income (blocker when income is $0, review otherwise; company/trust income recorded under its entity counts as covering business/rent credits) + an "upload your income statement" checklist item. Bank credits are still never counted. | ✓ | ✓ (Income upload / manual) | ✓ readiness finding + checklist (checklist gate pinned in check-units) | `first_timer_income` (ON) | FT1–4, 1, 3, 7 |
| `government_payment` income type (Youth Allowance / Austudy / JobSeeker, items 5/6) | ✓ assessable | ✓ Income form | ◑ item-mapped "why"; raw type label on Filing | `first_timer_income` (ON) | FT2 |
| `foreign_employment` income type (item 20) | ✓ assessable | ✓ Income form | ◑ item-mapped "why"; raw type label on Filing | `first_timer_income` (ON) | FT4 |
| Tax-free threshold with two or more payers (info note, no amount) | ✓ | — | ✓ | `first_timer_income` (ON) | FT2, 7 |
| Div 35 business-loss defer nudge (sole-trader expenses > business income beside other income; single-person tenants only until income is person-scoped; never applied to the position) | ✓ | — | ✓ | `first_timer_income` (ON) | FT3, 4, 5 |
| Foreign income for a non-AU resident (review nudge; income stays in the position — retired once `residency_assessability` decides from dated periods) | ✓ | ✓ residency switch | ✓ | `first_timer_income` (ON) | FT4 (10 only if residency is non-AU) |
| Wages answer on a credit group (never net-as-gross): Clarify "My wages" + the payroll "We noticed" card mark the payer as an employer (entity + `employment` period + `transactions.payer_entity_id`) and record **nothing**; per-employer "income statement not recorded" finding; a stamped credit can never be recorded as income (#554) | ✓ (`pft8`, e2e) | ✓ Clarify answer + "We noticed" cards in the Review queue (#587; Connect hands off to Review, #586) | ✓ readiness finding + worksheet "not entered" employer line; open cards count in the journey's Review step (#595) | `wages_payer` (OFF) | FT1 (`pft8`, FTe), FT2 |
| Credit triage "We noticed…" (0079 `noticed_signals`): payroll / platform payouts / government / interest / foreign, lists in the pack (`credit_signals`), one signal per FY + kind + payer key, dismissals stick across re-imports, evidence = counts/dates/total only. Platform confirm records payouts once as business income + an ABN activity; government/interest add a worksheet "check this matches" line; foreign sets `foreign_income` | ✓ (`pft8`, e2e) | ✓ cards in the Review queue (#587; legacy Accounts panel with `ft_journey` OFF) | ✓ | `wages_payer` (OFF) | FT1, FT2, FT3, FT4, FTe |
| Receipt ↔ bank-line match proposals (A8, #574): confidence-gated suggestions (pack `reconcile.*`), credits matchable, near-ties and contested lines left to the picker, "no bank line this year" bucket, dismissals never re-proposed; **never auto-confirmed** — Match is the existing manual Link; readiness `taxable_position_confirmed_cents` | ✓ (`pft11`, `pft11s` Undo restores the link's donated fields) | ✓ Review queue match cards (#587, absorbing #589): Match / Not this one, the import-time auto-links listed with Undo, the picker incl. credit lines (same-direction only) | ✓ Review step (`ft_journey`) | `reconcile_proposals` (OFF) | FT1 (`pft11`), 1–10 (confirmed ≥ tracked) |
| Situation profile as dated periods per person (`situation_periods`, 0078): residency type with dates, spouse, state, jobs (multi-valued, ref → employer), ABN activities, study / study loan (opt-in), WFH, car, foreign income, private hospital cover. Pack-validated (`situation_facts`); single-valued facts reject overlaps (400). Writes keep the legacy mirrors (`persons.occupation` ← longest job, `tax_residency` ← residency on 30 June, `profiles.private_health`) in the same batch. | ✓ | ✓ About you in Get set up (#585: first-run questions, fill-gaps only, + profile cards) | ✓ About you profile cards; myTax worksheet Personalise quotes them (#590) | `situation_profile` (OFF) | FT2v (`pft7`, `pft7a`), FT4, FTe |
| Relevance scan on bank lines (A4, #578): each debit payg / uncategorised line sorted relevant / worth a look / irrelevant from the profile's occupation tokens per FY + the pack (`relevance.floor_cents`); an occupation rule hit overrides the not-deductible default as a **worth a look** card (`claim_suggestions` source `relevance_scan`) — deductibility never changed, the user confirms every claim; re-scan on any job / ABN / WFH / car / foreign-income period write or a Settings occupation edit | ✓ (`pft9`, `pft9d`, `pft9a`, `pft9w` WFH fixed rate covers internet) | ✓ `POST /api/relevance/confirm` (label pick, work-use share, Assets routing) + `GET /api/relevance` | ✓ Review step worth-a-look cards (#587, `ft_journey`) | `relevance_scan` (OFF) | FTn (`pft9`), FT1–4 |
| Bank data minimisation (A5, #581): once a FY is lodged (mark / NOA, or the due date + 60 days backstop) and a line has been held 60 days, irrelevant debits (payg likely_not / confirmed_not, ignored transfers; linked to nothing) shrink to per-account / per-statement / per-FY rollups + fingerprint tombstones; every credit and every relevant / worth-a-look / unsorted / linked debit kept; re-upload / re-sync never revives a shrunk line (a 'Remove + re-import' purge forgets the statement's rollups + tombstones so its lines come back); statement listing includes rollups and the ledger tie-out (statementLedgerTieOut, proven in the golden; no UI caller yet) still lands on the closing balance | ✓ (`pft10`, `pft10b`) | — (server job; nothing to enter) | ◑ statement rows include the rollup; the notice + Settings › Your data copy are #594 | `bank_minimisation` (OFF, kill-switch) | FT1 (`pft10`) |
| Records (A7, #588 — folded into the Review step, #587): every confirmed, counted, non-reimbursed claim with its record status (matched receipt / photographed receipt / document / claim link), the facts to state (WFH hours, car km, platform gross + fees — from the profile's ticks or already-entered inputs) and a completeness meter (counts only, never money). Record-keeping exception attestation (`transactions.record_exception`, 0084; pack `record_keeping.exceptions`, re-checked every read, lapses once the covered total passes the limit) — an attestation, never evidence; position-neutral | ✓ (`pftrec`, incl. platform payouts already recorded) | ✓ Review queue record cards (#587, absorbing #588): Snap a receipt (upload + existing Link), exception attest/undo, WorkMethodsCard / CarMethodsCard / platform-fees entry | ✓ records meter in the Review header + journey `records` block | `ft_journey` (OFF) | FT1–3 (`pftrec`) |
| myTax worksheet (A9, #575 / #590): sections in myTax's own order (Contact and bank → Personalise → Income → Deductions → … → Medicare → Spouse), prefilled income as "check this matches" lines, D-lines equal to the accountant schedule's per-label subtotals, `tie_back` to the report, never a refund field | ✓ (`pft12`, `pft12p`, sweep over every persona tenant) | ✓ Lodge in myTax page (#590: Tax-ready gate, checklist, amend loop) | ✓ | `mytax_worksheet` (OFF) | FT1 (`pft12`), FT3, FT4, FTe |
| Lodging-year default + mark as lodged (A1b, #572): the default FY is the earliest unlodged year that has ended; marking it lodged (or a confirmed NOA) moves the default on; undo restores it | ✓ (`pft7l`) | ✓ Lodge in myTax "I've lodged" (#590) | ✓ journey `lodging_fy` + Lodge step done | `situation_profile` (OFF) | FT1 (`pft7l`), FTe |
| Four-step journey (A11, #582 / #585, spec §0): `GET /api/journey` — Get set up / Connect / Review / Lodge in myTax with a status and count each; Review is ONE queue (undecided claim lines + records + receipt proposals + open "We noticed" cards); a blocker points into its step; estimate only at 0 blockers | ✓ (`readJourney`, units for the pure rules) | ✓ app shell + Home (`ft_journey`) | ✓ | `ft_journey` (OFF) | FTe (e2e, all four steps) |
| Residency periods / temporary resident (no visa subclass) | ✓ periods + `residencyOn` (#571) | ✓ About you (#585: first-run questions + profile cards; `ft_journey` + `situation_profile`) | ✓ About you residency card + newcomer card | `situation_profile` (OFF) | FT2v, FT4 |
| Residency-aware foreign income (A13, #580): foreign-sourced income dated in a `foreign` / `whm` / `temporary` period is left out of the position (pack `residency_assessability`; temporary residents keep `foreign_employment`), surfaced in `excluded_by_type` with a general-info note; undated rows in a changed-residency FY stay in + `foreign_income_undated_part_year`. G11: Find My Claims keeps occupation suggestions (with an Australian-work caveat) instead of deferring them. | ✓ | ✓ About you (#585: first-run questions + profile cards; `ft_journey` + `situation_profile`) | ✓ readiness excluded line + findings, accountant-schedule note, myTax worksheet "left out" note | `residency_assessability` (OFF; needs `situation_profile`) | FT4 (`pft13`, `pft13t`, `pft13s`) |
| Residency marked "not sure" (review nudge, deferred; never flips the binary `tax_residency` mirror) | ✓ | ✓ About you (#585: first-run questions + profile cards; `ft_journey` + `situation_profile`) | ✓ `residency_unsure` | `situation_profile` (OFF) | FT2v (`pft7b`) |
| Study-loan flag + repayment-income passthrough (info, never a figure) | ✓ `study_loan` period + `study_loan_passthrough` (#571); ◑ NOA balance | ✓ About you (#585: first-run questions + profile cards; `ft_journey` + `situation_profile`) | ✓ | `situation_profile` (OFF) | FT2v (`pft7`), FT2, FT1 |

Still open from the findings doc: G7/G8 (sole-trader onboarding, platform statements) and per-person scoping of the
Div 35 and residency nudges for multi-person tenants. The About-you editor (A2) shipped in #585. Not yet in the
e2e journey: bank-data minimisation after lodging (A5, #594 open). Known gap the e2e records rather than asserts as
intended: with `situation_profile` ON a brand-new tenant's Get set up reads "in progress" (1 left), not "not started",
because `persons.tax_residency` defaults to `AU` and the journey falls back to that column until a residency period
exists.

## How it's wired (for maintainers)

- **Engines** are pure libs: `src/lib/{cgt,ess,gst,trust,smsf,car-logbook,occupations}.ts` + the
  property `cgt.ts` `computeCapitalGain`. They take plain values, no I/O.
- **Readers** in `src/lib/ledger-totals.ts` (`cgtTotals`, `essTotals`, `gstTotals`, `trustTotals`,
  `smsfFundPositions`, `carLogbookPosition`) load rows and call the engines; each is flag-gated and
  tolerates the pre-migration "no such table" case.
- **Position** is assembled in `src/lib/report.ts` (`buildReport`): `taxable_position_cents = income +
  net capital gain + ESS discount + trust distributions − deductions − depreciation`. GST and SMSF are
  **separate taxpayers** — never added to `taxable_position`.
- **The spine** is the activity-centric model (`income_activities` 0033 + `transaction_attributions`
  0034). New personas extend `activity_type` + a satellite table, not new top-level buckets.
