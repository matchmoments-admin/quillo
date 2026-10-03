# Personas 2 and 9 traced; Income, Extras and Savings dispositioned

> Findings for wayfinder ticket #439 on map #529 (*Ship-it-yourself — Quillo for first-time
> taxpayers*). Traced 2026-10-03 against `main` at `e441af4`. The question came from the old
> simplify-workflow map (#432): the 12-agent review in
> [`docs/ux/dashboard-simplification-review-2026-07.md`](../ux/dashboard-simplification-review-2026-07.md)
> never traced Daniel (2) or Aisha (9) and never read `Income.tsx`, `Extras.tsx` or `Savings.tsx`.
> It is answered here for the first-timer IA, where property, investments and entities move behind a
> "grow" layer. General information only.

## Verdict

- **Daniel (PAYG + shares + RSUs + CGT) can reach a filed-ready position**, but only by finding two
  cards at the bottom of the Income page. He hits one live defect on the way: the Income page's upload
  tells him his dividend statement was *not* read when it was, and tells him to type it in again. If
  he does, he double-counts the dividend and its franking credit (D1).
- **Aisha (pre-revenue Pty Ltd founder + ESS) cannot.** ESS works. But she has no way to enter R&D,
  because `rd_claims` has no API route and no UI. And a start-up cost she tags "s40-880" is deducted
  in full in year one, not spread over five years (D2). The coverage table's "capture-only, form
  tracked in #126" is stale: #126 was closed not-planned.
- **Income.tsx: keep it as a step, but split it.** The first-timer step is "your income": the
  statement upload, manual entry and duplicate-income linking. CGT, ESS, AMMA components, trading
  stock, entity attribution and rent move behind grow. In that shape Income **cannot** also take the
  distributions, SMSF and super sections the Settings ticket (#436) might send it. Those go to grow
  as well.
- **Extras.tsx: move behind grow** (proposed, confirm in the journey/IA ticket). It is a
  private-health engagement tracker and has no effect on the tax position. Its one tax-relevant fact
  (holds private hospital cover, which drives the Medicare levy surcharge) has a server writer that
  nothing in the SPA calls.
- **Savings.tsx: move behind grow and delete the compound-interest calculator** (proposed, confirm
  in the journey/IA ticket). It is not a tax step. Don't move `RunRateStrip` onto it.

## How the three pages are reached today

| | Route | Nav | Flag (prod) | Spine stop |
|---|---|---|---|---|
| Income | `/income` (`web/src/main.tsx:113`) | "1 · Bring in" (`web/src/App.tsx:39`) | none, always on | Bring in (`web/src/components/JourneySpine.tsx:22`) |
| Savings | `/savings` (`main.tsx:123`) | "5 · Save" (`App.tsx:66`) | `advisory_layer` ON | **none** |
| Extras | `/extras` (`main.tsx:124`) | "5 · Save" (`App.tsx:67`) | `phi_extras_tracker` ON | **none** |

- `nav_disclosure` is ON and puts "5 · Save" inside the "More ▾" disclosure (`App.tsx:255`,
  `:321-333`). The visible sidebar numbering is therefore 1, 2, 3, 4, 6 (already found by the dossier).
- Neither `/savings` nor `/extras` is in any spine stop's `match` list (`JourneySpine.tsx:20-27`), so
  `currentIdx` is −1 on both and the spine shows no current stop. The pages sit outside the journey
  even though the nav numbers them as a step.
- Neither page is in the mobile bottom tabs (`App.tsx:364-369`). You reach them through More.
- Other ways in: Income from the SetupChecklist "Add your income" item (`SetupChecklist.tsx:91-96`)
  and from Filing's fix links. Savings from the Dashboard `RunRateStrip` (`Dashboard.tsx:77`,
  `:366-381`). Extras has no other way in.

## Trace: Daniel (persona 2)

Golden: **`p2cap`** (`scripts/check-personas.ts:332-381`). The `p2` tenant is *not* Daniel. It is a
PAYG + Pty Ltd + co-owned rental + rent-free-father-house fixture (`check-personas.ts:77-90`), the
owner's own shape. `docs/personas.md:98-106` already records this. Any future "persona 2" work should
read `p2cap`.

| Step | Surface | What happens | Stall? |
|---|---|---|---|
| Cold Home | `App.tsx:100-104` | Redirects to `/onboarding` (no consent, no entities). | — |
| Onboarding | `Onboarding.tsx:38,131-132` | Steps: welcome, consent, intake, people, entities, properties, rules, confirm. Nothing asks about shares, ETFs, RSUs or a broker. The intake is free text (`:219-225`). Entities offers company, employment and novated lease (`:291`). | **Soft stall.** Nothing tells him Quillo handles his investments. |
| Bring in | Accounts | Bank statement → transactions. | — |
| Sort: Stake deposits | `ClarifyCard.tsx:73-115,278` via `ReviewView.tsx:373-377` (unified groups ON) | Answers "Investment / shares (capital)". With `capital_from_txn` ON he can also "start a holding record", which seeds one `cgt_asset` per deposit with units NULL and the cost base equal to the amount deposited. | Works. Readiness then chases units and cost base. |
| Dividends (bank) | Sort / income buckets | The cash credit counts as bank income. It has no franking credit. | — |
| Dividends (statement) | Income upload, `Income.tsx:61-86` | Server: `dividend_statement` is routed and records a dividend `income` row with franking (`src/agent.ts:3049-3064`). **Client: only `doc_type === "payslip"` counts as success**, so the non-payslip branch at `Income.tsx:78-79` says *"didn't read as an income statement. Add it manually below if needed."* That branch doesn't invalidate `["income"]` either, so the new row stays hidden. | **D1, live defect.** Following the advice double-counts the dividend and its franking credit. (`Documents.tsx:68-73` handles the same response correctly.) |
| Duplicate income | `IncomeDedupe`, `Income.tsx:196-254` | Suggests linking the bank credit to the documented row. Suggest-only. | Works if he notices it. |
| Holdings + disposal | `CapitalEquity`, `Income.tsx:184` → `components/income/CapitalEquity.tsx` | Holding form (units, owner, entity, cost-base elements), CSV import (`capital_statement_ingest`), disposal form (`:279-328`). "Cost base used" is typed by hand even when the C3 position already knows the cost base remaining. | Works, at the very bottom of the page, under the income table. |
| RSUs | `EssGrants`, `Income.tsx:185` → `components/income/EssGrants.tsx` | One date field writes both `grant_date` and `taxing_point_date` (`:47`). There is no employer picker, units or market value, though the API accepts all three (`src/agent.ts:2399-2414`). The list isn't FY-scoped (`:12`; `src/api.ts:1135` has no FY filter) while the engine is (`src/lib/ledger-totals.ts:836-845`). ESS statements have no `doc_type` (`src/lib/taxonomy.ts:121-134`), so the form is the only way in. | Works for a simple vest. Thin for deferral schemes. |
| Position | Reports `:185-205`; readiness lines `src/lib/readiness.ts:240-251` | Net capital gain and ESS discount each render as a position line, with an ESS defer nudge (`readiness.ts:477-479`). | Works (display leg ✓). |
| File | Filing | Readiness, sign-off, accountant schedule. | Works. |

## Trace: Aisha (persona 9)

Golden: **`p9`** (`check-personas.ts:281-291`; assertions `:561-564`).

| Step | Surface | What happens | Stall? |
|---|---|---|---|
| Onboarding | entities step | Can add "Startup Pty Ltd" (company). | — |
| Start-up costs paid personally | `AttributionPanel.tsx:19-41` from the transaction | Attributes the cost to the company with provision "Start-up cost (s40-880)". This creates a shareholder loan. | **D2, money defect.** `classifyAttribution` (`src/lib/attribution.ts:49-54`) and the company deductions query (`src/lib/ledger-totals.ts:353-360`) ignore the provision. The whole amount is deducted this FY in the company position, or the personal headline if attributed to an individual, instead of 20% a year for five years. The rule-pack `s40_880_years: 5` (`src/rulepacks/au-v1.json:96,118,140`) has zero readers. P9's "s40-880 capture-only, deductions = 0" assertion (`check-personas.ts:561`) passes only because the fixture has no attribution. |
| R&D | — | `rd_claims` is read (`ledger-totals.ts:385`, `rd_eligible` at `:479`) but nothing writes it. There is no API route and no UI (grep: only the fixture inserts). #126 (the capture forms) was closed not-planned when `blackhole_costs` was dropped. | **Hard stall.** The R&D offset can't be entered. `docs/personas.md:68` still says "form tracked in #126" (doc drift). |
| ESS | `EssGrants` | The ">10%" checkbox drives the startup-concession eligibility flag. The grant can't name her company as employer (no picker). | Works. The employer link is missing. |
| Company position | Filing "Company (separate return)" group (`Filing.tsx:20`) | Shows the carried-forward loss. With D2, a loss built from s40-880 costs is overstated. | Display works. The number is wrong if D2 is triggered. |
| Personal position | Reports / readiness | ESS discount only (`check-personas.ts:564`). | Works. |

## The three pages

### Income.tsx (497 lines + 561 lines of `components/income/*`)

**What it does:** income-statement upload (`:61-86`, `:109-122`), manual add (`:289-434`) with 12+
types, entity and property attribution, a holding link and the AMMA component sub-form (`:274-417`).
It also has the assessable totals (`:127-131`), a "captured, not assessable" card (`:138-155`),
`TradingStockCard` (`:133-134`, `:441-497`), `IncomeDedupe` (`:136`), `CapitalEquity` (`:184`) and
`EssGrants` (`:185`). The CGT and ESS cards show to **every** tenant (`cgt_engine` and `ess_engine`
are ON), including a first-job PAYG user.

**Facts only it writes (in the SPA):** manual `income` rows and AMMA components (Documents upload,
TxnDetail record-income and Clarify can also create income rows, but not manual or component ones),
income↔credit links (`linkIncome`/`unlinkIncome`), `cgt_assets`/`cgt_events` (except the C1 seed from
Sort) plus the CSV import, `ess_grants`, and `trading_stock`. No other page or component imports
these writers.

**Overlaps:** the upload duplicates the Documents upload (with the D1 divergence). The income table
duplicates Reports' income section. Rent capture depends on Settings → Properties (`:427`). Filing's
"Review property records" / "Add property records" links go to `/income` (`Filing.tsx:30`, `:365`),
but Income has no property records. **D3: broken fix link.**

**First-timer gaps:** the types list (`Income.tsx:22-35`; server `src/lib/taxonomy.ts:48-82`) has no
**government payment** (Youth Allowance / JobSeeker), no **foreign employment income**
(newcomers/WHM) and no allowance or tip type. Those land in `other`. `employment_lump_sum` has no
`TYPE_LABEL`, so it renders raw. The empty-state copy (`:177`) sends users to Documents although the
upload button is on the same page.

**Disposition: keep as a step, split** (shape proposed, confirm in the journey/IA ticket).
- *Step, "Your income":* statement upload (with D1 fixed), manual add limited to first-timer types,
  duplicate-income linking, and the captured-not-assessable card.
- *Behind grow:* `CapitalEquity`, `EssGrants`, AMMA components, `TradingStockCard`, entity
  attribution and rent. Each should unlock on a detected signal: a C1 capital answer or dividend
  credit for investments, an ESS statement or vest for ESS, an ABN or business activity for trading
  stock.
- *Can it take #436's distributions, SMSF and super?* Not into the step. Only into the grow sections.
  The page already mixes five domains, and the dossier also proposes moving the WFH and car editors
  onto it (dossier finding at line 200). Doing all of that would rebuild the Dashboard problem one
  page over.

### Extras.tsx (812 lines)

**What it does:** a private-health *extras* tracker behind a separate health-data consent gate
(`:60-67`, `:400-431`). It covers policies, per-category limits, usage, reset countdown and the cover
ring (`:102-139`), suggested next uses (`:167-214`), receipt OCR (`:701`), product auto-fill
(`:744-775`) and a provider finder (`:433-590`, `phi_provider_directory`). It has no effect on the
position: `check-personas.ts:428-435` asserts the position is byte-identical with the flag ON.

**Facts only it writes:** all `phi_*` rows and the health-extras consent. **Fact nothing writes:**
`profiles.private_health` (holds hospital cover, which drives MLS). The route exists
(`src/api.ts:562-565` → `src/agent.ts:6152-6156`) and `api.phiSetHospital` is defined
(`web/src/api.ts:154`), but no component calls it, and no tax code reads the column (only
`src/lib/queries.ts:916` echoes it). `phi_tax_inputs` is unimplemented (dossier, line 276).

**Overlaps:** none with the tax journey.

**Disposition: move behind grow** (proposed, confirm in the journey/IA ticket). Take it out of the
numbered nav, since it isn't a tax step. The MLS / private-health-statement fact belongs in the
*situation profile* (a map fog item), not in an 812-line engagement page.

### Savings.tsx (249 lines)

**What it does:** factual run-rate (spent so far, annualised, recurring commitment, `:70-74`),
year-on-year comparison (`:77-89`), "Worth a look" opportunities with a government comparator and a
**tier-1 energy partner CTA** (`:91-133`; `advisory_partners_energy` is ON per the dossier, line 276),
top spenders (`:136-153`), recurring bills and subscriptions with confirm/dismiss (`:156-159`,
`:169-204`), and a compound-interest "If you set aside…" calculator (`:206-249`).

**Facts only it writes:** confirm/dismiss on recurring bills, opportunity dismissals, referral leads.
None of them reaches the tax position.

**Overlaps:** `RunRateStrip` on the Dashboard (`Dashboard.tsx:366-381`) already shows the run-rate
headline from the same `["savings", fy]` cache entry and links here. Moving it *onto* Savings (as the
review proposed) would only delete the Dashboard copy. It adds nothing to Savings.

**Disposition: move behind grow, and delete the calculator** (proposed, confirm in the journey/IA
ticket). The calculator is general personal-finance arithmetic outside Quillo's tax-evidence remit.
It links out to MoneySmart, which does the job better (`:243`). Recurring-subscription detection may
have a tax use (software or subscriptions that may be work-related), but as a *Sort* signal, not a
Savings page. Whether the energy partner CTA stays is a commercial question for #441 (out of this
map's scope).

## Defects found

| # | Defect | Evidence | Build-ready? |
|---|---|---|---|
| D1 | Income-page upload calls a routed dividend statement "not read" and invites manual re-entry, so the dividend and franking credit are double-counted. The new row isn't invalidated either. | `web/src/pages/Income.tsx:68-80` vs `src/agent.ts:3049-3064`; correct handling at `web/src/pages/Documents.tsx:68-73` | **Yes.** Client-only copy and invalidation fix. Doesn't depend on the IA. |
| D2 | `s40-880` provision ignored: start-up costs are deducted 100% in year one (company or individual track), and the `s40_880_years` rule-pack value has no readers. | `src/lib/attribution.ts:49-54`, `src/lib/ledger-totals.ts:353-360`, `src/rulepacks/au-v1.json:96`; P9 assertion `scripts/check-personas.ts:561` doesn't exercise it | Clear bug, but it is money math on the grow (founder) path. Needs a persona golden and `/local-ultrareview`. Not first-timer-blocking. |
| D3 | Filing's property fix links go to `/income`, which has no property records (they live in Settings → Properties). | `web/src/pages/Filing.tsx:30`, `:365` | Yes, a one-line repoint. Not first-timer path. |
| D4 | Silent delete failures: holding, disposal and ESS deletes use `.then(invalidate)` with no catch. A holding with linked income is server-blocked (`assertNoBlockingChildren`, `src/lib/situation-write.ts:787`), so the click does nothing. `IncomeLine` delete has no `onError`. | `CapitalEquity.tsx:143,166`, `EssGrants.tsx:31`, `Income.tsx:258` | Yes, though low severity. |
| D5 | `rd_claims` has no writer, and `docs/personas.md:68` cites closed #126 as the tracker. | `src/lib/ledger-totals.ts:385,479`; #126 closed not-planned | Doc fix now. A capture form is a product decision for the grow path. |

## Proposed tickets and fog for the map

- **Build-ready:** fix D1 (Income upload outcome copy and invalidation). Bundle D3 and D4 with it.
- **Grow-path ticket:** s40-880 five-year spread (D2) with a P9 golden that includes an attribution.
- **Fog, situation profile:** private hospital cover / MLS and the PHI statement are tax inputs with
  no live writer. They belong in the profile entity the map hasn't specified yet, not in Extras.
- **Fog, first-timer income types:** government payments and foreign employment income need types
  (or an explicit "use other plus guidance" decision) before the Income step is spec'd.
- **Fog, grow unlock signals:** which detections unlock Investments, ESS and Business on Income.
  This feeds the map's "Grow path" section.
- **Fog, retiring legacy pages:** Savings and Extras are both grow or out-of-journey candidates. The
  journey/IA prototype confirms whether they survive as pages at all.
