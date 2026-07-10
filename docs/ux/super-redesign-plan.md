# The Super-inspired redesign — THE PLAN

> Status: proposal, ready to slice. Synthesised from the three ranked directions
> ("The Tax-Year Home" wins; "Kept / money-found" and "Quillo One / faithful five"
> donate salvage). Every compliance kill from the regulator's-seat judges is applied.
> This is a **flag-gated re-skin over engines that already exist** — `buildReport` for
> Suggested, `fy_carryovers` for Assessed, `advisory.ts` for savings — plus **one
> additive snapshot migration**. Flag-OFF is byte-identical; the 10 persona goldens are
> untouched because `report.ts` / `ledger-totals.ts` math is not changed.
>
> **Provenance.** Produced by a 22-agent investigation (4 code mappers, 4 web-research
> agents, 3 competing directions, a 9-verdict judge panel, synthesis, a completeness
> critic), then hand-verified. Corrections from that verification pass are folded in
> below and marked **[corrected]**. Three claims in the first draft were wrong and are
> fixed: the mobile tab flags are already ON in prod (§3, §8 slice 0); the
> "% of what's typically claimable" tile is an occupation benchmark this plan's own
> banned list forbids (§7); and the Home hero has **no data source on today's payload**
> (§4, "The hero's data problem"). Treat any figure here as a design target, not a
> measured value.

---

## 1. The bet

We reskin Quillo's Home in the AustralianSuper visual grammar (gradient hero band,
one hedged hero number, a year chip, flat rows, one primary CTA) **but keep the task
engine underneath**, because a super app is passive-monitoring and a tax app is
task-completion — so the Home **morphs across the tax-year lifecycle** (`capture → lodge →
assessed`) instead of showing one static "you're done" number for the ten months the user
is still working. The signature feature is an honest **Suggested-vs-Assessed** 5-year bar
chart — the first AU tax app to reconcile *what the app suggested* against *what the ATO
actually assessed off the Notice of Assessment* — built on a **frozen per-FY snapshot** so
past bars can never silently drift when an old transaction is edited. Gamification
celebrates **substantiation, on-time lodgement, records-kept cadence, and
accuracy-to-the-NOA — never claim size, never a refund**, with the dangerous mechanics
locked out in code and the PR template.

---

## 2. Where the Super analogy holds — and where it breaks

**Holds (lift verbatim, zero compliance risk):**
- Gradient hero band + one floating card = "this screen has one subject".
- One hero number at a large type scale; everything else ≤18px.
- The **"Estimated" hedge sub-label** under every figure. This is the keystone: Super hedges
  because its numbers are provisional; Quillo's are *more* provisional, so the hedge is the
  mechanism that lets us show a big number without implying it's assessed or advised.
- `(i)` info affordances instead of paragraphs — the natural home for GENERAL-INFO framing.
- Year-selector **chip** (reuse `FySwitcher`) — cheap time-travel, no date picker.
- Flat icon rows over dense tables ("So far this financial year").
- One primary CTA per screen; a low-urgency "Keep on track" link list.

**Breaks (do NOT copy — these actively harm a tax app):**
- **Hero-number-as-the-whole-home.** A super balance is authoritative and self-updating;
  Quillo's figure is only true once the user finishes capturing evidence. A giant number with
  no path to complete it *teaches the user the work is done*. → We keep **exactly one
  next-task row** on Home (`progress.nextAction()`, `src/lib/progress.ts:45`).
