# FY2025-26 — the state of play, and what happens next

> **Read this first.** State as at **2026-08-01**, `main@72779c3`. Everything described as shipped is
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
| [**#464** File FY2025-26](https://github.com/matchmoments-admin/quillo/issues/464) | A hand-over-ready accountant pack from real data, and every gap the run exposed fixed or decided | 8 tickets, 5 on the frontier |
| [**#473** What do CDR bank feeds actually cost us?](https://github.com/matchmoments-admin/quillo/issues/473) | The *price* of the feed — money, engineering, compliance — enough to commit or defer deliberately | 5 tickets, 3 on the frontier |
| [**#432** Simplify the tax-ready workflow](https://github.com/matchmoments-admin/quillo/issues/432) | A decision-complete build spec for the front end | 9 open, 1 resolved |

**#464 DOES as well as decides** — an explicit override of wayfinder's plan-only default. #473 and #432
are planning maps: they produce decisions, not shipped code.

## 3. The owner's tax shape — settled, do not re-ask

Established by grilling 2026-07-31. These facts shape every ticket.

1. **Two properties. One rented; the other is `private_use_rent_free`** — a relative lives there
   rent-free ⇒ deductions correctly **DENIED** while the CGT cost base still accrues.
2. **No share disposals in FY2025-26** — bought and held only. This collapses the capital work to pure
   *capture* and makes [#454](https://github.com/matchmoments-admin/quillo/issues/454) (AMIT), parcel
   choice and every cost-base-used blocker **moot this year**.
3. **Both properties 100% owner-owned** ⇒ the `ownership_pct = 100` fast path;
   [#125](https://github.com/matchmoments-admin/quillo/issues/125) is irrelevant to this return.
4. **FY2024-25 lodged, NOA not to hand.** `noa_capture` is ON and is the only route carry-forward
   losses reach FY2025-26.
5. **PAYG, renting their own home.** Rent paid is correctly non-deductible; the live claim in that
   shape is **WFH running costs at 70c/hr**, never occupancy.

## 4. What the owner has to do — nobody else can

These need files, logins or decisions. **They are the critical path.**

| | Ticket | What it needs from you |
|---|---|---|
| 1 | [#466](https://github.com/matchmoments-admin/quillo/issues/466) | Set both properties' `use_status`, periods and loan facts. **Minutes of work; do it first** — it changes how every property expense is treated and saves re-triaging the queue |
| 2 | [#465](https://github.com/matchmoments-admin/quillo/issues/465) | Upload FY2025-26 statements for **every** account, including both loan accounts. **Record each file's date range as you go** — see the coverage trap below |
| 3 | [#468](https://github.com/matchmoments-admin/quillo/issues/468) | Export the broker / registry / exchange CSVs and run the import. **This path has never run against a real file** |
| 4 | [#467](https://github.com/matchmoments-admin/quillo/issues/467) | Fetch the FY2024-25 NOA from myGov and enter it |
| 5 | [#475](https://github.com/matchmoments-admin/quillo/issues/475) | Ask Basiq for the platform access fee **in writing**; quote Fiskil and Skript |
| 6 | [#476](https://github.com/matchmoments-admin/quillo/issues/476) | Set the AWS secrets so Bedrock `au.` can be activated |

## 5. ⚠️ The coverage trap — read before uploading anything

**Nothing in Quillo checks that your statements cover the whole year.** Reconciliation is *within* a
statement only; `statements` has **no `period_start` / `period_end`** (`schema.sql:244-261`).

> Upload Jul–Feb and Apr–Jun for one account. **Every file reports `reconciled = 1`.** March is
> silently absent, the position is understated, and **no finding fires anywhere in the app.**

[#465](https://github.com/matchmoments-admin/quillo/issues/465) is exactly that shape — every account,
both loan accounts, a whole year. A missing month of rent and interest would reach the accountant pack
looking complete. Tracked as [#472](https://github.com/matchmoments-admin/quillo/issues/472), wired
`#465 → #472 → #470`.

## 6. Shipped in this session — live in prod

| PR | What | Why it mattered |
|---|---|---|
| [#479](https://github.com/matchmoments-admin/quillo/pull/479) | [#444](https://github.com/matchmoments-admin/quillo/issues/444) — readiness position lines now reconcile to the headline | Franking gross-up, super deduction and applied tax losses each moved the headline while rendering **no line**. The owner has franked dividends and would have hit it |
| [#480](https://github.com/matchmoments-admin/quillo/pull/480) | Literal NUL bytes removed; three stale `0070_` doc reservations corrected | `grep`/`rg` were **silently skipping `src/lib/report.ts`** — the 73KB money pipeline |

Both money-neutral: **AU snapshot byte-identical, 293/293 personas green.**

Two durable guards were added, and they matter more than the fixes:

- **`npm test` now asserts all position lines sum to `indicative_taxable_position_cents`.** The old
  assertion only guarded *within* the deduction group — the exact hole three terms fell through. The
  next term added to `buildReport` without a line fails CI.
- **`npm test` now asserts no literal NUL bytes in tracked source.** It immediately caught a third
  instance the fix's own comment had introduced.

## 7. Facts verified this session — don't re-derive them

- **Cloudflare D1, R2 and Durable Objects support only `eu` and `fedramp` jurisdictions. There is no
  AU/Oceania one**, and location hints are documented as *not guaranteed*. Verified against
  Cloudflare's docs. ⇒ Quillo **cannot make a contractual AU-residency claim for its system of record**
  while D1 is the store. Already recorded at `src/index.ts:83` and `wrangler.toml:136`.
- **Migration numbering: there is no collision.** The chain is complete through
  `0074_capital_imports.sql`. **Next free is `0075`.** Three docs were stale and are now corrected.
  Run `ls migrations/ | tail -1` rather than trusting a number in prose.
- **Feature flags: 94 keys, 92 ON**, 2 OFF (`phi_tax_inputs`, `partnership_losses`).
- **Duplicate calculators are real**: `WorkMethodsCard`/`CarMethodsCard` mount on **both**
  `Dashboard.tsx:87-88` **and** `Reports.tsx:143-144`.
- **`assessFilingReadiness` is read by one component** — `Filing.tsx:84`, the last page a user reaches.
- **Bedrock `au.` is built and inert** — `llm.ts:40`, `assertAuResidency` at `llm.ts:71`. Needs AWS
  secrets and a per-tenant flip, not a build.

## 8. The decision that gates the most money

[**#474**](https://github.com/matchmoments-admin/quillo/issues/474) — does Privacy Safeguard 8's
"overseas recipient" prohibition turn on **who receives** the data or **where it rests**?

The planning input reasons that a Worker which decrypts CDR data performs a *disclosure*, triggering
PS8 — an **entity** test — then proposes moving the store to an AU **region** (Turso, Aurora). Turso
and AWS are both US-incorporated. **If the test is entity-based, that XL re-platform changes the
compliance position not at all.**

There is also a cheaper possibility written into the ticket: ADR-0003 §7 already says the arrangement
must name Cloudflare and AWS as OSPs. **If that naming is sufficient, there is no migration.**

The owner has decided Basiq is the right call and that decision stands. The open question is not
*whether* — it is that **A$20 is the vendor price, not the engineering price**, and the engineering
price is unknown until #474 resolves.

## 9. Sequencing — what to do first

1. **[#466](https://github.com/matchmoments-admin/quillo/issues/466)** (minutes) — property setup gates
   the largest downstream rework.
2. **[#465](https://github.com/matchmoments-admin/quillo/issues/465)** → **[#472](https://github.com/matchmoments-admin/quillo/issues/472)** — statements, then verify coverage per account.
3. **[#468](https://github.com/matchmoments-admin/quillo/issues/468)** in parallel — the capital import
   is the highest-information ticket and low-risk this year (no disposals).
4. **[#476](https://github.com/matchmoments-admin/quillo/issues/476)** whenever the AWS secrets exist —
   unconditional, already built, unblocks the CDR track.
5. **[#474](https://github.com/matchmoments-admin/quillo/issues/474)** and
   **[#469](https://github.com/matchmoments-admin/quillo/issues/469)** are AFK research — they can run
   without the owner.

Then [#470](https://github.com/matchmoments-admin/quillo/issues/470) (review queue) and finally
[#471](https://github.com/matchmoments-admin/quillo/issues/471) (the pack) — the map's acceptance check.

## 10. Standing constraints

- **Deploy-only.** macOS 12.6 can't run `workerd`; verify via `npm run typecheck`,
  `cd web && npx tsc --noEmit && npm run lint`, `npm test`, then deploy.
- **The gates:** 1037 units + 293 personas + 12 e2e + AU snapshot + statement reconciliation.
- **Nothing destructive has been run.** The one outstanding destructive change is
  [#461](https://github.com/matchmoments-admin/quillo/issues/461) (dropping `cgt_assets.status`),
  which needs an explicit go and is **not** the one-line migration it looks like.
- **Never touch #461 during a live return run.**
