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
| CGT (shares/crypto/property) | ✓ | ✓ units/owner, brokerage + cost-base elements, purchase→holding from a deposit, dividend↔holding link | ◑ no running holdings **position** yet | `cgt_engine` + `capital_holding_detail` + `capital_entity_scope` + `capital_from_txn` + `capital_income_link` + `capital_cost_base_detail` (all ON) | 2,6,8,9,10 |
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
  capture-only — no auto-claim, form tracked in #126).
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
- Still open (re-planned once real holdings exist in prod): a derived holdings position with a part-disposal
  review finding (which is also where a zero cost base *with a disposal* becomes a blocker rather than a
  review), DRP parcels, the AMIT cost-base adjustment, and broker/registry statement ingest.

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