- **No task surface.** Super has no "12 uncategorised transactions"; Quillo lives or dies on
  that queue (MEMORY.md audit theme #1 = *silent-failure*). → **Sort** stays its own tab with
  the `needsReview` badge; the queue can never go silent.
- **Celebrating the number going up.** A bigger deduction is not automatically better and can
  be indefensible. → We gamify inputs (capture/timeliness/accuracy), never output magnitude.
- **One number fits everyone.** A super account *is* one balance; a tax position is
  multi-dimensional. A fixed "Deductions $4,180" hero fits Maya/Nadia (PAYG) but misrepresents
  Priya (rideshare: business profit + GST + PAYG instalments), Susan & Greg (a co-owned,
  negatively-geared rental *loss*), Margaret (SMSF/franking). → The hero figure is
  **persona-adaptive** (see Open Decision 1), and the dense per-property/per-category panels
  move to `/reports`, not Home.
- **Quarterly cadence.** `capture→lodge→assessed` is annual; a third of the personas have a
  recurring **BAS/PAYG-instalment** obligation with no home in that machine. → tracked as a
  deferred follow-up (§9), not silently omitted.

---

## 3. The target IA

Two layouts, one design system, keyed off a server-derived `home_state`.

**Mobile [corrected]:** the 5-tab bottom bar is **already live in prod** — `mobile_bottom_tabs`,
`nav_disclosure` and `nav_progress_strip` are all in `wrangler.toml:80` `FEATURES`, and
`App.tsx:167` renders `<BottomTabBar>` today. This is **not a flag flip**; it cannot be
"byte-identical OFF". The remaining work is a re-skin, `env(safe-area-inset-bottom)`, the
Sort-badge check, and the floating-chat collision below. Five **task-stage** tabs (verbs), not
Super's four nouns — dropping a stage re-creates silent-failure.

**The floating-chat collision (live bug, ship in slice 0).** `FloatingChat.tsx:114` pins the
launcher at `fixed bottom-4 right-4 z-[60]`; `BottomTabBar` (`App.tsx:360`) is
`fixed inset-x-0 bottom-0 z-30`. A 56px launcher 16px off the bottom sits **on top of** the
right-most tabs (Position / More) on every phone today. Fix: lift the launcher to
`bottom-[calc(4rem+env(safe-area-inset-bottom)+0.5rem)]` below `lg`, or dock chat into More.

**Desktop (≥lg):** keep the full journey spine as the left sidebar (`GROUPS`, `App.tsx:28`),
re-skinned to forest/sage. `nav_progress_strip` already renders the spine's pills
`hidden lg:block`, so mobile collapses to the tab bar + a one-line progress strip.

### Nav: before → after

| | Before (today, in prod) | After |
|---|---|---|
| Mobile tabs | **Home · Bring in · Sort · Position · More — already LIVE** (`mobile_bottom_tabs` ON; `App.tsx:167`) | Same tabs, forest/sage re-skin + safe-area inset + chat de-collision |
| Desktop | 6-stop numbered spine; `nav_disclosure` + `nav_progress_strip` already ON | Same spine, de-numbered forest/sage skin |
| Home route `/` | 3-KPI grid + 3 breakdown panels + embedded cards | **Morphing `HomeHero`** + one next-task + savings card + gamify strip + keep-on-track links |

### Every page gets a home [corrected — 9 pages were unassigned]

`web/src/pages/` holds 21 pages. "Simplify" can't be reviewed until each one lands somewhere
and each stays ≤2 taps away (the epic #145 promise).

| Tab / surface | Pages |
|---|---|
| **Home** `/` | Dashboard → Home |
| **Bring in** | Accounts, **Reconcile**, Documents, Income, QuickBooks |
| **Sort** | Transactions, Review, TxnDetail |
| **Position** | Reports, Assets, Filing (NOA + hand-off) |
| **More** (drawer) | Savings, Extras, Settings, Billing, Notifications, Glossary, Partner, Admin |

Reconcile is the one to watch: it's a money-critical surface and the draft plan dropped it
entirely. Verify all 10 personas reach their setup in ≤2 taps before flipping any flag.

### What merges / what dies (from the default Home view)

| Element | Fate | Why |
|---|---|---|
| 3-KPI grid (Tracked spend / Deduction categories / Income tracked) | **Dies** → one hedged hero number | "Deduction categories" is a vanity count; the grid buries the one subject |
| By-category / By-property / Income breakdown panels | **Move** to `/reports` (Position) | Desk-work, not a glance; `adaptive_dashboard` already hid empties |
| `ClaimsCard` + `ChecklistCard` + `SetupChecklist` | **Merge** into one completeness ring (endowed progress) | A half-set-up user should see one finish line, not three lists |
| `RunRateStrip` | **Merge** into the single savings card | One savings surface, in the Super "insurance card" slot |
| `NextActionBar` / `JourneySpine` / `TabGuide` stack on Home | **Suppress on Home** | The morphing hero *is* the next action — one next-task, not two |
| Settings (1182 lines), Extras (812 lines), Connections/Partner/Platform | **Behind "More"** | Progressive disclosure; nothing leaves the product, only the glance |
| Numbered "1 ·…6 ·" journey labels | **De-numbered** to plain verbs | Calmer chrome |

**Net test for every slice: does it REMOVE something from the default Home view?** Nothing
is deleted from the *product* — only from the *glance*. Every route stays one tap away.

---

## 4. Home, top to bottom

One component `<HomeHero state={home_state}/>` over a forest gradient band
(`#EDF1D6→#DCE2B6`) with a floating cream card (`#FBFCF4`, box-shadow + 20px radius).
`home_state` is resolved server-side in a new **pure** `src/lib/home-state.ts`
(unit-golden in `scripts/check-units.ts`) from: `currentFyStartYear(now)` (`report.ts`),
`needs_review` (already on the dashboard payload, `queries.ts:531`), the just-ended FY's
`fy_signoff.status`, and whether a `status='confirmed'` `fy_carryovers` row exists.

### The hero's data problem [corrected — nothing in this section is sourced yet]

**Home does not receive a single money position today.** `Dashboard.tsx:22` fetches only
`api.dashboard(fy)`, and `DashboardData` (`web/src/types.ts:304-314`) carries `by_bucket`,
`income_by_bucket`, `by_property`, `needs_review`, `undated`, `features` — and no position at
all. Today's "Tracked spend" KPI is `sum(by_bucket.total_cents)` (`Dashboard.tsx:54`), whose
own foot label reads *"not your tax position"*. Every figure below —
`total_deductions_cents`, `resolved_deductible_cents`, `taxable_position_cents`,
`taxable_position_confirmed_cents` — lives on the **Report** type (`web/src/types.ts:843-844`),
which Home never calls.

So the hero needs one of two things, and this is a real fork (see Open Decision 6):
- **(a) Home calls `/api/report`** — a `buildReport` round-trip through the DO on every Home
  load. Correct data, but Home stops being a cheap read, and #146 (parallelise `buildReport`
  reads, fix 2 N+1 loops) becomes a prerequisite rather than a nice-to-have.
- **(b) Extend the `dashboard()` payload** with the four figures — cheap, but the new fields
  **must be omitted when the read flag is OFF** or `test:au-snapshot` fails (correctly).

Recommendation: **(b)**, flag-gated, with the fields computed in `queries.ts` from the same
SQL the report uses. Do not promise the LODGE *range* hero until
`taxable_position_confirmed_cents` is confirmed present on whatever payload Home reads —
`position_confirmed_range` is ON, but the field currently surfaces on the scan summary
(`scan.ts:263`) and the Report, not the dashboard. If it isn't there, the range degrades to a
single number and §4's LODGE copy is wrong.

### The three-state hedge vocabulary (salvage from "faithful five")

Every money figure on Home carries **exactly one** of three hedge labels — the Super
"Estimated" grammar, retargeted:
- **SUGGESTED** — Quillo's indicative estimate (provisional).
- **TRACKED** — evidence captured (already-incurred spend; *not a claim yet*).
- **ASSESSED** — from the ATO's Notice of Assessment (authoritative).

### STATE = CAPTURE (in-year, the default ~Jul–Jun of the live FY)

- Eyebrow: `"FY 2026-27 · in progress"`.
- Hero number: **TRACKED** deductions, hedged. **Copy:** `"$6,240"` /
  sub-label `"tracked · not a claim yet"`. `(i)` → *"Spend you've captured with evidence —
  general information only, not a refund figure and not tax advice."*
  - **Compliance kill applied:** the hero must **not** be labelled "Claims"/"Suggested", and
    it draws from **confirmed/substantiated** deductible rows, not raw `needs_review` buckets.
    `report.total_deductions_cents` is documented as *captured/pending-review — NOT claimable
    yet* (it maps to `guide.ts:18` `tracked_deductions_cents`); `resolved_deductible_cents` is
    *confirmed deductible* (`guide.ts:19`, ~$0 until a real review — `deductibility.ts:36`).
    So the hero shows the **TRACKED** figure under the honest "tracked · not a claim yet"
    hedge, with a small **"Defensible now $X confirmed"** flat row beneath it sourced from
    `resolved_deductible_cents`. The biggest number must never read as the most optimistic one.
- Year chip top-right (reuse `FySwitcher`).
- **One next-task row** from `progress.nextAction()`: e.g. `"Sort 12 transactions →"`
  (`needs_review=12`) or `"Add your income statement →"` or
  `"12 items aren't in any year — add dates →"` (`dashboard.undated`). Exactly one CTA.
- **Completeness ring** (`ReadyMeter`): `"You're 4 of 6 steps to tax-ready."` (endowed
  progress — pre-seed the steps Quillo already did).

### STATE = LODGE (FY has ended; now is Jul 1–Oct 31; that FY not yet closed)

- Eyebrow: `"FY 2025-26 · ready to finalise"`.
- Hero becomes the **indicative position RANGE** (`position_confirmed_range` is ON):
  `"$41,180 – $43,900"` from `taxable_position_confirmed_cents` → `taxable_position_cents`
  (`scan.ts:263-264`), hedged: *"indicative taxable position — general information only, not
  your tax payable or refund. Confirm with a registered tax agent."* (mirrors
  `readiness.ts:90` `indicative_taxable_position_cents // NEVER tax payable`).
