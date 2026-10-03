# Quillo for first-time taxpayers — build spec

> Terminal deliverable of wayfinder map [#529](https://github.com/matchmoments-admin/quillo/issues/529)
> (ticket [#540](https://github.com/matchmoments-admin/quillo/issues/540)). Written 2026-10-03 against
> `main` at `a571a1c`. **Decision-complete:** every choice here traces to a closed ticket's resolution
> comment (indexed below) or is an implementation detail chosen to fit those decisions. Nothing in
> this document re-opens a decision. Nothing is open: §19, *Residual questions*, records the last two owner rulings.
>
> Each build area (§3–§16) is sized for `/to-tickets`: one to three PR-sized tickets. Areas name
> their files, migrations, flag, goldens, acceptance criteria and dependencies. §17 orders them into
> waves.
>
> General information only, not tax advice. Every surface this spec describes carries that framing.

## Contents

1. [Destination recap](#1-destination-recap)
2. [Decisions index](#2-decisions-index)
3. [Cross-cutting rules for every area](#3-cross-cutting-rules-for-every-area)
4. [A1 Situation profile with dated periods, lodging-year default, mark as lodged](#a1-situation-profile-with-dated-periods-lodging-year-default-mark-as-lodged)
5. [A2 About you onboarding](#a2-about-you-onboarding)
6. [A3 Bring in your money and 'we noticed' detections](#a3-bring-in-your-money-and-we-noticed-detections)
7. [A4 Relevance-scan engine](#a4-relevance-scan-engine)
8. [A5 Bank data retention and minimisation](#a5-bank-data-retention-and-minimisation)
9. [A6 Claims step UI](#a6-claims-step-ui)
10. [A7 Records step and completeness meter](#a7-records-step-and-completeness-meter)
11. [A8 Check step](#a8-check-step)
12. [A9 Ship it](#a9-ship-it)
13. [A10 Education, Before you start, guardrails](#a10-education-before-you-start-guardrails)
14. [A11 IA and navigation restructure](#a11-ia-and-navigation-restructure)
15. [A12 Visual system](#a12-visual-system)
16. [A13 Foreign income exclusion for non-resident periods](#a13-foreign-income-exclusion-for-non-resident-periods)
17. [A14 Persona and test plan](#a14-persona-and-test-plan)
18. [A15 Sequencing](#a15-sequencing)
19. [A16 Out of scope and deferred](#a16-out-of-scope-and-deferred)
20. [Residual questions](#residual-questions)
21. [Appendix: migration and flag ledger](#appendix-migration-and-flag-ledger)

---

## 1. Destination recap

A person doing their **first Australian return** signs up, connects a bank or uploads a statement,
is told in plain language what Quillo found and what they might claim **given their job and
situation**, learns **why**, and **ships their return** by self-lodging in myTax with a worksheet
Quillo prepares. The UI is redesigned: a new IA (Home + 6 steps + a hidden Grow layer) and a new
visual system (Direction A, "Quiet ledger", fully tokenised).

**Positioning (owner, charting #529).** First-timers are the launch cohort. Property and
evidence-vault depth becomes the grow-into-it path. The cohort is first-job PAYG, students and
part-timers, gig/ABN side hustles, and newcomers (WHM, international students). There are **no
cohort forks in the model**: everything derives from bank data plus onboarding plus continued
configuration, so a user scales by adding facts, not by switching products.

**The journey (locked in #535):**

```
Before you start (no account)
  → Home (readiness owns "what's left")
     1 About you → 2 Bring in your money → 3 What you might claim → 4 Records → 5 Check → 6 Ship it
  + Grow layer (Property, Shares & investments, Business & companies, Assets, Integrations,
    Extras, Savings, Advisers/Partner): hidden until detected or switched on
  + Ask Quillo "Why?" drawer on every step (explains, never drives)
  + Account menu: Billing, Alerts, Learn/Glossary, year switcher, Settings (account-only)
```

**Lodging (#530, #538, #542).** Quillo cannot lodge an individual return: the ATO's SBR IITR service
accepts only a registered tax agent as initiating party, prefill included. Ship it is a myTax
self-lodge worksheet. Partner-agent hand-off is a later effort.

**Binding invariants (CLAUDE.md).** Multi-tenant (`user_id` on every table, identity server-side);
one canonical money source per account (`assertCanonicalSource`); APP-8 consent gate before any
model call; additive, apply-once migrations with `schema.sql` in lockstep and new tenant tables in
`PURGE_TABLES`; persona goldens as the coverage contract (all 10 + the first-timer set stay green);
new tax features additive and flag-gated (flag OFF ⇒ byte-identical) with a golden added or flipped
in the same PR; GENERAL-INFO framing, `defer_to_agent` wording, never a refund prediction; design to
the standard; jurisdiction-neutral by construction (AU only today, every new mechanism reads its
jurisdiction values from the rule pack).

---

## 2. Decisions index

Every decision is recorded in exactly one place: the closed ticket's resolution comment. This
spec cites them by number.

| # | Question | Decision (short) | Used in |
|---|---|---|---|
| [#433](https://github.com/matchmoments-admin/quillo/issues/433) | Can readiness carry the display leg for P4/5/8/10? | No, not as-is (defect #444); parallel obligations are not position lines | A8 |
| [#434](https://github.com/matchmoments-admin/quillo/issues/434) | Where does Position live? | Fold it: estimate-only position in **Check**; `/reports` = Ship it detail view + Grow reports | A8, A9, A11 |
| [#435](https://github.com/matchmoments-admin/quillo/issues/435) | Where do stated claims live? | WFH hours + car km in **Records** beside the claim; loan interest under Grow › Property; prior-year carry-ins in **About you** | A2, A7, A11 |
| [#436](https://github.com/matchmoments-admin/quillo/issues/436) | What happens to Settings? | Split: situation/people → About you; properties/loans/entities/super/distributions/SMSF → Grow; Settings = account only (consent, export, delete) | A11 |
| [#437](https://github.com/matchmoments-admin/quillo/issues/437) | Can /reconcile fold into a queue? | Yes, as a **server-side proposer**, one confirm per row; two-pane stays as fallback; FY-scope by bank line; credits matchable; `needs_review` pill → queue row, cascade delete stays on Documents | A8 |
| [#438](https://github.com/matchmoments-admin/quillo/issues/438) | Onboarding write semantics | **Fill gaps only**, re-enterable, never overwrites or duplicates; WFH lands in the active FY (built, PR #543) | A2 |
| [#439](https://github.com/matchmoments-admin/quillo/issues/439) | Income / Extras / Savings disposition | Income = step, split (power cards → Grow); Extras + Savings → Grow; PHI hospital cover → situation profile | A1, A3, A11 |
| [#440](https://github.com/matchmoments-admin/quillo/issues/440) | Safe flag collapses | 12 collapsed (built, #553); 7 kill-switches kept; `partnership_losses` + `phi_tax_inputs` held | A16 |
| [#530](https://github.com/matchmoments-admin/quillo/issues/530) | Automatic lodgement? | No lawful self-lodge API; ship-it = myTax worksheet (default) + partner agent later | A9, A16 |
| [#531](https://github.com/matchmoments-admin/quillo/issues/531) | First-timer engine coverage | Gaps are capture + nudges (M1–M6), not tax math; never compute tax/rates | A1, A3, A13 |
| [#532](https://github.com/matchmoments-admin/quillo/issues/532) | What derives from bank + onboarding? | Feed says where to look, not what's claimable; occupation rules must run on bank lines; relevant + unsorted-for-a-window | A3, A4, A5 |
| [#533](https://github.com/matchmoments-admin/quillo/issues/533) | How do established players guide first-timers? | myTax Personalise order; 3 golden rules as the why; completeness meter, never a refund figure; worksheet mirrors myTax labels | A2, A7, A9, A10 |
| [#534](https://github.com/matchmoments-admin/quillo/issues/534) | Bank data minimisation | All credits + relevant/unsorted debits; irrelevant debits kept until lodged or ~60 days (later of), then shrink to per-account totals; CDR + statements alike | A5 |
| [#535](https://github.com/matchmoments-admin/quillo/issues/535) | Journey + IA | Home + 6 steps; Grow hidden until detected or switched on, never silently auto-on; only deletion is the Savings calculator | A11 |
| [#536](https://github.com/matchmoments-admin/quillo/issues/536) | About you question set | myTax order, ~6 questions; everything else derived ("we noticed") or asked in context; default year = year being lodged | A1, A2 |
| [#537](https://github.com/matchmoments-admin/quillo/issues/537) | Education model | Inline why (3 golden rules, ATO occupation links, glossary); Why? drawer; **no peer benchmarks**; guardrails | A10 |
| [#538](https://github.com/matchmoments-admin/quillo/issues/538) | Ship-it worksheet | In-app checklist in myTax section order + PDF; prefill 'check this matches'; copy buttons; record links; mark as lodged → NOA → next year | A9 |
| [#539](https://github.com/matchmoments-admin/quillo/issues/539) | Visual system | Direction A "Quiet ledger"; three-layer tokens; Geist; Anton retired ([design-system.md](design-system.md)) | A12 |
| [#542](https://github.com/matchmoments-admin/quillo/issues/542) | Partner agent | Out of this map's scope; when it lands, the **user pays the agent directly** | A16 |
| [#550](https://github.com/matchmoments-admin/quillo/issues/550) | Build: income capture | Shipped (PR #564): `first_timer_income` ON, goldens `pft1`–`pft6` | A3, A14 |
| [#551](https://github.com/matchmoments-admin/quillo/issues/551) | Build: word-boundary matching | Shipped (PR #561) | A4 |
| [#552](https://github.com/matchmoments-admin/quillo/issues/552) | Build: Income page defects | Shipped (PR #559) | — |
| [#553](https://github.com/matchmoments-admin/quillo/issues/553) | Build: collapse 12 flags | Shipped (PRs #560/#562/#563) | — |
| [#554](https://github.com/matchmoments-admin/quillo/issues/554) | "This is my wages" on a credit | Mark payer as employer, record **nothing**, ask for the income statement; retire `income_personal` for wages | A3 |
| [#555](https://github.com/matchmoments-admin/quillo/issues/555) | Occupation vs not-deductible default | Occupation match overrides the default as a **'worth a look'** card; user confirms every claim; never auto-claim | A4, A6 |
| [#556](https://github.com/matchmoments-admin/quillo/issues/556) | Situation profile shape | One profile per person, dated periods per fact; generalise the period mechanism; table shape in this spec | A1 |
| [#557](https://github.com/matchmoments-admin/quillo/issues/557) | Foreign income for non-residents | Exclude, flag-gated, from residency periods, with a general-info note + golden | A13 |
| [#566](https://github.com/matchmoments-admin/quillo/issues/566) | Build: tokenise the theme | In progress: three-layer CSS-variable tokens, look unchanged | A12 (prerequisite) |
| Coordinator, 2026-10-03 | 'You may not need to lodge'; SERR statements; first-timer pricing | General-info note on *Before you start* pointing to the ATO tool, never Quillo's verdict; SERR statement import **out** (joins #456); pricing handed to launch map #523 | A10, A16 |

**Map fog cleared by these decisions.** *Default FY* (#536). *Retiring legacy pages* (#535, #436,
#439, table in A11). *Grow path* (#535: detect-or-switch). *Mobile-first* (#539: mobile-first, one
column under 768px). *Agent surface* (#537 for where "why" lives and what the agent may say; cost
stays under the existing `ask_quillo` spend switch and per-tenant caps). *'You may not need to
lodge'* and *SERR* and *pricing* (coordinator, 2026-10-03).

---

## 3. Cross-cutting rules for every area

These apply to every ticket cut from this spec. Tickets don't need to restate them.

1. **Flags.** Each area names one flag (or reuses one). Flag OFF ⇒ byte-identical: same server
   payloads, same SQL results, same rendered markup. Server-side flags gate endpoints with a 404 when
   OFF. New keys go in `src/lib/features.ts` (`FEATURE_KEYS`, with a one-line rationale comment) and
   in `wrangler.toml` `FEATURES` only when the owner flips them. The persona and e2e harnesses run
   each new flag both ON and OFF.
2. **Migrations.** Numbers below are "next 00NN" at the time of writing (`main` ends at `0077`). If
   another migration lands first, renumber in order; never reuse a number. Every migration is
   `CREATE TABLE/INDEX IF NOT EXISTS` or `ALTER TABLE ADD COLUMN`, with `schema.sql` updated in the
   same PR (`npm run test:schema` enforces it). Every new tenant table goes in `PURGE_TABLES`
   (`src/lib/retention.ts`; a unit test asserts completeness) and in `exportTenant`.
3. **The SPA never sends identity.** Every new endpoint derives `user_id` server-side in
   `src/api.ts`, like every existing resource.
4. **Copy.** Every money surface shows the general-information footnote. Judgement calls use
   `defer_to_agent` wording: "confirm with a registered tax agent". No surface shows a refund, a tax
   payable figure, a rate, or a peer benchmark. New copy files are covered by the tax-advice term
   denylist test (A10).
5. **Engine ✓ + UI ✓ + display ✓.** A ticket is not done until the relevant persona can enter the
   data and see the result. If a ticket defers its UI, it says so and links the follow-up.
6. **Review.** Anything touching money, migrations, the ingest path or the report path runs
   `/local-ultrareview` before merge (`/code-review` is user-triggered only).
7. **Jurisdiction-neutral.** Status values, occupation tokens, label maps, due dates and thresholds
   come from the rule pack (`src/rulepacks/au-v1.json`), never hard-coded in TS. Rule-pack changes
   run `npm run rulepack:push` at deploy and reason about the eval gate.

---

## A1 Situation profile with dated periods, lodging-year default, mark as lodged

**Decisions:** #556 (shape), #536 (default year), #538 (mark as lodged), #439 (PHI hospital cover
belongs here), #435 (carry-ins live in About you).

### Goal

One **situation profile per person**, made of dated periods for each fact, that onboarding writes
and the scan, nudges, worksheet and foreign-income exclusion read. Plus the **lodging-year
default** and **mark as lodged**, which the profile's year logic depends on.

### Design to the standard

- myTax's Personalise screen asks residency (with dates for part-year), spouse (with dates), and
  ticks what applies. Xero/MYOB payroll model an employment as an employee record with start and
  termination dates. Quillo already models a job as an `entities` row of kind `employment`.
- **Chosen shape: one generic period table**, `situation_periods`, keyed by subject (person today,
  property later). This is the "generalise, don't special-case" route: it is the dated-period
  primitive the property `use_status` move (dogfood map #464) also needs. Migrating
  `properties.use_status` onto it is **not** part of this spec (grow path), but the table is built so
  that a `subject_kind = 'property'`, `fact = 'use_status'` row needs no further DDL.
- Rejected: widening `persons` with columns per fact (no history, part-year impossible) and reusing
  `entity_roles.start_date/end_date` for jobs (dark table, role-shaped, would split the profile
  across two mechanisms).

### Data model (next `0078_situation_periods.sql`)

```sql
CREATE TABLE IF NOT EXISTS situation_periods (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  subject_kind TEXT NOT NULL DEFAULT 'person',   -- person | property (property reserved, no writer yet)
  subject_id   TEXT NOT NULL,                    -- persons.id (or properties.id)
  fact         TEXT NOT NULL,                    -- see fact table below (pack-validated)
  value        TEXT,                             -- e.g. 'resident' | 'temporary' | 'foreign' | 'whm' | 'unsure'; occupation token; state code
  ref_id       TEXT,                             -- employment → entities.id; abn_activity → income_activities.id
  starts_on    TEXT,                             -- ISO date, NULL = open start
  ends_on      TEXT,                             -- ISO date inclusive, NULL = open end
  source       TEXT NOT NULL DEFAULT 'user',     -- user | onboarding | noticed
  detail_json  TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sitper_subject ON situation_periods(user_id, subject_id, fact);

ALTER TABLE fy_signoff ADD COLUMN lodged_at TEXT;   -- set by 'mark as lodged'; NULL = not lodged
```

`schema.sql` lockstep. `situation_periods` added to `PURGE_TABLES` and `exportTenant`.

**Facts** (pack key `situation_facts` in `au-v1.json`, so a jurisdiction can add or rename them):

| fact | value | ref_id | Cardinality | Written by |
|---|---|---|---|---|
| `residency` | `resident` \| `temporary` \| `foreign` \| `whm` \| `unsure` | — | single-valued (no overlaps) | About you Q1 |
| `spouse` | `yes` \| `no` | — | single-valued | About you Q2 |
| `state` | AU state code (education only) | — | single-valued | About you Q3 |
| `employment` | occupation token, or `none` ("not working yet", ignored by the scan) | `entities.id` (kind `employment`), NULL until the employer is known | multi-valued (overlaps allowed) | About you Q4/Q5, wages marking (A3) |
| `abn_activity` | `rideshare` \| `delivery` \| `freelance` \| `other` | `income_activities.id` (type `business`) | multi-valued | About you Q5, platform detection (A3) |
| `study` | `yes` | — | single-valued | About you Q5 |
| `study_loan` | `yes` | — | single-valued; **only stored when the user ticks it** (opt-in, data minimisation) | About you Q5 |
| `wfh` | `yes` | — | single-valued | About you Q5 |
| `car_for_work` | `yes` | — | single-valued | About you Q5 |
| `foreign_income` | `yes` | — | single-valued | About you Q5, foreign-inflow detection (A3) |
| `private_hospital_cover` | `yes` \| `no` | — | single-valued | About you (in context, when a PHI debit is noticed) |

A tick with no dates is stored as a period spanning the active FY (`starts_on` = FY start,
`ends_on` = FY end) so the next FY asks again rather than silently carrying it forward.

**Mirrors (keep legacy readers correct, written only by the new endpoints).**
- `persons.occupation` ← the `value` of the person's longest `employment` period in the active FY.
- `persons.tax_residency` ← `'AU'` if the residency period covering the FY's last day is
  `resident`, else `'foreign'` (the existing binary readers, `cgt.ts` discount and the non-resident
  defer, keep working).
- `profiles.private_health` ← `private_hospital_cover` (closes the orphaned writer, #439).

With the flag OFF none of the endpoints exist, so nothing writes the table or the mirrors.

*As built (#571):* the mirrors follow the **latest FY** (up to the current one) that the fact's periods reach,
so editing a past year never moves the live scalar; `residency = unsure`, or no period covering the FY's
last day, leaves `tax_residency` **unchanged** (an "I don't know" must not flip the CGT-discount reader;
`residency_unsure` defers instead); deleting a fact's last period reverts a mirror that still holds that
period's value (`'AU'` / `NULL`). `fy_signoff.lodged_at` moved out of `0078` into ticket (b)'s own migration
(#572), so later numbers in the appendix ledger shift by one when it lands.

### Server

- New `src/lib/situation-profile.ts`:
  - `profileForFy(env, userId, fy): Promise<SituationProfile[]>`, one per person, the shape in
    relevance-scan.md §8 (`jobs[]`, `abn_activities[]`, `residency[]` periods clipped to the FY,
    `flags`, `state`).
  - `residencyOn(profile, isoDate)` and `residencyPeriodsForFy(...)`, used by A13.
  - `validatePeriod(...)`: rejects overlaps for single-valued facts, rejects unknown facts/values
    against the pack, requires `starts_on <= ends_on`.
- New `src/lib/lodging-year.ts`: `lodgingFy(today, taxPeriod, lodgedFys): number`. Rule (#536): in
  FY *N*, the default is *N − 1* unless FY *N − 1* is lodged (`fy_signoff.lodged_at` set or
  `status = 'closed_with_noa'`), then *N*. Pure, unit-tested across the 1 July boundary.
- `src/lib/db.ts` `getSituation`: when the flag is ON, attach `profile_periods` (all periods) and
  `lodging_fy`. OFF ⇒ payload byte-identical.
- `src/api.ts`, new resources (all `uid` server-derived):
  - `GET /api/situation-periods?person_id=` and `POST`, `PATCH /:id`, `DELETE /:id`. Writes go
    through `src/lib/situation-write.ts` (new `upsertSituationPeriod`, `deleteSituationPeriod`)
    and update the mirrors in the same batch.
  - `POST /api/lodged?fy=` (mark as lodged; body `{ lodged_on?: ISO date }`) and
    `DELETE /api/lodged?fy=` (undo). Upserts `fy_signoff` with `lodged_at`, keeps
    `status = 'closed_with_noa'` if already set, otherwise `status = 'lodged'`. Writes an
    `audit_log` row.
  - `src/lib/noa-store.ts`: the NOA *unconfirm* path currently deletes the `fy_signoff` row where
    `status = 'closed_with_noa'`. Change it to reset `status` to `'lodged'` when `lodged_at` is set,
    so undoing a NOA never erases the lodged mark.
- Readiness (`src/lib/readiness.ts`, `assessReadiness`), new findings populated **only when the
  flag is on**:
  - `residency_unsure` (review): "You said you're not sure of your residency. The ATO's residency
    tests decide it; confirm with a registered tax agent." Links the ATO residency page.
  - `study_loan_passthrough` (info, only with `study_loan`): "Your compulsory study-loan repayment
    is worked out by the ATO from your repayment income (taxable income plus any reportable
    amounts). Quillo doesn't calculate it." No figure (personas-coverage M4/G5).

### SPA

- `web/src/lib/activeFy.tsx` `ActiveFyProvider`: seed order becomes stored `ui_state.active_fy` →
  `situation.lodging_fy` → `currentFyStart(...)`. With the flag OFF, `lodging_fy` is absent and the
  seed is unchanged.
- The About you step (A2) is this area's editor. Mark as lodged UI lives in Ship it (A9).
- `web/src/api.ts`: typed clients for the new resources.

### Flag

`situation_profile` (new). Covers the table's writers, the mirrors, `lodging_fy`, the lodged
endpoints and the two findings.

### Goldens

- **`pft7`** (new): a part-year resident (arrived 2026-02-01) with a `residency` period pair, two
  `employment` periods (two casual jobs, two occupation tokens) and a `study_loan` tick.
  Asserts `profileForFy` output; the mirrors (`persons.occupation` = longer job, `tax_residency` =
  `'AU'`); `study_loan_passthrough` fires with no money figure; `taxable_position_cents`
  byte-identical ON vs OFF; flag OFF adds no findings.
- Unit goldens (`scripts/check-units.ts`): `lodgingFy` on 30 Jun / 1 Jul / 15 Oct with and without
  a lodged prior FY; `validatePeriod` overlap rejection.

### Acceptance

- Writing, editing and deleting periods round-trips; overlapping single-valued periods are rejected
  with a 400 and a plain message.
- A brand-new tenant in October 2026 lands on FY 2025-26. After *Mark as lodged* for 2025-26, the
  app moves to FY 2026-27 and stays there on reload.
- NOA unconfirm after mark-as-lodged leaves `lodged_at` intact.
- All 10 personas + `pft1`–`pft6` unchanged; `npm test` green with the flag ON and OFF.

### Dependencies

None. Wave 1.

**Tickets:** (a) table + library + endpoints + mirrors + findings + `pft7`; (b) `lodgingFy` +
`/api/lodged` + NOA-unconfirm fix + ActiveFy seed.

*As built (#572):* migration `0087_fy_lodged_at.sql` (`lodged_at` holds the `YYYY-MM-DD` the user says they
lodged; default today). `/api/lodged` also answers `GET`, needs an explicit `fy` (no later than the current FY),
rejects a `lodged_on` before the FY started or in the future, writes through the DO (`markLodged` /
`unmarkLodged`, audited `fy_marked_lodged` / `fy_unmarked_lodged`) and returns `lodging_fy` so the SPA moves the
active FY at once (`useLodgedMark()` in `web/src/lib/activeFy.tsx`; the button itself is A9, #590). Undo keeps a
NOA close and otherwise leaves a plain soft sign-off. Re-opening the soft sign-off (`DELETE /api/signoff`) on a
lodged year is a 409 (undo the mark first) and never deletes the row. **Retention backstop** (owner ruling): an FY
with no mark is treated as lodged for retention from the self-lodger due date + 60 days (pack keys
`lodgement.self_lodge_due_after_fy_end` and `lodgement.retention_backstop_days`; AU FY 2025-26 → 30 Dec 2026).
A5 reads `retentionLodgedOn` / `isFyLodgedForRetention` / `backstopLodgedThroughFy` from `src/lib/lodging-year.ts`.
The backstop never moves the lodging-year default. Golden `pft7l`.

---

## A2 About you onboarding

**Decisions:** #536 (question set, myTax order, derive the rest), #438 (fill gaps only, carried
over), #435 (prior-year carry-ins in About you), #436 (situation + people come here from Settings).

### Goal

Replace the first-run wizard's shape with **About you**: about six questions in myTax Personalise
order, writing the situation profile. The same screen is the permanent editor for the profile
(step 1 of the journey).

### User-visible behaviour

Two modes of one page, `/about`:

- **First run** (new tenant, reached from the existing `FirstRunGate` in `web/src/App.tsx`): one
  question per screen on mobile, with the step header ("Step 1 of 6") and a footer (Back / Why? /
  Next). The APP-8 consent screen stays first, exactly as today's `consent` step.
- **Profile** (any later visit): the same questions as an editable summary, one card per fact, each
  with its dated periods. Editing here is the explicit edit path for those facts.

**Questions, in order** (myTax Personalise):

1. **Residency for the year.** All year / part of the year (arrival or departure date) / not an
   Australian resident (then: working holiday visa, student visa, other visa) / not sure. Writes
   `residency` periods: all year → one `resident` period over the FY; part-year → `resident` from
   arrival (or to departure) plus `foreign` for the rest; WHM → `whm`; student visa →
   `temporary`; other visa → `foreign`; not sure → `unsure` (raises `residency_unsure`).
   Newcomer education sits inline (A10).
2. **Spouse.** Yes / no, with optional dates. Writes `spouse`.
3. **State or territory.** Writes `state`. Labelled "used for local information only; your return
   is federal".
4. **Main occupation.** The existing picklist + free text (`web/src/content/occupations.ts`,
   `normaliseOccupation`), with "not working yet" as an option. Writes an `employment` period
   (`ref_id` NULL until an employer is known) and the `persons.occupation` mirror.
5. **Tick what applies** (chips): a job, study (with an optional "I have a HELP/study loan" tick),
   side income or an ABN, worked from home, used my own car for work, money from overseas. Writes
   `employment` / `study` / `study_loan` / `abn_activity` (+ an `income_activities` row of type
   `business`) / `wfh` / `car_for_work` / `foreign_income`. Ticking side income/ABN also switches
   on the Grow › Business layer (A11).
6. **Confirm.** A plain summary, then "Bring in your money" as the primary action.

Not asked up front (#536): WFH hours and car km (asked in Records), the income statement (asked in
Check / Bring in), employer names (learned from the bank, A3), private hospital cover (asked when a
PHI debit is noticed).

**From last year's return** (#435): a collapsed section at the bottom of the profile mode holding
the prior-year carry-in forms that live in `Settings.tsx` today (capital losses, opening
depreciation). Expanded automatically when a confirmed NOA or a prior FY with data exists.

**Fill gaps only (#438, carried over).** In first-run mode, answering never overwrites an existing
period, person, entity or activity: matching facts are skipped (same subject + fact + overlapping
dates, or same name/kind for entities). Re-entering the wizard is safe. Profile mode is the only
path that edits an existing period.

### Data model

None beyond A1.

### Server

- Uses A1's `situation-periods` endpoints. Add `fill_only: true` handling to
  `POST /api/situation-periods` (skip when an overlapping row for the same subject + fact exists),
  mirroring `POST /api/work-use`'s `fill_only` from PR #543.
- The existing `POST /api/situation/draft` stays for legacy onboarding (flag OFF).

### SPA

- New `web/src/pages/AboutYou.tsx` (first-run + profile modes), new
  `web/src/components/ft/SituationQuestion.tsx` (one question renderer) and `ft/PeriodEditor.tsx`.
- `web/src/pages/Onboarding.tsx` stays the flag-OFF path. With `ft_journey` ON, `/onboarding`
  redirects to `/about` and `FirstRunGate` sends new tenants to `/about`.
- Carry-in components move from `Settings.tsx` sections (`:116-125` area) into a shared component
  imported by both (Settings keeps them only while the flag is OFF).
- People management (`SituationFields.tsx`, the Settings "People" section) moves into About you's
  profile mode under "People in this return".

### Flag

`ft_journey` (the redesign flag, A11) for the page and routing; writes require `situation_profile`
(A1). Both must be ON for About you to render; with `ft_journey` ON and `situation_profile` OFF the
legacy Onboarding page is shown.

### Goldens

- `pft7` (A1) covers the writes. Add to the **e2e first-timer journey** (A14): the About you answer
  set for FT1 Jess produces exactly the expected periods; re-running first-run mode with the same
  answers writes zero rows.

### Acceptance

- Six questions, in the order above, each answerable in one tap or one date picker on a 400px
  screen.
- Re-entering first run never changes an existing row (asserted by row counts before/after).
- Every answer is editable later from profile mode, and the edit updates the mirrors.
- Carry-ins render in About you and no longer in Settings when `ft_journey` is ON.

### Dependencies

A1 (data), A11 shell (route + step chrome), A12 components. Wave 3.

**Tickets:** one (About you page, both modes, carry-ins move, routing).

---

## A3 Bring in your money and 'we noticed' detections

**Decisions:** #554 (wages: mark employer, record nothing, ask for the income statement), #532
(credit triage: payroll, platform, government, interest, foreign; propose, never assert), #536
(derived facts confirmed by the user), #439 (Income splits: "Your income" stays in the step),
#535 (Bring in ← Accounts, Income upload/manual, Documents capture).

### Goal

Step 2 brings money in (bank connect or statement upload, plus income statement / manual income)
and then shows **"We noticed…"** cards from a deterministic credit triage. Each card proposes a
profile change the user confirms. Wages never become income from a bank credit.

### User-visible behaviour

- **Bring in** page sections: *Your accounts* (connect a bank when `bank_feed_cdr` is ON, or upload
  a statement, today's Accounts flow), *Your income* (income statement upload and manual add limited
  to first-timer types: `salary_payg`, `government_payment`, `interest`, `business`,
  `foreign_employment`, `other`), *Capture a document* (today's Documents upload).
- After an import, **We noticed** cards, one per detected signal, each with *Yes* / *No* / *Not
  sure*:

| Signal (credit triage) | Card copy (shape) | *Yes* does | Never does |
|---|---|---|---|
| **Payroll payer** (same payer, regular cadence, payroll words) | "Looks like pay from **Big Retail**. Is this your wages?" | Creates or matches an `entities` row (kind `employment`, name = payer), links an `employment` period (`ref_id`), stamps `transactions.payer_entity_id` on that payer's credits, and shows: *"Your income statement in myTax shows your gross pay and tax withheld. Check it's there and enter it here, and Quillo will use it."* with an upload button | Records any `income` row; uses `income_personal` |
| **Second payroll payer** | "A second employer? **Café Co** pays you too." | As above for the second job; the existing `tax_free_threshold_two_payers` note applies once two income statements exist | Predicts a shortfall amount |
| **Platform payout** (`UBER`, `DIDI`, `DOORDASH`, `MENULOG`, `AIRTASKER`, `AIRBNB`, `MADPAW`, `HIPAGES`, from a pack list) | "Payouts from **DoorDash**. Do you have an ABN for this?" | Creates an `abn_activity` period + `income_activities` (type `business`, label = platform), switches on Grow › Business, records the payouts as business income through the existing direction-safe `recordCreditAsIncome` (business income is assessable as received; gross-vs-net fees is a Records prompt) | Asserts GST status (the existing `rideshare_gst_first_dollar` nudge covers ride-sourcing) |
| **Government payment** (`SERVICES AUSTRALIA`, `CENTRELINK`, `DSS`) | "Payments from **Services Australia**. These are usually prefilled in myTax." | Adds a *check this matches* line to the worksheet (A9) and offers manual entry as `government_payment` | Records it automatically |
| **Interest** | "Interest from **ING**. Usually prefilled." | Worksheet *check this matches* line | Records it automatically |
| **Foreign inflow** (`WISE`, `REMITLY`, `WESTERN UNION`, FX credits) | "Money from overseas. Is any of it income?" | Sets `foreign_income`, links About you Q1 if residency is unanswered, offers manual entry (`foreign_employment` / other foreign types) | Treats a transfer as income |
| **Person-to-person** (PayID / names) | none (silently treated as not income, as today's Clarify `ignore`) | — | — |
| **Rent, dividends, broker deposits** | Grow suggestions (A11), not step cards | — | — |

*No* dismisses the signal for that payer key and FY. *Not sure* leaves it open with a "Why?" link.

### Data model (next `0079_noticed_signals.sql`)

```sql
CREATE TABLE IF NOT EXISTS noticed_signals (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  fy          TEXT NOT NULL,                 -- '2025-26'
  kind        TEXT NOT NULL,                 -- payroll | platform | government | interest | foreign | grow_property | grow_investments | grow_business
  signal_key  TEXT NOT NULL,                 -- groupKey stem of the payer/merchant (src/lib/clarify.ts groupKey)
  status      TEXT NOT NULL DEFAULT 'open',  -- open | confirmed | dismissed
  evidence_json TEXT NOT NULL DEFAULT '{}',  -- counts + first/last date + total_cents only (no raw descriptions)
  ref_id      TEXT,                          -- the entity / activity created on confirm
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at  TEXT,
  UNIQUE (user_id, fy, kind, signal_key)
);
ALTER TABLE transactions ADD COLUMN payer_entity_id TEXT;   -- on a credit: the employer entity it is pay from
CREATE INDEX IF NOT EXISTS idx_txn_payer_entity ON transactions(user_id, payer_entity_id);
```

`noticed_signals` → `PURGE_TABLES` + export. `schema.sql` lockstep.

### Server

- New `src/lib/credit-triage.ts` (pure): `triageCredits(rows, packLists, existingEmployers)` →
  `{ kind, signal_key, evidence }[]`. Payroll detection = same `groupKey` stem, ≥ 2 credits at a
  7/14/28-day cadence (±3 days) or payroll words (`SALARY`, `PAY`, `WAGES`), amount band within
  ±35%. Platform/government/interest/foreign lists live in the rule pack (`credit_signals`).
  Deterministic, no LLM.
- `src/agent.ts`: after `stampDeductibility` on the statement path (`importStatement` region,
  ~`:1110`) and the feed path (~`:1950`), call `this.noticeSignals(userId, fy)`, which upserts
  `noticed_signals` (`INSERT OR IGNORE` on the unique key, so a dismissal sticks).
- New DO methods + `src/api.ts` resource `noticed`:
  - `GET /api/noticed?fy=` → open signals.
  - `POST /api/noticed/:id/confirm` (body by kind, e.g. `{ occupation? }` for payroll) and
    `POST /api/noticed/:id/dismiss`.
  - Payroll confirm: create/match employment entity (fill-gaps match on kind + name), create the
    `employment` period, `UPDATE transactions SET payer_entity_id = ? WHERE user_id = ? AND
    direction = 'credit' AND <groupKey stem match>`. **No `income` write.**
- **Retire the wages misuse of `income_personal`** (#554): `src/lib/clarify.ts` `suggestionsFor`
  gains a credit answer *"My wages"* of kind `wages_payer` (flag-gated) that routes to the same
  payroll-confirm handler. The server keeps `income_personal` for non-wage personal income only;
  a credit already stamped `payer_entity_id` can never be recorded via `income_personal` (guard in
  the answer handler, ~`agent.ts:5291`).
- `src/lib/first-timer-signals.ts`: the income-completeness finding (`income_not_recorded`,
  shipped in #550) becomes **per employer** when `payer_entity_id` exists: "Pay from Big Retail is
  in your bank, but its income statement isn't recorded yet." It clears when a `salary_payg` row
  whose `detail_json.employer` matches the entity (via `payerKey`) exists.

### SPA

- New `web/src/pages/BringIn.tsx` composing: the accounts/import body of `Accounts.tsx` (extracted
  to `web/src/components/accounts/AccountsPanel.tsx`), the "Your income" part of `Income.tsx`
  (extracted to `web/src/components/income/YourIncome.tsx`, first-timer types only), and the upload
  part of `Documents.tsx` (extracted to `web/src/components/DocumentCapture.tsx`).
- New `web/src/components/ft/NoticedCard.tsx`.
- `web/src/components/ClarifyCard.tsx` / `SortFlow.tsx`: show the *My wages* answer on credit groups
  when `wages_payer` is ON.

### Flag

`wages_payer` (new, server + Clarify answer) and `ft_journey` (the page). `noticed_signals` writes
happen only with `wages_payer` ON; Grow kinds are written by A11 under `ft_journey`.

### Goldens

- **`pft8`** (new): FT1 Jess, bank-only: 3 fortnightly credits from "BIG RETAIL PTY LTD" plus 2
  "DOORDASH" payouts. Asserts: triage emits one `payroll` + one `platform` signal; payroll confirm
  writes zero `income` rows, sets `payer_entity_id` on exactly the 3 credits, and the
  completeness finding names Big Retail; an income statement upload for Big Retail counts gross
  **once** and clears the finding; platform confirm records the 2 payouts as `business` income;
  the `income_personal` answer on a payer-stamped credit is refused; flag OFF byte-identical.
- Extend `pft1` with the payroll path (bank credits → employer marked → still $0 income → statement
  → gross once).

### Acceptance

- No path turns a bank credit into wage income.
- Dismissed signals never reappear for the same FY and payer key, including after re-import.
- `evidence_json` holds counts, dates and totals only, never raw descriptions (minimisation).
- Bring in shows the cards within the same screen after an import, without a reload.

### Dependencies

A1 (employment periods). A11 shell for the page. Server part is Wave 1–2; page is Wave 3.

**Tickets:** (a) credit triage + `noticed_signals` + payroll/platform/government/interest/foreign
confirm handlers + `wages_payer` Clarify answer + `pft8`; (b) Bring in page.

---

## A4 Relevance-scan engine

**Decisions:** #532 (occupation rules must run on bank lines; three-list output; re-scan on profile
change), #555 (occupation match overrides the not-deductible default as 'worth a look', user
confirms every claim, never auto-claim), #551 (word-boundary matching, shipped).

### Goal

Run the profile-driven relevance scan on **bank lines**, so a bank-only first-timer sees the few
lines that match their job and situation, and everything else stays buried by deny-by-default.

### Behaviour

For each FY, the scan sorts debit lines into three lists (relevance-scan.md §8):

1. **Relevant** — hits a claimability rule whose scope is in the profile (occupation tokens from
   all `employment` periods in the FY + `all` + the person's `abn_activity` kinds) or an apportion
   list. Grouped by `groupKey`.
2. **Prompts** — facts to state: WFH hours if `wfh`, km if `car_for_work` or a platform activity,
   residency dates if `foreign_income` and residency is unanswered. (Rendered in Records, A7.)
3. **Irrelevant** — denied, or matched nothing and below the dollar floor (pack
   `relevance.floor_cents`, starting at 2000). Candidates for minimisation (A5).

**Occupation override (#555).** When an occupation-scoped rule matches a line that the generic
deny list stamped `likely_not` (AHPRA, HSU, safety footwear), the line becomes **worth a look**: a
`claim_suggestions` row (`source = 'relevance_scan'`, `rule_id`, `person_id`) plus
`transactions.relevance = 'worth_a_look'`. The row's **deductibility is not changed**, so the
position is untouched until the user confirms through the existing `confirmSuggestedDeduction`
path, which writes `confirmed_deductible`. No auto-claim, ever.

**Re-scan.** Any write to `situation_periods` for `employment`, `abn_activity`, `wfh`,
`car_for_work` or `foreign_income` re-runs the scan over the FY's lines still present (A5's window
guarantees lines are still there before the FY is lodged).

### Data model (next `0080_txn_relevance.sql`)

```sql
ALTER TABLE transactions ADD COLUMN relevance TEXT;          -- NULL (not scanned) | relevant | worth_a_look | irrelevant
ALTER TABLE transactions ADD COLUMN relevance_rule_id TEXT;  -- the claimability rule that made it relevant
CREATE INDEX IF NOT EXISTS idx_txn_relevance ON transactions(user_id, relevance);
```

No new table. `claim_suggestions.source` gains the value `relevance_scan` (no DDL).

### Server

- New `src/lib/relevance-scan.ts` (pure): `scanLines(lines, profile, rules, denyLists, floor)` →
  `{ id, relevance, rule_id? }[]`. Uses `matchClaimRules` and `merchantMatches` from
  `src/lib/claimability.ts` (word-boundary since #551) and the deny verdict from
  `src/lib/deductibility.ts` `verdictForTxn`.
- `src/agent.ts`: new private `runRelevanceScan(userId, fy, { txnIds? })`, called after
  `stampDeductibility` at the statement and feed ingest sites (the same sites as A3) and from the
  situation-period write path. It writes `relevance`/`relevance_rule_id` and inserts
  `claim_suggestions` (`INSERT OR IGNORE` keyed on `user_id, txn_id, rule_id`, add the unique index
  in the same migration if absent). This closes D3 (`suggestClaims` today runs only on receipts at
  ~`agent.ts:2208`).
- **Rule-pack wording fix (D4/G7)**: `income_business` described as "business revenue (sole trader
  or company)" rather than Pty Ltd revenue; SaaS merchant hints no longer default to `company` for
  a tenant with no company entity (`au-v1.json` buckets + hints). Run `npm run eval` and record
  the drift in the PR.
- **Narrow nothing else.** The deny list keeps winning for generic (non-occupation) rules.
- `src/lib/queries.ts`: `listReviewGroups` gains a `relevance` filter so the Claims queue (A6) can
  show only `relevant` + `worth_a_look` lines for an FY.

### Rule-pack content (second ticket)

Author occupation guides + claimability rules for the cohort's missing tokens (relevance-scan.md
§3): `student`, `childcare_worker`, `warehouse_logistics`, `call_centre`, `fitness_instructor`,
`delivery_rider`. Each guide gets an `ato_url` (the ATO occupation guide) used by A10. Add
`ato_url` to the existing 17 guides too. Copy is general information; rules default to
`defer_to_agent` where nexus is judgement (self-education). `npm run rulepack:push` on deploy.

### SPA

None in this area (the Claims UI is A6).

### Flag

`relevance_scan` (new). OFF ⇒ no `relevance` writes, no `relevance_scan` suggestions, queue
unchanged.

### Goldens

- **`pft9`** (new): FT nurse grad with occupation `nurse`, lines AHPRA renewal, HSU dues,
  "safety footwear", Woolworths groceries, Netflix. Asserts: AHPRA/HSU/footwear →
  `worth_a_look` with a `relevance_scan` suggestion, deductibility still `likely_not`,
  `taxable_position_cents` unchanged; confirming AHPRA moves the position by exactly its amount;
  groceries/Netflix → `irrelevant`; the same lines for a `retail_worker` produce no AHPRA card;
  adding a second `employment` period (`nurse` added to a retail worker) re-scan surfaces AHPRA;
  flag OFF byte-identical.
- AU snapshot (`npm run test:au-snapshot`) unchanged (the scan never changes stamped deductibility).
- Eval: `npm run eval` result recorded; the wording fix is expected to help the 5 context-starved
  cases, not regress.

### Acceptance

- A bank-only nurse sees AHPRA as worth a look without uploading a receipt.
- Nothing becomes claimable without a user confirm.
- Scan cost is O(lines × rules in scope), deterministic, no model calls.

### Dependencies

A1 (profile). Wave 1–2 (engine needs A1's library; can start against `persons.occupation` and
switch to `profileForFy` when A1 merges).

**Tickets:** (a) engine + override + re-scan + wording fix + `pft9`; (b) rule-pack occupation
content.

---

## A5 Bank data retention and minimisation

**Decision:** #534 (all credits + relevant/unsorted debits; irrelevant debits kept until the FY is
lodged or about 60 days, whichever is later, then shrink to per-account totals; statements and CDR
alike; composes with `assertCanonicalSource`; window, purge job and CDR mapping in the spec).

### Goal

Hold the least bank data that still gives the user everything their return needs, with
reconciliation tie-backs intact.

### What is kept, per line

| Line | Kept as |
|---|---|
| Every **credit** | full row, forever (until the tenant's normal retention) |
| Debit that is **relevant**, **worth a look**, **unsorted** (`deductibility` `undetermined`, `needs_apportionment`, `likely_deductible`), **confirmed deductible**, or **linked** to anything (a matched receipt, `claim_links`, `transaction_attributions`, `asset_id`, a refund credit's `refund_for_txn_id`, `reimbursed = 1`, a loan-interest line, any non-`payg` bucket) | full row |
| Debit that is **irrelevant**: `bucket = 'payg'` with `deductibility IN ('likely_not','confirmed_not')`, or `status = 'ignored'` (own-account transfers, card repayments), and none of the links above | full row **inside the window**, then **shrunk** |

**The window (exact).** An irrelevant debit is shrinkable when **both** hold:
1. its FY is lodged: `fy_signoff.lodged_at IS NOT NULL` or `status = 'closed_with_noa'`; and
2. it has been held at least **60 days**: `created_at <= now − 60 days`.

That is "until lodged or ~60 days, whichever is later". It also guarantees a profile change before
lodging can still re-scan every line (A4).

**Shrink.** Shrinkable rows are deleted and folded into a per-account, per-FY, per-statement
aggregate. The line's fingerprint is kept as a tombstone so a re-upload of the same statement or a
feed re-sync never resurrects it.

### Data model (next `0081_bank_line_rollups.sql`)

```sql
CREATE TABLE IF NOT EXISTS bank_line_rollups (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  statement_id TEXT,                       -- NULL for cdr_feed lines
  fy           TEXT NOT NULL,              -- '2025-26'
  direction    TEXT NOT NULL DEFAULT 'debit',
  n            INTEGER NOT NULL DEFAULT 0,
  total_cents  INTEGER NOT NULL DEFAULT 0, -- sum of amount_aud_cents of the shrunk lines
  first_date   TEXT,
  last_date    TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, account_id, statement_id, fy, direction)
);
CREATE TABLE IF NOT EXISTS bank_line_tombstones (
  user_id          TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  line_fingerprint TEXT NOT NULL,          -- sha256, no description text
  fy               TEXT NOT NULL,
  PRIMARY KEY (user_id, account_id, line_fingerprint)
);
```

Both tables → `PURGE_TABLES` + export. `schema.sql` lockstep. (SQLite treats NULL `statement_id`
as distinct in the UNIQUE; the writer upserts by explicit lookup, not `ON CONFLICT`, for the NULL
case.)

### Server

- New `src/lib/minimise.ts`:
  - `SHRINKABLE_WHERE` (one SQL predicate, the table above), exported so a unit test can assert it
    never matches a credit or a linked line.
  - `minimiseTenant(env, userId, now)`: for each lodged FY, select shrinkable ids in batches of
    500; in one D1 batch per chunk: upsert `bank_line_rollups`, insert `bank_line_tombstones`,
    delete `corrections` and `ai_edits` rows referencing those txn ids (they carry the merchant
    text being minimised), delete the `transactions` rows. Writes one `audit_log` row per
    (account, FY) with counts and totals only. Returns counts.
- **Ingest dedup honours tombstones.** Statement path: the `seen` fingerprint set loaded at
  ~`agent.ts:524` also loads `bank_line_tombstones` for the account. Feed path (~`:1815`): skip
  inserts whose `line_fingerprint` is tombstoned (pre-check in the same batch).
- **Reconciliation reads rollups.** `src/lib/statements.ts` `reconcileStatement` callers and any
  per-account sum used for statement tie-back (`queries.ts` statement listing for Accounts) add
  `bank_line_rollups.total_cents` for the statement. Report/position code needs no change: shrunk
  rows were already excluded from every countable figure (they are `likely_not`/`confirmed_not`
  payg or `ignored`).
- **Purge job.** `src/index.ts` `scheduled`, weekly `0 8 * * 1` branch: add
  `if (featureOn(env, "bank_minimisation")) await stub.minimiseBankLines(u.user_id)` beside
  `flagOldData`. Uses the existing KV-cursor paging.
- **User notice.** After a shrink, one notification: "We tidied up N everyday transactions from FY
  2025-26 that your return doesn't need. Totals per account are kept." No undo (the data is gone,
  which is the point); the notice links Settings › Your data.
- `assertCanonicalSource` (`src/lib/queries.ts`) is untouched: an account keeps exactly one money
  source, only thinner.

### CDR minimisation mapping

| CDR obligation | How Quillo meets it | Where |
|---|---|---|
| Data minimisation principle (collect only what's reasonably needed; use only for the consented purpose) | Account picker: unselected accounts are never pulled. Backfill window is the FY being prepared, capped at 24 months. Provider `class` is never used as a tax signal. Use is limited to preparing the user's own return | ADR-0003 §6.3, `src/lib/basiq.ts` |
| Privacy Safeguard 12: destroy or de-identify redundant data | Irrelevant debits become redundant once the FY is lodged and 60 days have passed; they are **deleted** (Quillo never de-identifies, so there is no de-identified CDR data to govern). Aggregates are kept because statement reconciliation still needs them | `src/lib/minimise.ts`, this area |
| Deletion record | `audit_log` row per (account, FY): counts and totals, no line content | `minimiseTenant` |
| Consent withdrawal / expiry | Withdrawal runs the PS12 delete of the connection's `cdr_feed` lines (#576, `src/lib/bank-consent.ts`); extending it to `bank_line_rollups` / `bank_line_tombstones` for the disconnected accounts is #594. Expiry stops collection only — whether it must also delete is the #524 ruling. Deletions are recorded in `cdr_audit_log` (0085) | `src/lib/bank-consent.ts`, disconnect handler |
| Tenant erasure (APP 11.2 / PS12) | `purgeTenant` covers both new tables via `PURGE_TABLES` | `src/lib/retention.ts` |
| Statement uploads (not CDR) | Same rule applied for consistency (APP 11.2) | — |

The mapping's legal reading goes to the launch map's legal ticket (#524) with the rest of the CDR
review; it doesn't block the build because the flag stays OFF until the owner flips it.

### SPA

- Settings › Your data (A11) shows "Kept: all income credits and anything that might be part of
  your return. Tidied: N everyday transactions (per-account totals kept)."
- Accounts/Bring in statement rows show the reconciliation unchanged (rollup included).

### Flag

`bank_minimisation` (new, **genuine kill-switch**; stays OFF until the owner flips it after A9's
mark-as-lodged is live, because nothing is shrinkable before a FY is lodged).

### Goldens

- **`pft10`** (new): a tenant with 40 irrelevant payg debits, 3 relevant debits, 1 worth-a-look,
  1 matched receipt, 6 credits and one statement with opening/closing balances, FY lodged 61 days
  ago. Asserts after `minimiseTenant`: exactly the 40 rows are gone; rollup `n = 40` with the right
  sum; `taxable_position_cents`, every accountant-schedule section tie-back, and the statement
  reconciliation are byte-identical to before; re-importing the same statement inserts 0 rows;
  the same tenant with the FY not lodged (or lodged 59 days ago) shrinks nothing; flag OFF
  nothing.
- Unit: `SHRINKABLE_WHERE` never matches a credit, a linked line, or a non-payg bucket.
- `npm run eval:statements` (statement reconciliation suite) green.

### Acceptance

- After a shrink, the user's position, accountant pack and statement reconciliation are
  unchanged.
- A shrunk line can't come back via re-upload or re-sync.
- No line is shrunk before its FY is lodged.

### Dependencies

A1 (`lodged_at`), A4 (`relevance = 'worth_a_look'` must exist so the predicate can exclude it).
Wave 2. Flip after A9 is live.

**Tickets:** (a) tables + `minimise.ts` + tombstone dedup + rollup reconciliation + `pft10`;
(b) cron wiring + notice + Settings › Your data copy + PS12 disconnect extension.

---

## A6 Claims step UI

**Decisions:** #535 (Claims ← Transactions review, Review, TxnDetail), #555 (worth-a-look card,
user confirms), #537 (inline why on every claim card), #533 (the only place a claim becomes the
user's).

### Goal

Step 3, **What you might claim**: a short, grouped list of claim cards built from the relevance
scan, each explaining itself, with one decision per card.

### User-visible behaviour

- Header: "What you might claim" + one line: "Based on your job as a **nurse** and your bank lines.
  You decide what's yours."
- Sections, in order:
  1. **Worth a look** (`relevance_scan` suggestions): claim card per group (title, total, line
     count, badge "Worth a look", why strip (A10), ATO occupation-guide link, matched lines
     expandable). Actions: **Claim it** (confirm; asks *"Were you paid back for this?"* (golden
     rule 1) when the rule requires it, and work-use % when the rule is an apportion rule) and
     **Not work-related** (confirmed_not).
  2. **To sort** (relevant lines still `undetermined`/`needs_apportionment`): the existing grouped
     bulk triage (`ReviewView.tsx` / grouped review), filtered to `relevance IN
     ('relevant','worth_a_look')` and the active FY.
  3. **Your claims** (confirmed): a compact list with totals per ATO label, each linking to Records.
- **All transactions** link opens today's Transactions list (unfiltered) for power users; TxnDetail
  opens as a drawer.
- **By label** view (today's `/review` roll-up) is a tab inside Claims.
- **Your sorting rules** (`Settings.tsx` "Per-user rules" section) moves here as a collapsed
  section.
- Empty state: "Nothing to look at yet. Bring in your money first." with the step-2 link.

### Data model

None.

### Server

- `GET /api/transactions/review-groups` (existing, `grouped_review_v2` kill-switch kept) gains
  `relevance=relevant,worth_a_look` and `fy=` parameters, honoured only when `relevance_scan` is
  ON.
- `GET /api/claims?source=relevance_scan&fy=` (existing `claims` resource) returns suggestions with
  rule id, guide `ato_url`, golden-rule flags (`needs_not_reimbursed`, `needs_work_use_pct`).
- Confirm uses the existing `confirmSuggestedDeduction` (`agent.ts:5645`) and existing
  batch-confirm/ignore endpoints. No new write path.

### SPA

- New `web/src/pages/Claims.tsx`; new `web/src/components/ft/ClaimCard.tsx`.
- Reuse `ReviewView.tsx`, `SortFlow.tsx`, `BulkBar.tsx`, `TxnDetail.tsx` (as a drawer).
- `Review.tsx` content mounted as the "By label" tab.
- With `ft_journey` ON: `/transactions?view=review` and `/review` redirect into `/claims` (the
  `/transactions` list route itself stays).

### Flag

`ft_journey` (page) + `relevance_scan` (worth-a-look section and filtering). With
`relevance_scan` OFF, Claims shows the To sort section over all review groups (today's behaviour,
new chrome).

### Goldens

- `pft9` covers the engine. The **e2e first-timer journey** (A14) drives: scan → worth-a-look list
  → confirm one with "not reimbursed" → position moves by that amount → dismiss one → it leaves
  the list.

### Acceptance

- A nurse with 1,200 lines sees at most a few dozen cards; nothing irrelevant is in the list.
- Every card shows the three golden rules strip and, where a guide exists, the ATO link.
- No card shows a peer benchmark or an estimated tax saving.

### Dependencies

A4, A11 shell, A12 components, A10 why strip. Wave 3.

**Tickets:** one.

---

## A7 Records step and completeness meter

**Decisions:** #435 (WFH hours + car km live in Records beside the claim), #533/#537 (completeness
meter, never a refund figure; evidence before claims), #535 (Records ← Documents, WorkMethodsCard),
#437 (Documents keeps the cascading delete; `needs_review` pill becomes a queue row).

### Goal

Step 4: for every confirmed claim, show whether its record exists, collect the facts no bank feed
can carry, and show a **completeness meter**.

### User-visible behaviour

- **Completeness meter** at the top: "Records: **6 of 8** claims have a record · **1 of 2** facts
  stated". A segmented bar, no dollar figure, no refund language.
- **Record rows**, one per confirmed claim group: status (Recorded / Needs a record), the record's
  link (receipt or document), and actions *Snap a receipt* (existing upload with the claim
  pre-linked), *Link a document*, or *It's under the record-keeping exception* (shown only for
  laundry ≤ $150 and total work claims ≤ $300, with the ATO wording and "confirm with a registered
  tax agent"; stored as an attestation on the line, `transactions.record_exception`, never as
  evidence).
- **Facts you state** (the "must ask" list):
  - **Work from home** (when `wfh` is ticked or WFH claims exist): `WorkMethodsCard` (hours-first,
    diary behind a disclosure, per the dossier F35 verifier note).
  - **Car for work** (when `car_for_work` is ticked or a platform activity exists): `CarMethodsCard`
    (cents/km and logbook).
  - **Platform fees** (when a platform activity exists): "Payouts are after fees. Your platform's
    annual summary shows the gross amount and fees." Entry is manual (gross + fees), no statement
    import (SERR import is out of scope).
- **Your documents**: today's Documents library (list, `needs_review` items as rows with a *Check
  it* action, and the cascading delete with its existing confirmation).

### Data model

WFH and car facts stay in `work_use_inputs` and `car_inputs`. One column for the record-keeping
exception attestation (next `0084_record_exception.sql`):

```sql
ALTER TABLE transactions ADD COLUMN record_exception TEXT;  -- NULL | laundry_150 | total_300 (user attestation, not evidence)
```

`schema.sql` lockstep. Position-neutral: no countable predicate reads it.

### Server

- New `GET /api/journey?fy=` (owned by A11; this area defines its `records` block):
  `{ claims_total, claims_with_record, claims_exception, facts_needed: string[], facts_done:
  string[] }`. "Has a record" = the confirmed line has a matched receipt (`matched_txn_id`), a
  `claim_links` row, or a `document_id`. Facts needed derive from the profile (A1) and existing
  claims.
- `src/agent.ts` rationale copy that says "Enter your days/week on the Dashboard" (~`:3642`
  region, `wfh` rationale) is repointed to "in Records" when `ft_journey` is ON.

### SPA

- New `web/src/pages/Records.tsx`, `web/src/components/ft/CompletenessMeter.tsx`,
  `ft/RecordRow.tsx`.
- `WorkMethodsCard` and `CarMethodsCard` mount **only** here when `ft_journey` is ON (removed from
  Dashboard/Reports mounts; Reports keeps a read-only summary linking here).
- Documents list extracted from `Documents.tsx` into `web/src/components/DocumentLibrary.tsx`.

### Flag

`ft_journey`.

### Goldens

- Unit golden for the `records` block (and that setting `record_exception` leaves
  `taxable_position_cents` unchanged): 3 confirmed claims (one with receipt, one with document,
  one bare) + `wfh` ticked with hours missing → `{ claims_total: 3, claims_with_record: 2,
  facts_needed: ['wfh_hours'], facts_done: [] }`; no money figure in the payload.
- e2e first-timer journey: entering WFH hours flips `facts_done`; the position's WFH line equals
  hours × the pack rate (existing engine).

### Acceptance

- The meter never shows a dollar amount or the word refund.
- Every confirmed claim appears exactly once with a correct record status.
- WFH and car editors exist in exactly one place in the new IA.

### Dependencies

A6 (confirmed claims), A11 (`/api/journey`, shell), A12. Wave 3.

**Tickets:** (a) Records page + meter + `records` block; (b) record-exception attestation +
platform-fee prompt (small, can merge into (a) if the ticket stays PR-sized).

---

## A8 Check step

**Decisions:** #535 (Check ← Reconcile folded as proposals + readiness + estimate-only position),
#437 (server-side proposer, one confirm per row, two-pane as fallback, FY-scope by bank line,
credits matchable, "no line this year" bucket), #434 (estimate-only position lives here), #433
(parallel obligations are not position lines), #533 (CompleteCheck pattern).

### Goal

Step 5: one review screen that finds what's wrong or missing before shipping, proposes receipt ↔
bank-line matches for one-tap confirmation, and shows the **indicative position labelled estimate
only**.

### User-visible behaviour

- **Blockers** (readiness `blocker` findings), then **Worth checking** (`review`), each as a check
  item with its fix link (today's `findingFixLink` logic from `Filing.tsx`, moved to a shared
  module and repointed to the new routes).
- **Match your receipts** (proposals): rows "Receipt: Officeworks $89.00, 3 Mar → Bank line:
  OFFICEWORKS 0423 $89.00, 4 Mar" with **Match** / **Not this one**. *Not this one* opens the
  two-pane picker (today's Reconcile UI) for that receipt. Leftovers with no plausible line show in
  a **No bank line this year** bucket with the hint "Paid in cash? The receipt is still your
  record." (substantiation, not matching).
- **Your estimate** (bottom): "Estimated taxable position: $X (estimate only, general
  information)". Shows the confirmed → tracked range (`taxable_position_confirmed_cents` →
  `taxable_position_cents`) per the dossier's standing decision. **Never a refund or tax figure.**
  `READINESS_DISCLAIMER` attached locally. Parallel obligations (BAS, PAYG instalments) appear
  only under Grow, never as position lines (#433).
- Step done when blockers = 0 and proposals = 0.

### Proposer rules (decided here as implementation, inside #437's decision)

- Candidates: receipts with `matched_txn_id IS NULL` and bank lines in the **same FY by the bank
  line's date**, any direction (credits included, so a refund receipt can match a refund credit).
- Score: the existing `reconcileScore` (now `src/lib/reconcile-proposer.ts`, amount tolerance max(50¢, 1%) at
  0.7 + date within 7 days at 0.3).
- **Propose** when best score ≥ `reconcile.propose_min_score` (pack, starting 0.85) **and** the
  best beats the runner-up by ≥ 0.15. Otherwise no proposal; the receipt stays in the two-pane
  fallback.
- **Never auto-confirm.** Every match is one user confirm (#437's confidence-gate concern).
- A dismissed pair is never proposed again.

### Data model (next `0082_reconcile_dismissals.sql`)

```sql
CREATE TABLE IF NOT EXISTS reconcile_dismissals (
  user_id    TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  line_id    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, receipt_id, line_id)
);
```

→ `PURGE_TABLES` + export. Proposals themselves are computed on read (no stored state).

Also add `taxable_position_confirmed_cents` to the readiness `position` block (computed from the
same `buildReport` with confirmed-only deductibility; the dossier §7 "one addition required").

### Server

- New `src/lib/reconcile-proposer.ts` (pure): `proposeMatches(receipts, lines, dismissals,
  cfg)`.
- `src/api.ts`: `GET /api/reconcile/proposals?fy=` and `POST /api/reconcile/proposals/dismiss`
  (`{ receipt_id, line_id }`). Confirm uses the existing `POST /api/match` (the only writer of
  `matched_txn_id`, `agent.ts` Link action).
- `src/lib/readiness.ts` `FilingReadiness.position`: add `taxable_position_confirmed_cents`
  (flag-gated; absent when OFF).
- Remove the client copy of the scorer (`Reconcile.tsx:141`) once the server proposer owns
  ordering; the two-pane fallback reads server ordering.

### SPA

- New `web/src/pages/Check.tsx`, `web/src/components/ft/CheckItem.tsx`,
  `ft/MatchProposalRow.tsx`; `web/src/lib/findingLinks.ts` (moved `findingFixLink`).
- `Reconcile.tsx` becomes the fallback picker at `/check/match?receipt=`; `/reconcile` redirects to
  `/check` when `ft_journey` is ON.

### Flag

`reconcile_proposals` (new, server endpoints + position field) and `ft_journey` (page).

### Goldens

- **`pft11`** (new): 3 receipts (exact match, near-tie between two lines, cash with no line) + a
  refund receipt and refund credit. Asserts: exactly the exact match and the refund pair are
  proposed; the near-tie is not; the cash receipt is in the no-line bucket; confirming a proposal
  sets `matched_txn_id` and produces exactly the position today's manual Link of the same pair
  produces (the proposer adds no new money behaviour; under `COUNTABLE` a matched receipt stops
  counting separately and the bank line counts); a dismissed pair isn't re-proposed; flag OFF
  byte-identical (no `taxable_position_confirmed_cents` field).
- All personas: `taxable_position_confirmed_cents` ≥ `taxable_position_cents` (fewer deductions ⇒ a
  higher taxable position; #255's invariant — asserted per persona, flag ON).

### Acceptance

- No match is ever written without a user tap.
- Check shows an estimate only after the blockers section, labelled estimate only, with the
  general-information note.
- Two-pane fallback still works for every receipt.

### Dependencies

A11 shell, A12. Server part is Wave 1; page Wave 3.

**Tickets:** (a) proposer + endpoints + dismissals + confirmed position field + `pft11`;
(b) Check page.

---

## A9 Ship it

**Decisions:** #538 (checklist in myTax section order, prefill 'check this matches', type-these-in
with copy buttons and record links, tick-off, PDF, mark as lodged → NOA → next year, lodge after
prefill, 31 Oct), #530 (self-lodge worksheet, non-customised, every figure the user's confirmed
assertion), #434 (Reports = Ship it detail view), #542 (agent hand-off later).

### Goal

Step 6: a myTax worksheet the user types in, line by line, then marks as lodged.

### User-visible behaviour

- Top: "Lodge in myTax after your prefill is ready (**usually late July**). Self-lodgers are due by
  **31 October**." Dates from the pack (`lodgement.prefill_ready_hint`,
  `lodgement.self_lodge_due`). "Quillo doesn't lodge for you, and this isn't tax advice."
- **Sections in myTax order** (pack `mytax_sections`):
  1. **Income: check this matches** (prefilled in myTax): each employer (from `salary_payg` rows and
     employer entities with no income row yet, flagged "add your income statement"), interest,
     government payments, dividends where prefilled. Each line shows Quillo's figure (or "not
     entered") and a tick *Matches myTax*.
  2. **Income: type these in** (not prefilled): business income (sole trader, from platform payouts
     and business rows), foreign income (`foreign_employment` + other foreign types, after A13's
     exclusion when ON), other income Quillo holds.
  3. **Deductions D1–D10**: one line per label with an amount, from the accountant schedule's label
     grouping (`atoReturnLabel`). Rows labelled "Work-related (confirm label)" don't appear as a
     line; they surface as a Check item (`worksheet_unlabelled`, review) until confirmed to a label.
  4. **Business and professional items** (when an ABN activity exists): income and expense totals
     per activity from the attribution engine.
  5. **Medicare and private health**: private hospital cover answer (A1) as a *you'll be asked
     this* line; no levy figure.
- Every line: label (`D5`), plain name, figure in Geist Mono, **Copy** button (copies the amount
  as `1234.56`), **See records** link (to Records / Claims filtered to that label), and a tick
  ("Done in myTax"). Ticks persist per FY in `profiles.ui_state.worksheet_ticks[fy]` (no
  localStorage, per house rule).
- **Print / save as PDF**: a print-styled view at `/ship/print` (browser print; no server PDF
  library). Same sections, ticks shown as boxes.
- **Details**: "See the full breakdown" opens Reports (the detail view), with the accountant
  schedule download for anyone taking it to an agent: "Prefer a registered tax agent? Take this
  pack to any registered agent." (No partner hand-off; #542.)
- **Mark as lodged**: "I've lodged in myTax" → date picker (default today) → confirm. Then: the app
  moves to the next FY (A1); an *After you lodge* panel asks for the **notice of assessment** when
  it arrives (the existing `noa_capture` flow, moved from Filing) and offers "Start next year's
  records" (sets a notification reminder for the next 1 July). Undo is available from the panel.

### Data model

None (A1 adds `fy_signoff.lodged_at`; ticks live in `ui_state`).

### Server

- New `src/lib/mytax-worksheet.ts`: `buildMytaxWorksheet(env, userId, fy)` →
  `{ sections: [{ key, title, lines: [{ key, label, name, amount_cents | null, kind:
  'check'|'type_in'|'answer', record_href, note? }] }], tie_back: { deductions_total_cents,
  income_type_in_total_cents } }`. Built **only** from `buildReport` and `buildAccountantSchedule`
  outputs, using their predicates, so every figure ties back. Income type → myTax item map in the
  pack (`mytax_income_items`: `salary_payg` → 1, `government_payment` → 5/6, `interest` → 10,
  `dividend` → 11, `foreign_employment` → 20, `business` → P8/business items), extending the item
  mapping already in `readiness.ts` `incomeTypeWhy`.
- `src/api.ts`: `GET /api/mytax-worksheet?fy=`.
- Readiness: `worksheet_unlabelled` (review) when any counted work-related row lacks a D-label,
  flag-gated.
- No refund, tax payable, offset or levy figure is computed or returned. The worksheet carries
  `READINESS_DISCLAIMER`.

### SPA

- New `web/src/pages/ShipIt.tsx`, `web/src/pages/ShipItPrint.tsx`,
  `web/src/components/ft/WorksheetLine.tsx` (copy via `navigator.clipboard.writeText`, with a
  select-text fallback).
- `Filing.tsx` content folds in: readiness summary (link to Check), soft sign-off becomes mark as
  lodged, NOA capture moves to the After you lodge panel. With `ft_journey` ON, `/filing` redirects
  to `/ship`.
- `Reports.tsx` stays at `/reports` and is reached from Ship it ("See the full breakdown") and from
  Grow.

### Flag

`mytax_worksheet` (new; endpoint + finding) and `ft_journey` (page).

### Goldens

- **`pft12`** (new): FT1 Jess complete (income statement, D3 uniform, D5 phone at 40%, WFH hours,
  one unlabelled work row). Asserts: sections in pack order; D-label totals equal the accountant
  schedule's per-label subtotals; the sum of deduction lines + the unlabelled amount equals
  `report` deductions; no field named or containing `refund`/`tax_payable`; the unlabelled row
  raises `worksheet_unlabelled`; flag OFF → endpoint 404 and no finding.
- Extend for an ABN tenant (FT3 Sam): business items section present with activity totals.
- e2e first-timer journey: copy → tick → mark as lodged → active FY advances → NOA panel shown.

### Acceptance

- Every amount on the worksheet ties back to `buildReport` / the accountant schedule.
- A first-timer can complete myTax using only this screen and the prefill.
- Mark as lodged moves the year forward and is undoable.

### Dependencies

A1 (lodged). A11 shell, A12. Server part Wave 1–2; page Wave 3.

**Tickets:** (a) worksheet builder + endpoint + finding + `pft12`; (b) Ship it page + print view
+ mark-as-lodged UI + Filing fold.

---

## A10 Education, Before you start, guardrails

**Decisions:** #537 (inline why: three golden rules, ATO occupation-guide links, glossary; Why?
drawer; no peer benchmarks; state info as education; guardrails), #533 (say fit up front; the
escalation ladder; newcomer content in the flow), coordinator 2026-10-03 ('You may not need to
lodge' as general info on Before you start).

### Goal

Every step explains itself without advising, and a no-account screen tells people whether Quillo
fits before they sign up.

### User-visible behaviour

- **Before you start** (public, no account, `/start`):
  - Who Quillo fits (first job, student, side hustle, newcomer), what it does (finds and organises,
    you lodge in myTax), and what it doesn't (it isn't a registered tax agent, gives general
    information only, never estimates your refund).
  - **"Not everyone has to lodge. Check with the ATO's 'Do I need to lodge?' tool."** with the ATO
    link, plus: "Even if you don't have to, lodging can get back tax your employer withheld."
    Quillo never gives its own verdict on whether the user must lodge.
  - Links: TFN, myGov, the ATO residency page.
  - Price/fit line: placeholder copy slot, filled when the pricing ticket #523 decides (not a
    build blocker; the slot renders nothing until set in the pack/config).
  - Primary action: Sign up.
- **Inline why** on claim cards and step intros: a `GoldenRules` strip ("You spent it · It's for
  earning your income · You have a record"), each rule ticking green/grey for that card (spent:
  a bank line exists; earning: the user confirmed work use; record: A7 status). Plus the ATO
  occupation-guide link (`ato_url`, A4) and `<Term>` glossary terms.
- **Why? drawer**: the step footer's *Why?* opens the Ask Quillo drawer (`ChatProvider` /
  `FloatingChat`) seeded with the step and item context. When `ask_quillo` is OFF, *Why?* shows a
  static explainer from `web/src/content/stepGuides.ts` instead.
- **State education**: one card in About you after Q3 linking the state revenue office's general
  pages (pack `state_education`), labelled "for your information; your return is federal".
- **Newcomer education** inline in About you Q1: WHM rates are applied by the ATO, temporary
  residents' foreign income, Medicare entitlement statement, DASP on departure. Text only, no
  figures.
- **Glossary additions** (`web/src/content/glossary.ts`): prefill, income statement, notice of
  assessment, tax residency, temporary resident, working holiday maker, HELP, ABN, golden rules,
  myTax, registered tax agent, record-keeping exception.

### Guardrails (tests)

- New unit test in `scripts/check-units.ts`: scans `web/src/content/*.ts`, the new `ft/`
  components' string literals and the rule-pack copy for the tax-advice denylist already used by
  the goldens (refund, "you will get", "you are entitled", "guaranteed", peer phrasing like
  "people like you") and fails on a hit.
- The Ask Quillo prompt keeps its existing general-info system rules; add the step context only.
- No surface renders `claim_suggestions.estimated_deduction_cents` as a saving.

### Server

- Rule pack: `ato_url` on occupation guides (A4 ticket b), `state_education`, `lodgement` block,
  `mytax_sections`, `mytax_income_items`, `credit_signals`, `situation_facts`. One rule-pack PR per
  owning area; push at deploy.
- `src/api.ts` `ask`: accept an optional `context: { step, item_id }` (ignored when absent, so the
  existing behaviour is byte-identical).

### SPA

- New `web/src/pages/BeforeYouStart.tsx` mounted **outside** `<Protected />` in
  `web/src/main.tsx` (beside `/sign-in/*`). The marketing landing page is not changed (outward
  marketing changes are an owner gate).
- New `web/src/components/ft/GoldenRules.tsx`, `ft/WhySheet.tsx`,
  `web/src/content/stepGuides.ts`.

### Flag

`ft_journey`.

### Goldens

- The denylist unit test. e2e journey asserts every step page renders the general-information
  footnote.

### Acceptance

- *Before you start* renders signed-out at 400px and never states whether the user must lodge.
- Every claim card shows the golden-rules strip.
- Denylist test green.

### Dependencies

A12 components; content can be written in parallel with A11. Wave 3 (content Wave 2).

**Tickets:** (a) Before you start + glossary + step guides + denylist test; (b) GoldenRules strip
+ Why? drawer wiring + state/newcomer cards.

---

## A11 IA and navigation restructure

**Decisions:** #535 (Home + 6 steps; Grow hidden until detected or switched on, never silently
auto-on; account menu; Admin unchanged; only deletion = Savings calculator), #436 (Settings →
account only), #434 (Position folded; Reports as Ship it detail), #439 (Income split; Extras +
Savings → Grow), dossier standing decision (readiness-home is the foundation; confirmed → tracked
range on Home).

### Goal

Replace the sidebar's six-stop spine and 18 destinations with **Home + 6 steps**, a Grow layer that
appears only when relevant, and an account menu. Legacy pages remain reachable through redirects so
every deep link keeps working.

### Shell

- **Desktop:** left rail with Home, the 6 numbered steps (status dot: not started / in progress /
  needs attention / done), then a **Grow** group listing only unlocked layers, then the account
  menu at the bottom (avatar: Billing, Alerts, Learn & glossary, year switcher, Settings, sign
  out). Admin/Partner items keep their existing role gating.
- **Mobile (< 768px):** step header with progress segments at the top of each step; bottom bar of
  four: **Home**, **Steps** (sheet listing the 6 with status), **Ask** (Why? drawer), **Account**.
  `scripts/check-mobile-shell.ts` updated for both shells (flag ON and OFF).
- `JourneySpine` and the old `GROUPS` nav render only when `ft_journey` is OFF.

### Home (`/`)

Three blocks, same order in every state (dossier §4): (1) **readiness hero** from
`assessFilingReadiness` ("2 to fix · 3 to check", plus the confirmed → tracked estimate when
blockers are 0, labelled estimate only), (2) **What's left**: one list of readiness findings +
open `noticed_signals` + Grow suggestions, each with a deep link, (3) a quiet **step row** with
each step's status and count. Cold state: "Nothing in for FY 2025-26 yet" + "Start with About you".
No calculators, no breakdown tables, no run-rate strip.

### `/api/journey?fy=`

Composite endpoint (one fetch for Home and the shell):
`{ steps: [{ key, status, count }], records: {...A7}, grow: { layers: [{ key, state, reason }],
suggestions: [...] }, lodging_fy, lodged: bool }`. Step status rules:

| Step | Done when |
|---|---|
| 1 About you | residency answered, occupation (or "not working") set, tick-what-applies saved |
| 2 Bring in | ≥ 1 account with lines for the FY, and no open `payroll`/`platform` signals |
| 3 Claims | no `relevant`/`worth_a_look` line left undecided for the FY |
| 4 Records | `claims_with_record + claims_exception = claims_total` and `facts_needed` all done |
| 5 Check | 0 blockers and 0 proposals |
| 6 Ship it | FY lodged |

"Needs attention" = a blocker points into that step.

### Grow layer

Layers: `property`, `investments` (Shares & investments), `business` (Business & companies),
`assets`, `integrations` (QuickBooks), `extras`, `savings`, `advisers` (Partner).

A layer is visible when **any** of:
1. the user switched it on (About you tick or the Grow switcher in the account menu); or
2. the user confirmed a detection for it ("Looks like you have rental income: add it?" → *Yes*); or
3. the tenant **already has data** in it (properties, holdings, entities other than employment,
   assets, a QBO connection, PHI rows, advisory rows, partner membership). Existing users never
   lose sight of their own data; this is the user's own prior entry, not a silent auto-on.

**Detection** (writes `noticed_signals` kinds `grow_property` / `grow_investments` /
`grow_business`, `ft_journey` ON): rent-like credits (`isRentLikeStem`), dividend credits
(registry stems / `CBA DIV`), broker deposits (the C1 capital-from-txn stems), platform payouts or
an ABN tick. Shown on Home's What's left as a suggestion card. *No* dismisses it for the FY.

**Data model (next `0083_grow_layers.sql`)**:

```sql
CREATE TABLE IF NOT EXISTS grow_layers (
  user_id    TEXT NOT NULL,
  layer      TEXT NOT NULL,              -- property | investments | business | assets | integrations | extras | savings | advisers
  state      TEXT NOT NULL,              -- on | off
  source     TEXT NOT NULL,              -- switched | detected
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, layer)
);
```

→ `PURGE_TABLES` + export. Data-presence visibility (rule 3) is computed, not stored.

**Grow pages** at `/grow/:layer`, each composed from the existing components (no rewrites):

| Layer | Composed from |
|---|---|
| Property | `Settings.tsx` Properties + Loan attribution + loan interest (`LoanInterestCard`), Income rent card, `Reports.tsx` per-property position |
| Shares & investments | `CapitalEquity`, `EssGrants`, AMMA components, dividend/distribution income, capital imports |
| Business & companies | `Settings.tsx` Entities (non-employment), Business activities, GST, BAS periods & PAYG instalments, Trust/Partnership distributions, SMSF members, Super contributions; `TradingStockCard`; entity attribution |
| Assets | `Assets.tsx` |
| Integrations | `QuickBooks.tsx` |
| Extras | `Extras.tsx` (hospital-cover fact moves to About you) |
| Savings | `Savings.tsx` **minus the compound-interest calculator** (deleted, `Savings.tsx:206-249`) |
| Advisers | `Partner.tsx` (partner-role gated as today) |

### Page-by-page migration (all 21 pages)

With `ft_journey` OFF every route behaves exactly as today. With it ON:

| # | Page (route) | New home | Route behaviour (ON) | What moves / changes |
|---|---|---|---|---|
| 1 | `Dashboard.tsx` (`/`, `/dashboard`) | **Home** | `/` renders Home; `/dashboard` → `/` | KPI cards, breakdown tables, ChecklistCard/SetupChecklist, ClaimsCard, RunRateStrip, Reports/Handoff buttons dropped from the glance (breakdowns already on Reports); WorkMethods/CarMethods → Records |
| 2 | `Onboarding.tsx` (`/onboarding`) | **1 About you** (first-run mode) | → `/about` | Questions replaced (A2); consent screen kept first |
| 3 | `Settings.tsx` (`/settings`) | **Account menu › Settings** (account only) | stays `/settings` | Keeps consent, data export, delete account, devices (ingest keys), bank connections dashboard (ADR-0003 §6.4), *Your data* (A5). People/situation → About you; carry-ins → About you; properties, loans, entities, activities, GST, BAS, trust, partnership, SMSF, super → Grow; per-user rules → Claims |
| 4 | `Accounts.tsx` (`/accounts`) | **2 Bring in** | → `/bring-in` | Body extracted to `AccountsPanel` |
| 5 | `Income.tsx` (`/income`) | **2 Bring in** ("Your income") + **Grow** | → `/bring-in#income` | Upload, manual add (first-timer types), duplicate linking, captured-not-assessable card stay; CGT, ESS, AMMA, trading stock, entity attribution, rent → Grow layers |
| 6 | `Documents.tsx` (`/documents`) | **2 Bring in** (capture) + **4 Records** (library) | → `/records#documents` | Cascade delete stays on the library; `needs_review` pill becomes a row action |
| 7 | `Transactions.tsx` (`/transactions`) | **3 Claims** (queue) + "All transactions" | `?view=review` → `/claims`; plain list route kept | — |
| 8 | `TxnDetail.tsx` (`/txn/:id`) | **3 Claims** drawer | route kept (deep links) | Opens as a drawer from Claims |
| 9 | `Review.tsx` (`/review`) | **3 Claims** "By label" tab | → `/claims?view=labels` | — |
| 10 | `Reconcile.tsx` (`/reconcile`) | **5 Check** (proposals) + fallback picker | → `/check`; picker at `/check/match` | Scorer moves server-side (A8) |
| 11 | `Reports.tsx` (`/reports`) | **6 Ship it** detail view + Grow reports | route kept | WFH/car editors removed (summary links to Records) |
| 12 | `Filing.tsx` (`/filing`) | **6 Ship it** | → `/ship` | Sign-off → mark as lodged; NOA → After you lodge panel; readiness list → Check |
| 13 | `Assets.tsx` (`/assets`) | **Grow › Assets** | → `/grow/assets` | `payg_express` hiding replaced by Grow visibility |
| 14 | `Extras.tsx` (`/extras`) | **Grow › Extras** | → `/grow/extras` | Hospital cover fact → About you |
| 15 | `Savings.tsx` (`/savings`) | **Grow › Savings** | → `/grow/savings` | Compound-interest calculator **deleted** (the only deletion) |
| 16 | `QuickBooks.tsx` (`/quickbooks`) | **Grow › Integrations** | → `/grow/integrations` | — |
| 17 | `Partner.tsx` (`/partner`) | **Grow › Advisers** | route kept (role-gated) | — |
| 18 | `Notifications.tsx` (`/notifications`) | **Account menu › Alerts** | route kept | — |
| 19 | `Billing.tsx` (`/billing`) | **Account menu › Billing** | route kept | — |
| 20 | `Glossary.tsx` (`/glossary`) | **Account menu › Learn & glossary** | route kept | Also inline `<Term>` everywhere |
| 21 | `Admin.tsx` (`/admin`) | **Admin** (admin-only) | unchanged | — |

**Deep links.** Server hrefs (`progress.ts` `next_action`, readiness fix links, notifications) are
**not** changed, so server output stays byte-identical. The SPA maps legacy hrefs to new routes
with one table, `web/src/lib/legacyRoutes.ts`, used by the redirects and by `findingLinks.ts`.

### Server

- `GET /api/journey?fy=` (new, `src/api.ts` → DO method `journey(userId, fy)` composing readiness,
  `noticed_signals`, the records block, grow visibility). Gated by `ft_journey`.
- `GET/PUT /api/grow-layers` (switch on/off).
- Grow detection added to `noticeSignals` (A3) under `ft_journey`.

### SPA

- `web/src/App.tsx`: new `FtShell` (rail + mobile bar + account menu) rendered when
  `has("ft_journey")`; existing layout otherwise.
- `web/src/main.tsx`: new routes `/about`, `/bring-in`, `/claims`, `/records`, `/check`,
  `/check/match`, `/ship`, `/ship/print`, `/grow/:layer`, public `/start`; redirects per the table
  (flag-aware `<FtRedirect>` element so OFF renders the legacy page).
- New `web/src/pages/Home.tsx`, `web/src/pages/Grow.tsx`, `web/src/lib/legacyRoutes.ts`.
- Hooks above early returns in every new page (memory: hooks-crash); the hooks lint gate covers
  them.

### Flag

`ft_journey` (new; **the redesign flag**: shell, pages, routes, Direction A theme, `/api/journey`,
Grow). Stays OFF until the owner flips it at the end of Wave 4.

### Goldens

- `scripts/check-mobile-shell.ts`: both shells.
- Unit: step-status rules and grow visibility (data-presence rule asserted for the owner's
  property-heavy shape: a tenant with 3 properties sees Grow › Property without any switch).
- e2e first-timer journey (A14) walks Home → 6 steps.

### Acceptance

- Every legacy URL resolves (redirect or same page) with the flag ON; nothing 404s.
- A first-timer with no property/investments/ABN sees no Grow items.
- The owner's tenant (property-heavy) sees Property, Assets and Integrations without switching
  anything.
- Flag OFF: SPA markup identical (snapshot of the shell).

### Dependencies

A12 (theme + components) for the visual shell; can start on structure in parallel. A1 for
`lodging_fy`. Wave 2 (shell + Home + routes + Grow), page fills in Wave 3, Settings split in Wave 4.

**Tickets:** (a) shell + routes + redirects + `/api/journey` + Home; (b) Grow layer (table,
detection, visibility, `/grow/:layer` pages, Savings calculator deletion); (c) Settings split to
account-only + carry-ins/people/rules moves (Wave 4, after A2/A6 exist).

---

## A12 Visual system

**Decisions:** #539 + [design-system.md](design-system.md) (Direction A values, three-layer
tokens, Geist + Geist Mono, Anton retired, mobile-first, rollout steps 2–4), #566 (tokenise first,
look unchanged; in progress).

### Goal

Apply Direction A over the tokenised theme, behind `ft_journey`, with a dark theme, and build the
core components once.

### Behaviour

- `data-theme` on `<html>`: `legacy` (today's values, what #566 emits as `light`) when
  `ft_journey` is OFF; `quiet-light` / `quiet-dark` when ON, chosen by the account menu's
  **Appearance: System / Light / Dark** (stored in `profiles.ui_state.theme`; System follows
  `prefers-color-scheme`).
- Light roles = design-system.md §3 table, verbatim.
- **Dark roles** (same role names, same primitives family):

| Role | Dark |
|---|---|
| `surface.page` | `#121614` |
| `surface.raised` | `#1A1F1C` |
| `surface.sunken` | `#0D100E` |
| `border.default` | `#2A302C` |
| `border.strong` | `#3A413C` |
| `text.primary` | `#ECEDE8` |
| `text.secondary` | `#A8AFA9` |
| `text.inverse` | `#0D100E` |
| `accent.default` | `#4FA383` |
| `accent.hover` | `#63B394` |
| `accent.soft` | `#1C3A2F` |
| `status.ok` | `#4FA383` |
| `status.warn` | `#E0A955` on `#2B2214` |
| `status.danger` | `#E07A68` |
| `status.info` | `#7FA6DD` |
| `focus.ring` | `#4FA383` at 50% |

  A token test asserts WCAG AA (≥ 4.5:1 for `text.primary`/`text.secondary` on every surface,
  ≥ 3:1 for accent on surfaces) for both themes; any value failing is adjusted in the ticket within
  the same hue.
- Typography, radius, spacing, elevation, motion: design-system.md §3. Geist and Geist Mono
  self-hosted (`web/public/fonts/*.woff2`, `font-display: swap`), `system-ui` fallback. Anton is
  removed from the `ft_journey` themes (kept only in `legacy` until the flag is retired).
- Charts read `chart.series.1..6` roles.

### Components (built once on the tokens, `web/src/components/ft/`)

StepHeader (progress segments + "Step n of 6"), StepFooter (Back / Why? / primary), ClaimCard,
RecordRow, CheckItem, MatchProposalRow, WorksheetLine, WhySheet, Chip (tick-what-applies),
CompletenessMeter, NoticedCard, GrowSuggestionCard, GoldenRules, GeneralInfoNote (the footnote
style on every money surface), EmptyState, Skeleton, ErrorState, PeriodEditor, AccountMenu,
FtShell rail + MobileBar. Touch targets ≥ 44px; `prefers-reduced-motion` respected; visible focus
ring.

### Files

`design/tokens.mjs` (`themes['quiet-light']`, `themes['quiet-dark']`), the CSS-variable emitter
from #566, `web/tailwind.config.js` (no change beyond #566's role mapping), `web/src/index.css`
(`@font-face`), `web/src/lib/theme.ts` (sets `data-theme`). Landing page adoption (rollout step 4)
is **not** in this spec: it's an outward marketing change and needs the owner.

### Flag

`ft_journey`.

### Goldens / tests

- Token test: both themes define every role; contrast thresholds above.
- #566's hex/raw-palette guard covers `components/ft/`.
- Flag OFF: computed colours identical to #566's baseline.

### Acceptance

- With the flag ON, the app renders Direction A in light and dark; switching is instant and
  persists.
- No component under `ft/` uses a raw hex or palette class.

### Dependencies

**#566 merged** (hard prerequisite). Wave 1 (themes + fonts + theme switch) and Wave 2 (component
library, before the step pages).

**Tickets:** (a) Direction A light + dark themes + fonts + theme switch + contrast test;
(b) component library.

---

## A13 Foreign income exclusion for non-resident periods

**Decisions:** #557 (exclude, flag-gated, from residency periods, general-info note, newcomer
golden; nudge from #550 covers it until then), #531 (M3 via the existing
`NON_ASSESSABLE_INCOME_TYPES` / `excluded_by_type` path; G11 narrow the blanket non-resident defer).

### Goal

When a person's residency period is foreign, WHM or temporary, foreign-sourced income dated in that
period is captured but **excluded from the position**, with a note.

### Rule (pack table `residency_assessability`)

| Residency value | Excluded income types (when the income's date falls in the period) |
|---|---|
| `foreign` | every foreign-sourced type (`foreign_*`, `foreign_employment`) |
| `whm` | same as `foreign` (WHMs are generally foreign residents for tax) |
| `temporary` | foreign-sourced types **except** `foreign_employment` (the ATO says temporary residents declare foreign employment income earned while a temporary resident; owner-confirmed 2026-10-03) |
| `resident`, `unsure` | none (`unsure` keeps everything in and the `residency_unsure` finding asks) |

- Person: `income.person_id`, defaulting to the self person.
- Date: `income.txn_date`. If NULL and the FY has more than one residency value for that person,
  the row **stays in** the position and a review finding `foreign_income_undated_part_year` asks
  "When did you earn this? Your residency changed during the year." (No automatic split.)
- Excluded rows surface in `excluded_by_type` with reason `non_resident_foreign` and the note:
  "Foreign income earned while you were not an Australian resident for tax purposes is generally
  not taxed in Australia, so Quillo has left it out of your estimate. This is general information;
  confirm with a registered tax agent."
- The #550 nudge `foreign_income_non_resident` is suppressed for rows the exclusion handled.
- **G11:** the blanket non-resident defer in `suggestClaims`/Find My Claims (`agent.ts` ~`:3843`,
  `:3887`) narrows: occupation suggestions for Australian employment still appear for a
  foreign/WHM/temporary period, with the caveat "Deductions against your Australian work income
  generally still apply; confirm with a registered tax agent." Other rules keep the defer.

### Data model

None beyond A1 (`situation_periods`). Pack keys `residency_assessability`.

### Server

- `src/lib/ledger-totals.ts` income reader (~`:140-155`): when the flag is ON, load rows (not the
  GROUP BY) for foreign-sourced types, evaluate each against `residencyOn(profile, txn_date)`, and
  move excluded rows into `excluded_by_type`. OFF ⇒ the existing query, byte-identical.
- `src/lib/readiness.ts`: `foreign_income_undated_part_year` finding; suppression of the #550 nudge.
- Worksheet (A9): excluded rows don't appear as type-in lines; the Foreign income section shows
  "Left out: $X while you were not a resident (see note)".

### SPA

Displays come through existing readiness/Reports/worksheet surfaces; About you Q1 already
captures the periods. No new page.

### Flag

`residency_assessability` (new; money output, kill-switch).

### Goldens

- **`pft13`** (new, flips `pft4` when ON): Lena, `whm` from 2025-11-01 to 2026-06-30, `foreign`
  before; AU wages $28k; `foreign_employment` $6k dated 2025-09 (foreign period) and $2k dated
  2026-03 (WHM period); one undated foreign dividend. Asserts with the flag ON: both foreign
  employment rows excluded (`whm` and `foreign` both exclude), the undated dividend stays in with
  `foreign_income_undated_part_year`; a `temporary` variant keeps the 2026-03 `foreign_employment`
  row in; occupation suggestions appear with the residency caveat (G11); flag OFF:
  `taxable_position_cents` byte-identical to today and `pft4` unchanged.
- All 10 personas unchanged (none sets a non-resident period; P10's foreign pension stays in for a
  resident).

### Acceptance

- Exclusion only ever applies inside a dated non-resident period, never on the binary
  `tax_residency` alone.
- Every excluded dollar is visible with the note; nothing silently disappears.

### Dependencies

A1. Wave 2.

**Tickets:** one.

---

## A14 Persona and test plan

### Persona coverage

The 10 personas and `pft1`–`pft6` stay green in every PR. New first-timer goldens, each landing in
the same PR as its mechanism:

| Golden | Area | Persona | Mechanism asserted | Flag(s) |
|---|---|---|---|---|
| `pft7` | A1 | FT2 Mia variant (part-year, two jobs, HELP) | periods, mirrors, `study_loan_passthrough`, no money change | `situation_profile` |
| `pft8` | A3 | FT1 Jess + FT3 payouts | payroll → employer, no income write, per-employer completeness, platform → business income, `income_personal` refused | `wages_payer` |
| `pft9` | A4 | FT nurse grad | bank-line occupation scan, worth-a-look override, confirm moves position exactly, re-scan on new job | `relevance_scan` |
| `pft10` | A5 | FT1 Jess, lodged FY | shrink exact set, tie-backs + statement recon byte-identical, tombstones, window | `bank_minimisation` |
| `pft11` | A8 | FT1 Jess with receipts | proposals (unique, credits), no auto-confirm, dismissals, confirmed-position field | `reconcile_proposals` |
| `pft12` | A9 | FT1 Jess complete + FT3 Sam | worksheet order, tie-back, no refund field, unlabelled finding | `mytax_worksheet` |
| `pft13` | A13 | FT4 Lena | period-based foreign exclusion, undated part-year, temporary carve-out, G11 | `residency_assessability` |

`docs/personas.md` gains the rows for each in the same PR (the first-timer table already exists;
flip the ✗ rows for wages answer, residency periods, residency-aware foreign income and study-loan
passthrough as their PRs land).

### End-to-end journey

New `scripts/e2e-first-timer.ts` (same in-memory D1 shim as `scripts/e2e-journey.ts`), added to
`npm test` after `test:e2e`. It drives one FT1 Jess year through the real server functions with
every first-timer flag ON:

1. About you answers → expected periods; re-run first-run writes 0 rows.
2. Statement import → scan, credit triage → payroll + platform signals.
3. Confirm payroll (no income), upload income statement (gross once), confirm platform.
4. Claims: confirm one worth-a-look with not-reimbursed, dismiss one.
5. Records: WFH hours entered; meter reaches complete.
6. Check: confirm the one proposal; 0 blockers; estimate shown, no refund field.
7. Ship it: worksheet ties back; mark as lodged → lodging FY advances; NOA panel.
8. Minimisation (with the clock at lodged + 61 days): exact shrink, position unchanged.

Also run with all first-timer flags OFF and assert the outputs match today's baseline (byte-
identical report and readiness for the same fixture).

### Other gates

- `scripts/check-mobile-shell.ts` both shells (A11). Denylist unit test (A10). Token contrast test
  (A12). `npm run test:schema` per migration. `npm run eval` on A4's rule-pack changes (signal,
  not a gate). `/local-ultrareview` on A3, A4, A5, A8, A9, A13 (money/ingest/report/migration).
- Live check on `wrangler dev` (`--var CLERK_ISSUER:` and `--var FEATURES:...` with the new flags)
  for each page ticket: cold load of each new route with the flag ON and OFF (memory: the #310
  hooks crash only showed on cold load).

**Tickets:** one (e2e first-timer journey + OFF-baseline comparison). Goldens ride with their
areas.

---

## A15 Sequencing

```
Wave 0 (in flight)   #566 tokenise theme
                         │
Wave 1 (parallel)    A1a profile ─┬─ A1b lodging year + mark lodged
                     A12a Direction A themes + fonts (after #566)
                     A8a reconcile proposer
                     A9a worksheet builder (independent; only A9b's mark-as-lodged UI needs A1b)
                                  │
Wave 2 (parallel)    A3a credit triage + wages (needs A1a)
                     A4a relevance scan (needs A1a)   A4b occupation content (independent)
                     A13 foreign exclusion (needs A1a)
                     A5a minimisation core (needs A1b + A4a)
                     A11a shell + routes + /api/journey + Home (needs A12a)
                     A12b component library (needs A12a)
                     A10a Before you start + glossary + denylist (content)
                                  │
Wave 3 (parallel     A2 About you (A1, A11a, A12b)      A3b Bring in page (A3a)
 page fills)         A6 Claims (A4a)                    A7 Records (A6 for confirmed claims; can start on mocks)
                     A8b Check (A8a)                    A9b Ship it (A9a, A1b)
                     A10b golden rules + Why? wiring    A11b Grow layer
                                  │
Wave 4 (finish)      A11c Settings → account-only      A5b cron + notice + PS12 disconnect
                     A14 e2e first-timer journey       docs/personas.md final pass
                     Owner flips: ft_journey + first-timer server flags; bank_minimisation last
```

**What can parallelise.** Every Wave 1 item is independent. In Wave 2 the server engines (A3a,
A4a, A13, A5a) touch different files except `src/agent.ts` ingest sites (A3a and A4a both add a
call after `stampDeductibility`): land A4a first or have the second rebase; they don't conflict
logically. A11a and A12b can run beside the engines. Wave 3 pages are independent once the shell
and components exist (A7's confirmed-claims list reads data A6 doesn't create, so it can build
against fixtures).

**Flip order (owner).** `situation_profile`, `wages_payer`, `relevance_scan`,
`reconcile_proposals`, `mytax_worksheet` can go ON as each lands (server-only effects, no new IA).
`residency_assessability` ON with A2 live (users need About you to set periods). `ft_journey` ON
once Wave 3 + A11c + A14 are green. `bank_minimisation` ON last, after a FY has been marked lodged
in prod and the notice copy is reviewed.

**Estimated tickets: 25** (A1 2, A2 1, A3 2, A4 2, A5 2, A6 1, A7 2, A8 2, A9 2, A10 2, A11 3,
A12 2, A13 1, A14 1), plus the in-flight #566.

---

## A16 Out of scope and deferred

| Item | Status | Where it's tracked |
|---|---|---|
| **Partner registered-agent hand-off and any auto-lodge** | Later effort, after guided self-lodge works end to end. Money principle when it lands: **the user pays the agent directly**; Quillo takes no fee tied to the agent service (#542). Quillo registering as a tax agent stays out (#530) | #542 (closed, out of scope), launch map #514 |
| **First-timer pricing** (free tier vs flat fee vs pay-at-lodge) | The one open commercial question. **Not a build blocker**: the *Before you start* price/fit slot renders nothing until it's decided | Launch map pricing ticket [#523](https://github.com/matchmoments-admin/quillo/issues/523) |
| **Gig platform annual-statement import (SERR)** | Out of this spec. Platform income is detected from bank payouts (A3); gross/fees are a manual Records prompt. Statement upload joins broker/registry ingest | [#456](https://github.com/matchmoments-admin/quillo/issues/456) |
| `partnership_losses` flip | Held: promised Div 35 note isn't emitted and a negative share renders no line (#444). Grow-path work | flag audit, #440 |
| `phi_tax_inputs` | Held: zero code reads, marks an owner-gated feature | epic #297 |
| s40-880 five-year spread (start-up costs deducted 100% in year one) | Standalone money bug on the founder (grow) path, with a P9 golden | [#558](https://github.com/matchmoments-admin/quillo/issues/558) |
| Div 35 deferral applied to the position | Only the nudge exists (#550); applying it is a money decision | personas-coverage.md open decision 3 |
| Property `use_status` migrated onto `situation_periods` | Table supports it; migration is grow-path / dogfood work | dogfood map #464 |
| Landing page adopting the tokens (design rollout step 4) | Outward marketing change, owner gate | design-system.md §5 |
| Multi-jurisdiction return math | Seam kept, not built (standing decision) | — |
| Partners commercial surface | Standalone, detached from this map | #441 |
| Wave 4 Part 2 (retire `ClarifyCard`) | Not needed by this spec; Claims reuses it | txn-review program |

---

## Residual questions

**None. Both were settled by the owner on 2026-10-03:**

1. **Minimisation backstop when a FY is never marked lodged:** confirmed. Treat the FY as lodged
   for minimisation purposes at the self-lodger due date + 60 days (30 December after the FY ends)
   when no `lodged_at` exists. A5 builds this as the default.
2. **Temporary residents' foreign employment income:** confirmed. Follow the ATO: other foreign
   income is excluded for foreign- and temporary-resident periods, but `foreign_employment` stays in
   for temporary residents (A13's data-driven carve-out).

---

## Appendix: migration and flag ledger

**Migrations** (numbers at time of writing; renumber in order if another lands first):

| # | File | Area | DDL | New tenant tables → `PURGE_TABLES` |
|---|---|---|---|---|
| 0078 | `0078_situation_periods.sql` | A1 | `situation_periods`; `fy_signoff.lodged_at` | `situation_periods` |
| 0079 | `0079_noticed_signals.sql` | A3 | `noticed_signals`; `transactions.payer_entity_id` + index | `noticed_signals` |
| 0080 | `0080_txn_relevance.sql` | A4 | `transactions.relevance`, `relevance_rule_id` + index; unique index on `claim_suggestions(user_id, txn_id, rule_id)` if absent | — |
| 0081 | `0081_bank_line_rollups.sql` | A5 | `bank_line_rollups`, `bank_line_tombstones` | both |
| 0082 | `0082_reconcile_dismissals.sql` | A8 | `reconcile_dismissals` | `reconcile_dismissals` |
| 0083 | `0083_grow_layers.sql` | A11 | `grow_layers` | `grow_layers` |
| 0084 | `0084_record_exception.sql` | A7 | `transactions.record_exception` | — |

All additive and apply-once; no backfills (every new column starts NULL and every new table empty),
so there is nothing destructive to sign off. The one data-deleting behaviour, A5's shrink, is a
runtime job behind a kill-switch, not a migration.

**Flags** (all new, all OFF on landing):

| Flag | Area | Kind | OFF ⇒ |
|---|---|---|---|
| `situation_profile` | A1 (+A2 writes) | server | no period endpoints, no mirrors, no `lodging_fy`, no new findings |
| `wages_payer` | A3 | server + Clarify answer | no triage writes, no *My wages* answer |
| `relevance_scan` | A4 (+A6 filtering) | server | no relevance writes, no worth-a-look |
| `bank_minimisation` | A5 | server, **kill-switch** | no shrink |
| `reconcile_proposals` | A8 | server | no proposals, no confirmed-position field |
| `mytax_worksheet` | A9 | server | endpoint 404, no `worksheet_unlabelled` |
| `residency_assessability` | A13 | server, **money**, kill-switch | income reader unchanged |
| `ft_journey` | A2, A3b, A6–A12 | SPA + `/api/journey` + Grow | legacy shell, legacy theme, legacy routes |

Kept from earlier work and reused: `first_timer_income` (ON), `ask_quillo` (Why? drawer
kill-switch), `grouped_review_v2`, `noa_capture`, `bank_feed_cdr` (OFF until the CDR legal review
#524 clears — the consent dashboard (#576) and bounded backfill (#511) shipped; Bring in falls back to statement upload).
