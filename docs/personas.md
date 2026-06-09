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

## Coverage status (2026-06-09)

Legend — **engine**: backend computes it (✓ live behind flag); **UI**: a web surface to enter the data;
**display**: the result is rendered. A persona is "end-to-end" only when all three hold.

| Capability | Engine | UI in | Display | Flag | Personas |
|---|:---:|:---:|:---:|---|---|
| PAYG salary + WFH + deductions | ✓ | ✓ | ✓ | (live) | 1,3,7 |
| Negative-gearing rentals + Div 40/43 | ✓ | ✓ | ✓ | (live) | 6 |
| Multi-income aggregation | ✓ | ✓ | ✓ | (live) | all |
| Sole-trader `business` income | ✓ | ◑ income only | ✓ | — (additive) | 4,5 |
| Sole-trader activity + attribution | ✓ | ✗ no form | ◑ | `attribution_engine` | 4,5,8 |
| CGT (shares/crypto/property) | ✓ | ✓ | ✓ | `cgt_engine` (ON) | 2,6,8,9,10 |
| Employee Share Scheme | ✓ | ✗ | ✗ | `ess_engine` | 2,9 |
| GST registration flag | ✓ | ✓ | ✓ | — | 4,5,8 |
| Indicative BAS / PAYG instalments | ✓ | ✗ | ✗ | `gst_bas` | 4,5,8 |
| Motor-vehicle logbook | ✓ | ✗ | ✗ | `car_logbook` | 3,4,5,7 |
| Occupation content (person-level) | ✓ | ✓ | ✓ | — | 3,7 |
| Occupation scope on an activity | ✓ | ✗ | ◑ | — | 3,7 |
| Trust distributions / streaming | ✓ | ✗ | ✗ | `trust_distributions` | 8 |
| SMSF / pension / ECPI | ✓ | ✗ | ✗ | `smsf_engine` | 10 |

**Bottom line today:** the *engines* for all 10 personas are live (EPIC #134, migrations 0037–0042, all
flags OFF in prod). The *front end* lets a user complete only Personas 1, 3 (partly), 6 and 7 (partly)
end-to-end. CGT / ESS / logbook / trust / SMSF need input UI + API write + display before Personas 2, 8,
9, 10 (and the gig/sole-trader depth of 4, 5) are completable in the app. Tracked as the front-end
completion epic.

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