- Primary CTA: `"Hand off to your agent →"` (`/filing`). Secondary: `"Add your Notice of
  Assessment"` (pre-arms the assessed state).

### STATE = ASSESSED (just-ended FY is `closed_with_noa`, or ≥1 confirmed NOA exists)

- The Super-style chart becomes the hero (see §5).
- Eyebrow `"Taxable income by year"`; giant **ASSESSED** figure from the latest confirmed
  `fy_carryovers.taxable_income_cents`, labelled `"Assessed · FY 2024-25 · from your NOA"`.
- This is the calm monitoring view — **earned only after the ATO number lands**.

### Below the hero — STABLE across all three states (Super "So far…" + "Keep on track")

1. **Gamify strip** — 2 tiles (§7).
2. **Savings card** — in the Super "insurance card" slot (§6). Factual, Tier-1, hedged.
3. **"Keep on track"** flat link rows: `"Close FY 2025-26 off your Notice of Assessment →"`,
   `"Consolidate accounts →"`, `"Tell us about your assets →"`, `"Records: 8 months running"`
   (read-only capture streak).
4. Footer: *"General information only — not tax or financial advice. Quillo doesn't hold an
   AFSL."*

### Which mock wins, and why

- **Mobile Home = 1d ("Amount-focus card · flat, closest to Super")** with the **ghost/track
  bar** encoding. On a phone, a ghost bar (Suggested = faint full-height track, Assessed =
  solid fill) halves the bar count vs paired bars and reads the exact question — *"did I
  capture 99% or 60% of what was suggested?"* — as fill-vs-target, the Monzo goal-bar mental
  model. **1a** ("paired bars · flat forest hero") donates its **gamify strip** and its
  **dashed future-year bar** treatment, but its paired bars lose to the ghost bar on mobile.
- **Desktop dashboard = 1e ("Web dashboard widget · flat")**: the hero becomes a **widget**
  (paired-bar chart left, forest stat card right) atop the real worktable, because on desktop
  the hero shares the screen with the task lists it summarises. Paired bars win here — wide
  room makes side-by-side comparison across years legible.

One `ClaimsByYearChart` component, **two render modes by breakpoint**.

---

## 5. Suggested vs Assessed — the data design

**What today's NOA capture DOES store** (verified): `noa_capture` (ON) runs
`extractNoticeOfAssessment` (`src/extract.ts:786`), which captures **`taxable_income_cents`**
(the "Taxable income" line) and **`tax_assessed_cents`** (`extract.ts:751-774`), plus
carried-forward losses / HELP / MLS / franking. On user confirm, `confirmNoaCarryover`
(`src/lib/noa-store.ts:113`, called from `api.ts:851`) writes those into `fy_carryovers` and
sets `fy_signoff.status='closed_with_noa'`.

**What it does NOT store:** *a deductions line.* A NOA does not itemise deductions.
`fy_carryovers` holds `taxable_income_cents` + `tax_assessed_cents` only (`noa-store.ts:16-17`).

### Consequence — the honest comparison (compliance MUST-SURVIVE)

The owner's mock label *"Deductions claimed · from your NOA"* is **literally unsourceable**
and is **killed**. v1 pairs, per FY:
- **SUGGESTED** = Quillo's indicative **taxable position** for that FY.
- **ASSESSED** = the ATO's **taxable income** from the confirmed NOA
  (`fy_carryovers.taxable_income_cents`).

Both sides are real, stored figures — **zero inference**. "Deductions tracked" stays the
CAPTURE hero's figure (hedged, Suggested-only); the *cross-year chart* compares taxable
income/position, where both sides have a true number. A deductions overlay is a **deferred
fast-follow** (§9) that first needs the extractor to also capture **assessable** income
(deductions = assessable − taxable) — not shipped in v1.

### The snapshot problem (the correctness insight the whole feature depends on)

`buildReport` computes a report **live from the current ledger** (there is no snapshot table).
If we recompute a past FY's *Suggested* from today's ledger, the bar **silently drifts every
time the user edits an old transaction** — "what Quillo suggested" becomes a moving target and
the accuracy tile would lie. **Fix: freeze the Suggested figure at the moment the year is
closed**, and read the frozen value forever after.

- For a **closed** year: Suggested = the **frozen snapshot** (never drifts).
- For the **live in-progress** year: Suggested = a fresh `buildReport` (correctly provisional,
  hedged).
- **Backfill:** already-closed years (confirmed before this ships) have no snapshot. A
  **one-time deploy backfill** writes them from a live `buildReport` and **labels those bars
  `recomputed`**; the accuracy tile is **suppressed** for any un-snapshotted / recomputed year
  (never show a drifting number as historical truth). This backfill is an **explicit slice**,
  not a footnote.

### The migration (additive, apply-once, next in sequence — last on disk is `0069`)

```sql
-- migrations/0070_fy_position_snapshots.sql
-- Additive + apply-once. Freezes each FY's Suggested figures at year-close so the
-- Suggested-vs-Assessed chart can never silently drift when an old txn is edited.
-- No money/tax OUTPUT changes: this table is written by a new close-time hook and only
-- READ by the chart endpoint. report.ts / ledger-totals.ts are untouched ⇒ personas green.

CREATE TABLE IF NOT EXISTS fy_position_snapshots (
  user_id                          TEXT    NOT NULL,
  fy                               INTEGER NOT NULL,   -- FY start year (2024 = 2024-25)
  taxable_position_cents           INTEGER NOT NULL,   -- Suggested (tracked/optimistic end)
  taxable_position_confirmed_cents INTEGER,            -- Suggested (confirmed/defensible end)
  total_deductions_cents           INTEGER NOT NULL,   -- tracked deductions at freeze
  resolved_deductible_cents        INTEGER NOT NULL,   -- confirmed-deductible at freeze
  total_income_cents               INTEGER NOT NULL,
  reason                           TEXT    NOT NULL DEFAULT 'noa_close',
                                     -- 'noa_close' | 'signoff' | 'backfill_recomputed'
  captured_at                      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, fy)
);

CREATE INDEX IF NOT EXISTS idx_fy_position_snapshots_user
  ON fy_position_snapshots (user_id);
```

