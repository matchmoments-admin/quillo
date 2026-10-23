# Design audit, October 2026 (everyday design principles)

> Wayfinder ticket #696 on map #692 (*Enterprise-ready for new users*). Audited 2026-10-24 against
> `main` at `a2e5216`, using the inventory in [`docs/architecture/feature-inventory.md`](../architecture/feature-inventory.md).
> Method: `/everyday-design-principles` (Don Norman). Every journey was walked with the Seven Questions
> and scored against the seven principles. The lens is a **brand-new first-time Australian taxpayer**,
> plus the richer life situations (property, novated lease, company, sole trader).

## How this was done

- **I drove the real UI.** `wrangler dev` ran locally with the prod `FEATURES` list (flag OFF, what prod
  serves today) and again with the eight journey flags added (flag ON). Playwright took screenshots at
  390px and 1280px of every SPA route, plus walkthroughs of Get set up (ON), the legacy `/onboarding`
  wizard (OFF), Connect, Review, Lodge, Grow and the transaction detail page.
  - Headless sign-in used an audit-only Clerk stub aliased in a throwaway Vite config. It was never
    committed. The Worker ran with `DEV_AUTH_BYPASS`.
- **I read the code.** Three read-only passes covered: the legacy set-up and bring-in pages; sort,
  check and file; and grow, power-user and admin. Every file:line below was checked by reading.
- **Tags.**
  - **fix**: simplify or clarify.
  - **explain**: needs a what/why Explain tooltip.
  - **cut-candidate**: meets the map's unused/complex test. Cuts need owner sign-off in #697;
    nothing is cut here.
- **Severity.**
  - **H**: blocks the task, causes errors or data loss, or misstates something for a new user.
  - **M**: slows or confuses.
  - **L**: polish.

## Shipped in this ticket (6 PRs, unmerged)

