# Capital holdings, shares & CGT — handoff

> **Read this first, then [`capital-cgt-findings.md`](capital-cgt-findings.md)** (the Phase 0 investigation).
> State as at **2026-07-30**, `main@91946a5`. Everything described as shipped is **live in prod**.
>
> The scoped brief is `CLAUDE.capital.md`. Where it and this file disagree, **this file is the current
> truth** — the tranche corrected several of its assumptions, and each correction is recorded below with
> the reason.

---

## 1. Where this stands

The **engine was never the problem** — `computeNetCapitalGain` was correct before any of this work and is
untouched. **Capture** was the whole gap, and the foundation tranche closed it: a taxpayer can now record
what they hold, who holds it, what it cost including brokerage, where a dividend came from, and have a
brokerage deposit start the record for them.

**Shipped** (11 PRs, 5 migrations, 7 flags, all ON in prod):

| Slice | Flag | Migration | What it does |
|---|---|---|---|
| C0 | `capital_holding_detail` | — | Units, owner, description on a holding; units sold on a disposal; both rendered |
| C-E | `capital_entity_scope` | 0070 | A company/trust/SMSF parcel leaves the individual headline |
| C1 | `capital_from_txn` | 0071 | A confirmed capital clarify answer seeds a holding per deposit |
| C-L | `capital_income_link` | 0072 | `income.cgt_asset_id` — the dividend↔holding link |
| C2 | `capital_cost_base_detail` | 0073 | Brokerage + cost-base elements, itemised on the accountant CSV |
| C3 | `capital_position` | — | **Derived** holdings position, over-disposal findings, closing-holdings CSV section |
| C6 | `capital_statement_ingest` | 0074 | Broker / registry / crypto CSV import — preview, then confirm-before-write |
| — | — | — | Persona 2 (Daniel) made executable; PR #451 and the C3 hardening PR each fixed two review-found defects |

**Prod data reality (checked, not assumed):** `cgt_assets` has **zero rows** and all 51 `income` rows are
unlinked, so nothing in prod depends on any of this yet — which is why every flag could ship ON. But the
owner **does hold ETFs, shares and crypto**; they simply haven't been entered. So the "the data model is
free to change" window (§5) is about to close, and the next person should not plan around it lasting.

The wider account is **property-heavy**: 4 properties, 2401 transactions, 50 `rent` income rows in
FY2024-25 — and only **46 transactions plus 1 income row in FY2025-26**. The owner's blocker on their own
FY2025-26 return is **data entry, not engine**. See [`fy2025-26-walkthrough.md`](fy2025-26-walkthrough.md).

**Test surface:** 1037 unit goldens (`scripts/check-units.ts`), 293 persona checks
(`scripts/check-personas.ts`). Capital-specific tenants: `pc0on`/`pc0off` (units are display-only),
`pce` (entity scoping), `pc1` (deposit→holding), `pclon`/`pcloff` (link is money-neutral), `pc2`
(brokerage), `pc3bad` (the C3 inconsistencies: over-disposal, disposed-with-no-cost-base, a still-held
zero-cost-base control, and an ENTITY disposal that must not fall through both findings),
`pc6` (what a CONFIRMED import leaves behind — brokerage in the cost base, an unmatched sale blocking,
and flag-OFF identity), **`p2cap` (Daniel — the integration golden across the slices; `p2capCoRio` is the
held entity parcel that makes the closing-holdings scope test able to fail)**.

---

## 2. Entry points

Line numbers are accurate at `main@91946a5`; the symbol names are the durable part.