`UNIQUE`/upsert on `(user_id, fy)` so re-closing overwrites; add
`"fy_position_snapshots"` to `PURGE_TABLES` (`src/lib/retention.ts:11`, alongside
`fy_signoff`/`fy_carryovers` at `:43-44`) — **invariant: every tenant table is purgeable**.
Keep `schema.sql` in lockstep.

### The write seam

Write the upsert at the two real close seams (NOT `agent.ts`):
- **NOA confirm:** inside `confirmNoaCarryover` (`noa-store.ts:113`) — `buildReport(source_fy)`
  is reachable at confirm time. `reason='noa_close'`.
- **Soft sign-off:** inside `signOffFy` (invoked at `api.ts:837`). `reason='signoff'`.

The **write rides on `noa_capture` (already ON)** so history starts accruing before the read
flag flips. Pure mapper `src/lib/fy-snapshot.ts` (+ golden) turns a `Report` into a snapshot row.

### The endpoint + render

New `GET /api/claims-by-year` → `[{ fy, suggested_cents, suggested_status, assessed_cents,
assessed_status }]`, merging: snapshots (closed yrs) + live `buildReport` (current yr) +
confirmed `fy_carryovers` (assessed). Gated by new flag `claims_by_year` — **OFF ⇒ endpoint
404s, no chart ⇒ byte-identical**.

- **Chart:** one **hand-rolled inline-SVG** component — **no chart library** (protect the
  735kB bundle, #227). Ghost bar (mobile) / paired bars (desktop).
- **Future / unassessed year:** the Assessed bar renders as a **dashed hollow outline** with an
  **explicit text + `aria-label` "FY2026 — not yet assessed"** — never an empty slot, never
  `$0` (a dangerous misread for a tax figure). a11y: value labels on every bar + a non-colour
  texture for the Suggested series (the sage palette is low-contrast; do not rely on hue alone;
  target WCAG 2 AA).
- **Gap attribution (compliance MUST-SURVIVE):** a persistent `(i)` caption — *"The ATO also
  applies prefill, prior-year credits, debt offsets and timing. A gap between Suggested and
  Assessed isn't necessarily an error."* A **lower** Suggested than Assessed must **not** read
  as "Quillo would've gotten you a bigger refund" — frame the win as **completeness**, never as
  magnitude. This attribution is *why no competitor ships this chart*; without it, the feature
  destroys the trust it's meant to build.

---

## 6. The savings / utility checker

Takes the AustralianSuper **"insurance cover" card** slot: one flat card on Home + the full
surface at `/savings` (`advisory_layer`, ON). Reads the existing `savingsOverview` payload
(`advisory.ts`: `classifyBiller`, `recurring_bills`, `signpostFor`, `is_essential`). The
**design** risk is low; the **compliance** risk is the whole constraint.

### v1 — zero data deals, honest copy (ship now)

- Strictly **factual + Tier-1**. Show what a detected recurring essential runs per year and the
  **government comparator first**: *"Energy — about $1,860/yr on your recent bills. Compare
  plans at the AER's Energy Made Easy →"* (`signpostFor('energy')` → `energymadeeasy.gov.au`).
- Every string passes `advisory.ts` `assertFactual()` (`advisory.ts:33`) — **verified**:
  `BANNED_TOKEN_RE` blocks *should / recommend / best / cheapest / projected*, and
  `BANNED_PHRASE_RE` blocks *"save up to" / "you could save" / "whole-of-market" / "better off" /
  "switch to"*. **The guardrail you already shipped forbids the owner's literal pitch.** No
  projected saving, no "cheaper", no usage-aware comparison — not as a policy choice, as code.

### What is actually wired today [corrected — the partner funnel is a demo]

The savings engine is real; the *commercial* layer is a scaffold. Verified:

- **Detection is 100% deterministic, no LLM** (`advisory.ts:133-235`, `agent.ts:5270-5298`).
  `detectRecurrence()` needs ≥2 dated debits, takes the median inter-payment gap, maps it to a
  cadence band, and only marks `confirmed` at ≥3 occurrences. `classifyBiller()` keyword-matches
  into 9 categories. Zero model cost, zero latency — ideal for a Super-style flat-row list.
- **The switch card only fires for energy/gas/health.** `signpostFor()` returns a comparator for
  those three only, so water/internet/mobile/insurance produce **no** switch card today
  (`agent.ts:5315`).
- **There is no live energy partner.** The only `partners`/`partner_offers` rows come from
  `scripts/seed-test-partner.sql` — a non-migration fixture ("Econnex (TEST)") pointing at a
  public compare page where no affiliate token is honoured. Unless that's manually run against
  remote D1, `matchEnergyOffer` returns null and **no CTA renders at all**, flag ON or not.
- **Postcode scoping does not exist.** `matchEnergyOffer` never references `postcode_scope`, and
  **Quillo does not store the user's postcode anywhere** — the only postcode input is the PHI
  provider search, where the user types one. "In their area" has no `area`.
- **There is no postback.** `clicked → converted → paid` exists only as an admin-gated
  `POST /api/admin/referrals/:token/advance` simulate. The real HMAC webhook is deferred.

So: `advisory_partners_energy` being ON in prod means the *code path* is live, not the *business*.
The cheapest step toward "in your area" is **capturing the user's postcode** — `partner_offers.
postcode_scope` and `au-postcodes.ts` (3,169 centroids) already exist and are waiting for it.

- When a real offer exists, the **Tier-1 partner CTA** attaches: a tokened outbound link
  (`POST /api/referrals`) that opens the partner site — **no PII leaves Quillo**. Ships with a
  plain-English **"how we get paid"** disclosure adjacent to the CTA, and **ranked by genuine
  saving, never by commission** — do **not** claim a value-ranking the code doesn't do
  (`matchEnergyOffer` returns the newest active offer; add real ranking or don't claim it — see
  Open Decision 4).

### The gamification template already exists — copy it, don't invent

`phi_extras_tracker` (ON) is a complete, compliant "use it before you lose it" surface:
a conic-gradient cover ring, an **unused-dollars hero number**, a weeks-to-reset countdown
(`"Resets in N weeks"`), a growing `"$X of $Y claimed"` meter, and ranked "Suggested Next"
nudges (`web/src/pages/Extras.tsx:104-166`, `web/src/lib/phi-suggestions.ts:39-105`). It is
display-only, never feeds `report.ts`, and every string passes `assertFactual`. **This is the
pattern §7 should generalise to tax and savings** — the mechanics are already proven in-repo.

### v2 — CDR Product Reference Data ingest (deferred, needs-decision)

Build a real "a cheaper plan exists in your area" checker with **no accreditation** using the
AER's public **CDR Product Reference Data** APIs behind Energy Made Easy:
**`Get Generic Plans`** and **`Get Generic Plan Detail`** (base
`https://cdr.energymadeeasy.gov.au/<cdrCode>`, max 1000 records/call, the 6 NECF jurisdictions
NSW/QLD/SA/TAS/ACT/VIC — WA/NT excluded). This is **plan-vs-detected-spend**, which only needs
the **free public PRD** and keeps the Tier-1 "no PII leaves Quillo" stance intact.
**Usage-aware** comparison (kWh, peak/off-peak, solar feed-in) needs CDR **consumer** data
(accredited ADR = Tier 2, a partner like Accurassi) — **out of scope**.

