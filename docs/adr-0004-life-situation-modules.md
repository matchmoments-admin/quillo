# ADR-0004 — Life situations plug in through one SituationModule registry

**Status:** Accepted · **Date:** 2026-10-24 · **Context:** map #692, decision #732, audit [`docs/architecture/deepening-2026-10.md`](architecture/deepening-2026-10.md) §"Life-situation seam"

Quillo has to help anyone do their taxes, whatever their life involves: a simple PAYG job, rental
properties, a novated lease, a company, a trust. The architecture audit found every situation can
already land **additively**, but each one has touched 6–17 files. `buildReport` has written
summands inline, readiness has kept a hand-written list, and the accountant pack has kept its own.

**Decision.** Every life situation from now on is a `SituationModule` in
`src/lib/situations/<key>.ts`, registered once in `situations/index.ts`. The modules are loaded over
a single `ReportContext`, and `composePosition` (`src/lib/position.ts`, PR #716) is the **only**
place money is combined.

```ts
interface SituationModule<R> {
  key: string;                                            // the Report field it owns
  flag: FeatureKey;                                       // OFF ⇒ not loaded ⇒ field absent ⇒ byte-identical
  load(ctx: ReportContext): Promise<R | null>;            // the reader
  contributes?(r: R): Partial<PositionSummands>;          // absent ⇒ information only
  findings?(r: R, report: Report): ReadinessFinding[];    // readiness iterates the registry
  schedule?(r: R, ctx: ReportContext): ScheduleSection[]; // the accountant pack iterates the registry
}
```

## The boundary (what is and isn't a module)

| Kind | Examples | Shape |
|---|---|---|
| **Situation module** | CGT, ESS, trust, partnership, franking, super, trading stock, reportable amounts (RFBA/RESC), novated lease, Div 7A, HELP, MLS info, SMSF, car logbook, GST/PAYG | one file, registry entry, flag |
| **Core ledger fold** (not a module) | `byBucket`, attributions, loan interest, refunds, work methods' deduction total | stays in the deduction engine; feeds `deductions_cents` |
| **Context** (not a module) | jurisdiction, rule pack, FY bounds, separate-taxpayer ids, **person scope** | lives in `ReportContext` |

## Settled choices

- **Readiness findings belong to the module.** Keeping a situation's read, money, findings and pack
  section in one file is the point. `assessReadiness` iterates the registry for situation findings
  and keeps the core findings (unreviewed lines, missing receipts) central.
- **Partner / spouse is a scope, not a module.** `ReportScope.personId` (#722) is threaded through
  `ReportContext`. It changes money output for a tenant with two earners, so it lands behind
  `person_scoped_income` (default OFF, byte-identical) with a two-earner golden. An information-only
  MLS module comes after it.
- **A persona comes before its module.** Novated lease has no persona today (P1–P10 don't cover it),
  so P11, a PAYG employee with a novated lease, is added to `docs/personas.md` and the goldens
  before the module ships.
- **The order of migration:**
  1. Move one existing information-only block, reportable amounts (#718), to prove the registry
     with zero money risk.
  2. Move one contributing summand (franking or ESS).
  3. Build the novated-lease module.
  4. Then Div 7A.

  Each step is its own PR with the AU snapshot byte-identical.

## Considered options

- **Keep explicit inline code in `buildReport`.** It's greppable with no indirection, but every new
  situation edits 6–17 files and the two position endpoints can drift. Rejected; drift has already
  happened once and was fixed in #716.
- **A plugin system with runtime registration or dynamic imports.** Rejected as over-built. A static
  array of modules is enough, and it keeps the bundle and types simple.

## Consequences

- A reader of `buildReport` no longer sees every summand inline. They follow `situations/index.ts`.
- All values stay integer cents. If a fractional summand ever appears, `composePosition` must round
  at its input, so that the summation order can't change the result.
- The jurisdiction-neutral rule (memory: jurisdiction-neutral by construction) composes naturally:
  a module can be AU-only by its `flag`/jurisdiction check without touching the core.