| Concern | Where |
|---|---|
| Pure gain maths (**don't rewrite — extend around it**) | `src/lib/cgt.ts` — `computeNetCapitalGain:168`, `cgtRulesForFy:152`, `cgtUnits:33` |
| Pure cost-base elements | `src/lib/capital.ts` — `costBaseFromElements:61`, `parseCostBaseElements:88` |
| The **only** reader that feeds the position | `src/lib/ledger-totals.ts` — `cgtTotals:787` |
| Capital readiness signals (both queries) | `src/lib/capital-signals.ts` — `capitalReadinessSignals` |
| Individual-vs-separate-taxpayer predicate (**shared, see §4**) | `src/lib/ledger-totals.ts` — `cgtPersonalScopeExpr:576` |
| Holding/event writes | `src/agent.ts` — `recordCgtAsset:1707`, `recordCgtEvent:1742` |
| AMMA → CGT materialisation | `src/lib/situation-write.ts` — `syncIncomeCgtFromComponents:222` |
| Deposit → holding + its cascades | `src/lib/situation-write.ts` — `syncTxnCgtHolding:289`, `clearTxnCgt:325`, `clearOrphanedTxnCgt:348` |
| The FX/entity split guard on AMMA | `src/agent.ts` — `safeToSplit:1660` |
| Draft-from-a-bank-line (pure) | `src/lib/clarify.ts` — `draftHoldingFromTxn:109` |
| Accountant CSV CGT section | `src/lib/accountant-schedule.ts` — section 9 `:840`, closing holdings 9b `:900` |
| Readiness findings + signals | `src/lib/readiness.ts` — `capital_holding_needs_units:673`, signals `:78` |
| Holdings UI | `web/src/components/income/CapitalEquity.tsx` (register + both forms + derived position) |
| Income↔holding UI | `web/src/pages/Income.tsx` (holding picker on dividend / managed fund) |
| Clarify second step | `web/src/components/ClarifyCard.tsx` (`capitalFor` reveal) |

**Next free migration: `0075_`.** Keep `schema.sql` in lockstep — `npm run test:schema` is the guard.

---

## 3. What remains

**Two slices — C5 (#454) and C4 (#455) — and both should wait for real data.** C3, C6 and the
foundation are shipped; C-jur is declined. §6 records why.

### ~~C3 — holdings position~~ · SHIPPED (`capital_position`, #453)

Decided **derived on read**, not stored. `holdingPosition()` in `src/lib/capital.ts` is the single
definition; it is computed **server-side** and shipped on the holdings payload so the SPA doesn't keep a
second copy that can drift. `cgt_assets.status` remains **dead but present** — dropping a column is a
destructive migration needing its own sign-off, so C3 documents it and derives instead.

Findings: over-disposal and over-used-cost-base are **review** (a missing earlier parcel is the usual
cause); missing cost base is promoted to **blocker** only when a disposal exists against it — the one
materially-distorted case in the capital set. The accountant pack gained *"Investment holdings at year end
(carried forward)"*, deliberately **without** a `tie_back` since a closing balance contributes to no report
figure. Read the section's `notes` before changing it: they state that remaining figures are derived and
explicitly **not** a parcel selection.

**Hardened afterwards** (traps 10–12, all live defects that all-green gates missed):

- The **closing-holdings section is entity-scoped** through the shared `cgtPersonalScopeExpr`. A *held*
  company/trust/SMSF parcel was being carried forward on the individual's pack and summed into its TOTAL.
- The section is now **bounded to the report's FY** on both reads (`acquired_date <= end`, `ev.fy <= fy`).
  It states a position *as at year end*; unbounded, re-exporting a closed year showed the position as it
  stands today — a wrong carry-forward on a prior-year deliverable.
- **Exactly one finding per holding, with no holding left with none.** Only the *blocker* is entity-scoped
  (it alone claims the individual's position is distorted); the two `over_*` findings are deliberately
  **not**, because their copy is holding-level arithmetic and the register shows their badge on entity
  rows. The review finding a holding is suppressed from is exactly the set the blocker picks up —
  see the complementarity invariant at the top of `src/lib/capital-signals.ts`.
- Those two queries **moved out of the DO** into `src/lib/capital-signals.ts` so the goldens exercise the
  real function instead of a re-typed copy of its SQL. The first hardening cut tested a replica, which is
  trap 10 committed inside the fix for trap 11.

**Known limitation, deliberate:** a *zero-cost-base disposal* on a separate-taxpayer parcel raises the
**review** finding rather than the blocker — the blocker's claim ("the entire proceeds are showing as a
capital gain") is about the individual's headline, and C-E keeps that parcel out of it. That entity lodges
its own return, which Quillo does not produce. Revisit if entity-level returns ever come in scope.

### C4 — DRP as a parcel generator · `capital_drp`

- A `drp` flag on a holding. A dividend against a DRP holding mints a **new parcel** at the reinvestment
  price with its own `acquired_date` — and therefore **its own 12-month discount clock**.
- **The dividend stays fully assessable.** The reinvestment is a separate acquisition, not a netting.
  Assert this in a golden; getting it backwards understates income.
- Units will be **fractional** — `cgtUnits` already rounds nothing, deliberately. Don't add rounding.
- **A DRP dividend never touches the bank feed** (no cash moves), so it can only arrive by hand-entry or
  C6. `income.cgt_asset_id` (C-L) is the attachment point and is already shipped.

### C5 — apply the AMIT cost-base net amount · `capital_amit_costbase`

- Captured on the income row's `detail_json` as `amit_cost_base_net_amount_cents`
  (`src/lib/managed-fund.ts:39`), summed portfolio-wide into a readiness nudge, and **never applied**.
- Sign convention: **positive = a cost-base *decrease*** (tax-deferred), negative = an increase.
- Use `income.cgt_asset_id` to know *which units* to adjust. Before C-L this was impossible — it was
  unattributable, not merely unapplied.
- **Its golden must span two FYs.** A cost-base adjustment only changes the position in the FY of
  *disposal*, so in a non-disposing year it is byte-identical by construction and proves nothing.
  Distribute in FY1, dispose in FY2. The brief's stated acceptance criterion does not test the year that matters.
- Keep the defer nudge, and itemise the adjustment on the accountant schedule.

### ~~C6 — broker/registry statement ingest~~ · SHIPPED (`capital_statement_ingest`, #456, PR #463)

**Open decision 3 resolved: a GENERIC column-mapper**, not named annual statements and not the ATO prefill
shape. The owner holds ETFs, shares **and crypto**, and there are hundreds of crypto exchanges — a
named-format approach would never finish. Named formats can still be layered on later as pre-seeded column
maps; this doesn't foreclose them.

- `src/lib/capital-import.ts` is the PURE core (`applyCapitalColumnMap`, `parseMoneyCents`, `parseUnits`,
  `parseSide`, `parseCapitalDate`, `summariseDrafts`). `extractCapitalColumnMap` (`src/extract.ts`) is the
  one model call per file — same division of labour as the bank-CSV path: an LLM for the *shape*, pure code
  for every *row*.
- **Confirm-before-write.** `parseCapitalImport` stages rows in R2 beside the raw file with a
  `capital_imports` row (migration 0074); `confirmCapitalImport` writes only the rows the user ticked.
  Nothing auto-commits. Routes: `POST/GET/DELETE /api/capital-imports`, `POST …/:id/confirm`.
- Brokerage is **added** to an acquisition's cost base and **subtracted** from disposal proceeds — never
  both, or the same fee is counted twice in the taxpayer's favour.
- An imported disposal writes `cost_base_used_cents = 0` **deliberately**: an export says what you sold
  *for*, never which parcel you drew on, and parcel choice changes the gain.
- An unmatched disposal is **reported back**, never silently dropped and never auto-creating a phantom
  parcel. Rows that fail to parse are shown **with their reason**, never dropped.
- **New blocker `capital_disposal_no_cost_base_used`** — see trap 13. There are now **TWO** capital
  blockers, both meaning "the position is materially distorted".

**Not done, and the honest remainder of #66/#68:** the **PDF** path. `managed_fund_amma` is a recognised
`doc_type` but still falls through to the shelf unimplemented, and `classifyDocument` has no broker or
crypto doc type at all. Note `receiptBlock` only emits `document` for PDFs and `image` otherwise, so a CSV
**cannot** go through `/api/documents/upload` — which is exactly why C6 took its own route.

### ~~C-jur — the jurisdiction seam~~ · DECLINED (#457), replaced by a standing constraint

The owner declined the dedicated seam refactor and replaced it with a rule that binds **all new work**:

> "I should have said AU only but we should build everything so it can be worldwide at some point adding a
> jurisdiction at a time"

So: **no retrofit project**, but every new feature is built jurisdiction-parameterised by construction.
In practice — never hardcode `AUD` (take it from the descriptor's `baseCurrency`); never hardcode the
financial year (`fyForDate(date, jur)` / `fyBounds(startYear, descriptor)` — 1 July–30 June is an AU fact,
not a universal one); never assume a date convention; name for the **concept**, not the AU instrument
(`gain_relief`, not `discount`); jurisdiction-specific values live in the **rule pack**.

**C6 is the worked example to copy.** Its `day_first` is a parameter resolved from the tenant's descriptor
rather than assumed: `03/04` is 3 April in AU/UK and 4 March in the US, and guessing wrong silently moves a
disposal across a FY boundary *and* across the 12-month discount threshold.

**The `cgt_discount_keep_fraction` trap is unchanged and still blocks any future rename** — see trap 6.
Recorded on epic **#239** (Quillo Worldwide).

## 4. Traps — each of these has already bitten once

1. **`tie_back` is necessary but NOT sufficient.** It proves a section's subtotal reconciles to
   `buildReport`. It says **nothing** about whether rows *inside* a section are mutually consistent. C2
   shipped a cost-base block describing the whole parcel under a row showing the cost base of the units
   *sold*; on a part-disposal the CSV displayed a breakdown that visibly failed to add up, through
   entirely green gates (fixed, PR #451). **Any slice adding derived or sub-row presentation to the
   schedule needs its own internal-consistency assertion.**
2. **Cover the PART-disposal case, not just the full one.** That asymmetry is exactly what let trap 1
   through — `pc2` only ever exercised a full disposal, where the two figures coincide.
3. **Every cost-base adjustment must land in `cgt_events.cost_base_used_cents` at disposal time**, never
   downstream of the engine, or the tie-back breaks. This governs C3 and C5 directly.
4. **`cgtPersonalScopeExpr` is shared by `cgtTotals` and the accountant schedule on purpose.** If a reader
   applies a scope predicate the schedule doesn't, the section over-states and the tie-back fails. Add
   readers to the shared expression, never a local copy.
5. **The scope predicate is the *precise* rule, not `entity_id IS NULL`.** `entities` holds
   `individual`/`employment` rows (P2's "Me") and those **are** the taxpayer. The blunt rule silently drops
   a user's own gain from their own return. `separateTaxpayerPredicate` is the single definition — reuse it.
6. **Renaming the rule-pack key `cgt_discount_keep_fraction`** needs a **back-compat read of both keys**
   plus `npm run rulepack:push`. KV **shadows** the bundled default, so a prod pack predating a rename
   silently falls back to `0.5` — *coincidentally correct for AU*, so it would pass every golden while
   being a live latent bug for every other jurisdiction. Blocks C-jur.
7. **A cgt_asset with no cgt_event is money-neutral by construction.** `cgtTotals` and the schedule both
   read `cgt_events`. Useful: it is why C1 could not move the position. Also a hazard: a holding-only
   feature will *look* inert in the report while still being wrong on the register.
8. **Provenance columns are mutually exclusive by convention, not constraint.** `property_id` / `income_id`
   / `txn_id` — exactly one set, or all NULL for a manual holding. A new source must add itself to the
   capital-register filter in `src/api.ts`, and needs a `clear*Cgt` cascade or a deleted source orphans a
   parcel. **`txn_id` deliberately stays visible in the register** (a transaction is not a holding editor —
   the user has to finish the units somewhere); `property_id`/`income_id` are hidden because a source form
   owns them.
9. **Deploy-only environment** (macOS 12.6 can't run `workerd`). Verify by typecheck + tests, then deploy
   and smoke-test. Allow ~60s for asset propagation before comparing the live bundle hash to the build.
10. **A fixture can make an assertion PASS for the wrong reason — check what would have to change for it
    to fail.** C3's closing-holdings query had no entity predicate at all, and its golden ("the company's
    parcel is not carried forward") passed only because the sole entity fixture happened to be fully
    *disposed* and was filtered by its **derived** position (`holdingPosition(...).status`), not ownership.
    The leak was invisible until a **held** entity parcel existed (`p2capCoRio`). When an assertion says
    "X is excluded", make sure X is excluded by the rule under test and not by an unrelated property of the
    fixture. The same rule caught a second one: an over-use check that passed on a zero because the fixture
    had no over-use in it. **Prove a new golden fails** — revert the fix and watch it go red.
11. **Two findings about the same row is a bug — and so is none.** C3's blocker and C1's
    missing-cost-base review finding both counted a zero-cost-base holding *with* a disposal, so the user
    saw the blocker plus a review finding reading "it doesn't affect this year's figures while you still
    hold it" — false for something they had sold. When a slice **promotes** a case to a higher severity it
    must **remove** that case from the finding it was promoted out of — but the removal has to be *exactly*
    as narrow as the promotion. The first fix suppressed the review finding for **any** holding with a
    disposal while the blocker only picked up **personal** ones, so an entity parcel fell through both and
    was surfaced nowhere. Suppress on the promoting condition itself, not on a proxy for it.
13. **When a slice writes a deliberate blank, check something actually CHASES it.** C6 writes
    `cost_base_used_cents = 0` on an imported disposal on purpose (an export can't tell you which parcel you
    sold), and the plan said "C3's blocker will chase it". It would **not**: that blocker fires only when the
    HOLDING has no cost base. Here the holding has one and the SALE claims none of it, so the full proceeds
    landed as gain with **nothing flagging it** — the taxpayer taxed on money they never made, silently.
    `capital_disposal_no_cost_base_used` is the finding that was missing. There are now **two** capital
    blockers, and the rule is: a capital finding may be a blocker **only** when the position is materially
    distorted. Caught by C6's own persona golden, which is the argument for writing the golden first.
12. **A golden that re-types the code's SQL asserts its own copy.** The DO's `filingReadiness` isn't
    reachable from the harness, so the first hardening cut pasted its two queries into
    `scripts/check-personas.ts` — which stays green no matter what `src/agent.ts` does. If the code under
    test isn't reachable, **move it** until it is: the queries now live in `src/lib/capital-signals.ts` and
    both the DO and the goldens call the same function. Applies directly to C4/C5, which add signals here.

---

## 5. Corrections to `CLAUDE.capital.md`

The brief is good and mostly accurate. These specific points are superseded:

- **A missing Slice 0.** `cgt_assets.units` had no capture surface at all, which made C3 and C4
  *uncomputable* rather than unbuilt. Shipped as C0.
- **C4 and C5 depended on a column no slice created.** `income.cgt_asset_id`. Shipped as C-L.
- **The entity leak was a live bug, not "decide it explicitly."** Shipped as C-E — and note the fix is
  entity-scoped only. **Person-level scoping is deliberately unchanged**: no reader in the platform
  excludes a non-self `person_id` (`incomeTotals` doesn't either), so making CGT uniquely person-scoped
  would be an inconsistency. Platform-wide person scoping is a separate, larger decision.
- **C1 deviates from the brief's provenance instruction** — see trap 8.
- **C2's shape decision is made**: one canonical `cost_base_cents`, elements as a `detail_json` breakdown.
  Rationale in `migrations/0073_cgt_cost_base_detail.sql` and `src/lib/capital.ts`. Don't relitigate
  without reading those.
- **C5's acceptance criterion is insufficient** — see §3 C5.
- **Persona 2 (Daniel) did not exist** as an executable fixture despite the coverage table claiming it.
  Now `p2cap`.

---

## 6. Open decisions (owner's call — do not guess)

1. ~~**C3: derived or stored?**~~ **DECIDED: derived on read** (2026-07-30). Shipped. A follow-up decision
   remains open: whether to drop the dead `cgt_assets.status` column — that is a destructive migration and
   needs an explicit go plus a reverse plan.

   **It is NOT a one-line migration**, despite how the first draft of this section read. The column is
   `TEXT NOT NULL DEFAULT 'held'`, so the default would cover an insert that simply omitted it — but
   nothing omits it. It is still named explicitly in **six places**: four insert column-lists
   (`recordCgtAsset` in `src/agent.ts`; the property, AMMA-income and txn-seeded inserts in
   `src/lib/situation-write.ts`), the capital-register `SELECT` in `src/api.ts`, and a golden `SELECT` at
   `scripts/check-personas.ts:914` — that last one means the drop would fail inside `npm test`, the very
   gate §7 prescribes. Naming a dropped column in an insert list or a select throws, so **all six must be
   cleaned and shipped BEFORE the drop**, not with it. SQLite's `ALTER TABLE … DROP COLUMN` also has to be
   mirrored into `schema.sql` or `npm run test:schema` fails. Order: strip the six references → ship →
   verify → drop in its own migration. The dead *reader* in the C1 readiness query is already gone
   (removed by the C3 hardening PR), so that one is done.
2. **Slice order.** C3 and C6 are done. **C-jur (#457) was DECLINED** — see the note below. *Remaining:
   **C5 (#454, AMIT) then C4 (#455, DRP)** — but hold both until the owner's ETF distributions are actually
   in the system.* C5 only changes the position in a year of **disposal**, so against a non-disposing year
   it is byte-identical by construction and proves nothing; building it against real data is strictly
   better than building it against an invented fixture.
3. ~~**C6 scope.**~~ **DECIDED: a generic column-mapper** (2026-07-30). Shipped — see §3 C6 for the
   reasoning (ETFs + shares + crypto; hundreds of exchanges; named formats can be layered on later).
4. ~~**Issue #68's disposition.**~~ **DECIDED: closed as completed** (2026-07-30), with #456 named as the
   successor for its remaining v1.1 CSV/broker import.

---

## 7. Verification recipe

```bash
npm run typecheck                                    # server
cd web && npx tsc --noEmit && npm run lint && cd ..  # SPA — BOTH, the lint gate catches hooks bugs
npm test                                             # units + personas + statement recon + schema drift
npm run test:personas                                # all 10 must stay green
```

Per-slice acceptance, non-negotiable:

- **Flag OFF ⇒ byte-identical report AND accountant CSV** (zero-row and populated cases).
- **A persona golden added or flipped in the same PR.** Daniel (`p2cap`) and Margaret (`p10`) are the
  contract; extend `p2cap` for anything that composes across slices.
- **Internal consistency of any new schedule presentation**, asserted directly (trap 1).
- Money math or a migration ⇒ **`/code-review` at high effort**. It found two real defects in this
  tranche that all green gates missed. Do not skip it.

Then: apply migrations to remote D1 **in order** and verify; squash-merge; `npm run web:build && npm run
deploy`; `curl -s https://app.quillo.au/healthz`; smoke-test the touched surface with the flag both OFF
and ON.

---

GENERAL INFORMATION ONLY. Quillo never lodges, never holds money, never computes tax payable. CGT is
fact-specific — cost-base elements, parcel choice, residency, exemptions — so every judgement call defers
to a registered tax agent.