### The hard line at insurance (AFSL)

Energy/telco referrals are **not** financial products (no AFSL). **Insurance IS a financial
product.** No insurance switch CTA ships without an AFSL/AR + recorded consent. v1 surfaces
health cover as a **factual run-rate line only** with `privatehealth.gov.au` as the neutral
comparator — **never** a switch CTA. The repo already defers this; keep it deferred.

---

## 7. Gamification — the approved menu (this section is the compliance contract)

**The one rule, codified in the PR template:** *gamify **inputs** (evidence captured,
timeliness, accuracy-to-NOA, records-kept cadence) — **never outputs** (deduction size, refund,
"beat last year on claim size").* Every metric must be allowed to legitimately **go down** in a
lower-spend year without reading as failure.

### Shipped mechanics

| Mechanic | Celebrates | Exact copy | Flag |
|---|---|---|---|
| **Tax-ready completeness ring** (endowed progress + Zeigarnik) | Evidence completeness — a process, never a dollar | *"You're 4 of 6 steps to tax-ready. General information only — this isn't advice to lodge."* | `ready_meter` |
| **On-time lodgement streak** (from `fy_signoff.signed_off_at` vs the 31 Oct date; `status='closed_with_noa'`) | A clean compliance track record | *"3 years · lodged on time · every year"* | `gamify_strip` |
| **Accuracy-to-NOA tile** (frozen snapshot vs `fy_carryovers.taxable_income_cents`) | **Substantiation** — your records were complete, nothing was missed | *"Your FY24 records matched your NOA within 1% — nothing was missed."* | `gamify_strip` |
| **Records-kept cadence** (counts evidence-ingest events — receipt/txn dates — **monthly**, never claims) | The record-keeping habit the ATO depends on | *"Records kept: 8 months running. Good habits make tax time boring — that's the goal."* | `gamify_strip` |
| **Streak-freeze / personal-best** (rider on every streak) | Nothing new — defuses the punitive loss-aversion edge | *"Missed a month — your 11-month best is safe."* | `gamify_strip` |
| **Evidence-types-present meter** [corrected] (self-referential; a count we already hold) | Which evidence *kinds* are captured this FY — never a claim-size benchmark | *"5 of 7 evidence types captured this year — income statement, receipts, logbook…"* | `gamify_strip` |
| **One restrained finish-line moment** (forest palette, at year-close / NOA-matched only — **never per-claim**) | A true completion event, once a year | *"FY24 closed. Records kept, lodged on time."* | `gamify_strip` |

**Compliance kills applied to this menu:**
- The mock's **"+12% more captured than FY24"** growth tile is **cut**. A YoY **growth** framing
  of a deduction number sits on the wrong side of the ATO's over-claiming line.
- **[corrected] The first draft replaced it with *"you've captured 88% of what's typically
  claimable for your situation"* — which is the occupation-benchmark mechanic this very section
  bans.** No "typically claimable" ceiling exists in the code; `advisory.ts:11` states the
  advisory layer has **no benchmarks** as a hard principle; and a per-situation claim target is
  exactly what the ATO's occupation benchmarks are *not* for (they're an audit tool). Any
  completeness % must have a **factual, self-referential denominator** — evidence types present,
  checklist steps done (reuse `SetupChecklist` / `fy_checklist`) — never "what people like you
  claim". This also keeps the tile clear of epic **#426**, which owns occupation-claim guidance
  and must not be forked by a vanity metric.
- The accuracy tile is framed as **substantiation** (*"records were complete"*), **never** as
  *"Quillo predicts the ATO accurately"* — a prominent per-year "this is your position, and we
  nail the ATO" claim strengthens a **reliance** argument under TASA 2009 (a tax-agent service
  is one a client can reasonably rely on). Stay on the substantiation side.
- The **"deductions-tracked reveal"** (a celebration when `total_deductions_cents` *increases*)
  is **cut** — firing on a new claim being added is claim-volume dopamine regardless of wording.
  If ever revived, it may fire **only on a substantiation event** (a receipt matched to an
  already-categorised expense), never on claim creation. Not in v1.
- The **realised-savings tile** ("you kept $240 by switching") is **not** in the gamify strip —
  gamifying a number that drives partner-commission referrals is a soft conflict-of-interest.
  It lives in the **factual savings strip** (§6), disclosed, `needs-decision`, and only ever a
  **backward-looking observed spend delta** (never a projection).

### Banned list (state loudly — a future contributor must not build these)

| Banned mechanic | Why |
|---|---|
| Animated **refund counter / live refund meter** (TurboTax-style) | Violates the hard invariant *never predict a refund amount*; documented dark pattern (FTC/Intuit 2024) |
| **Summed "money found" total** (deductions + savings in one "in your pocket" figure) | Implies a refund/cash figure and rewards claim magnitude — the two currencies must never be added |
| Occupation **"people like you claim $X"** benchmark | Over-claim inducement; ATO occupation benchmarks are an *audit* tool, not a claim target |
| **Refund/claim leaderboard** ("you beat 80% of users") | Refunds are individual; invites aggressive claims |
| **Countdown / scarcity pressure to lodge** | Manufactures anxiety (ProPublica FUD finding); deadline framing must stay calm & factual |
| **Variable / lottery / spin-to-reveal** reward | Trivialises a compliance act (Robinhood, $7.5M Massachusetts settlement); there is no honest "random" in tax |
| **Per-claim confetti** | Manufactures a claiming dopamine loop; celebrate finish lines only |
| **YoY "beat last year on claim SIZE"** tile | Over-claim pressure; metrics reward inputs, never output magnitude |