| PR | Branch | What | Findings closed |
|---|---|---|---|
| [#734](https://github.com/matchmoments-admin/quillo/pull/734) | `ux/route-not-found` | Branded "Page not found" / "Something went wrong" `errorElement`. Unknown URLs, and `/start` in prod, showed React Router's "Hey developer 👋" screen. | F1 |
| [#735](https://github.com/matchmoments-admin/quillo/pull/735) | `ux/legacy-mobile-overlaps` | The legacy shell scrolled sideways at 390px on every page. The tour card's Next sat under the chat launcher. Undo sat under the tab bar. A failed Undo was silent. | F2, F3, F4 |
| [#736](https://github.com/matchmoments-admin/quillo/pull/736) | `ux/mutation-error-feedback` | A global `MutationCache.onError` toast for any mutation that has no `onError` of its own. This closes about 30 silent failures. | F5 |
| [#738](https://github.com/matchmoments-admin/quillo/pull/738) | `ux/ft-next-step-clarity` | The cold Home hero now points at the first unfinished step, not always Get set up. A disabled Next now shows its reason. | F7, F12 |
| [#739](https://github.com/matchmoments-admin/quillo/pull/739) | `ux/plain-labels-not-slugs` | Entity kinds and person roles appear in plain words (no more `novated_lease`, `smsf`, `self`). | F10 |
| [#740](https://github.com/matchmoments-admin/quillo/pull/740) | `ux/txn-detail-honest-feedback` | "Confirm as-is" on an uncategorised line was a silent no-op. A false "you can Undo" is gone. The rent note no longer reads as advice. | F8, F15 |

## Per-journey scorecard

Scores run from 1 (fails) to 5 (good), judged from the first-timer's seat unless the row names a situation.
Columns: **D** discoverability, **S** signifiers, **M** mapping, **F** feedback, **C** constraints,
**CM** conceptual model, **E** error forgiveness. "ON" means the first-timer journey flags; "OFF" means
prod today.

| Journey | D | S | M | F | C | CM | E | One-line verdict |
|---|---|---|---|---|---|---|---|---|
| J1 Signup → set up, **ON** (`/start`, `/setup`) | 4 | 4 | 4 | 3 | 3 | 4 | 3 | Clear and calm. Problems: the consent dead end (F6), the job chip silently overwriting the typed occupation (F11), and "Not working yet" nagging forever (F13). |
| J1 Signup → set up, **OFF** (`/onboarding`) | 2 | 2 | 3 | 2 | 2 | 2 | 2 | Seven steps of schema words ("entities", `self`), the AI called "the agent", the consent dead end, and lands on FY 2026-27, not the year being lodged (F9). |
| J2a Import by statement (Connect / Accounts) | 3 | 3 | 3 | 3 | 3 | 3 | 3 | ON is focused. OFF shows QuickBooks sync to everyone, and the "Money source" picker commits on change. |
| J2b Bank feed (OFF flag) | – | – | – | – | – | – | – | Not reachable. Audit it when `bank_feed_cdr` is flipped (#596). |
| J2c Receipt photo / Documents | 3 | 3 | 3 | 2 | 3 | 3 | 2 | The "review" badge leads nowhere. Raw `source`/`status` values show on the detail page. The Delete column is clipped on a phone. |
| J2d Email forwarding | 2 | 3 | 3 | 2 | 4 | 3 | 3 | The mailbox appears only in Settings. Nothing confirms that a forwarded item arrived. |
| J3 Sort (Transactions / Needs review, OFF) | 3 | 3 | 3 | 2 | 3 | 2 | 3 | Strong bulk and undo machinery, but undo was hidden on phones (F3) and the empty state says "all caught up" with zero data. |
| J3 Review queue, **ON** (`/review`) | 4 | 3 | 3 | 3 | 3 | 3 | 3 | One list, which is good. A "By label" tab re-embeds the legacy page. Three stacked disclaimers. A dense WFH card. |
| Check: Reconcile, scan, readiness | 2 | 2 | 3 | 2 | 3 | 2 | 3 | Reconcile has its own year picker (which contradicts the global FY), no success feedback and no unlink. |
| Position: Dashboard / Reports / Home | 2 | 3 | 2 | 3 | 3 | 2 | 3 | The position appears in three places. A first-timer's Dashboard opens with WFH, car and a 9-item checklist at $0. ABN/BAS/rental blocks always show. |
| File: legacy `/filing` | 2 | 2 | 3 | 2 | 2 | 2 | 1 | Silent sign-off failure. NOA "Undo" quietly deletes carry-overs. "File" / "Handoff" / "Year-end handoff" all name one page. |
| File: Lodge in myTax, **ON** (`/lodge`) | 4 | 4 | 3 | 4 | 4 | 4 | 4 | The best surface in the app. A two-step mark-lodged with warnings. Minor: unexplained "M2" chip, "accountant schedule" jargon, duplicated myGov check. |
| J4 Ask / Guide (chat, Why?, TabGuide) | 3 | 3 | 2 | 3 | 4 | 2 | 4 | Three helpers on three endpoints. The chat launcher covered the tour (F2). Good proposal/confirm/undo model. |
| J5 Billing | 3 | 3 | 4 | 3 | 4 | 3 | 4 | Clear. The wallet is plain. |
| J6 Settings, privacy, delete | 3 | 3 | 3 | 2 | 3 | 3 | 2 | Deletes have no confirm or undo. "Switch to Australian processing" is promised but has no control (F6). "Mint key". |
| J7 Investment property | 2 | 3 | 2 | 2 | 2 | 2 | 2 | Buried in Settings (OFF). Can't see or edit the ownership % (F21). Change of use has no dates. Cost base can be entered in two places. |
| J7 Novated lease | 1 | 1 | 1 | 1 | 2 | 1 | 2 | Filed as a tax "entity" (raw slug, fixed in #739), feeds no figure, and nothing says so (F14). Car cents-per-km offered with no lease warning. |
| J7 Company director | 2 | 2 | 2 | 2 | 3 | 2 | 2 | Can't enter a director or shareholder role. Nothing says the company sits outside the personal headline. No Div 7A signpost. |
| J7 Sole trader / gig | 2 | 3 | 2 | 2 | 3 | 2 | 2 | Set-up is spread over four places. Trading stock is shown to every PAYG user. Two GST checkboxes on one screen. |
| J7 Shares / crypto / ESS | 3 | 4 | 3 | 4 | 3 | 3 | 2 | CSV import is the best power-user flow (preview, named result). Deletes have no confirm. Disposal cost base has no help. |
| J7 Trust / SMSF / partnership | 1 | 2 | 2 | 2 | 3 | 3 | 2 | Hidden behind an "Entities" title that omits them. SMSF told users to pick kind `"smsf"` (fixed in #739). |
| J7 Assets / depreciation | 2 | 2 | 3 | 2 | 3 | 2 | 1 | Div 40/43, pools, WDV and DV/PC are unexplained. One tap deletes an asset and its schedule. |
| J7 QuickBooks / Savings / Extras / Partner / Admin | 2 | 3 | 2 | 2 | 3 | 1 | 2 | Outside the tax journey. "Partner" reads as spouse. "Extras" can be mistaken for hospital cover (MLS). See the cut list. |

## Ranked findings

Tags: **fix**, **explain**, **cut**. "Shipped" names the PR that fixes it.

| # | Sev | Tag | Route | File:line | Principle | Problem → fix | Shipped |
|---|---|---|---|---|---|---|---|
| F1 | H | fix | any unknown URL; `/start` in prod | `web/src/main.tsx` (no `errorElement`) | Feedback, error forgiveness | React Router's "Unexpected Application Error! … Hey developer 👋" screen, with no way back. → Add a branded `RouteError`. | #734 |
| F2 | H | fix | every legacy page on a phone | `web/src/components/JourneySpine.tsx:108` | Affordance, signifier | The `flex-none` CTA row was 417px on a 390px screen, so the whole page scrolled sideways. → Let it wrap. | #735 |
| F3 | H | fix | `/transactions` on a phone | `web/src/components/UndoToast.tsx:42` | Error forgiveness | The Undo toast was `sticky bottom-3 z-10`, under the z-30 tab bar, so the only undo for a bulk edit was invisible. → Use BulkBar's clearance. | #735 |
| F4 | H | fix | first login, all widths | `web/src/components/Coachmarks.tsx:80` | Affordance | The tour card at `bottom-4` sat under the chat launcher (z-60), which covered **Next**. On a phone the tab bar covered its body. → Lift it above both. | #735 |
| F5 | H | fix | Settings, carry-ins, Assets, Dashboard, Filing sign-off, logbook, AI undo, … | `web/src/main.tsx:47` (`MutationCache` had only `onSuccess`); e.g. `Settings.tsx:432,589,651,724,851,941,999`, `Filing.tsx:33`, `Dashboard.tsx:163,241`, `CarMethodsCard.tsx:114` | Feedback | About 30 writes with no `onError` and no inline error: a failure looks like success. → Global error toast for mutations without their own handler. | #736 |
| F6 | H | fix | `/setup` consent (ON), `/onboarding` step 2 (OFF), Settings | `web/src/content/aboutYou.ts:116`, `Onboarding.tsx:28,170,195`, `Settings.tsx:504`; gate `App.tsx:97-107` | Constraints, conceptual model | The copy promises "switch to Australian processing", but no control exists anywhere. A user who won't consent to US processing can't pass set-up, and the first-run gate bounces every link back to it. → Ship the Bedrock switch (#641), or at least a "Use Australian processing" request path, and stop promising it until then. **Not cheap**: it touches APP-8 consent and the provider; owner call. | – |
| F7 | H | fix | `/` Home (ON) | `web/src/pages/Home.tsx:31-44` | Mapping, conceptual model | The cold hero always said "Start by checking you can get into myTax… [Get set up]", even with Get set up **Done** beneath it. → Point at the first unfinished step. | #738 |
| F8 | H | fix | `/txn/:id` | `web/src/pages/TxnDetail.tsx:68,90,418` | Feedback | "Confirm as-is" on an `unknown` line sent nothing, then navigated as if it had worked. → Disable it, with a visible reason. | #740 |
| F9 | H | fix | prod landing after `/onboarding` | `web/src/lib/activeFy.tsx:45-55` (seeds from `situation.lodging_fy`, which is returned only with `situation_profile` ON) | Conceptual model | In October 2026, a first-timer lodging FY 2025-26 lands on **FY 2026-27**, which is empty. The seed logic already exists; it's dark. → It's fixed when `situation_profile` flips (map flag order). Or return `lodging_fy` regardless of the flag; owner call, because that changes the OFF default. | – |
| F10 | H | fix | `/settings`, `/onboarding`, `/grow/business` | `SituationFields.tsx:86-91,293`, `Settings.tsx:926,1117`, `Onboarding.tsx:292,443,453` | Signifiers | Raw slugs (`novated_lease`, `smsf`, `self`, `dependent`). → Label maps. | #739 |
| F11 | M | fix | `/setup` question 5 (ON) | `web/src/lib/aboutYou.ts:211-224` | Conceptual model ("settings that secretly interact") | Typing an occupation pre-ticks "A job". Tapping that chip again silently sets occupation to "Not working yet" and the typed job is lost (seen in the confirm summary). → Show the ticked chip as "A job (Retail)" and confirm before clearing a typed occupation. | – |
| F12 | M | fix | `/setup` consent (ON) | `AboutYou.tsx:470`, `components/ft/StepFooter.tsx` | Signifiers | Next was greyed out with no reason. → `disabledReason`. | #738 |
| F13 | M | fix | Home / Review "Your occupation isn't set" | `src/lib/readiness.ts:589-590` | Feedback | Answering "Not working yet" writes an `employment=none` period but not `persons.occupation`, so the nag never clears. Journey also says set-up is Done at the same time, which contradicts it. → Treat an `employment` period of `none` as answered. Server change; a persona golden may move, so it needs its own PR. | – |
| F14 | M | explain | `/settings`, `/grow/business` (novated lease) | `Settings.tsx:227,242`, `components/CarMethodsCard.tsx` | Conceptual model | A novated lease is an "entity" that feeds no figure, and nothing says so. The car card offers cents-per-km with no lease warning (double-claim risk). → After saving, say "Quillo doesn't calculate FBT; your RFBA comes from your income statement; lease running costs aren't deductible". Warn on the car card when a lease exists. Key `novated_lease` exists. | – |
| F15 | M | fix | `/txn/:id` | `TxnDetail.tsx:437,461` | Feedback, GENERAL-INFO | "You can Undo" with no undo. "Running costs **are**" deductible stated as fact. | #740 |
| F16 | M | fix | `/filing` | `Filing.tsx:357,360` | Error forgiveness | "Undo (re-open the year)" and "Discard" delete the NOA carry-overs with no confirmation. → Name the object ("Remove the FY 2024-25 NOA record and its carry-forward losses?") and relabel the button. | – |
| F17 | M | fix | Settings, Assets, Income, Capital, ESS, Extras deletes | `components/ProfileSections.tsx:37` (`runDelete`), `Settings.tsx:670,858,889,1032,1076,1125,1177`, `Assets.tsx:88`, `Income.tsx:312`, `CapitalEquity.tsx:144,167`, `EssGrants.tsx:32` | Error forgiveness | One-tap delete with no confirm and no undo. → A named confirm in `runDelete`, plus the inline handlers; or reuse `UndoToast`. | – |
| F18 | M | fix | legacy nav | `App.tsx:36-73`, `JourneySpine.tsx:20-27`, `Coachmarks.tsx:28` | Consistency | The sidebar reads "1 Bring in, 2 Sort, 3 Check, 4 Position, **6** File" (5 · Save sits under MORE). The spine reads "Set up › … › File". "Position" goes to `/` in one and `/reports` in the other. → One numbering and one target. `check-units` pins the mobile shell, so update it in the same PR. | – |
| F19 | M | cut | `/review?view=labels` (ON) and `/review` (OFF) | `pages/Review.tsx`, `ReviewQueue.tsx` "By label" tab | Duplicate surface | The fifth review surface, embedded again inside the one-list queue. See the cut list. | – |
| F20 | M | fix | `/connect`, `/review`, `/lodge` (ON) | `ConnectPage.tsx`, `ReviewQueue.tsx`, `ShipIt.tsx:186-187` + the `FtShell` footer | Feedback (too much) | Two or three stacked "General information only" disclaimers per page teach people to skip them. → Keep the shell footer plus one contextual line. Needs an owner nod (compliance copy). | – |
| F21 | M | fix | property rows | `Settings.tsx:635-720` | Feedback, constraints | The ownership % is neither shown nor editable after adding. `property_owners` isn't read by the report. → Show "· 50% yours" and add the field to edit mode. | – |
| F22 | M | fix | `/income` | `Income.tsx:167,488` | Discoverability (noise) | The trading-stock card shows for every PAYG user, and Save gives no success feedback. → Show it only when a business activity exists. | – |
| F23 | M | fix | `/grow/business` | `Settings.tsx` AddEntity (company GST default ticked) + "GST registration" section | Conceptual model | Two GST checkboxes on one screen (company vs personal), one pre-ticked, no explanation. → Label them "This company is registered for GST" and "I'm registered for GST (as a sole trader)". | – |
| F24 | M | fix | `/` Dashboard (OFF), first-timer | `Dashboard.tsx:52-56` + WFH, car and checklist cards | Discoverability, flow | An empty user sees three $0 tiles, the WFH editor, the car editor and a 9-item checklist. → When nothing has been imported, show one "Bring in your first statement" card and collapse the rest. | – |
| F25 | M | fix | `/transactions` empty | `components/ReviewView.tsx:169`, `Transactions.tsx:269` | Feedback | With zero data: "Nothing needs review — you're all caught up" and "No transactions match these filters". → Say "No transactions yet" and link to Import. | – |
| F26 | M | fix | `/transactions` error | `components/ReviewView.tsx:117` | Conceptual model | The error copy says "This app sits behind Cloudflare Access". Sign-in is Clerk. → "You're signed out — sign in again". | – |
| F27 | M | fix | legacy `/onboarding` step 4 | `Onboarding.tsx` (person editor), `SituationFields.tsx:293` | Constraints | The self person's role select isn't locked, so the taxpayer can make themself a "spouse". → Pass `lockRole` for `role==="self"`, as Settings already does. | – |
| F28 | M | fix | legacy `/onboarding`, Settings, QuickBooks | `Onboarding.tsx` header copy, `QuickBooks.tsx:64,93` | Consistency | "The agent" means Quillo's AI here, and a registered tax agent everywhere else. → "Quillo". | – |
| F29 | M | fix | `/partner`, `/grow/advisers` | `App.tsx:84`, `growRoutes.ts:25`, `Partner.tsx:27` | Conceptual model | "Partner" is the commercial portal, but reads as spouse/partner in a tax app. Consumers get a bare "Not available." → Rename it "Referral partners" and send non-partners home. | – |
| F30 | M | explain | Assets, Income, Reports, Filing, Clarify, AttributionPanel | see the explain list | Conceptual model | Statute codes and jargon with no what/why. | – |
| F31 | L | fix | `/lodge` (ON) | `ShipIt.tsx:198-210` | Mapping | "1 thing to sort out in Review" when the blocker is "Nothing captured" (a Connect item). Two hops. → Link to the step that owns the blocker. | – |
| F32 | L | fix | Settings, Onboarding, JourneySpine, Notifications, Reconcile, Dashboard | `Settings.tsx:19` (`del`), `JourneySpine.tsx:67`, `Notifications.tsx:41`, `Reconcile.tsx:131`, `Dashboard.tsx:218,260`, legacy footer links (15px) | Affordance | Hit targets of about 16–30px on a phone. → `min-h-11 px-3`. | – |
| F33 | L | fix | `/txn/:id` | `TxnDetail.tsx:372-373,387` | Signifiers | Raw `upload` / `needs_review` / "no score". "Bucket" here but "Category" everywhere else. → Map to labels; rename the field "Category". | – |
| F34 | L | fix | `/reconcile` | `Reconcile.tsx:70-84` | Consistency | A page-local year picker contradicts the global FY. No success feedback or unlink after Link. | – |
| F35 | L | fix | `/settings` | `Settings.tsx:1005` | Signifiers | "Mint key" → "Create device key". | – |

**Top 15 by impact for a new user:** F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F13, F14, F16, F17.
F1–F5, F7, F8, F10 and F12 are fixed in this ticket's PRs. **F6, F9, F11, F13, F14, F16 and F17 are the
next fix wave.**

## Cut-candidate list (for owner sign-off in #697)

Nothing is cut here. Per the map, a cut means flagging the surface OFF first. Code deletion comes later, and
only once no persona golden needs it.

| Surface | Why it meets the test | Personas affected | What replaces it | Persona-golden impact |
|---|---|---|---|---|
| **Legacy "By label" review** (`/review` OFF; the `/review?view=labels` tab ON; `pages/Review.tsx`) | Duplicates the claim picker on Needs review and the ft one-list queue; it is the fifth review surface (inventory obs. 2). Bulk Deductible/Not deductible per label has no confirm or undo. | All, today. None need it once `ft_journey` is ON. | The ft Review queue (ON); the Needs-review tab's ClaimPicker (OFF) | **Keep the engine.** `deductibility` appears 77× in `check-personas.ts`. Cut the page and tab only. |
| **Savings page + compound-interest calculator** (`/savings`, `advisory_layer`) | No tax persona needs it. The calculator was already ruled deleted (#535) but still renders with the flag OFF. Dismiss/confirm have no error handling. | None (P1–P10, FT1–FT4) | Nothing, or one Home suggestion card | None: `advisory`/`savings` have 0 golden hits |
| **Extras / PHI tracker** (`/extras`, `phi_extras_tracker`, `phi_provider_directory`) | Outside the tax return, and the name invites confusion with hospital cover / MLS. `phi_tax_inputs` has no runtime reader. | P6, P2 (display only) | Rename it "Health extras tracker" and move it out of the tax nav, or flag it OFF | Byte-identical check only (`phi_` 2 hits) |
| **QuickBooks in the default nav** (`/quickbooks`; "Sync accounts from QuickBooks" on `/accounts`) | No new-user persona; the Sync button fails for everyone without QBO. | P5, P8 | Grow › Integrations only; show Sync only when connected | None (`qbo` 0 hits) |
| **`/partner` in the consumer namespace** | It's a staff/referral portal; consumers see "Not available." and read it as spouse. | None | A staff-only route | None |
| **WFH/car editors duplicated on Reports and RecordCards** (`Reports.tsx:157-162`) | The same editors render on Dashboard, Reports and Review; edits in one place surprise the others. | P1, P3, P5, P7, FT1 | A read-only summary with a link to the one editor | None: the engines stay (`car_logbook` 2 hits) |
| **ClarifyCard "Repeat merchants to sort"** (`components/SortFlow.tsx:60`) | With `unified_review_groups` ON it duplicates the inline group answers (Wave 4 Part 2). | All | Inline group answers | `clarify` 2 hits: check them before flagging OFF |
| **Legacy Dashboard claims card + Filing "Find my claims" duplication** (`Dashboard.tsx:230`, `Filing.tsx:254-257`) | Claims appear in two places. | All | One list on `/filing` (OFF) / `/lodge` (ON) | `claim_review` 0 hits |
| **CGT asset kind "property"** (`CapitalEquity.tsx:11`) | A second place to enter a rental's cost base; the two can disagree with Settings › Capital details. | P6, P2 | The property's Capital details | **Golden exercises the property CGT path** (`property_capital_detail`, `cgt_assets` 41 hits). Hide only the option, after confirming no golden writes `kind='property'` through it. |
| **WFH "Generate a diary"** (`WorkMethodsCard.tsx:62-114`, `wfh_generate_diary`) | Generates a diary on the same card that says estimates aren't accepted, which is self-contradictory and a compliance risk. | P1, P5, P7, FT1 | The user's own record (the "I keep a record" tick) | `wfh_generate_diary` 0 hits. **Needs an owner decision** (relabel as a draft, or cut). |

## Explain list (Explain tooltip keys)

The map says the copy moves into the rule pack per jurisdiction (what, why it matters, ATO link,
general information only). Today it lives in `web/src/content/glossary.ts`. The first-timer path renders
almost no tooltips: `AboutYou`, `ReviewQueue`, `ShipIt`, `ConnectPage` and `Home` don't use
`InfoTip`/`Term` at all. Only `BeforeYouStart` and `GoldenRules` do.

**Keys that exist but aren't wired where the term appears:**

| Key | Where it's needed |
|---|---|
| `tax_residency` | `/setup` Q1, legacy residency select |
| `mytax` | `/setup`, `/lodge` |
| `income_statement` | `/connect` "Your income statement" |
| `notice_of_assessment` | `/lodge`, `/filing` NOA |
| `help_debt` | `/setup` study-loan chip |
| `payg` | `/income` "PAYG withheld"; note the key describes the bucket, not withholding |
| `franking_credit` | Reports, Income |
| `ato_label` | Rule editor, Onboarding |
| `confidence` | Documents, TxnDetail "no score" |
| `reconcile` | `/reconcile` heading |
| `bucket` | TxnDetail |
| `novated_lease` | Car card, the novated-lease entity |
| `record_keeping_exception` | `/review` records |
| `registered_tax_agent` | Everywhere the defer line appears |

**Missing keys to add:**

| Key | Term and where it's used |
|---|---|
| `taxable_position` | "Indicative (taxable) position": Reports, Filing, Home |
| `fito` | Foreign income tax offset: Reports |
| `payg_withholding` | Tax withheld: Income, Connect |
| `wfh_fixed_rate` | The 70c/hr method: Review records, Dashboard |
| `cost_base` | Settings Capital details, CapitalEquity, Clarify |
| `cgt_discount` | The 50% discount after 12 months: CapitalEquity disposal |
| `parcel` | FIFO / specific parcel: CapitalEquity |
| `effective_life` | Assets |
| `adjustable_value` | WDV: Assets, carry-ins |
| `div40_plant` | Div 40 plant and equipment: Assets, AttributionPanel |
| `div43_capital_works` | Assets, AttributionPanel |
| `low_value_pool` | Assets |
| `dv_vs_prime_cost` | Assets method |
| `negative_gearing` | Reports per-property net |
| `div7a` | Company loans: AttributionPanel, company signpost |
| `rfba` | Reportable fringe benefits: Reports, novated lease |
| `resc` | Reportable employer super: Reports |
| `ecpi` | SMSF exempt income: Settings SMSF |
| `payg_instalment` | Grow › Business |
| `ess_taxing_point` | EssGrants |
| `amma` | Managed fund statement: Income |
| `trust_distribution_character` | Settings trust |
| `carry_ins` | Prior-year losses and opening values: Settings, set-up |
| `apportion` | Work-use %: Review, ClaimPicker, AttributionPanel (one term, three names today) |
| `mls` | The "M2" chip on `/lodge`; Medicare levy surcharge |
| `cross_border_consent` | The APP-8 consent: set-up, Settings |
| `tax_ready` | The income-statement status: Connect, Lodge |
| `myid` | `/setup` myTax check |
| `accountant_schedule` | `/lodge`, `/filing` CSV |
| `sole_trader` | Entity picker, activities |

## What works well (keep it)

- **Lodge in myTax (ON).** Worksheet sections in myTax order, "You'll be asked this" chips, a two-step
  mark-lodged with an "N lines aren't ticked" warning, and plain words throughout. It's the model for
  the rest.
- **Before you start (`/start`).** It's honest about what Quillo doesn't do, which builds trust before signup.
- **Get set up (ON).** One question per screen, "Not answered" shown on the confirm summary, "You
  can change any answer later", and fill-gaps saving that never overwrites.
- **Broker CSV import.** It has a preview, a named result, and honest warnings for unmatched sales.
- **Proposal → confirm → undo for AI edits** (`ai_edits` feed). The machine proposes, and the human decides.

## Not covered

- **The bank feed journey** (`bank_feed_cdr` OFF, sandbox only). Audit it at flag-flip time (#596).
- **Screen-reader and WCAG beyond what's noted.** The map lists this as not yet specified.
- **Admin / Security & compliance.** It's owner-only, and the read-only pass found it sound (one
  role-chip confirm, L).
