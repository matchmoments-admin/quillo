# FY2025-26 — the state of play, and what happens next

> **Read this first.** State as at **2026-08-03**, `main@0d2e6a2`. Everything described as shipped is
> **live in prod**. The route this handoff executes is
> [`fy2025-26-walkthrough.md`](fy2025-26-walkthrough.md) — that file is the *how*, this one is the
> *where we are and who does what*.
>
> **GENERAL INFORMATION ONLY.** Quillo never lodges, never holds money and never computes tax payable.
> Every judgement call — deductibility, cost-base composition, parcel choice, apportionment — is for a
> registered tax agent.

---

## 1. The one-line summary

**The engine is ready; the year is empty.** FY2025-26 holds 46 transactions, 1 income row and **zero
rent against 4 properties**, while FY2024-25 holds ~2,355 transactions. The owner's blocker on their
own return is **data entry, not build** — which is why the work is organised as a *dogfood run* rather
than a feature programme.

## 2. Three maps, running beside each other

None is a child of another. Each has its own destination; work is claimed one ticket at a time.

| Map | Destination | Status |
|---|---|---|
| [**#464** File FY2025-26](https://github.com/matchmoments-admin/quillo/issues/464) | A hand-over-ready accountant pack from real data, and every gap the run exposed fixed or decided | 8 tickets. **#469 answered** (held open, `needs-decision`). Frontier: #465 #466 #467 #468 — **all need the owner** |
| [**#473** What do CDR bank feeds actually cost us?](https://github.com/matchmoments-admin/quillo/issues/473) | The *price* of the feed — money, engineering, compliance — enough to commit or defer deliberately | 5 tickets. **#474 answered** (held open, `needs-decision`). Frontier: #475 #476 — **both need the owner** |
| [**#432** Simplify the tax-ready workflow](https://github.com/matchmoments-admin/quillo/issues/432) | A decision-complete build spec for the front end | 10 tickets, 2 resolved (#433, #437). **The only map with AFK work left: #440 first, then #439** |

**#464 DOES as well as decides** — an explicit override of wayfinder's plan-only default. #473 and #432
are planning maps: they produce decisions, not shipped code.

## 3. The owner's tax shape — CORRECTED 2026-08-02

The 2026-07-31 "settled facts" undercounted. The owner restated their situation in-session; the
corrected record is on [#466 (comment)](https://github.com/matchmoments-admin/quillo/issues/466) and
this supersedes fact 1 of the old list.

1. **THREE 100%-owned properties**: two tenanted (`use_status = rented`), one where the owner's dad
   lives rent-free (`private_use_rent_free` ⇒ deductions **DENIED**, CGT cost base still accrues —
   the runbook's Property-B denial narrative **stands**, there's just one more rented row than it
   describes). Plus the owner **rents their own residence** (`renting_residence`) — which is why prod
   has 4 property rows. ⚠️ **The runbook's two-property table
   ([`fy2025-26-runbook.md`](fy2025-26-runbook.md) Step 1) is now stale** — same instructions, one
   more rented property; not yet rewritten.
2. **No share disposals in FY2025-26** (unconfirmed since restated — re-ask before #468 commits an
   import; DRP participation also unconfirmed, and DRP is unbuilt, #455).
3. **FY2024-25 lodged, NOA not to hand.** `noa_capture` is ON and is the only route personal
   carry-forward losses reach FY2025-26.
4. **PAYG + renting their own home** ⇒ rent non-deductible; the live claim is WFH 70c/hr. "Leave main
   residence unticked" **remains correct for FY2025-26**.
5. **NEW, previously unrecorded anywhere:** a **pre-revenue Pty Ltd** with expenses (second taxpayer —
   the two-return handoff is not yet a deliverable of any map); a **novated lease starting this FY**
   (mid-year car changeover: part-year cents/km claim + RFBA — capture-only today, election is #494,
   zero persona coverage for the changeover); and in **FY2026-27 the owner moves out of the rental
   into one of the owned (mortgaged) properties** — inexpressible today because `use_status` is a
   single scalar; the effective-dated-periods design is **#492** (`needs-decision`). Which property
   they move into is unconfirmed (a formerly-tenanted one drags CGT apportionment; the dad one is
   simpler).

## 4. What the owner has to do — nobody else can

These need files, logins or decisions. **They are the critical path.**

| | Ticket | What it needs from you |
|---|---|---|
| 1 | [#466](https://github.com/matchmoments-admin/quillo/issues/466) | Set all THREE owned properties' `use_status`, periods and loan facts (the corrected facts are already commented on the ticket; still open: vacancy gaps, is dad paying *anything* (#184), redraw/offset on the loans, `acquired_date` + cost bases). **Minutes of work; do it first** |
| 2 | [#465](https://github.com/matchmoments-admin/quillo/issues/465) | Upload FY2025-26 statements for **every** account, including the loan accounts. **Record each file's date range as you go** — see the coverage trap below |
| 3 | [#468](https://github.com/matchmoments-admin/quillo/issues/468) | Export the broker / registry / exchange CSVs and run the import. **This path has never run against a real file.** Confirm no-disposals + DRP status first |
| 4 | [#467](https://github.com/matchmoments-admin/quillo/issues/467) | Fetch the FY2024-25 NOA from myGov and enter it |
| 5 | [#475](https://github.com/matchmoments-admin/quillo/issues/475) | Ask Basiq for the platform access fee **in writing**; quote Fiskil and Skript |
| 6 | [#476](https://github.com/matchmoments-admin/quillo/issues/476) | Set the AWS secrets so Bedrock `au.` can be activated |

## 5. ⚠️ The coverage trap — read before uploading anything

**Nothing in Quillo checks that your statements cover the whole year.** Reconciliation is *within* a
statement only; `statements` has **no `period_start` / `period_end`** (`schema.sql:244-261`).

> Upload Jul–Feb and Apr–Jun for one account. **Every file reports `reconciled = 1`.** March is
> silently absent, the position is understated, and **no finding fires anywhere in the app.**

[#465](https://github.com/matchmoments-admin/quillo/issues/465) is exactly that shape. Tracked as
[#472](https://github.com/matchmoments-admin/quillo/issues/472), wired `#465 → #472 → #470`.

## 6. Shipped 2026-08-02/03 — the fix wave (live in prod)

A capability audit of the app against the owner's **corrected** situation found a family of
captured-then-orphaned / engine-yes-display-no defects. **5 PRs (#495–#499), no migrations, all
gates green** (personas now **306**, AU snapshot byte-identical throughout). The previous wave
(#479–#491) is described in this file's git history.

| PR | What | Why it mattered |
|---|---|---|
| [#495](https://github.com/matchmoments-admin/quillo/pull/495) | Dead WFH-checklist condition (`kind === "payg"` can never match); car-logbook honesty copy; two stale flag comments | The card said "Recommended: Logbook · $X" while the position quietly used cents-per-km |
| [#496](https://github.com/matchmoments-admin/quillo/pull/496) | Add-asset form can attach a property/entity | A hand-typed rental appliance depreciated in the headline but was invisible on the property's schedule and exempt from the rent-free lockout. No `updateAsset` endpoint exists — editing an existing asset's attachment is still delete + re-add |
| [#497](https://github.com/matchmoments-admin/quillo/pull/497) | **`reportable_amounts`** (flag, ON): RFBA + RESC surfaced — report payload, readiness defer finding, accountant-pack informational section | Both were extracted into `income.detail_json` and read by **nothing**; they feed income tests the app never computes. Review caught: RFBA is ANNUAL ⇒ **per-employer MAX, never a row sum**. Matters directly for the owner's novated lease |
| [#498](https://github.com/matchmoments-admin/quillo/pull/498) | **`company_carryforward`** (flag, ON): company loss carry-forward **derived from the ledger** with profit-year utilisation; readiness line defers COT/SBT | `company_tax_positions` has **no writer anywhere**, so every company's loss silently reset each FY. The table is now dead in BOTH flag states (ADR-0002 updated); dropping it is a destructive migration needing its own sign-off |
| [#499](https://github.com/matchmoments-admin/quillo/pull/499) | [#490](https://github.com/matchmoments-admin/quillo/issues/490) closed: reconcile caps killed — fy/limit params, TRUE "X of Y" totals, `RECONCILE_SCAN=2000` + `lines_available`, lines score-ordered server-side | The page rendered `LIMIT 200` as the whole queue. `best_receipt_id` per line is the deliberate seed of the shape-B proposer — but it has a **500-receipt scoring bound**; don't give it a consumer until receipts paginate |

Also filed: **[#494](https://github.com/matchmoments-admin/quillo/issues/494)** (car method
election, `needs-decision` — auto-swapping the logbook in would double-count: car depreciation is
already fully deducted and business-bucket fuel is never excluded; P4's golden *pins* that shape) and
**[#492](https://github.com/matchmoments-admin/quillo/issues/492)** (property use periods).

## 7. Facts verified — don't re-derive them

- **Cloudflare D1/R2/DO have no AU jurisdiction** (only `eu`/`fedramp`; hints not guaranteed) ⇒ no
  contractual AU-residency claim while D1 is the store. Recorded at `src/index.ts:83`, `wrangler.toml:136`.
- **Migration chain complete through `0074`. Next free: `0075`.** Run `ls migrations/ | tail -1`.
- **Feature flags: 97 keys, 95 ON**, 2 OFF (`phi_tax_inputs`, `partnership_losses`).
- **There is NO auto-matcher.** `agent.ts` manual Link is the only `matched_txn_id` writer; the
  scorer now proposes an ordering server-side but confirms nothing
  ([`ux/reconcile-fold-findings.md`](ux/reconcile-fold-findings.md)).
- **Bedrock `au.` is built and inert** — `llm.ts:40`, `assertAuResidency` at `llm.ts:71`. Needs AWS
  secrets and a per-tenant flip, not a build.
- **Known gaps vs the owner's situation, tracked but unbuilt:** salary packaging / pre-tax lease
  deductions (absent), DRP parcels (#455), AMIT application (#454), `ownership_pct` applied to
  ongoing rent/expenses (CGT-only today — inert while everything is 100%-owned), below-market rent
  (#184), mid-year `use_status` change (#492).

## 8. The decisions waiting on the owner

All `needs-decision`, deliberately **open** — the research is done, the call isn't mine.

| | Decision | Recommendation |
|---|---|---|
| [#474](https://github.com/matchmoments-admin/quillo/issues/474) | **PS8**: option **A** (stay on Cloudflare, test exception 2), **B** (AU-controlled infra), or **C** (no CDR) | **A.** PS8 is an *effective-control* test — the store migration does not resolve it and should not be scheduled. [`cdr-ps8-findings.md`](cdr-ps8-findings.md) |
| [#469](https://github.com/matchmoments-admin/quillo/issues/469) | Two-figure cost base (`reduced_cost_base_cents`)? | **Yes, but not this year** — derive from `use_status_denied` rows; deadline is the first disposal. [`cgt-third-element-findings.md`](cgt-third-element-findings.md) |
| [#492](https://github.com/matchmoments-admin/quillo/issues/492) | Effective-dated `property_use_periods` (day-apportioned deductions) | **Yes, before FY2026-27** — the owner's own move is the dated forcing function; nothing needed for FY2025-26 |
| [#494](https://github.com/matchmoments-admin/quillo/issues/494) | Car method election (logbook vs cents/km) | Decide before the novated lease starts if the part-year logbook figure looks material; prerequisites documented on the ticket |
| [#461](https://github.com/matchmoments-admin/quillo/issues/461) | Drop dead `cgt_assets.status` (**destructive**) | **Not during a live return run** |

## 9. Sequencing — what to do first

1. **[#466](https://github.com/matchmoments-admin/quillo/issues/466)** (minutes) — property setup for
   all three owned properties; the corrected facts are already on the ticket.
2. **[#465](https://github.com/matchmoments-admin/quillo/issues/465)** → **[#472](https://github.com/matchmoments-admin/quillo/issues/472)** — statements, then verify coverage per account.
3. **[#468](https://github.com/matchmoments-admin/quillo/issues/468)** in parallel — after re-confirming
   no-disposals + DRP status.
4. **[#476](https://github.com/matchmoments-admin/quillo/issues/476)** whenever the AWS secrets exist.
5. **Remaining AFK work is on map #432**: **[#440](https://github.com/matchmoments-admin/quillo/issues/440)**
   next (which Wave 1 flag collapses are safe — with 95 of 97 flags ON it decides whether the flag
   system is retired or kept; known trap already on the ticket: `grouped_review_v2` gates a server
   payload contract, and there's a fourth flag `accountant_pass`), then
   **[#439](https://github.com/matchmoments-admin/quillo/issues/439)** (trace personas 2 and 9;
   disposition Income/Extras/Savings — `Extras.tsx` is the largest page in `web/src` and has never
   been reviewed). Wayfinder discipline: one ticket per session.

Then [#470](https://github.com/matchmoments-admin/quillo/issues/470) (review queue) and finally
[#471](https://github.com/matchmoments-admin/quillo/issues/471) (the pack) — the map's acceptance check.

## 10. Standing constraints

- **Deploy-only.** macOS 12.6 can't run `workerd`; verify via `npm run typecheck`,
  `cd web && npx tsc --noEmit && npm run lint`, `npm test`, then deploy.
- **The gates:** 1037 units + **306 personas** + 12 e2e + AU snapshot + statement reconciliation + schema drift.
- **Nothing destructive has been run.** Outstanding destructive changes: #461 (`cgt_assets.status`)
  and, since #498, `company_tax_positions` is equally dead — both need an explicit go.
- **Never touch #461 during a live return run.**