**Two-currency invariant (salvage from "Kept"):** EVIDENCE (deductions *tracked* — hedged,
GENERAL-INFO, explicitly *not a refund*) and CASH (*realised savings* — the only honest running
dollar, backward-looking) are **two typed figures that are NEVER summed**. Encode it so it
can't drift.

---

## 8. The slice plan (ordered: pure/additive first, risky last behind sign-off)

New flag keys follow the existing snake_case style in `src/lib/features.ts`.

**The two guards that actually bite [corrected].** The plan says "personas untouched" throughout,
and that's true (`report.ts` / `ledger-totals.ts` math is unchanged, so no golden is added or
flipped — state that reason explicitly in each PR). But the guard that catches **dashboard-payload
drift** is `test:au-snapshot` (`scripts/check-au-snapshot.ts`), and the guard that catches a
**new tenant table missing from `PURGE_TABLES`** is `test:schema` (`scripts/check-schema-drift.ts`).
Both run in `npm test`. Slices 1 and 4 will trip them if done carelessly — that's the guardrail
working, not a surprise.

| # | Slice | Flag | Files | Migration | Persona goldens | Effort | needs-decision? |
|---|---|---|---|---|---|---|---|
| **0** | **[corrected] Mobile IA is already live — this is a re-skin, not a flag flip.** `mobile_bottom_tabs` + `nav_disclosure` + `nav_progress_strip` ship ON today. Work: forest/sage re-skin, `env(safe-area-inset-bottom)` on the bar, **lift the `floating_chat` launcher above the tab bar on `<lg`** (live collision), verify the Sort badge. Cannot be "byte-identical OFF". | existing 3 (ON) | `web/src/App.tsx`, `web/src/components/chat/FloatingChat.tsx` | none | Untouched | **S** | No |
| 1 | **`home_state` resolver + golden.** Pure `resolveHomeState(now, currentFy, endedFySignoffStatus, needsReview, hasConfirmedNoa) → 'capture'\|'lodge'\|'assessed'`; attach to dashboard payload **behind the read flag**. ⚠️ `home_state` **must be omitted from the payload when the flag is OFF** or `test:au-snapshot` fails. Resolve the hero data-source fork (§4) in this slice. | `home_seasons` | `src/lib/home-state.ts` (new), `scripts/check-units.ts`, `src/lib/queries.ts` (`dashboard()`) | none | Untouched | **S–M** | No |
| 2 | **Morphing Home shell.** Split `Dashboard.tsx` → `HomeHero` with CAPTURE/LODGE branches using only data that exists today (tracked+confirmed deductions, position range, `needs_review`, checklist). ASSESSED falls back to LODGE until slice 4. Demote 3 breakdown panels to `/reports`. | `home_seasons` | `web/src/pages/Dashboard.tsx`→`Home.tsx`, `web/src/components/HomeHero.tsx` (new), `web/src/pages/Reports.tsx` | none | Untouched (display) | **M** | No |
| 3 | *(folded into slice 0 — the mobile IA was never OFF)* | — | — | — | — | — | — |
| 4 | **`fy_position_snapshots` table + capture-on-freeze + backfill.** Upsert a snapshot in `confirmNoaCarryover` and `signOffFy`; **one-time deploy backfill** of already-closed years (labelled `backfill_recomputed`, accuracy tile suppressed). ⚠️ The table must land in **`schema.sql` AND `PURGE_TABLES` in the same commit** or `test:schema` fails. | write rides on `noa_capture` (ON); read gated by `claims_by_year` | `migrations/0070_fy_position_snapshots.sql` (new), `src/lib/fy-snapshot.ts` (+golden), `src/lib/noa-store.ts`, `src/api.ts` (signoff seam), `src/lib/retention.ts`, `schema.sql` | **0070** additive | Untouched (`buildReport` only READ) | **M** | No (additive, no output change) |
| 5 | **`GET /api/claims-by-year` + `ClaimsByYearChart`.** Merge snapshots + live current-yr + confirmed NOA. Inline-SVG ghost-bar (mobile) / paired-bar (desktop); dashed "not yet assessed" bar + `aria-label`; value labels + non-colour texture; gap-attribution `(i)`. Wire ASSESSED hero. | `claims_by_year` | `src/api.ts`, `src/lib/claims-by-year.ts` (new), `web/src/components/ClaimsByYearChart.tsx` (new), `Home.tsx`, `Reports.tsx` | none | Untouched | **M–L** | No |
| 6 | **Tax-ready completeness ring.** Reuse `SetupChecklist` + situation steps with endowed progress. | `ready_meter` | `web/src/components/ReadyMeter.tsx` (new), `src/lib/progress.ts`, `Home.tsx` | none | Untouched | **M** | No |
| 7 | **Savings card in the insurance-slot** + "how we get paid" disclosure. Reuse `savingsOverview`; government comparator first, Tier-1 CTA. | `advisory_layer` (ON) + `advisory_partners_energy` (ON) | `web/src/components/SavingsCard.tsx` (new, replaces `RunRateStrip` on Home), `Home.tsx` | none | Untouched | **S** | Partner CTA prominence = **yes** (owner sign-off) |
| 8 | **Gamify strip.** Pure metrics + goldens: on-time streak (`fy_signoff`), records-kept cadence (ingest dates), accuracy-to-NOA (snapshot vs NOA), completeness-toward-ceiling, streak-freeze. Assert metrics count **inputs**, never claim size. | `gamify_strip` | `src/lib/streaks.ts` (new +golden), `src/api.ts`, `web/src/components/GamifyStrip.tsx` (new) | none | Untouched | **M** | **Yes** (net-new engagement surface on a tax app) |
| 9 | **FAST-FOLLOW (deferred): deductions overlay.** Capture NOA **assessable** income so deductions = assessable − taxable; add a chart mode toggle. | `claims_by_year` (mode) | `src/extract.ts` (+`assessable_income_cents`), `migrations/0071_noa_assessable.sql`, `src/lib/noa.ts`/`noa-store.ts`, `ClaimsByYearChart.tsx` | **0071** additive: `ALTER TABLE fy_carryovers ADD COLUMN assessable_income_cents INTEGER` | Untouched | **M** | Only after the taxable-income chart is validated live |
| 10 | **DEFERRED: CDR PRD savings v2.** `Get Generic Plans` / `Get Generic Plan Detail` ingest → plan-vs-spend comparison. | new `advisory_cdr_prd` | `src/lib/advisory-cdr.ts` (new), `partners.ts` | KV cache of plans (no D1 migration) | Untouched | **L** | **Yes** (touches savings claims + partner revenue) |

