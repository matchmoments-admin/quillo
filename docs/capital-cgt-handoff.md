# Capital holdings, shares & CGT — handoff

> **Read this first, then [`capital-cgt-findings.md`](capital-cgt-findings.md)** (the Phase 0 investigation).
> State as at **2026-07-30**, `main@fdef445` + PR #451. Everything described as shipped is **live in prod**.
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

**Shipped and live** (6 PRs, 4 migrations, 5 flags, all ON in prod):

| Slice | Flag | Migration | What it does |
|---|---|---|---|
| C0 | `capital_holding_detail` | — | Units, owner, description on a holding; units sold on a disposal; both rendered |
| C-E | `capital_entity_scope` | 0070 | A company/trust/SMSF parcel leaves the individual headline |
| C1 | `capital_from_txn` | 0071 | A confirmed capital clarify answer seeds a holding per deposit |
| C-L | `capital_income_link` | 0072 | `income.cgt_asset_id` — the dividend↔holding link |
| C2 | `capital_cost_base_detail` | 0073 | Brokerage + cost-base elements, itemised on the accountant CSV |
| — | — | — | Persona 2 (Daniel) made executable; PR #451 fixed two review-found defects |

**Prod data reality:** as at handoff, `cgt_assets` has **zero rows** and all 51 `income` rows are
unlinked. Nothing in prod depends on any of this yet, which is why every flag could ship ON. **This is the
cheapest moment the data model will ever be to change** — see §5.

**Test surface:** 984 unit goldens (`scripts/check-units.ts`), 268 persona checks
(`scripts/check-personas.ts`). Capital-specific tenants: `pc0on`/`pc0off` (units are display-only),
`pce` (entity scoping), `pc1` (deposit→holding), `pclon`/`pcloff` (link is money-neutral), `pc2`
(brokerage), **`p2cap` (Daniel — the integration golden across all five slices)**.

---

## 2. Entry points

Line numbers are accurate at `main@fdef445`; the symbol names are the durable part.

| Concern | Where |
|---|---|
| Pure gain maths (**don't rewrite — extend around it**) | `src/lib/cgt.ts` — `computeNetCapitalGain:168`, `cgtRulesForFy:152`, `cgtUnits:33` |
| Pure cost-base elements | `src/lib/capital.ts` — `costBaseFromElements:61`, `parseCostBaseElements:88` |
| The **only** reader that feeds the position | `src/lib/ledger-totals.ts` — `cgtTotals:787` |
| Individual-vs-separate-taxpayer predicate (**shared, see §4**) | `src/lib/ledger-totals.ts` — `cgtPersonalScopeExpr:576` |
| Holding/event writes | `src/agent.ts` — `recordCgtAsset:1707`, `recordCgtEvent:1742` |
| AMMA → CGT materialisation | `src/lib/situation-write.ts` — `syncIncomeCgtFromComponents:222` |
| Deposit → holding + its cascades | `src/lib/situation-write.ts` — `syncTxnCgtHolding:289`, `clearTxnCgt:325`, `clearOrphanedTxnCgt:348` |
| The FX/entity split guard on AMMA | `src/agent.ts` — `safeToSplit:1660` |
| Draft-from-a-bank-line (pure) | `src/lib/clarify.ts` — `draftHoldingFromTxn:109` |
| Accountant CSV CGT section | `src/lib/accountant-schedule.ts` — section 9, `:794` |
| Readiness findings + signals | `src/lib/readiness.ts` — `capital_holding_needs_units:668`, signals `:78` |
| Holdings UI | `web/src/components/income/CapitalEquity.tsx` (register + both forms + derived position) |
| Income↔holding UI | `web/src/pages/Income.tsx` (holding picker on dividend / managed fund) |
| Clarify second step | `web/src/components/ClarifyCard.tsx` (`capitalFor` reveal) |

**Next free migration: `0074_`.** Keep `schema.sql` in lockstep — `npm run test:schema` is the guard.

---

## 3. What remains

Four slices plus a seam. **Recommended order below; §6 records why.**

### C3 — holdings position + part-disposal guard · `capital_position`

The register already **derives** remaining units for display (`derivePosition` in `CapitalEquity.tsx`).
What's missing is the server-side, queryable version and the findings that depend on it.

- Remaining units = `units − Σ units_disposed`. Remaining cost base = `cost_base_cents − Σ cost_base_used_cents`.
  **Both are arithmetic over what the user entered** — *not* a parcel selection. This matters: it is the
  only formulation that doesn't collide with the anti-goal *"do not auto-select parcels on a disposal."*
- A disposal exceeding units held is a **review finding**, not a hard block. Quillo surfaces, the agent decides.
- This is also where the zero-cost-base finding becomes a **blocker** — but *only* when a disposal exists
  against it. Today it is `review` (`capital_holding_missing_cost_base`) because an un-disposed holding
  distorts nothing. Don't promote it unconditionally.
- **Open decision** — derived-on-read vs stored-and-maintained. See §6.
- `cgt_assets.status` is dead: written as the literal `'held'` at insert since 0037, never updated by
  anything. Either maintain it here or delete the column; leaving it half-alive is what caused the PR #451
  display bug.

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

### C6 — broker/registry statement ingest · `capital_statement_ingest`

Highest leverage remaining: **a bank line fundamentally cannot tell you units, price or brokerage** — an
annual statement can. Route through the existing document-ingest → classify → **confirm-before-write**
path; never auto-commit an extraction.

- Existing issues this closes or advances: **#68** (its v1.1 CSV/broker import) and **#66** (its Phase 2
  `managed_fund_amma` extractor).
