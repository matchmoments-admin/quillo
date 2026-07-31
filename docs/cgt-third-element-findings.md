# Third-element cost base — should denied holding costs accrue?

> **Research deliverable for [#469](https://github.com/matchmoments-admin/quillo/issues/469)**, map
> [#464](https://github.com/matchmoments-admin/quillo/issues/464). Produced 2026-08-01.
>
> ⚠️ **GENERAL INFORMATION ONLY — not tax advice.** Cost-base composition is fact-specific and is for a
> registered tax agent. This document is an engineering design input.

---

## 0 · The answer in one paragraph

**Yes — and the ATO's own design intent is deny-*then*-capitalise, so Quillo currently implements
exactly the wrong half of the rule.** But it must **not** be done by adding the amount to
`cost_base_cents`, because `computeCapitalGain` uses **one figure for both a gain and a loss** and
third-element costs are generally **excluded from the reduced cost base** — so a naive addition would
**overstate a capital loss**. That makes this a two-figure modelling change, not a one-line one. The
good news: **Quillo already holds the data** (every denied cost is already a transaction row tagged
`use_status_denied` against a `property_id` in an FY), so the amount should be **derived, not captured
again**. And for **FY2025-26 specifically, nothing needs to ship** — see §6.

## 1 · The gap, re-verified

| Claim | Status |
|---|---|
| `schema.sql:397-399` promises deductions are denied "**while CGT cost base still accrues**" | Stated intent |
| `properties.acquired_cost_detail_json` (`schema.sql:407`) | **Zero readers** across `src/`, `web/src/`, `scripts/` |
| `computeCapitalGain` (`src/lib/cgt.ts:55`) | Takes `cost_base_cents` flat; the **only** adjustment is `− div43_claimed_cents`. No addition path |
| The five s110-25 elements | Modelled for `cgt_assets` (shares/crypto) only — `capital.ts`, `detail_json.cost_base_elements`. **Property never got them** |

So a denied expense on a rent-free property is **denied and then dropped**. The half of the schema
comment that promises accrual is unimplemented.

> Re-verified after the NUL-byte fix (PR #480) — these greps genuinely return nothing now, rather than
> being silently skipped.

## 2 · The ATO position

**s110-25(4)** — the third element is the **costs of owning** the CGT asset, but **only if the asset
was acquired after 20 August 1991**. It includes:

- interest on money borrowed to acquire the asset
- **rates and land tax**
- costs of maintaining, repairing or **insuring** it
- interest on money borrowed to finance capital expenditure that increased the asset's value

**Conditions and exclusions:**

- **Excluded to the extent you have deducted it, or can still deduct it** (amendment period not
  expired) — s110-45(1B) for assets acquired after 13 May 1997. Non-deductibility is precisely what
  makes it available.
- **Cannot be indexed.**
- **Not available at all** for collectables or personal-use assets. *(Land and buildings are excluded
  from the personal-use-asset definition, so a house does not fall foul of this.)*
- **Generally cannot be used to work out a capital LOSS** — the reduced cost base excludes it.

**The ATO frames the denied-deduction case explicitly:** where a deduction is denied for holding costs
on vacant land or an untenanted residential property, those costs are **capitalised into the third
element**, reducing the eventual capital gain. Deny-then-capitalise is the design of the rule.
Quillo denies and stops.

### 2.1 · The nuance that shapes the model

The reduced-cost-base exclusion has an **exception**:

> You do not include rates, insurance, land tax, maintenance and interest in the reduced cost base —
> **unless** you acquired the property under a contract entered into after 20 August 1991 **and could
> not claim a deduction for the costs because you did not use the property to produce assessable
> income**.

**That exception is the owner's exact situation** (rent-free, not income-producing, acquired post-1991).
So here the costs may sit in *both* the cost base and the reduced cost base — while for an ordinary
rented property they sit in the cost base only.

**This is the argument for modelling the two figures separately rather than collapsing them.** The
conditional is real and it is not a rounding detail: get it wrong in the general case and you overstate
a capital loss.

## 3 · Why this is not a one-line change

```ts
// src/lib/cgt.ts:56 — ONE figure serves both branches
const adjustedCostBase = i.cost_base_cents - (i.div43_claimed_cents ?? 0);
const raw = i.proceeds_cents - adjustedCostBase;
if (raw < 0) { /* capital loss — uses the SAME figure */ }
```

Adding third-element costs to `cost_base_cents` would inflate the loss branch too. The engine needs a
**`reduced_cost_base_cents`** concept — the first genuine two-figure change in the CGT engine. That is
the real work, and it is why this ticket is `needs-decision` rather than a chore.

## 4 · Designing to the standard

Per `CLAUDE.md`, checked against how the established players model it:

- **Xero / MYOB / QuickBooks** don't model a CGT cost base at all — CGT is outside GL scope. What they
  *do* model, and the transferable shape, is a fixed asset whose **cost is a ledger of dated,
  categorised contributions**, not a scalar.
- **Simple Fund 360 / BGL** model investment parcels with **dated cost-base adjustment events**
  (tax-deferred / AMIT amounts against a parcel) — the same shape.

**Quillo already matches this shape** for shares: `cgt_assets.detail_json.cost_base_elements`. The
divergence for property is **cadence** — acquisition costs are one-off, third-element costs are
*recurring annual accruals*. That is the only genuinely new thing here.

## 5 · Options

| | Option | Migration | Pros | Cons |
|---|---|---|---|---|
| **1** | **Derive from denied rows.** Sum qualifying `use_status_denied` transactions per property per FY | **None** | Zero new data entry — the rows already exist and are already tagged; self-updating; cannot drift from the ledger; mirrors the C3 "derived, not stored" precedent the owner already chose | Needs a qualifying-category filter (rates/insurance/interest/maintenance qualify; capital improvements are the **fourth** element, not the third) |
| **2** | **Capture explicitly** on the property form | Yes | Precise, user-confirmed | Makes the user re-enter what Quillo already knows; drifts from the ledger; new table |
| **3** | **Hybrid** — derive as a suggestion, user confirms per FY, store the confirmation | Yes | Accurate + auditable | Most work; the confirmation is the thing that goes stale |

**Recommendation: Option 1**, with the reduced-cost-base split built in from the start.

Assessed against the invariants:

- **Additive + flag-gated** — a new `capital_third_element` flag; OFF ⇒ no reader ⇒ byte-identical.
- **Jurisdiction-neutral by construction** — the generalisable concept is *"non-deductible holding
  costs capitalised to an asset's basis."* The AU specifics (post-20-Aug-1991, the reduced-cost-base
  exception, which categories qualify) belong in the **rule pack**, not in the engine. Composes with
  the existing `properties.jurisdiction` column.
- **Generalises rather than special-cases** — extend the existing `cost_base_elements` vocabulary to
  properties with a `third_element` accrual keyed by FY, rather than inventing a property-only
  mechanism.

**Deliberately excluded:** anything already deducted (that is the whole condition), and Div 43 capital
works — those already *reduce* the cost base at `cgt.ts:56` and must never also be added.

## 6 · Is it in scope for FY2025-26? **No — and that is a real finding, not a deferral**

- **The owner had no disposals this year** ⇒ no CGT event ⇒ nothing to compute. A third-element figure
  would change no number on this return.
- **The data accrues for free regardless.** Every denied cost on the rent-free property is *already*
  being captured as a `use_status_denied` transaction by [#465](https://github.com/matchmoments-admin/quillo/issues/465)
  and [#470](https://github.com/matchmoments-admin/quillo/issues/470). Under Option 1 those rows **are**
  the third element — nothing is being lost while the engine work waits.
- **So the deadline is the first disposal, not this return.** That removes the urgency I originally
  attached to this ticket ("capture it while the records are fresh") — Option 1 means the records
  capture themselves.

**One thing that would change this:** if the property was acquired **before 21 August 1991**, no third
element is available at all and the whole question is moot. Worth confirming
`properties.acquired_date` during [#466](https://github.com/matchmoments-admin/quillo/issues/466).

## 7 · Recommended next steps

1. **Nothing ships for FY2025-26.** Confirm `acquired_date` on both properties in #466.
2. **Before the first disposal**, build Option 1 as its own slice: `reduced_cost_base_cents` in the CGT
   engine first (it is the money-correctness half), then the derived third-element accrual on top.
3. **Add a readiness `info` finding**, not a blocker: *"Costs denied on this property may be able to be
   added to its cost base when you sell — confirm with your registered tax agent."* This is the honest
   surface today: Quillo surfaces, the agent decides.
4. **Update [`docs/personas.md`](personas.md)** when it lands — this is a persona-6 (Susan & Greg) and
   persona-10 capability, and it needs a golden.

---

*Sources: ITAA 1997 s110-25(4), s110-45(1B), s110-55; ATO guidance on cost base and reduced cost base,
and on holding costs denied for vacant/untenanted land. Verify against current ATO guidance before
relying on any of it. General information only — not tax advice.*
