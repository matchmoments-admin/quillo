# Codebase-architecture deepening opportunities (October 2026)

> Wayfinder ticket #700 on map #692 (*Enterprise-ready for new users*). Audited 2026-10-24 against
> `main` at `a2e5216`. It builds on the [feature inventory](feature-inventory.md) (#695) and respects
> [ADR-0001](../adr-0001-do-write-coordinator-d1-ceiling.md) (the DO is the write coordinator and D1
> is the ceiling) and [ADR-0002](../adr-0002-canonical-sources.md) (one canonical source per fact).
> Vocabulary is from `/codebase-design`: **module, interface, depth, seam, adapter, leverage,
> locality**.

## How to read this

Each opportunity gives:

- the **current shape** (file:line on `a2e5216`);
- the **deeper module** proposed;
- its **interface**;
- the **test** the module makes possible;
- the **migration path**.

Every migration path is additive, flag-gated where it touches money, and keeps the 10 contract
personas (578 goldens) and the AU snapshot green.

**Rank** weighs benefit (simplicity, testability, scale, ease of adding life situations) against risk
(money output, blast radius). **Disposition** is one of:

- **shipped**: a PR is open;
- **ticketed**: there is a GitHub issue labelled `area:architecture`;
- **accepted**: recorded here, and no action is planned.

## Ranked list

| # | Opportunity | Benefit | Risk | Disposition |
|---|---|---|---|---|
| 1 | One `aiCall` gate for every model call (APP-8 consent + budget + xborder audit) | High: a non-negotiable invariant enforced in one place; one bug found | Medium: every model path | **Ticketed #721** (the budget-gate bug ships first) |
| 2 | The life-situation seam: `composePosition` now, a `SituationModule` registry next | High: a new situation touches 1–3 files instead of 6–17 | Low (step 1) / medium (registry) | **Step 1 shipped: PR #716.** Registry: **#147** (re-scoped) + proposed ADR-0004 |
| 3 | A person-scoped report (`ReportScope.personId`) | High: unblocks partner/MLS; removes a correctness trap | Medium: changes money output for any tenant with 2 earners | **Ticketed #722** (needs-decision) |
| 4 | One classified income ledger shared by the report and the accountant pack | Medium-high: kills a second income pipeline | Low-medium | **Ticketed #723** |
| 5a | One-time backfills scan every tenant on every 10-minute cron tick | High at scale: about 3N KV reads + 2 full scans every 10 min | Low | **Ticketed #724** |
| 5b | `buildReport` fan-out: about 47 sequential queries; `/api/journey` about 70+ | Medium-high: latency and D1 load | Low (read reordering) | **Ticketed #146** (updated) |
| 6 | One server-side review-queue module behind the 5 review surfaces | Medium: one grouping, one payload | Medium: UX coupling | **Ticketed #725** (after the #696 cut list) |
| 7 | Decompose `src/agent.ts` (7,962 lines) cluster by cluster | Medium per cluster, high cumulatively | Low per PR | **Ticketed #726** (umbrella) |
| 8 | One RFBA/RESC per-employer fold for the report and the pack | Medium: removes drift between payload and pack; the novated-lease seam | Low (pure) | **Shipped: PR #718** |
| 9 | Share taxonomy, FY-label and money helpers between web and Worker | Low-medium | Low | **Ticketed #727** |
| 10 | Property use periods: move the gate from a SQL 0/1 marker to a per-property fraction | Unblocks change of use | Medium (money; needs-decision) | **Seam note on #492** |
| 11 | Three AI helper endpoints (`/api/chat`, `/api/ask`, `/api/guide`) | Low until the cut list decides which survive | Low | **Accepted.** Folded into #721 (the shared gate) and the #696 cut list |
| 12 | Per-DO SQLite stays unused for tenant data (ADR-0001) | n/a | n/a | **Accepted.** No change; shard-by-tenant stays the documented escape hatch |

---

### 1. One `aiCall` gate for every model call (#721)

- **Current shape.** Every model call in the DO hand-writes the same sequence: provider, APP-8 consent
  check, `withinBudget`, `getLLM`, `auditXborderInference`, extractor, `audit`.
  - The consent check `provider === "anthropic" && profile.consent_xborder !== 1` is written **13
    times** (agent.ts 409, 850, 1216, 2548, 2761, 3687, 4306, 4676, 7018, 7400, 7433, 7480, 7552).
  - `withinBudget` is called 14 times and `auditXborderInference` 13 times.
  - The order varies between callers. `src/api.ts` maps `consent_required`→403 and
    `ai_budget_reached`→429 four times.
  - **Bug:** `importDepreciationSchedule` (agent.ts ~4303–4308) checks consent but **never checks
    the budget**, so a QS-schedule PDF import bypasses the per-tenant and global cost caps.
- **Deeper module.** `src/lib/ai-call.ts`.
- **Interface.** `aiCall(deps, { userId, purpose, profile }, (llm) => Promise<T>)`.
  - It throws `ConsentRequired` or `BudgetReached` before the callback runs.
  - It records the cross-border audit.
  - `deps = { env, withinBudget, audit }`, so a test passes fakes.
  - `aiErrorResponse(e)` replaces the 4 mappings in api.ts.
- **Test.** A table over every `purpose`: no consent, or over budget, means the callback is never
  invoked. A source guard bans a raw `getLLM(` outside `aiCall`, like the existing `RECEIPTS.get(`
  ban.
- **Migration.**
  1. The one-line budget fix.
  2. The 4 AI front doors.
  3. The remaining 9 callers, one PR each.
  4. The guard.

  No money output changes.

### 2. The life-situation seam (PR #716 shipped; #147)

Covered in full in [the seam section below](#life-situation-seam). Summary:

- **Current shape.** The position formula was written out twice: the tracked end (report.ts:887–889)
  and the confirmed end (report.ts:1004–1006). `buildReport` has 19 `featureOn` blocks and about 50
  hand-written `Report` fields.
- **Shipped (PR #716).**
  - `src/lib/position.ts` holds `composePosition(summands, deductions_cents, carried_tax_loss_cents)`.
  - Both endpoints share one `PositionSummands` object.
  - Byte-identical (AU snapshot and 578 goldens). 6 new units, including confirmed ≥ tracked and a
    guard against an inline copy.
- **Next (#147).** A `SituationModule` registry, after ADR-0004.

### 3. A person-scoped report (#722)

- **Current shape.** `buildReport` calls `incomeTotals` (report.ts:643) without a `personId`.
  - It is the **only** caller, so the `personId` and `propertyId` options (ledger-totals.ts:192–223)
    have never been used.
  - A spouse's income would be added to the user's headline.
- **Deeper module.** One scope value threaded through the pipeline.
- **Interface.** `type ReportScope = { userId; personId? }`; `buildReport(env, scope, fy)`.
  - Per-person readers take the scope.
  - Tenant-level readers (properties, companies) ignore it.
- **Test.** A two-earner golden.
  - Flag OFF: the headline is the sum of both (byte-identical).
  - Flag ON: the headline is the self's income only, and the spouse's income is available to the MLS
    test.
- **Migration.** Behind a flag (`person_scoped_income`), with P6 as the persona. It changes money
  output, so it needs an owner decision.

### 4. One classified income ledger (#723)

- **Current shape.** The accountant pack re-implements the income query (accountant-schedule.ts:340–350).
  - It re-applies `NON_ASSESSABLE_INCOME_TYPES` and the residency classification in JS (:722–727).
  - The residency context is resolved twice.
  - The separate-taxpayer clause is written out **5 times**: ledger-totals.ts:152, 203, 766;
    report.ts:921; accountant-schedule.ts:325.
  - `tie_back` checks subtotals, not rows, and that gap has caused a bug before.
- **Deeper module.** `incomeLedger(env, scope, fy) → { rows: ClassifiedIncomeRow[]; totals }`.
  - The report reads `totals`; the pack renders `rows`.
  - There is one classification.
- **Test.** A row-level tie-back for every persona: the sum of the pack's assessable rows equals
  `report.income.gross_cents`.
- **Migration.**
  1. Extract `separateTaxpayerClause(ids)` (byte-identical SQL).
  2. `incomeTotals` returns its rows.
  3. The pack switches to those rows.

  This must land before #722, so the person scope goes in one place.

### 5a. Cron fan-out (#724)

- **Current shape.** The `*/10` cron (src/index.ts ~439–491) runs 3 **one-time** backfills on every
  tick, with no end date.
  - On each tick, `SELECT user_id FROM profiles` runs twice.
  - `runOnceGuarded` then does a KV read per tenant per backfill, even when the work finished long ago.
  - That is about 3N sequential KV reads plus 2 full scans every 10 minutes. At 1,000 tenants it comes
    to about 430k no-op KV reads a day, and the loop will eventually hit the cron time limit.
- **Deeper module.** `runBackfillOnce(env, key, perTenant)`: a global completion marker, KV-cursor
  paging (the #79 pattern), and one KV read per tick once the backfill is done.
- **Test.** With a fake KV and DB: a finished backfill does 0 scans; one in progress handles at most
  one page per tick.
- **Migration.** Confirm the 3 backfills have finished in prod. If they have, delete the loops;
  otherwise wrap them.

### 5b. `buildReport` and journey fan-out (#146)

- **Current shape.** One `buildReport` issues about 47 sequential D1 queries with flags on.
  - It uses no `Promise.all` and no `DB.batch`.
  - `profiles` is read 3+ times.
  - `/api/journey` → `filing-readiness.ts:69` costs about 70+ queries per mount (Home, ReviewQueue).
  - The BAS-quarter loop (report.ts ~571) is an N+1 that also hardcodes Jul–Jun dates, although the
    jurisdiction is resolved a few lines above.
- **Deeper module.** A `ReportContext` loaded once (profile, jurisdiction, rule pack, separate ids,
  FY bounds). Independent readers run under `Promise.all`; the quarters become one `GROUP BY`.
- **Test.** The AU snapshot stays byte-identical. A query-count assertion on the persona D1 shim
  checks that the count falls and never regresses.
- **Migration.** Pure read reordering. It pairs with #147, because `ReportContext` is the registry's
  `load` input.

### 6. A review-queue module (#725)

- **Current shape.** 5 routes, 3 components (`ReviewView`, `Review`, `ReviewQueue`), and **no shared
  server module**. The only shared piece is `NEEDS_REVIEW`, at queries.ts:117.
  - **Three merchant-grouping keys:** `clarify.ts:49`, `ReviewView.tsx:272`, `web/src/lib/claims.ts:32`.
  - **`DEDUCTIBLE_STATES` written 3 times.**
  - **Duplicate fetches:** ReviewQueue re-fetches what `/api/journey` already computed.
  - **The `/inbox` alias** resolves differently in `main.tsx:125` and `legacyRoutes.ts`.
- **Deeper module.** `reviewQueue(env, scope, fy, { view }) → { groups, counts }`. It is
  server-grouped, with one bulk write: `resolveReviewGroup(groupKey, verdict)`.
- **Test.** Same tenant, every view: identical group keys and counts.
- **Migration.** Start after #696 decides which surfaces survive. Move one surface at a time, then
  flag the retired ones OFF (map rule: flag off first, delete later).

### 7. Decompose `src/agent.ts` (#726)

- **Current shape.** 7,962 lines in one class.
  - 315 inline `DB.prepare` calls and 174 `audit(` calls.
  - Biggest clusters: bank feed (~910 LOC), statements (~815), clarify/movements (~615).
  - Most DO behaviour is tested by **regex over the source**, not through an interface. That is a sign
    of the wrong test surface.
- **Deeper module.** `src/lib/<cluster>.ts` taking `TenantDeps = { env, userId, audit }`. The DO
  method becomes a one-line delegation, exactly as `filing-readiness.ts` and `journey-read.ts` already
  do.
  - The DO stays the per-tenant write coordinator and audit façade (ADR-0001 is unchanged).
  - First pure extractions:
    - the address resolver (3570–3655)
    - `budgetVerdict` (7716–7810)
    - `reviewClaims` grouping (4594–4641)
    - the receipt system prompt (7581–7609)
    - the keyword matcher (1671–1695 and 4155–4177)
    - `thresholdForFy`/`toDepAsset`
- **Test.** Behavioural tests on the `node:sqlite` D1 shim that the persona suite already uses.
- **Migration.** One cluster per PR, each byte-identical.

### 8. One RFBA/RESC fold (PR #718 shipped)

- **Current shape.** The per-employer MAX rule (annual figures, never a sum of payslips; null == 0;
  unnamed employers merge) was written out in report.ts:919–948 **and** accountant-schedule.ts:812–826.
  Only a comment ("mirrors buildReport's reportable_amounts exactly") kept the two in step.
- **Shipped.** `src/lib/reportable-amounts.ts`: `reportableAmountsByEmployer(detailJsons)` and
  `reportableAmountsTotal(map)`. Each caller keeps its own query and scope. Byte-identical; 8 new
  units.
- **Why it matters for situations.** RFBA is a novated lease's only footprint in the data today. This
  module is what a salary-packaging situation and the MLS/HELP income tests will read.

### 9. Shared helpers between web and Worker (#727)

- **Current shape.**
  - `BUCKETS` and `PROPERTY_BUCKETS` are copied in `src/lib/taxonomy.ts` and `web/src`.
  - The FY-label template has 7 copies, plus 3 open-coded in report.ts (721, 802, 925), although
    `fyLabel` is already imported (ADR-0002 calls `fyLabel` the only sanctioned producer).
  - Money formatting has 6 copies.
- **Deeper module.** A dependency-free `shared/` folder (`taxonomy.ts`, `fy.ts`, `money.ts`) that
  both tsconfigs include.
- **Test.** A guard that bans the FY template outside `shared/fy.ts`.
- **Migration.** Byte-identical steps.

### 10. Property use periods (#492, seam note)

- **Current shape.** The use-status gate is a row-level SQL 0/1 marker (`useStatusDeniedExpr`), baked
  into `byBucket`, `byPropertyRaw` and `resolved`. A boolean in SQL can't say "rented 182 of 365 days".
- **Deeper module.** A pure `propertyUseFractions(periods, fyBounds)`, read from `situation_periods`
  (`subject_kind='property'`, already reserved). It is applied in the per-property fold in
  TypeScript, the same place `loanInterestByProp` is folded today, and it contributes through the
  situation seam.
- **Test.** A mid-year-move golden. With the flag OFF, the SQL marker stays (byte-identical).
- **Migration.** Waits on the owner's model decision (#492 is needs-decision).

### Accepted (no action)

- **AI helpers (11).** Having three endpoints is a *product* duplication; the #696 cut list decides
  which survive. The *code* duplication (`askQuestion` and `chatTurn` share about 15 lines of
  grounding) mostly disappears once #721 lands. A shared `groundedAnswer()` is worth extracting only
  if both ask and chat survive the cut.
- **Per-DO SQLite (12).** ADR-0001 still holds. Shard-by-tenant stays the documented escape hatch,
  and #724 and #146 are the D1 pressure points to fix first.

---

<a id="life-situation-seam"></a>

## Life-situation seam

### Can the system take a new situation additively?

**Yes, but not cheaply.** The inventory's verdict holds: all 13 situations extend without a
destructive migration or a pipeline rewrite. What is missing is **locality**. A new situation
spreads across 6 to 17 files:

| Commit | Situation | Files touched |
|---|---|---|
| 817f00e | reportable_amounts (RFBA/RESC) | 8 |
| 0d20555 | company carry-forward | 6 |
| cffd1d1 | residency_assessability | 16 |
| 9d45947 | wfh_car_methods (new table) | 15 |
| ddde178 | partnership | 17 |

The usual checklist for a situation that changes money and needs a table touches all of these:

- a domain lib
- a `ledger-totals` reader
- in `report.ts`: a flag block, a `Report` field, and (until #716) **both** position formulas
- `features.ts` and `wrangler.toml`
- a migration and `schema.sql`
- `PURGE_TABLES`, and `CHILD_REFS` if it has a parent
- a readiness finding in an 820-line `assessReadiness` (57 inline `findings.push`)
- an accountant-pack section
- the myTax worksheet
- the rule pack
- capture in agent.ts and api.ts
- web types, client and page
- goldens

Some of these are **essential**: schema, retention, the flag, capture UI, the golden. Each is a
different concern, and a registry should not hide them. The rest are **accidental**. They exist
only because there is nowhere for a situation to *live*: the read, the position contribution, the
report field, the readiness finding and the pack section are all scattered.

How the three named situations would land today:

- **Novated lease / salary packaging.** The `entities.kind='novated_lease'` row feeds no money
  figure. RFBA is captured, and since #718 it is folded in one place. It needs:
  - a `salary_packaging` table `(user_id, fy, entity_id)`;
  - an info-only contribution, because RFBA is reportable and not assessable;
  - income-test inputs;
  - **a persona first**: none of P1–P10 has a novated lease.
- **Div 7A.** It needs:
  - a `div7a_loans` table `(user_id, entity_id, person_id, fy)`;
  - a deemed-dividend **assessable** summand when the minimum repayment is missed;
  - a readiness finding;
  - a pack section.

  `div7a_benchmark_rate_pct` is already in the pack, unused.
- **Partner / spouse (MLS).** This is not a module; it is a **scope**.
  - #722 (`ReportScope.personId`) comes first.
  - Then an info-only MLS module reads both persons' income-test figures (taxable income + RFBA +
    RESC, which #718 now provides).

### The single seam every future situation should use

**A `SituationModule` registry over a `ReportContext`, with `composePosition` as the only place
money is combined.**

```ts
// src/lib/situations/<key>.ts — one file per life situation (the module), registered in situations/index.ts
interface SituationModule<R> {
  key: string;                                         // the Report field it owns
  flag: FeatureKey;                                    // OFF ⇒ not loaded ⇒ field absent ⇒ byte-identical
  load(ctx: ReportContext): Promise<R | null>;         // the reader (null = nothing to show)
  contributes?(r: R): Partial<PositionSummands>;       // assessable/deductible; absent ⇒ info-only (RFBA, GST, SMSF)
  findings?(r: R, report: Report): ReadinessFinding[]; // readiness iterates the registry
  schedule?(r: R, ctx: ReportContext): ScheduleSection[]; // the accountant pack iterates the registry
}
interface ReportContext { env; scope: ReportScope; startYear; bounds; jurisdiction; rulePack; separateIds }
```

- **Depth.** `buildReport` becomes "load the context, load the enabled modules in parallel, compose
  the position, spread the fields". A new situation is **one module file plus one registry line**. On
  top of that come its essential, separate concerns: schema, capture UI and the golden.
- **Locality.** A situation's read, contribution, finding and pack section sit in one file, so
  reviewing Div 7A means reading one file.
- **It is a real seam.** About 12 existing summands and info blocks would be adapters on day one:
  CGT, ESS, trust, partnership, franking, super, trading stock, work methods, reportable amounts,
  GST/PAYG, car logbook and SMSF. That is far past the "two adapters" bar.
- **What stays outside it, deliberately.** The core ledger folds (`byBucket`, attributions, loan
  interest, refunds) are the deduction engine, not situations. Separate-taxpayer exclusion and the
  person scope are context, not modules.
- **Step 1 is shipped (#716).** `PositionSummands` and `composePosition` already make the formula a
  single point. A new summand added today goes into one field and both endpoints pick it up.
- **Ordering trap to keep.** All money values are integer cents, so the sum is order-independent.
  `composePosition` keeps the historical order anyway. If a fractional value ever entered a summand,
  the order would matter for byte-identity. `composePosition` should round at its input if that
  happens.

### ADR recommendation

**Write ADR-0004, "Life situations plug in through one SituationModule registry", before the first
summand moves.** It meets all three parts of the bar:

- **Hard to reverse.** Every future situation, and the readiness and pack consumers, take this shape.
- **Surprising.** A reader of `buildReport` would no longer see the summands inline. Readiness and the
  pack become registry consumers rather than hand-written lists.
- **A real trade-off.** It trades explicit, greppable code for indirection and locality. It also has
  to settle whether readiness findings belong to the module or stay central in `assessReadiness`.

The ADR should also record the boundary: what is a situation module and what is a core ledger fold
or context. #147 carries the work. The ADR needs the owner's acceptance; it is proposed here, not
accepted.

## What shipped from this ticket

| PR | Branch | What | Evidence |
|---|---|---|---|
| #716 | `arch/compose-position` | `src/lib/position.ts`: one position formula for the tracked and confirmed endpoints | typecheck, web tsc + lint, `npm test` green; personas 578/0; AU snapshot byte-identical; +6 units |
| #718 | `arch/reportable-amounts` | `src/lib/reportable-amounts.ts`: one RFBA/RESC fold for the report and the pack | same gates; RA flag-ON goldens unchanged; +8 units |

Neither PR is merged or deployed. Neither changes money or tax output.

_Related: [`feature-inventory.md`](feature-inventory.md) (life-situation matrix, observations 2, 4, 10, 11),
[`journeys.html`](journeys.html), ADR-0001, ADR-0002, issues #146, #147, #492, #721–#727._