- Reuse: `classifyDocument`, the `extractColumnMap` column-mapper already used for bank CSVs, and
  `recordCreditAsIncome`'s `matched_income_id` dedupe — **do not add a second link mechanism**.
- Dedupe matters here in a way it didn't for DRP: a statement-ingested *cash* dividend **will** collide
  with the same dividend on the bank feed.
- **Open decision** — which formats first. See §6.

### C-jur — the jurisdiction seam (no behaviour change)

Build the **seam only**, keep AU as the sole implementation, document the interface. Two named strategies
rather than more fields:

1. **Gain-relief strategy** — must be able to express AU's 50% discount at 12 months; UK's annual exempt
   amount then flat rates; Ireland's flat 33% with an exemption; Canada's 50% inclusion; US short-vs-long
   split at 12 months.
2. **Parcel strategy** — AU specific-ID/FIFO; Ireland FIFO; **UK Section 104 pooling**; **Canada ACB
   averaging**; US specific-ID/FIFO plus the wash-sale rule.

**Canada and the UK make one-row-per-parcel *wrong*, not merely differently configured.** Name things
jurisdiction-neutrally (`gain_relief`, not `discount`). Belongs under epic **#239** (Quillo Worldwide).

---

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

1. **C3: derived-on-read or stored-and-maintained position?** Derived can't desync and needs no migration;
   stored is queryable from readiness/report without recomputation and survives the FY rollover as data.
   The register already derives for display. *Recommendation: derived, with `cgt_assets.status` deleted
   rather than left half-alive.*
2. **Slice order.** *Recommendation: C3 → C5 → C4 → C6 → C-jur.* C3 makes the position legible and is the
   prerequisite for the blocker-severity finding; C5 is small now that C-L exists and is pure correctness;
   C4 needs an input source, which is really C6; C6 is the largest. **C-jur is cheapest right now** —
   `cgt_assets` has zero prod rows — so there is a case for doing it first while nothing can break.
3. **C6 scope.** Named annual statements (CommSec / Stake / Computershare / Link) vs the ATO prefill shape
   vs a generic column-mapper reusing `extractColumnMap`. Materially different sizes.
4. **Issue #68's disposition** (`needs-decision`, `priority:p1`). Its v1 manual-entry scope is **done** and
   its proposed `cgt_parcels` table is **superseded** by 0037's `cgt_assets`/`cgt_events`; only its v1.1
   CSV/broker import remains, which is C6. Per the working agreement, a `needs-decision` issue is never
   auto-closed — so it is left open with an evidence comment pending your call.

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