Order rationale: 0–2 are pure display/additive; 4 is additive persistence that only reads
`buildReport`; 5–6 are read+render; 7–8 are the surfaces that touch partner revenue and the
engagement contract, so they carry sign-off; 9–10 are deferred and each needs a validated
predecessor.

**Bundle cost [corrected].** Inline-SVG (no chart library) is the right call for #227, but
splitting Dashboard into `HomeHero` + `ClaimsByYearChart` + `ReadyMeter` + `GamifyStrip` +
`SavingsCard` *nets more* code in the 735kB main chunk. `React.lazy` the chart and the gamify
strip so first paint doesn't grow; treat **#227** as a soft prerequisite.

**Zero-data first run.** Self-service signup is now open, so most traffic is brand-new users
landing on a CAPTURE Home with $0 tracked, no next-task, and empty streaks. The `Onboarding.tsx`
→ Home handoff and the hero's zero-data state are the make-or-break screen and are **not yet
specified** — do that before slice 2, not after.

---

## 9. What we are NOT doing — and why

**Killed (compliance):**
- **"Deductions claimed · from your NOA"** as a chart series or hero — the NOA has **no
  deductions line** (`fy_carryovers` stores taxable income + tax assessed only). Any derived
  deductions figure attributed to the NOA is a factual misstatement. We compare **taxable
  income/position** instead.
- **A single summed "money found" total** — implies a refund/cash figure and rewards claim
  magnitude. Two typed figures, never added.
- **Refund meter, occupation benchmark, leaderboard, lodge countdown, variable/lottery reward,
  per-claim confetti, YoY "beat last year on claim size"** — see the banned list (§7).
- **Insurance switch CTA** — insurance is a financial product; needs AFSL/AR + consent. Health
  cover stays a factual run-rate line with `privatehealth.gov.au` as the neutral comparator.

**Deferred (real, later):**
- **Deductions overlay on the chart** (slice 9) — needs a new NOA extractor field + re-extract
  path; only after the taxable-income chart is validated live.
- **CDR PRD savings v2** (slice 10) — real plan comparison; buildable with no accreditation but
  touches savings claims + partner revenue.
- **Realised-savings "kept" number** — honest (backward-looking observed spend delta) but noisy
  (a bill can drop for a credit or seasonally) and touches partner revenue; ship only with an
  explicit "I switched" confirmation + dismiss path, `needs-decision`. Not gamified.
- **A quarterly/BAS-cadence Home state** for the sole-trader/GST personas (Priya, Tom, James) —
  the `capture→lodge→assessed` machine is annual; a recurring BAS/PAYG-instalment surface is a
  separate follow-up, tracked so it isn't silently omitted (Open Decision 2).

### Backlog wiring [corrected — the draft cited only #145 / #259 / #227]

This plan closes nothing outright, but four open issues are directly in its path:
- **#242** (BAS/GST workpaper + PAYG-instalment dashboard card) **is** the "quarterly cadence"
  deferred in Open Decision 2 — cite it as the successor, don't open a new issue.
- **#388** (retire `NextAction`/`TabGuide`, currently BLOCKED on flag flips) — §3 suppresses
  `NextActionBar`/`JourneySpine`/`TabGuide` on Home, which may unblock or partly deliver it.
- **#387** (refund completeness / learning / handoff) — the accuracy-to-NOA tile is a #387
  deliverable.
- **#426** (guide to maximum legitimate claims) — the completeness ring must **compose with**
  `txn_scan_v2`'s existing occupation-guide prompts, not fork a parallel benchmark (see §7).

**Not simplified, only relocated (be honest):** Settings (1182 lines) and Extras (812 lines)
are *big because the data is* (entity setup, SMSF members, PHI limits). Pushing them behind
"More" simplifies the **glance**, not the **task**. Onboarding for the complex personas
(4/5/8/10) must still reach that setup in ≤2 taps — verify per slice that all 10 personas can
reach their data through the new IA before flipping any flag (epic #145).

---

## 10. Open decisions for the owner

1. **Persona-adaptive hero figure.** A fixed "Deductions tracked" hero is a PAYG-employee
   artefact for 6 of 10 personas (rideshare → business profit + GST; landlords → rental result;
   SMSF → franking). **Recommendation:** make the CAPTURE hero figure persona-adaptive (net
   position / business profit / rental result / deductions tracked) driven by the entity/situation
   already on the profile, with the same three-state hedge. Ship the PAYG hero first (slice 2),
   add the adaptive variants as a fast-follow. *(needs-decision — touches how a money figure is
   framed per persona.)*

2. **Quarterly cadence.** Do we add a `bas` / instalment surface to the Home for GST-registered
   personas, or keep it on `/reports` only? **Recommendation:** keep v1 annual; add a "Next BAS"
   keep-on-track row for GST-registered users in a follow-up rather than a fourth `home_state`.

3. **Gamify strip default.** Ship `gamify_strip` **ON** for everyone, or hold it for a cohort
   given signup just opened (mostly brand-new users, for whom streaks/accuracy tiles are empty)?
   **Recommendation:** ship ON but **hide** each tile until it has real data (an empty streak
   reads as failure) — new users see the completeness ring only, which works from day one.

4. **Savings-card ranking claim.** `matchEnergyOffer` returns the newest active offer with **no
   value ranking**. Do we build real "rank by genuine saving" before elevating the partner CTA to
   Home, or ship the government-comparator-first factual card without a partner CTA on Home until
   ranking exists? **Recommendation:** Home shows the **factual card + government comparator**
   only; the partner CTA stays on `/savings` until genuine value-ranking ships — don't claim a
   ranking the code doesn't do. *(needs-decision — partner revenue on the primary surface.)*

5. **Backfill trust label.** For already-closed years with no snapshot, do we render a
   `recomputed` bar (with the accuracy tile suppressed), or hide those years entirely until a
   fresh close writes a real snapshot? **Recommendation:** render `recomputed` (more history is
   better) but visibly label it and suppress the accuracy tile — never present a drifting number
   as historical truth.

*(Decisions 1–5 remain open. 6–8 are settled by the owner, 2026-07-10.)*

6. **DECIDED — Home gets its money figure from an extended `dashboard()` payload.** Add
   `tracked_deductions_cents`, `resolved_deductible_cents`, `taxable_position_cents` and
   `taxable_position_confirmed_cents`, computed in `queries.ts` from the same SQL the report uses
   and **omitted entirely when `home_seasons` is OFF** so `test:au-snapshot` stays green. Accepted
   cost: some report SQL is duplicated in `queries.ts` — the two must not drift, so a unit golden
   asserts the payload figures equal `buildReport`'s for a fixture tenant. Rejected: a
   `buildReport` round-trip on every Home load, which would make **#146** a hard prerequisite.

7. **DECIDED — derive the residence postcode; never ask twice.** Owner's steer: a user with a
   rental or an owner-occupied home **already enters an address**, so asking again is a
   double-entry bug, not a privacy question. `properties.address` (`schema.sql:395`) exists, and
   `use_status` already distinguishes `owner_occupied` (`schema.sql:399`). Design:
   - Add `properties.postcode` (additive `ALTER TABLE … ADD COLUMN`), parsed from `address` on
     write, plus a one-time backfill parse of existing rows.
   - The **residence** postcode is the `owner_occupied` property's — **not** any rental. An
     energy plan is for where the user *lives*; a tenant pays the power bill at an investment
     property, so scoping an energy offer to a rental's postcode is simply wrong.
   - **Only ask when we hold nothing.** Renters and PAYG-only personas (Maya) have no property
     row at all, so a single optional field remains the fallback — prefilled and confirmed, never
     re-asked, when a residence address exists.
   - `partner_offers.postcode_scope` (`schema.sql:1156`) and `au-postcodes.ts` (3,169 centroids)
     are already built and waiting for this one value.

8. **DECIDED — ship the re-skin first (slices 0–2).** No migration, no new data, no compliance
   surface. Fix the live chat/tab-bar collision, land the morphing Home shell, demote the
   breakdown panels to `/reports`. Validates the IA cheaply before any engine work; the chart
   (slices 4–5) follows once the shell is proven. Accepted cost: the differentiator ships second.

---

## 11. Build-depth specifications (the gap between "planned" and "buildable")

The slice table names the work; these are the five things it left underspecified. Each is
settled here so a PR can be opened without a fresh design conversation.

### 11.1 The records-kept streak — which timestamp?

Three candidates give three materially different streaks: `transactions.date` (when the money
moved), `transactions.created_at` (`schema.sql:58` — when Quillo learned about it), and
`documents.created_at` (`schema.sql:16` — when evidence was uploaded).

**Use ingest time, never the transaction date.** A month "counts" when the tenant ingested at
least one piece of evidence in that calendar month — a `kind='receipt'` transaction row or a
document — read off `created_at`. Rationale: the habit being celebrated is *keeping records*.
Sourcing the streak from `transactions.date` lets a single back-dated CSV import retroactively
manufacture a twelve-month streak, which is a lie the user will notice and a mechanic that
rewards bulk-dumping over habit. Ingest time can only be earned in real time.

### 11.2 The evidence meter — what is the denominator?

The draft invented "7 evidence types". **Don't.** `SetupChecklist.tsx:78` already builds a
situation-derived `items[]` and filters it to `visible` (`:116`) with a per-item `done` flag
computed from real data (`:92`). The meter is `visible.filter(done).length` of `visible.length`
— **already self-referential, already situation-aware, already auto-hiding.** Reuse it; do not
author a parallel list.

**One blocker, and it's a real bug.** `SetupChecklist` persists its done/skip marks in
**localStorage** (`SetupChecklist.tsx:11`) — while `profiles.ui_state` exists at
`schema.sql:52` for exactly this purpose ("per-tenant UI state JSON — no localStorage"). A
completeness ring promoted to a Home hero mechanic **cannot** have device-local state: the ring
would reset when the user opens Quillo on their phone. Migrating those marks to `ui_state` is a
prerequisite of slice 6, not a follow-up.

### 11.3 Chart accessibility (slice 5)

The sage palette is low-contrast and the ghost-bar encoding leans on hue alone — both fail a
naive implementation.

- **Never encode by colour alone.** Suggested = mid-green `#5E7A4A` **with a hatch pattern**;
  Assessed = solid forest `#13311E`. The pairing must survive greyscale.
- **Value label on every bar**, not on hover — hover doesn't exist on the primary (mobile) target.
- **The unassessed year** renders as a dashed hollow outline with visible text *"not yet
  assessed"* and `aria-label="FY2026 — not yet assessed"`. Never an empty slot, never `$0`.
  A `$0` tax figure is a dangerous misread.
- Ship an `aria-describedby` data table behind the SVG so the series is readable without sight of
  the chart. Target WCAG 2.1 AA on every text/background pair in the hero.

### 11.4 Measurement — how we know it worked

**There is no analytics infrastructure.** The only event stream is `audit_log`
(`schema.sql:326`: `user_id, event, detail, created_at`, hash-chained). Options are (a) reuse it
by emitting a small set of named UI events, or (b) accept qualitative validation for the re-skin
and instrument later.

**Recommendation: (b) for slices 0–2, (a) before slice 8.** The gamify strip is the one slice
whose entire justification is behavioural — shipping it with no way to observe whether it changes
behaviour means we can never honestly evaluate it, and a mechanic we can't evaluate is a mechanic
we can't defend. Do **not** add a general-purpose analytics table on the way; `audit_log` is
hash-chained and tenant-scoped, which is the right privacy posture. Define the ≤6 events first.

Baseline metrics to capture before slice 0 ships (all queryable from D1 today):
median `needs_review` per active tenant · % of tenants with ≥1 categorised transaction ·
% with an income statement · NOA uploads per closed FY.

### 11.5 Rollout and kill-switch

Slices 0–2 and 4–6 are flag-gated and reversible with one `wrangler.toml` edit + redeploy — the
repo's standing rollback story. **Slice 8 (`gamify_strip`) is different**: it is the only slice
that changes how a user *feels* about claiming, and a bad mechanic is not undone by turning the
flag off after they've seen it.

- Ship `gamify_strip` **ON but data-gated**: each tile hides until it has real data. A brand-new
  user (now the common case — signup is open) sees the completeness ring only, which works from
  day one; an empty streak reads as failure and must never render.
- The compliance contract in §7 is enforced by a **unit golden**, not by review vigilance: assert
  that no shipped tile's copy references a deduction magnitude, a refund, or a peer comparison.
  A future contributor should get a red test, not a thoughtful reviewer.

### 11.6 Zero-data first run (blocks slice 2)

With signup open, the modal user lands on a CAPTURE Home with `$0` tracked, no next-task, and no
streak. The hero must therefore have a **first-run state that is not a number**: the completeness
ring at 0-of-N with the single next action from `progress.nextAction()` (`progress.ts:45`) as the
primary CTA, and the hero amount suppressed entirely until the first transaction is categorised.
A `$0` hero on a tax app reads as "you have no deductions", which is both discouraging and false.
Specify and review this screen **before** slice 2, not after.
