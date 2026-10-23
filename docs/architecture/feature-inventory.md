# Quillo feature and journey inventory

> Wayfinder ticket #695 on map #692 (*Enterprise-ready for new users*). Audited 2026-10-24 against
> `main` at `37117ab`. Read-only: nothing here changes behaviour. Later audits (#696 design audit,
> #699, #700) build on it. The diagram is [`journeys.html`](journeys.html).

**How to read the flag column.** "Prod" means the `FEATURES` list in `wrangler.toml` on `main`,
because `npm run deploy` ships that file. A deploy from a branch could differ, so confirm against the
live Worker before you rely on a single flag. The registry is `FEATURE_KEYS` in
`src/lib/features.ts`. The SPA sees the enabled subset through `GET /api/dashboard → features`
(`web/src/lib/features.ts:useFeatures`).

**Personas.** P1 to P10 are the contract personas in [`docs/personas.md`](../personas.md):
P1 Maya (PAYG renter), P2 Daniel (PAYG plus investments), P3 Lukas (tradie), P4 Priya (rideshare),
P5 Tom (freelancer), P6 Susan & Greg (co-owned landlords), P7 Nadia (multi-employer nurse),
P8 James (company plus trust), P9 Aisha (founder, ESS), P10 Margaret (SMSF plus crypto).
FT1 to FT4 are the first-timer cohort in [`docs/first-timer/personas-coverage.md`](../first-timer/personas-coverage.md):
FT1 Jess (first job), FT2 Mia (student), FT3 Sam (PAYG plus gig), FT4 Lena (newcomer on a WHM visa).
"All" means every persona passes through the feature.

## Counts

| What | Count | Source |
|---|---|---|
| Features (rows in the table below) | **96** | this doc |
| SPA routes | **40**: 28 protected app routes, `/start`, sign-in, sign-up, 7 old-step redirects, `/grow/:layer` (8 layers) and `/glossary` | `web/src/main.tsx` |
| SPA pages (`web/src/pages/*.tsx`) | 30 | |
| API resource groups (`/api/<resource>`) | **88** in `src/api.ts`, plus 9 Worker-level routes in `src/index.ts` | |
| Feature flags | **105** registered; **89 ON** and **16 OFF** in prod | `src/lib/features.ts`, `wrangler.toml` |
| Cron schedules | 3 | `wrangler.toml [triggers]`, `src/index.ts:scheduled` |
| External integrations | 10 | see [Integrations](#integrations) |
| D1 migrations / tables | 87 migrations (`0001`–`0087`), ~80 `CREATE TABLE` in `schema.sql` | |

**The 16 OFF flags:** `ft_journey`, `situation_profile`, `relevance_scan`, `wages_payer`,
`reconcile_proposals`, `mytax_worksheet`, `residency_assessability`, `bank_minimisation` (the eight
first-timer journey flags), `bank_feed_cdr`, `d1_backups`, `security_monitoring`,
`admin_mfa_required`, `qbo_token_fail_closed`, `receipt_image_compression`, `partnership_losses`,
`phi_tax_inputs`.

## Architecture in one paragraph

One Cloudflare Worker (`src/index.ts`) serves three hosts. `quillo.au` and `www` get the marketing page,
the waitlist, terms and privacy (`src/marketing/*`). `app.quillo.au` gets the React SPA from the
`ASSETS` binding, plus `/api/*`. Every `/api/*` call is Clerk-verified (`src/auth/clerk.ts:requireClerk`),
rate-limited (`api_rate_limit`) and dispatched by `src/api.ts:handleApi` to the tenant's own
`TaxAgent` Durable Object (`src/agent.ts`, one per tenant via `stubFor`). The DO is a **write
coordinator**. Its SQLite is unused; D1 `tax-agent-db` is the store and the scale ceiling
([ADR-0001](../adr-0001-do-write-coordinator-d1-ceiling.md)). Reads mostly go straight to D1
(`src/lib/queries.ts`), and the position is computed by pure libs (`src/lib/report.ts:buildReport` →
`src/lib/ledger-totals.ts` → the engines). Receipts and statements live in R2 `tax-agent-receipts`
(through `src/lib/r2-store.ts`). The rule pack, nonces, cron cursors and cost counters live in KV `RULES`.
The model call goes through `src/llm.ts:getLLM`. The APP-8 consent gate applies to Anthropic (US).
`assertDataResidency` applies to CDR data and requires Bedrock `au.`. The Worker also has
`email()` (Email Routing) and `scheduled()` (crons) handlers.

## Feature table

Column key: **Stop** is the journey stop. **Route** is the SPA route (pages are in `web/src/pages`).
**API** lists endpoints (`src/api.ts` unless noted). **Flags** shows each flag with its prod state.

### Set up

| # | Feature | Stop | Route / page | API | Flags (prod) | Personas | Key files |
|---|---|---|---|---|---|---|---|
| 1 | Sign up / sign in (Clerk) | Set up | `/sign-in`, `/sign-up` (Clerk widgets in `main.tsx`) | Clerk-hosted; every `/api/*` verifies the JWT | none (open signup: `CLERK_ALLOWED_USERS=""`) | All | `web/src/main.tsx`, `src/auth/clerk.ts` |
| 2 | Tenant bootstrap | Set up | (implicit, first `/api` call) | any `/api/*` → `ensureTenant` | none | All | `src/lib/situation-write.ts:ensureTenant`, KV `tenant:init:<uid>` |
| 3 | First-run gate | Set up | every protected route (`App.tsx:FirstRunGate`) | `GET /api/situation` | `ft_journey` OFF (OFF ⇒ `/onboarding`, ON ⇒ `/setup`) | All | `web/src/App.tsx` |
| 4 | Public "Before you start" | Set up | `/start` (`BeforeYouStart.tsx`, public) | `GET /api/public/before-you-start` (`index.ts`) | `ft_journey` OFF ⇒ 404 | FT1–FT4 | `src/lib/before-you-start.ts`, `web/src/content/beforeYouStart.ts` |
| 5 | Onboarding wizard (legacy) | Set up | `/onboarding` (`Onboarding.tsx`) | `situation`, `situation/draft`, `consent`, `entities`, `persons`, `properties`, `rules`, `work-use`, `progress` | none; `ft_journey` ON redirects to `/setup` | All | `web/src/pages/Onboarding.tsx` |
| 6 | APP-8 cross-border AI consent | Set up / Privacy | Onboarding, AboutYou, Settings `#privacy` | `POST /api/consent`, `POST /api/consent/withdraw`; plus legacy `POST /consent` (`index.ts`) | none; it is the `profiles.consent_xborder` column, checked in the DO before every Anthropic call | All | `src/agent.ts:recordConsent/withdrawConsent`, `src/llm.ts` |
| 7 | Get set up step (About you) | Set up | `/setup` (`Steps.tsx:SetupStep` → `AboutYou.tsx`) | `situation`, `situation-periods`, `income-activities`, `capital-losses`, `opening-depreciation`, `noa`, `education`, `ui-state` | `ft_journey` OFF, `situation_profile` OFF | FT1–FT4, P1, P7 | `web/src/pages/AboutYou.tsx`, `web/src/components/ft/*`, `src/lib/situation-profile.ts` |
| 8 | Situation profile (dated periods: residency, spouse, jobs, ABN, study loan) | Set up | `/setup` | `GET/POST /api/situation-periods`, `PATCH/DELETE /api/situation-periods/:id` | `situation_profile` OFF | FT2, FT4, P6 | `src/lib/situation-profile.ts`, migration `0078` |
| 9 | People, properties, entities, rules (situation CRUD) | Set up | `/settings` (OFF) or Grow layers (ON) | `persons`, `properties`, `entities`, `entity-roles`, `property-owners`, `loans-properties`, `rules`, `income-activities` | none | All | `src/lib/situation-write.ts`, `web/src/pages/Settings.tsx` |
| 10 | Occupation content | Set up | Onboarding, AboutYou | via `situation`; `POST /api/guide` | none | P3, P7, FT1 | `src/lib/occupations.ts`, `web/src/content/occupations.ts` |
| 11 | Carry-ins (prior capital losses, opening depreciation) | Set up | Settings / AboutYou `ProfileSections` | `capital-losses`, `opening-depreciation` | none | P2, P6, P10 | `src/lib/situation-write.ts` |
| 12 | Journey read model (Home, step dots) | Set up | `/` → `Home.tsx` (ON) | `GET /api/journey` | `ft_journey` OFF | FT1–FT4 | `src/lib/journey-read.ts`, `src/lib/journey.ts` |
| 13 | Glossary | Ask-Guide | `/glossary` | none | `ft_journey` (switches content set) | All | `web/src/content/glossary.ts` |

### Bring in

| # | Feature | Stop | Route / page | API | Flags (prod) | Personas | Key files |
|---|---|---|---|---|---|---|---|
| 14 | Accounts (bank / card / loan) | Bring in | `/accounts` (`Accounts.tsx`) | `GET/POST /api/accounts`, `PUT/DELETE /api/accounts/:id`, `…/archive`, `…/source` | none | All | `src/lib/situation-write.ts:addAccount`, `src/lib/queries.ts:assertCanonicalSource` |
| 15 | Statement upload (PDF/CSV) and parse | Bring in | `/accounts`; `/connect` (ON) | `GET/POST /api/statements`, `POST /api/statements/:id/confirm`, `DELETE /api/statements/:id` | `redact_statement_lines` ON | All | `src/agent.ts:parseStatement/confirmImport`, `src/extract.ts:extractStatement`, `src/lib/bank-parsers.ts`, `src/lib/statements.ts` |
| 16 | Bulk statement confirm | Bring in | `/accounts` | `POST /api/statements/confirm-batch` | `bulk_import` ON | All | `src/agent.ts:confirmImportBulk` |
| 17 | Categorisation (live vs Batch API) | Bring in → Sort | (background) | (inside confirm); cron `*/10` drains | `CATEGORISE_MODE=auto` var (not a flag) | All | `src/agent.ts:categoriseStatement/pollBatchJobs`, `src/lib/batch.ts`, `src/lib/features.ts:categoriseMode` |
| 18 | One canonical money source per account | Bring in | (server invariant) | statements, bank, QBO writers | none | All | `src/lib/queries.ts:assertCanonicalSource`, [ADR-0002](../adr-0002-canonical-sources.md) |
| 19 | CDR bank feed (connect, callback, select, sync) | Bring in | `/accounts`, `/connect` | `GET /api/bank/connect`, `GET /api/bank/callback` (`index.ts`, no Clerk), `bank/connections`, `bank/accounts`, `bank/sync`, `bank/sync-status` | `bank_feed_cdr` OFF; provider `BANK_FEED_PROVIDER` unset ⇒ `basiq` default; `FISKIL_ENV`/`BASIQ_ENV`=sandbox | All (FT1–FT4 first) | `src/lib/bank-provider.ts`, `fiskil.ts`, `basiq.ts`, `bank-connect.ts`, `bank-sync.ts`, `bank-feed-core.ts` |
| 20 | Bank consent dashboard, withdraw, PS12 delete, CDR history | Settings-Privacy | Settings `BankConsents` | `bank/connections`, `bank/history`, `bank/disconnect` | `bank_feed_cdr` OFF | All | `src/lib/bank-consent.ts`, `web/src/components/BankConsents.tsx`, migration `0085` |
| 21 | Consent expiry + inactive end-user deletion | Settings-Privacy | (cron, weekly) | — | `cdr_expiry_delete` ON, `cdr_inactive_user_delete` ON (both only act under `bank_feed_cdr`, OFF) | — | `src/index.ts:scheduled`, `src/lib/bank-consent.ts` |
| 22 | Receipt photo upload | Bring in | Transactions / Review / TxnDetail | `POST /api/upload`, `GET /api/receipt/:txnId` | `receipt_client_compression` ON, `receipt_image_compression` OFF | All | `src/agent.ts:ingest/ingestImages/extractAndCategorise`, `web/src/lib/compress-image.ts`, `src/lib/r2-store.ts` |
| 23 | Smart document upload (classify and route) | Bring in | `/documents` | `GET /api/documents`, `POST /api/documents/upload`, `GET …/:id/download`, `DELETE …/:id` | none | All | `src/agent.ts:classifyAndRoute/fileDocument`, `src/extract.ts:classifyDocument` |
| 24 | Email forwarding ingest | Bring in | Settings shows the mailbox | Worker `email()` handler | none | All | `src/index.ts:email`, `src/lib/email.ts`, `src/lib/db.ts:userIdFromLocalpart` |
| 25 | Signed device ingest + correction (HMAC keys) | Bring in | Settings `#devices` | `POST /ingest`, `POST /correct` (`index.ts`); `GET/POST /api/keys`, `POST /api/keys/:id/revoke` | none | power users | `src/ingest/auth.ts:verifyIngest`, `android/` |
| 26 | Income records (manual + match to bank credits) | Bring in | `/income` (`Income.tsx`); `/connect#income` (ON) | `GET/POST /api/income`, `DELETE /api/income/:id`, `income/matches`, `income/link`, `income/unlink` | `income_dedupe` ON, `refund_netting` ON | All | `src/lib/queries.ts:listIncome`, `src/agent.ts:recordIncome` |
| 27 | Income statement upload (single + multi-employer) | Bring in | `/income`, `/connect` | `POST /api/documents/upload`; `GET /api/income-statements` | `income_statement_upload` ON, `income_statement_multi` ON | P1, P3, P7, FT1–FT3 | `src/lib/income-statement.ts`, `src/lib/income-statement-wait.ts` |
| 28 | Reportable amounts (RFBA / RESC passthrough) | Position | `/reports` line | via `/api/report` | `reportable_amounts` ON | P7, P2 | `src/lib/report.ts`, `src/lib/accountant-schedule.ts` |
| 29 | First-timer income completeness | Check | readiness findings | via `filing-readiness` | `first_timer_income` ON | FT1–FT4, P1, P3, P7 | `src/lib/first-timer-signals.ts` |
| 30 | Wages / credit triage ("We noticed") | Sort | `/accounts` `NoticedPanel`, `/review` | `GET /api/noticed`, `POST /api/noticed/:id/confirm/dismiss` | `wages_payer` OFF | FT1–FT4 | `src/lib/credit-triage.ts`, `src/lib/noticed-signals.ts`, migration `0079` |
| 31 | Connect step (ft shell) | Bring in | `/connect` (`components/connect/ConnectPage.tsx`, embeds Accounts + Income) | accounts, statements, `bank/*`, `income-statements` | `ft_journey` OFF | FT1–FT4 | `web/src/components/connect/ConnectPage.tsx` |
| 32 | Non-cash business income | Bring in | `/income` | `/api/income` | `non_cash_income` ON | P4, P5 | `src/lib/ledger-totals.ts` |

### Sort

| # | Feature | Stop | Route / page | API | Flags (prod) | Personas | Key files |
|---|---|---|---|---|---|---|---|
| 33 | Transactions list + "Needs review" tab (old Inbox) | Sort | `/transactions` (`?view=review`), `/inbox` → redirect | `GET /api/transactions`, `GET/DELETE /api/transactions/:id`, `PATCH …/flags`, `POST /api/transactions/batch-delete` | none | All | `web/src/pages/Transactions.tsx`, `web/src/components/ReviewView.tsx` |
| 34 | Transaction detail editor | Sort | `/txn/:id` (`TxnDetail.tsx`) | `transactions/:id`, `correct`, `receipt/:id`, `work-use` | none | All | `web/src/pages/TxnDetail.tsx` |
| 35 | Corrections (single, batch, undo) | Sort | Review / TxnDetail / BulkBar / UndoToast | `POST /api/correct`, `correct/batch`, `correct/undo` | none | All | `src/agent.ts:applyCorrection/applyCorrectionBatch/undoCorrectionBatch` |
| 36 | Bulk edit bar | Sort | `/transactions` BulkBar | `correct/batch`, `deductibility`, `transactions/batch-delete` | `txn_bulk_edit` ON | All | `web/src/components/BulkBar.tsx` |
| 37 | Bulk confirm as-is | Sort | BulkBar | `POST /api/confirm/batch` | `bulk_confirm` ON | All | `src/agent.ts:confirmBatch` |
| 38 | Bulk "Not spend" | Sort | BulkBar | `POST /api/ignore/batch` | `bulk_ignore` ON | All | `src/agent.ts:ignoreBatch` |
| 39 | Grouped review (server groupKey) + unified groups | Sort | review list (`GroupedList`), ClarifyCard | `GET /api/transactions/review-groups` | `grouped_review_v2` ON, `unified_review_groups` ON | All | `src/lib/clarify.ts:groupKey`, `src/lib/queries.ts:listReviewGroups` |
| 40 | Inline category edit + inline claim | Sort | review rows | `correct/batch`, `deductibility` | `txn_inline_edit` ON, `inline_claim` ON | All | `web/src/components/review/*` |
| 41 | Apply to look-alikes + rule from a single edit | Sort | TxnDetail, UndoToast, SortFlow | `GET /api/transactions/:id/siblings`, `POST …/apply-to-siblings`, `POST /api/rules` | `apply_to_siblings` ON, `rule_from_action` ON | All | `src/agent.ts`, `web/src/components/UndoToast.tsx`, `SortFlow.tsx` |
| 42 | Rules engine (merchant → category) | Sort | Settings rules / ReviewQueue RulesSettings | `GET/POST /api/rules`, `PUT/DELETE /api/rules/:id` | none | All | `src/lib/rules.ts`, `src/lib/token-match.ts` |
| 43 | Clarify questions (merchant groups) | Sort | ClarifyCard | `GET /api/clarify`, `POST /api/clarify/scan`, `…/:id/answer`, `…/:id/dismiss` | `accountant_pass` ON, `clarify_direction_guard` ON | All | `src/lib/clarify.ts`, `web/src/components/ClarifyCard.tsx` |
| 44 | AI accountant pass + suggested deductions | Sort | `AccountantPassCard` | `POST /api/accountant/run`, `GET …/suggestions`, `POST …/confirm` | `accountant_pass` ON, `grouped_deductions` ON | All | `src/agent.ts:runAccountantPass`, `src/lib/queries.ts:listSuggestedDeductions` |
| 45 | Deductibility review "By label" | Check | `/review` (OFF), `/review?view=labels` (ON) | `GET /api/review/summary`, `POST /api/deductibility` | `deductibility_review` ON | All | `web/src/pages/Review.tsx`, `src/lib/deductibility.ts` |
| 46 | Relevance scan on bank lines | Sort | `/review` WorthALookCard | `GET /api/relevance`, `POST /api/relevance/confirm` | `relevance_scan` OFF | FT1–FT4 | `src/lib/relevance-scan.ts`, `relevance-scan-run.ts` |
| 47 | Personal-transfer sweep | Sort | `MovementSweepCard` | `GET /api/movements/sweep`, `POST /api/movements/apply` | none | All | `web/src/components/MovementSweepCard.tsx` |
| 48 | Record a rent credit as income | Sort | TxnDetail | `POST /api/transactions/:id/record-income` | `record_credit_income` ON | P6 | `src/agent.ts:recordTxnAsIncome` |
| 49 | Attribution (payer ≠ claimant, ownership split, activity) | Sort | TxnDetail `AttributionPanel` | `GET/PUT/DELETE /api/transactions/:id/attributions`, `income-activities` | `attribution_engine` ON, `attribution_labels` ON | P4, P5, P6, P8 | `src/lib/attribution.ts`, `attribution-write.ts`, `web/src/components/AttributionPanel.tsx` |
| 50 | Notifications / alerts | Sort | `/notifications` | `GET /api/notifications`, `POST …/:id/read` | none | All | `src/lib/queries.ts:listNotifications` |

### Check

| # | Feature | Stop | Route / page | API | Flags (prod) | Personas | Key files |
|---|---|---|---|---|---|---|---|
| 51 | Reconcile receipts ↔ bank lines (manual) | Check | `/reconcile`; `/review/match` (ON) | `GET /api/reconcile`, `POST /api/match/link`, `POST /api/match/unlink` | none | All | `web/src/pages/Reconcile.tsx`, `src/lib/queries.ts:reconcilePairs` |
| 52 | Reconcile proposer (confidence-gated matches) | Check | `/review` (ReviewQueue) | `GET /api/reconcile/proposals`, `…/dismiss`, `GET /api/reconcile/linked`, `…/linked/undo` | `reconcile_proposals` OFF | All | `src/lib/reconcile-proposer.ts`, `src/lib/receipt-link.ts` |
| 53 | Records (substantiation) + exceptions | Check | `/review` RecordCards | `GET /api/records`, `POST /api/records/exception` | `ft_journey` OFF | All | `src/lib/records.ts`, migration `0084` |
| 54 | Claim review (find-and-attach evidence) | Check | `/filing`, Dashboard `FindAndAttachSheet` | `GET /api/claim-review`, `…/match`, `…/attach`, `…/detach`, `…/draft`, `…/rules` | `claim_review` ON | All | `src/lib/claim-match.ts`, `src/lib/claimability.ts` |
| 55 | Double-check scan (over-claim / missed deductions) | Check | `/reports` ScanFindings | `GET /api/scan` | `txn_scan` ON, `txn_scan_v2` ON | All | `src/lib/scan.ts`, `web/src/components/ScanFindings.tsx` |
| 56 | Review queue (ft step 3) | Check | `/review` (`ReviewQueue.tsx`) | `review/summary`, `records`, `relevance`, `noticed`, `reconcile/proposals`, `education` | `ft_journey` OFF (+ the flags of each card type) | FT1–FT4 | `web/src/pages/ReviewQueue.tsx` |
| 57 | Filing readiness (findings + blockers) | Check / File | `/filing`, `/lodge` | `GET /api/filing-readiness` | `readiness_audit_v2` ON, `integrity_nudges` ON | All | `src/lib/filing-readiness.ts`, `src/lib/readiness.ts` |
| 58 | Checklist + claims (dashboard cards) | Check | `/` Dashboard (OFF) | `GET /api/checklist`, `POST …/generate`, `PATCH …/:id`, `GET /api/claims`, `PATCH /api/claims/:id` | none | All | `src/lib/queries.ts:listChecklist/listClaims` |
| 59 | Progress / journey spine | Check | `JourneySpine` (legacy shell) | `GET /api/progress` | `nav_progress_strip` ON | All | `src/lib/progress.ts`, `web/src/components/JourneySpine.tsx` |

### Position

| # | Feature | Stop | Route / page | API | Flags (prod) | Personas | Key files |
|---|---|---|---|---|---|---|---|
| 60 | Tax position report (indicative, never a refund) | Position | `/reports`, `/` Dashboard | `GET /api/report?fy=`, `GET /api/dashboard` | `position_confirmed_range` ON, `position_excludes_nondeductible` ON, `position_excludes_property_undetermined` ON | All | `src/lib/report.ts:buildReport`, `src/lib/ledger-totals.ts` |
| 61 | WFH fixed-rate method + generated diary | Position | `WorkMethodsCard` (Dashboard, Reports, RecordCards) | `GET/POST /api/work-use` | `wfh_car_methods` ON, `wfh_generate_diary` ON | P1, P5, P7, FT1 | `src/lib/work-use.ts`, `web/src/components/WorkMethodsCard.tsx` |
| 62 | Car cents-per-km + logbook (informational) | Position | `CarMethodsCard` | `GET/POST /api/car-use`, `GET/POST/DELETE /api/vehicle-logbooks` | `car_methods` ON, `car_logbook` ON | P3, P4, P5, P7 | `src/lib/car-logbook.ts`, migration `0040` |
| 63 | Property net + negative gearing + use status | Position | Settings `PropertySettings`; `/grow/property` | `properties`, `property-owners`, `loans-properties`, `GET /api/properties/:id/cgt` | `property_capital_detail` ON, `position_excludes_property_undetermined` ON | P6, P2 | `src/lib/report.ts`, `src/lib/cgt.ts` |
| 64 | Loan interest (evidence-first, per property) | Position | Accounts, `LoanInterestCard`, `/grow/property` | `GET /api/loans/interest`, `POST /api/loans/:accountId/interest` | `loan_interest_v2` ON | P6 | `src/lib/loan-interest.ts` |
| 65 | Depreciation (Div 40/43), asset register | Position | `/assets` (`Assets.tsx`), `/grow/assets` | `GET/POST /api/assets`, `…/:id/schedule`, `…/:id/compute`, `…/:id/dispose`, `POST /api/depreciation/rollforward` | `asset_defaults` ON, `asset_life_default` ON, `asset_class_defaults` ON, `dep_method_lock` ON | P3, P5, P6 | `src/lib/depreciation.ts`, weekly cron `rollForward` |
| 66 | CGT engine (shares, crypto, property) | Position | `/income` CapitalEquity; `/grow/investments` | `GET/POST/DELETE /api/cgt-assets`, `/api/cgt-events` | `cgt_engine` ON, `cgt_parcel_method` ON | P2, P6, P8, P9, P10 | `src/lib/cgt.ts`, `src/lib/ledger-totals.ts:cgtTotals` |
| 67 | Capital tranche (holding detail, entity scope, from-txn, income link, cost-base detail, derived position) | Position | CapitalEquity | `cgt-assets`, `cgt-events`, `income` | `capital_holding_detail`, `capital_entity_scope`, `capital_from_txn`, `capital_income_link`, `capital_cost_base_detail`, `capital_position` (all ON) | P2, P10 | `src/lib/capital.ts`, `capital-signals.ts`, migrations `0070`–`0073` |
| 68 | Broker / registry / exchange CSV import | Bring in | CapitalImport | `POST /api/capital-imports`, `GET/DELETE …/:id`, `POST …/:id/confirm` | `capital_statement_ingest` ON | P2, P10 | `src/lib/capital-import.ts`, migration `0074` |
| 69 | Managed fund (AMMA) components | Position | `/income` | `/api/income` | `mf_components` ON | P2, P10 | `src/lib/managed-fund.ts` |
| 70 | Franking gross-up | Position | `/income` | `/api/income` | `franking_gross_up` ON | P2, P10 | `src/lib/report.ts` |
| 71 | ESS (employee share scheme) | Position | `/income` EssGrants; `/grow/investments` | `GET/POST/DELETE /api/ess-grants` | `ess_engine` ON | P2, P9 | `src/lib/ess.ts` |
| 72 | Trust distributions (beneficiary side) | Position | Settings BusinessSettings; `/grow/business` | `/api/trust-distributions` | `trust_distributions` ON | P8 | `src/lib/trust.ts`, `ledger-totals.ts:trustTotals` |
| 73 | Partnership distributions (+ losses) | Position | BusinessSettings | `/api/partnership-distributions` | `partnership_distributions` ON, `partnership_losses` OFF | P5, P8 | `src/lib/ledger-totals.ts:partnershipTotals`, migration `0056` |
| 74 | Company positions + loss carry-forward | Position | Settings entities; Reports "Detailed tax positions" → "Company positions" card (per company: income, deductions, loss carried forward, director loan; kept apart from the individual position — #766). Not on Lodge: the myTax worksheet is the individual's return only | `entities`, `entity-roles`; read via `GET /api/report` `company_positions` | `company_carryforward` ON | P8, P9, P2 | `src/lib/ledger-totals.ts:companyPositions`, `web/src/pages/Reports.tsx` |
| 75 | SMSF fund position (ECPI) | Position | BusinessSettings SMSF members | `/api/smsf-members` | `smsf_engine` ON | P10 | `src/lib/smsf.ts` |
| 76 | Personal super deduction | Position | BusinessSettings Super contributions | `/api/super-contributions` | `super_deduction` ON | P5, P10 | `src/lib/report.ts` |
| 77 | Sole-trader activities (ABN, PSI status) | Position | Settings BusinessSettings | `GET/POST /api/income-activities` | `attribution_engine` ON | P4, P5, FT3 | `src/lib/situation-write.ts`, migration `0033` |
| 78 | GST registration + indicative BAS + PAYG instalments | Position | BusinessSettings | `PUT /api/gst-registered`, `/api/bas-periods`, `/api/payg-instalments` | `gst_bas` ON | P4, P5, P8 | `src/lib/gst.ts`, migration `0039` |
| 79 | Trading stock (s 70-35) | Position | Income → Trading stock card | `GET/POST /api/trading-stock` | `trading_stock` ON | Erin (TS), P5 | `src/lib/report.ts:tradingStockAdjustment`, migration `0068` |
| 80 | Residency-aware assessability | Position | AboutYou periods | (inside `report`) | `residency_assessability` OFF | FT4 | `src/lib/residency-assessability.ts` |
| 81 | Single-PAYG express surface | Position | nav hides Assets | via `situation` | `payg_express` ON | P1, FT1 | `src/lib/db.ts:getSituation` |
| 82 | Jurisdiction / currency seam | Position | (server) | — | `jurisdiction_period` ON, `currency_base` ON | — (AU only) | `src/lib/jurisdiction.ts`, `src/lib/fx.ts` |

### File

| # | Feature | Stop | Route / page | API | Flags (prod) | Personas | Key files |
|---|---|---|---|---|---|---|---|
| 83 | Filing page (legacy hand-off) | File | `/filing` (`Filing.tsx`) | `filing-readiness`, `claim-review`, `signoff`, `lodged`, `noa`, `report?format=csv/xlsx` | `ft_journey` OFF (ON ⇒ `/lodge`) | All | `web/src/pages/Filing.tsx` |
| 84 | Accountant schedule CSV + xlsx | File | `/filing`, `/reports` | `GET /api/report?format=csv`, `?format=xlsx` | `accountant_schedule` ON, `accountant_schedule_v2` ON, `accountant_xlsx` ON | All | `src/lib/accountant-schedule.ts`, `src/lib/xlsx.ts` |
| 85 | FY sign-off | File | `/filing`, `/lodge` | `GET/POST/DELETE /api/signoff` | none | All | `src/lib/fy-signoff.ts` |
| 86 | Mark as lodged | File | `/lodge` | `GET/POST/DELETE /api/lodged` | `situation_profile` OFF | FT1–FT4 | `src/lib/lodging-year.ts`, migration `0087` |
| 87 | myTax worksheet + print | File | `/lodge` (`ShipIt.tsx`), `/lodge/print` (`ShipItPrint.tsx`) | `GET /api/mytax-worksheet` | `mytax_worksheet` OFF, `ft_journey` OFF | FT1–FT4, P1, P7 | `src/lib/mytax-worksheet.ts`, rule pack `mytax_sections` |
| 88 | NOA capture + carry-forward losses | File | `/filing` NoaCloseOff, `/lodge` | `GET /api/noa`, `POST/DELETE /api/noa/:id` | `noa_capture` ON, `carryforward_position` ON | All (P2, P6, P10 carry losses) | `src/lib/noa.ts`, `src/lib/noa-store.ts` |
| 89 | Bank-data minimisation + retention summary | Settings-Privacy | Settings data-retention note | `GET /api/data-retention` | `bank_minimisation` OFF | All | `src/lib/minimise.ts`, `src/lib/retention-schedule.ts` |

### Ask-Guide, Billing, Settings-Privacy, Admin, Grow

| # | Feature | Stop | Route / page | API | Flags (prod) | Personas | Key files |
|---|---|---|---|---|---|---|---|
| 90 | Ask Quillo chat (floating) + proposed actions + navigate + AI-edits feed | Ask-Guide | `FloatingChat` (legacy shell only); Settings AI changes | `POST /api/chat`, `GET /api/chat/:session`, `GET /api/ai-edits`, `POST /api/ai-edits/apply`, `…/undo` | `ask_quillo` ON, `ask_actions` ON, `ask_actions_v2` ON, `chat_nav` ON, `ai_edit_feed` ON | All | `src/agent.ts:chatTurn`, `web/src/components/chat/*` |
| 91 | Ask (single-turn) and Why? drawer, Guide me, education | Ask-Guide | ft `WhyDrawer`; `TabGuide` | `POST /api/ask`, `POST /api/guide`, `GET /api/education` | `ask_quillo` ON, `guide_me` ON, `ft_journey` OFF (education) | All | `src/agent.ts:askQuestion/guideMe`, `src/lib/guide.ts`, `src/lib/education.ts` |
| 92 | Usage-based wallet billing (free grant, Stripe top-up, debit per call, D10 fee deduction) | Billing | `/billing` (`Billing.tsx`) | `GET /api/billing`, `POST /api/billing/topup`, `POST /api/stripe/webhook` (`index.ts`), `GET /api/usage` | `billing` ON, `quillo_fee_deduction` ON | All | `src/lib/billing.ts`, `src/lib/stripe.ts`, `src/lib/usage.ts` |
| 93 | Settings, privacy, export, delete account, UI state | Settings-Privacy | `/settings` (account-only when `ft_journey` ON) | `POST /api/consent/withdraw`, `GET /api/account/export`, `DELETE /api/account/data`, `PATCH /api/ui-state` | none | All | `src/lib/retention.ts:exportTenant/purgeTenant/PURGE_TABLES` |
| 94 | Admin (tenants, roles, spend, referrals, QBO backfill) + Security & compliance | Admin | `/admin`, `/admin/security` | `GET /api/admin/overview`, `…/tenants`, `…/spend`, `PUT …/tenants/:id/roles`, `…/referrals`, `…/qbo-token-backfill`, `GET /api/admin/security`, `POST …/security/check` | `admin_mfa_required` OFF, `security_monitoring` OFF | owner | `src/lib/roles.ts`, `src/lib/access-control.ts`, `src/lib/security-dashboard.ts` |
| 95 | Grow layers (property, investments, business, assets, integrations, extras, savings, advisers) | Grow | `/grow/:layer` (`Grow.tsx`) | `PUT /api/grow-layers` + each layer's own | `ft_journey` OFF | P2–P10 | `web/src/lib/growRoutes.ts`, `src/lib/grow.ts`, migration `0083` |
| 96 | Savings & opportunities, PHI extras, partner portal, QuickBooks | Grow | `/savings`, `/extras`, `/partner`, `/quickbooks` | `savings`, `savings/scan`, `opportunities`, `recurring-bills`, `referrals`, `phi/*` (13 routes), `partner/overview`, `qbo/*` | `advisory_layer` ON, `advisory_partners_energy` ON, `phi_extras_tracker` ON, `phi_provider_directory` ON, `phi_tax_inputs` OFF, `qbo_token_fail_closed` OFF | All (savings, PHI); P5, P8 (QBO) | `src/lib/advisory.ts`, `partners.ts`, `phi-providers.ts`, `qbo-oauth.ts`, `src/ledger/qbo.ts` |

Row 96 bundles four "grow" surfaces that sit outside the tax journey. Each is broken out in
[Integrations](#integrations) and the power-user traces.

## Coverage cross-checks

### Every SPA route

`/sign-in` 1 · `/sign-up` 1 · `/start` 4 · `/` 12/60 · `/inbox` 33 · `/transactions` 33 · `/txn/:id` 34 ·
`/dashboard` 60 · `/income` 26 · `/assets` 65 · `/documents` 23 · `/accounts` 14 · `/reconcile` 51 ·
`/notifications` 50 · `/settings` 93 · `/onboarding` 5 · `/quickbooks` 96 · `/reports` 60 ·
`/savings` 96 · `/extras` 96 · `/billing` 92 · `/filing` 83 · `/admin` 94 · `/admin/security` 94 ·
`/partner` 96 · `/setup` 7 · `/connect` 31 · `/review` 45/56 · `/review/match` 51 · `/lodge` 87 ·
`/lodge/print` 87 · `/about` `/bring-in` `/claims` `/records` `/check` `/check/match` `/ship` (old
6-step URLs → `/setup`, `/connect`, `/review`, `/review#documents`, `/review#check`, `/review/match`,
`/lodge`) · `/grow/:layer` 95 · `/glossary` 13.

How `ft_journey` changes routing (`web/src/pages/Steps.tsx:FtRedirect`, `web/src/lib/legacyRoutes.ts`):
when it is ON, legacy pages redirect to their step. `/transactions?view=review` goes to `/review`,
`/income` to `/connect#income`, `/assets` to `/grow/assets`, `/documents` to `/review#documents`,
`/accounts` to `/connect`, `/reconcile` to `/review#check`, `/onboarding` to `/setup`, `/quickbooks`
to `/grow/integrations`, `/savings` to `/grow/savings`, `/extras` to `/grow/extras`, `/filing` to
`/lodge`, and `/dashboard` to `/`. When it is OFF, step URLs fall back: `/setup` goes to `/onboarding`,
`/connect` to `/accounts`, `/lodge` to `/filing`, and `/review` renders the "By label" page in place.

### Every API resource group

`src/api.ts` resources (88), each mapped to a row above:
`account`(93) `accountant`(44) `accounts`(14) `admin`(94) `ai-edits`(90) `ask`(91) `assets`(65)
`bank`(19,20) `bas-periods`(78) `billing`(92) `capital-imports`(68) `capital-losses`(11) `car-use`(62)
`cgt-assets`(66,67) `cgt-events`(66) `chat`(90) `checklist`(58) `claim-review`(54) `claims`(58)
`clarify`(43) `confirm`(37) `consent`(6) `correct`(35) `dashboard`(60) `data-retention`(89)
`deductibility`(45) `depreciation`(65) `documents`(23) `education`(91) `entities`(9,74)
`entity-roles`(9) `ess-grants`(71) `filing-readiness`(57) `grow-layers`(95) `gst-registered`(78)
`guide`(91) `ignore`(38) `income`(26) `income-activities`(77) `income-statements`(27) `journey`(12)
`keys`(25) `loans`(64) `loans-properties`(63) `lodged`(86) `match`(51) `movements`(47)
`mytax-worksheet`(87) `noa`(88) `noticed`(30) `notifications`(50) `opening-depreciation`(11)
`opportunities`(96) `partner`(96) `partnership-distributions`(73) `payg-instalments`(78)
`persons`(9) `phi`(96) `progress`(59) `properties`(63) `property-owners`(9,63) `qbo`(96)
`receipt`(22) `reconcile`(51,52) `records`(53) `recurring-bills`(96) `referrals`(96)
`relevance`(46) `report`(60,84) `review`(45) `rules`(42) `savings`(96) `scan`(55) `signoff`(85)
`situation`(3,9) `situation-periods`(8) `smsf-members`(75) `statements`(15,16)
`super-contributions`(76) `trading-stock`(79) `transactions`(33–41,48,49)
`trust-distributions`(72) `ui-state`(93) `upload`(22) `usage`(92) `vehicle-logbooks`(62)
`work-use`(61).

Worker-level routes in `src/index.ts`: `GET /healthz`, `POST /csp-report`, the marketing routes
(`GET /`, `POST /waitlist`, `GET /terms`, `GET /privacy`; apex host only), `POST /ingest` and
`POST /correct` (row 25), `POST /consent` (row 6, device path), `POST /api/stripe/webhook` (row 92),
`GET /api/qbo/callback` (row 96), `GET /api/bank/callback` (row 19), and
`GET /api/public/before-you-start` (row 4). The Agents-SDK `/agents/*` transport is deliberately not
mounted (`src/index.ts`, review CRITICAL), although `/agents/*` is still listed in `run_worker_first`.

### Every feature flag

All 105 keys map to at least one row. Flags not named in a row above, all ON: `claim_review` (54),
`deductibility_review` (45), `guide_me` (91), `mobile_bottom_tabs` and `nav_disclosure` (legacy nav in
`App.tsx`), `api_rate_limit` (Worker gate, see Integrations), `redact_statement_lines` (15).
`phi_tax_inputs` (row 96) is OFF **and has no runtime reader**. Only `scripts/check-personas.ts`
mentions it.

### Crons

| Schedule | What runs | Flags | Code |
|---|---|---|---|
| `*/10 * * * *` | Drain `batch_jobs` (`pollBatchJobs`); daily security checks (`runScheduledSecurityChecks`, at most once a day); publish the MFA access record; one-time guarded backfills (asset reclass, recategorise, statement repair), skipped when the global daily AI ceiling is hit | `security_monitoring` OFF (checks no-op) | `src/index.ts:scheduled` |
| `0 8 * * 1` (Mon 08:00 UTC) | Weekly sweep, paged 400 tenants per tick through a KV cursor: `runProactiveScan`, `rollForward` (depreciation), `flagOldData` (retention flags, never deletes), `detectAdvisory`, `detectBenefitsReset`, `bankConsentLifecycle`, `minimiseBankLines`, `bankInactiveEndUser`, then `publishLifecycleRecord` | `advisory_layer` ON, `phi_extras_tracker` ON, `bank_feed_cdr` OFF, `bank_minimisation` OFF, `cdr_inactive_user_delete` ON | `src/index.ts:scheduled` |
| `30 16 * * *` (02:30 AEST) | D1 export → R2 `tax-agent-backups` (`d1/daily/`, `d1/monthly/`) | `d1_backups` **OFF** | `src/lib/backups.ts:runD1Backup` |

### Integrations

| Integration | Used for | Direction / entry | Gate | Key files |
|---|---|---|---|---|
| **Clerk** (US) | SPA sign-in; JWT verify on every `/api/*`; admin second-factor check | SPA ↔ Clerk; Worker → JWKS | open signup (`CLERK_ALLOWED_USERS=""` means open; non-empty is a kill-switch); still on the **DEV** instance (`CLERK_ISSUER=*.clerk.accounts.dev`); `admin_mfa_required` OFF | `src/auth/clerk.ts`, `docs/security/clerk-production-cutover.md` |
| **Stripe** (US) | Wallet top-up checkout; webhook credits the wallet | Worker → Checkout; Stripe → `POST /api/stripe/webhook` | `billing` ON | `src/lib/stripe.ts`, `src/lib/billing.ts` |
| **Anthropic** (US) | Default inference (`DEFAULT_INFERENCE_PROVIDER=anthropic`): extraction, categorisation, Batch API, chat | DO → API | APP-8 `consent_xborder=1`; spend caps (`MAX_DAILY_COST_CENTS*`, `MAX_MONTHLY_COST_CENTS_GLOBAL`); wallet balance when `billing` is ON | `src/llm.ts`, `src/extract.ts`, `src/lib/batch.ts` |
| **AWS Bedrock** (`ap-southeast-2`, `au.` profile) | Per-tenant AU-resident inference (`profiles.inference_provider='bedrock'`); required for CDR data | DO → Bedrock (SigV4) | `assertDataResidency` fails closed; no consent needed | `src/llm.ts`, `src/lib/sigv4.ts` |
| **Fiskil / Basiq** (CDR) | Bank feeds | DO → aggregator; aggregator → `GET /api/bank/callback` | `bank_feed_cdr` OFF; `BANK_FEED_PROVIDER` unset ⇒ `basiq`; both in sandbox | `src/lib/bank-provider.ts`, `fiskil.ts`, `basiq.ts`, `docs/bank-feed-golive-checklist.md` |
| **QuickBooks Online** (Intuit) | Reader / reconciler, push a txn, sync accounts | OAuth `GET /api/qbo/connect` → `GET /api/qbo/callback`; DO → QBO API | no flag; `qbo_token_fail_closed` OFF (plaintext fallback if `QBO_TOKEN_KEY` is unset) | `src/lib/qbo-oauth.ts`, `src/ledger/qbo.ts`, `src/lib/token-crypto.ts` |
| **Cloudflare Email Routing** | Forwarded receipts, payslips and statements | Email → Worker `email()` | mailbox localpart → `tenants.email_localpart` | `src/index.ts:email`, `src/lib/email.ts` |
| **R2** | `RECEIPTS` (`tax-agent-receipts`): originals, statement sidecars (gzipped), documents. `BACKUPS` (`tax-agent-backups`): D1 exports. Cloudflare Images binding (`IMAGES`) for server-side compression | DO / Worker | `receipt_image_compression` OFF, `d1_backups` OFF | `src/lib/r2-store.ts`, `src/lib/backups.ts` |
| **KV `RULES`** | Rule pack `rulepack:au-v1` (wins key by key over the bundle), tenant-init markers, `/ingest` nonces, cron cursor, cost counters, chat rate counters, bank connect state, security source records | Worker / DO | push with `npm run rulepack:push` | `src/lib/rulepack.ts`, `src/rulepacks/au-v1.json` |
| **D1 backup** (Cloudflare D1 REST export) | Daily export | cron → D1 API → R2 | `d1_backups` OFF | `src/lib/backups.ts`, `docs/security/backup-dr.md` |
| Others | Geoapify Places (PHI provider directory, KV-cached); GitHub API (security-alert counts on the Security page); Workers Rate Limiting (`API_IP_RATE_LIMITER` 600/min, `API_USER_RATE_LIMITER` 300/min) | | `phi_provider_directory` ON, `security_monitoring` OFF, `api_rate_limit` ON | `src/lib/phi-providers.ts`, `src/lib/security-dashboard.ts` |

## Journey traces

Format: page → endpoint → DO method / lib → storage → external. Steps are what runs in prod today
unless they are marked **(OFF)**.

### J1. Signup → first-timer journey

1. The visitor opens `app.quillo.au` → `main.tsx` `Protected` → Clerk `<SignUp>` (`/sign-up`).
2. The first `/api` call goes through `index.ts`: `ipRateLimit` (`api_rate_limit`) → `requireClerk`
   (JWKS, `azp`, allow-list empty so access is open; the founder sub maps to tenant `me`) → `userRateLimit`
   → `stubFor(userId)`.
3. `handleApi` → `ensureTenant` → D1 `profiles` and `persons` (self) → KV `tenant:init:<uid>`.
4. `App.tsx:FirstRunGate` reads `GET /api/situation`. A tenant with no consent and no entities goes to
   `/onboarding` (OFF) or `/setup` (ON).
5. **Legacy (prod today):** the `/onboarding` wizard runs `POST /api/situation/draft` (AI drafting of
   entities), then `POST /api/consent` → `TaxAgent.recordConsent` (`profiles.consent_xborder=1`,
   `audit_log`), then people, properties, rules and work-use → the Dashboard at `/`.
6. **(OFF) `ft_journey`:** `/start` (public `BeforeYouStart`) → sign-up → `/setup` (`AboutYou`: myTax
   access check, consent, employers, situation periods under `situation_profile`) → `/connect`
   (statement or bank feed, income statement shown as waiting) → `/review` (one card queue) →
   `/lodge` (myTax worksheet, mark lodged). Home (`/`) reads `GET /api/journey`
   (`journey-read.ts:readJourney`).
7. The flags turn on one per PR, in spec §A15 order: `ft_journey`, `situation_profile`,
   `relevance_scan`, `wages_payer`, `reconcile_proposals`, `mytax_worksheet`,
   `residency_assessability`, `bank_minimisation`.

### J2a. Import by statement upload

1. `/accounts` (or `/connect`): add an account → `POST /api/accounts`.
2. Upload a PDF or CSV → `POST /api/statements` → `TaxAgent.parseStatement`: `assertCanonicalSource(…,
   "statement")`, `withinBudget`, dedupe on `statements.file_hash`.
3. Original → R2 `RECEIPTS` (`putStatementOriginal`). `extract.ts:extractStatement` (PDF, chunked) or
   `extractColumnMap` (CSV) → Anthropic or Bedrock. Lines sidecar → R2 (gzipped). Row → D1 `statements`.
4. The user confirms → `POST /api/statements/:id/confirm` (or `confirm-batch`, `bulk_import`) →
   `confirmImport` → D1 `transactions` (`redact_statement_lines` cleans merchant text).
5. `categoriseStatement`: consent gate, then `categoriseMode`. Live path: 40-line `extractBatch`
   chunks. Batch path (over 60 lines): Anthropic Message Batches → D1 `batch_jobs`.
6. Cron `*/10` → `pollBatchJobs` → applies results to `transactions` → the Needs-review queue.

### J2b. Import by bank feed **(OFF: `bank_feed_cdr`)**

1. `/accounts` or `/connect` → `GET /api/bank/connect` → `bankConnectUrl` → `bank-provider.ts`
   (Basiq default, Fiskil when `BANK_FEED_PROVIDER=fiskil`) → `createUser` → KV connect state → the
   aggregator's hosted consent.
2. Aggregator → `GET /api/bank/callback` (`index.ts`, no Clerk; tenant from KV state) → `bankCallback`
   → D1 `bank_connections`, `bank_connection_accounts`.
3. `POST /api/bank/accounts` → `bankSelectAccounts` → `assertCanonicalSource(…, "cdr_feed")`.
4. `POST /api/bank/sync` → `bank-sync.ts` resumable runs (`bank_sync_runs`) → `fetchTransactionPage` →
   `categoriseFeedLines`. **`assertDataResidency` requires Bedrock `au.` for production CDR data.**
5. After import, `afterLinesImported` runs credit triage (`wages_payer`, OFF) and the relevance scan
   (`relevance_scan`, OFF).
6. The weekly cron runs the consent lifecycle (expiry ⇒ PS12 delete with `cdr_expiry_delete`) and
   deletes inactive end users.

### J2c. Import by receipt photo

1. Review row, TxnDetail or Documents → the SPA compresses the image (`compress-image.ts`,
   `receipt_client_compression` ON; longest edge 2000px, EXIF dropped).
2. `POST /api/upload` → `TaxAgent.ingest/ingestImages` → dedupe on `image_hash` →
   `r2-store.ts:maybeCompressImage` (`receipt_image_compression` OFF) → R2.
3. D1 `transactions` row (`source='receipt'`) → `extractAndCategorise` → `extract.ts:extractReceipt` →
   the model.
4. Documents path: `POST /api/documents/upload` → `classifyAndRoute` → `classifyDocument`, then route
   by type: receipt or invoice ⇒ transaction; income statement ⇒ `decomposeIncomeStatement`; payslip
   ⇒ `recordIncome`; NOA ⇒ draft `fy_carryovers`.
5. Matching to a bank line: manual `/reconcile` → `POST /api/match/link`; proposer (OFF:
   `reconcile_proposals`).

### J2d. Import by email forwarding

1. The user forwards to their Quillo mailbox → Cloudflare Email Routing → `index.ts:email()`.
2. `parseEmail` → `userIdFromLocalpart` (strips `receipts+`, looks up `tenants.email_localpart`).
   Unknown mailboxes are dropped and only a hashed tag is logged.
3. No attachment ⇒ `stub.ingestText(…, "email", text)`. Each attachment ⇒
   `classifyAndRoute(…, "email", bytes, mime)` → same as J2c step 4.

### J3. Review → position → lodge

1. Sort: `/transactions?view=review` (`/inbox` redirects here) → `GET /api/transactions?review=1`,
   `GET /api/transactions/review-groups` (`grouped_review_v2`).
2. Resolve: inline edit or claim → `POST /api/correct/batch` and `POST /api/deductibility`; BulkBar →
   `confirm/batch`, `ignore/batch`; ClarifyCard → `clarify/:id/answer`; rule → `POST /api/rules`;
   undo → `correct/undo`. Every write is audited (`audit_log`) through the DO.
3. Accountant pass: `POST /api/accountant/run` → suggested deductions → `accountant/confirm`.
4. Check: `/review` "By label" (`review/summary`); `/reconcile`; `GET /api/scan` (double-check) on
   `/reports`.
5. Position: `GET /api/report?fy=` → `report.ts:buildReport` → `ledger-totals.ts` engines → indicative
   `taxable_position_cents` as a confirmed→tracked range. No refund figure, GENERAL-INFO framing.
6. Readiness: `GET /api/filing-readiness` → `computeFilingReadiness`.
7. File (legacy, prod): `/filing` → claim review → sign-off (`POST /api/signoff`) → download the
   accountant schedule (`report?format=csv` or `xlsx`) → NOA upload closes the year (`noa_capture`) →
   carry-forward losses (`carryforward_position`).
8. **(OFF)** `/lodge`: Tax-ready gate → `GET /api/mytax-worksheet` (sections in myTax order) →
   `/lodge/print` → `POST /api/lodged` (`fy_signoff.lodged_at`, `situation_profile`) → the 5-year
   retention clock starts from the lodge date.

### J4. Ask / Guide

1. Legacy shell: `FloatingChat` → `POST /api/chat` → `TaxAgent.chatTurn`. ft shell **(OFF)**: `WhyDrawer`
   → `POST /api/ask` → `askQuestion` with `{step, item_id}` context.
2. `TabGuide` → `POST /api/guide` → `guideMe` → `buildGuidePrompt` → `extractGuide`.
3. Gates in order: Worker rate limit → `chatRateOk` (12 per minute, 300 per day, KV) → `withinBudget`
   (daily and monthly $ caps, plus a positive wallet when `billing` is ON) → consent → `redact(q)` →
   `getLLM`.
4. The model may propose actions (`ask_actions`, `ask_actions_v2`) or navigation (`chat_nav`). It never
   executes them: the user confirms a card → `POST /api/ai-edits/apply`, `deductibility`,
   `correct/batch` or `rules` → `ai_edits` + `audit_log` → undo through `POST /api/ai-edits/undo`.

### J5. Billing top-up

1. `/billing` → `GET /api/billing` → `grantSignupCredits` (`INSERT OR IGNORE` into `credit_ledger`
   kind `grant`, `FREE_CREDIT_GRANT_CENTS=500`) → `getBillingOverview`.
2. Top up → `POST /api/billing/topup` → `stripe.ts:createTopupCheckout` (metadata `user_id`,
   `credit_e4`) → Stripe Checkout.
3. Stripe → `POST /api/stripe/webhook` (`index.ts`, signature verified, 503 if unconfigured) →
   `checkout.session.completed` + `paid` → `creditWallet(…, "topup", session.id)` (idempotent on
   `credit_ledger UNIQUE(user_id, ref)`).
4. `quillo_fee_deduction` ⇒ `recordFeeDeduction` writes a D10 "cost of managing tax affairs"
   transaction.
5. Every model call → `usage.ts:recordUsage` → debit `credit_balance_e4` by cost × `USD_TO_AUD_RATE`
   (1.55) × (1 + `COST_MARKUP_PCT` 30%) in the same D1 batch. With a zero balance, AI work is refused
   (receipts queue as needs-review).

### J6. Settings, privacy, consent, delete account

1. `/settings#privacy` → `POST /api/consent/withdraw` → `withdrawConsent` (`consent_xborder=0`,
   audit). Further Anthropic calls throw `consent_required`. Bedrock tenants are unaffected.
2. Export → `GET /api/account/export` → `retention.ts:exportTenant` (secrets redacted) → JSON download.
3. Delete → `DELETE /api/account/data` → `purgeTenant`, in order: aggregator `deleteUser` (fail-closed)
   → QBO revoke (best-effort) → R2 `<uid>/` prefix → KV tenant keys and cost keys → one D1 batch over
   `PURGE_TABLES` → an empty profile is re-created. `audit_log` is kept.
4. Bank consents (OFF) → `POST /api/bank/disconnect` → revoke + PS12 delete of the `cdr_feed` lines.
5. Devices → `POST /api/keys/:id/revoke`. AI-changes feed → undo.
6. Retention: the weekly cron flags (never deletes) records older than 5 years from the lodge date.
   Bank minimisation (OFF) shrinks irrelevant debits to per-account totals.

### J7. Legacy power-user features

| Feature | Trace (prod) |
|---|---|
| **CGT / capital** | `/income` CapitalEquity (or `/grow/investments`) → `POST /api/cgt-assets` (units, owner, entity, brokerage) → `POST /api/cgt-events` (disposal, parcel method) — or a broker CSV via `POST /api/capital-imports` → confirm → `cgtTotals` → `cgt.ts` (50% discount, loss offset, carry-in `capital_losses`) → `report.ts` net capital gain; `capital_position` derives units/cost base remaining; findings for over-disposal / no cost base; accountant schedule closing holdings. |
| **Property** | Settings `PropertySettings` → `POST /api/properties` (use_status, ownership_pct, cost base) + `property-owners` + `loans-properties` → rent via `income` (`record-income` on a credit) → expenses bucketed `property` + attribution split → `loans/interest` evidence → `report.ts` per-property net / negative gearing; deny-by-default when use_status isn't rented; CGT on sale `GET /api/properties/:id/cgt`. |
| **Company** | Settings entities `kind='company'` + `entity-roles` → attributions with `entity_id` → `companyPositions` (income, deductions, loss carry-forward derived, shareholder-loan balance) → shown separately in Reports; never in the individual headline. |
| **Trust** | BusinessSettings → `POST /api/trust-distributions` (share, character, franking, resolution date) → `trustTotals` → `summariseTrustDistributions` → adds to the beneficiary's position; s100A / UPE defer to an agent. |
| **SMSF** | Entity `entity_type='smsf'` → `smsf-members` (phase, balances) → fund income via `income.entity_id` → `smsfFundPositions` (ECPI) → separate fund position; `super-contributions` → `super_deduction`. |
| **Depreciation / assets** | `/assets` → `POST /api/assets` (class defaults, effective life, method locked once used) → `…/schedule` → `depreciation.ts` → `depreciation_schedule`; weekly cron `rollForward`; opening WDV carry-ins via `opening-depreciation`. |
| **Car logbook** | `CarMethodsCard` → `POST /api/car-use` (km) / `vehicle-logbooks` → cents-per-km in the position; the logbook result is informational only (#494). |
| **BAS / GST** | `PUT /api/gst-registered` → `bas-periods`, `payg-instalments` → `gstTotals` / `basPositionFrom` → indicative BAS shown separately (never in income tax). |
| **QBO** | `/quickbooks` → `GET /api/qbo/connect` → Intuit OAuth → `GET /api/qbo/callback` (`index.ts`) → tokens (encrypted if `QBO_TOKEN_KEY` set) → `GET /api/qbo/status`, `qbo/reconcile`, `POST /api/qbo/sync-accounts`, `POST /api/qbo/push/:txnId` (never auto-posts what a feed provides). |
| **ESS** | `/income` EssGrants → `POST /api/ess-grants` → `essTotals` / `ess.ts` (taxed-upfront vs deferral; startup concession defers to CGT) → position. |
| **NOA / carry-forward** | `/filing` NoaCloseOff → `POST /api/documents/upload` → `classifyAndRoute` → `extractNoticeOfAssessment` → draft `fy_carryovers` → user confirms `POST /api/noa/:id` → `carryforward_position` applies prior-year losses; HELP balance captured. |

## Life-situation extensibility matrix

Shared seams (from `src/lib/report.ts` and `ledger-totals.ts`): a new money figure is a new
`ledger-totals.ts` reader added to `preLossPosition` (`report.ts:887`) inside a `featureOn` block.
Other seams: a new `income.income_type` (add it to `NON_ASSESSABLE_INCOME_TYPES` if it is not
taxable), a rule-pack section or `thresholds_by_fy` key, a new `entities.kind`, `situation_periods`
facts (including the reserved `subject_kind='property'`), or a new table keyed by `(user_id, fy)`.
Each lands behind a flag with a persona golden in the same PR.

**Cross-cutting gap:** `buildReport` calls `incomeTotals` (`ledger-totals.ts:182`) **without a
`personId`**. Every non-separate-taxpayer income row in the tenant lands in one headline, so a spouse's
income would be summed into the user's. `incomeTotals` already accepts `opts.personId`, so the fix is a
flagged call-site change.

| Life situation | Data model today | Engine | UI | Gap | Additive? (seam) |
|---|---|---|---|---|---|
| **Simple PAYG** (P1, P3, P7, FT1) | `income` `salary_payg` (`withholding_cents`, `detail_json` employer/RFBA/RESC); `entities.kind='employment'`; `persons.occupation`; `transactions` buckets | `incomeTotals`; deny-by-default deductions (`report.ts:deductionGroupForRow`); `income-statement.ts`; rule pack `occupations`, `payg_deductibility` | Income, Transactions/Review, Reports, Filing | Position only: no tax payable, LITO or Medicare (by design: no refund figure). Wages detection (`wages_payer`) and the myTax worksheet are OFF | **Yes.** A flagged tax-calc lib reading new `thresholds_by_fy` keys, if the owner ever wants it |
| **Multiple jobs** (P7, FT2) | Many `salary_payg` rows + `employment` entities; `situation_periods` `employment` (`multi`, `ref_id`) | `incomeTotals` sums; `salaryPayerCount` → `tax_free_threshold_two_payers` note (`readiness.ts:954`); `income_statement_multi` | Income (statement upload), Settings entities; AboutYou jobs (OFF) | No per-job occupation scoping (`income_activities.occupation_scope` has no UI, #156); no per-job deduction split or under-withholding hint | **Yes.** `occupation_scope` column + `employment` period `ref_id` |
| **Renter WFH** (P1) | `work_use_inputs` (hours, days, weeks, dedicated office, diary); rent paid as a `renting_*` property, held and never counted | `work-use.ts:computeWorkMethodDeductions` (`report.ts:805`, `wfh_car_methods`); rule pack `wfh_fixed_rate_cents_per_hour` | `WorkMethodsCard` (Dashboard, Reports); diary in the CSV | Fixed-rate method only; no actual-cost method | **Yes.** New `work_use_inputs` columns + a sibling summand |
| **Investment property** incl. co-owned, rent-free family use, change of use (P6, P2) | `properties` (`use_status`, `ownership_pct`, cost base, disposal fields, `main_residence_flag`); `property_owners`; `income` `rent` + `property_id`; `loans_properties`; `assets`/`depreciation_schedule` | `report.ts:661-756` per-property net; rent-free / renovating denied (`report.ts:269`); co-ownership through `transaction_attributions` (`attribution.ts:splitAttribution`); `loan-interest.ts`; `cgt.ts` property path | Settings `PropertySettings` (`property_capital_detail`), Assets, `LoanInterestCard`, `AttributionPanel` | `use_status` is a single value, so a **change of use within the year has no dates and no day apportionment**. Partial (below market) family rent is not modelled. **`property_owners` is written but never read by report/attribution.** No main-residence partial exemption or 6-year rule | **Yes.** `situation_periods` with `subject_kind='property'`, `fact='use_status'` (reserved), read by a day-weighted use-status gate behind a flag; make `splitAttribution` default from `property_owners` |
| **Shares / crypto** (P2, P10, P9, P8) | `cgt_assets` (kind, units, entity, cost-base elements, `txn_id`); `cgt_events` (parcel method); `income` dividend / `managed_fund_distribution` + `cgt_asset_id`; `capital_imports`; `ess_grants` | `cgtTotals`, `cgt.ts`, `capital.ts`, `capital-signals.ts`; `essTotals`; franking (`report.ts:863`); all `capital_*` ON | Income CapitalEquity, CapitalImport, EssGrants | No DRP parcels (#455), no AMIT cost-base adjustment (#454); no exchange/wallet import; no crypto-specific rules (personal-use asset, staking income) | **Yes.** `income.cgt_asset_id` already links income to holdings; new `income_type` (e.g. `crypto_staking`) / `asset_kind` |
| **Novated lease / salary packaging (FBT, RFBA, ECM)** (no contract persona) | `entities.kind='novated_lease'` (`detail_json` provider, vehicle, pre_tax, fbt_method; `schema.sql:443`, `taxonomy.ts:152`); `rfba_cents`/`resc_cents` in `income.detail_json`. **No table for salary sacrifice, packaging caps or ECM** | `reportable_amounts` (ON) surfaces RFBA/RESC per employer (max, never summed, never in the position; `report.ts:920`, `readiness.ts:856`, `accountant-schedule.ts:805`); rule `au-novated-car` marks novated car costs not deductible and defers to an agent | Settings entities (novated lease), Onboarding drafting, Reports reportable-amounts line | **No FBT or ECM calculation**, no pre/post-tax split, no salary-sacrificed super link to `super_contributions`, no packaging caps (PBI / health exempt), RFBA feeds no income test (no MLS/HELP/Div 293 engine). The novated-lease entity feeds no money figure | **Yes.** A new `salary_packaging` table keyed `(user_id, fy, entity_id)` + rule-pack thresholds; RFBA is already captured for downstream income tests. Needs a persona first (none of P1–P10 has one) |
| **Sole trader / gig** (P4, P5, P3, FT3, Erin) | `income_type` business / `non_cash_business` / `foreign_business`; `income_activities` (`activity_type='business'`, `psi_status`); `transaction_attributions`; GST columns; `bas_periods`, `payg_instalments`, `vehicle_logbooks`, `car_inputs`, `trading_stock`; `abn_activity` periods (OFF) | `incomeTotals`; `attributionTotals`; `gst.ts`/`basPositionFrom` (separate); `paygInstalmentsTotal`; `carLogbookPosition`; `tradingStockAdjustment`; PSI and Div 35 are nudges only; platform-payout detection in `credit-triage.ts` (OFF) | Settings BusinessSettings (activities, GST, BAS, instalments), `CarMethodsCard`, Income → Trading stock | No PSI results test / Div 86 split; no Div 35 application; no small-business simplified depreciation pool; no platform statement ingest (G7/G8) | **Yes.** `income_activities.psi_status` drives a flagged Div 86 summand |
| **Company director with a Pty Ltd** (P8, P9, P2) | `entities` company (`base_rate_entity`, GST); `entity_roles` (director/shareholder, %, dates); legacy `company_tax_positions` (no writer); `rd_claims` (no writer); `transaction_attributions.creates_shareholder_loan` (`shareholder_loan_id` reserved, table dropped in 0052) | `companyPositions` (`ledger-totals.ts:461`): company income, deductions, loss carry-forward, person→company loan balance; kept out of the headline (`separateTaxpayerPredicate`) | Settings entities, `AttributionPanel`, Reports "Detailed tax positions"; **entity-roles UI client methods are never called** | **No Div 7A model** (company→person loans; `div7a_benchmark_rate_pct` unused); director fees not distinguished; no company tax payable, franking account or dividend flow to the individual; no R&D capture | **Yes.** New `div7a_loans` table `(user_id, entity_id, person_id, fy)`, `income_type='director_fee'`, existing `entity_roles.role='director'` |
| **Trust** (P8) | `entities` trust; `trust_distributions` (beneficiary, share, amount, character, franking, `resolution_dated_before_30jun`, `upe_present`, `source_kind`) | `trustTotals` → `summariseTrustDistributions` (`report.ts:848`); `partnershipTotals`; s100A / UPE defer | Settings Trust and Partnership distributions | Beneficiary side only: no trustee-side net income (s95), s99A, or streamed capital-gain character into CGT | **Yes.** A trust-position reader like `companyPositions`, keyed by entity + FY, using `separateTaxpayerPredicate` |
| **SMSF** (P10) | `entities.entity_type='smsf'`; `smsf_members` (phase, balances); `super_contributions`; fund `income.entity_id`; `super_pension` capture-only | `smsfFundPositions` → `smsf.ts` ECPI (separate taxpayer); `superConcessionalDeduction` | Settings SMSF members, Super contributions | No segregated method / actuarial certificate; no contributions tax, Div 293 calc (nudge only), cap checks or transfer-balance-cap tracking | **Yes.** New `smsf_members` / `super_contributions` columns + rule-pack thresholds |
| **First-time lodger / student (HELP)** (FT2, FT1; no contract persona) | `situation_periods` facts `study`, `study_loan`; `fy_carryovers.hecs_balance_cents` from the NOA; `income_type='government_payment'` | `study_loan_passthrough` info finding (`readiness.ts:1013`, under `situation_profile` OFF); worksheet study-loan line (`mytax-worksheet.ts:632`) | AboutYou (OFF), Income (government payments) | No repayment-income figure (RFBA/RESC captured but not combined); no repayment bands in the pack; most of the journey is behind OFF flags | **Yes.** `thresholds_by_fy` repayment bands + an info-only report field (never in the position) |
| **Moving in or out of AU (residency)** (FT4, FT2v; P10 only if foreign) | `situation_periods` `fact='residency'` (resident / temporary / foreign / whm / unsure, dated); `persons.tax_residency` mirror; foreign `income_type`s | `residency-assessability.ts` + `ledger-totals.ts:139` `residencyIncomeSplit` exclude foreign-sourced income in non-resident periods (OFF); `foreign_income_undated_part_year` finding | AboutYou `PeriodEditor` (OFF) | No part-year tax-free threshold amount (worksheet note only, `mytax-worksheet.ts:647`); non-resident and WHM rates, the departing-resident CGT event (I1) and FITO limits not modelled; nudges not per person | **Yes.** Rule-pack `residency_assessability.rules` + `thresholds_by_fy` read by a flagged lib |
| **Partner / spouse (MLS, PHI)** (P6, P2; golden `pft12p`) | `persons.role='spouse'`; periods `spouse`, `private_hospital_cover`; `profiles.private_health`; PHI tables (`phi_policy`, `phi_limit`, `phi_benefit_usage`, `phi_statement`) display-only; `income.person_id` | **None for money.** `mls_single_threshold_cents` unused; worksheet spouse and Medicare lines are text; PHI tracker never feeds `report.ts`; `phi_tax_inputs` has no reader | Settings People, AboutYou (OFF), Extras (PHI). `/partner` is the **commercial** partner portal, not a spouse page | No MLS / rebate tier; no spouse-income or family-income capture; no dependants table; income not person-scoped (cross-cutting gap) | **Yes.** Pass `personId` to `incomeTotals` behind a flag; spouse income in a new `(user_id, fy)` table or the spouse period's `detail_json`; MLS bands in `thresholds_by_fy` as an info-only field |

**Verdict.** All 13 situations can be extended additively. None needs a destructive migration or a
rewrite of the position pipeline. The three weakest are **novated lease / salary packaging** (an
entity with no money path, no persona), **spouse/MLS** (no engine, and the tenant-wide income sum is a
correctness trap once a second person has income), and **change of use** for property (a scalar
`use_status` where the domain needs dated periods; the seam is already reserved).

## Observations (candidates for later audits, not fixed here)

1. **The first-timer journey is fully dark in prod.** All eight journey flags are OFF, so new users
   get the legacy six-group sidebar, `/onboarding` and `/filing`. `/start`, `/setup`, `/connect`,
   `/lodge`, `/api/journey`, `/api/education`, `/api/mytax-worksheet` and `/api/lodged` are 404 or
   redirect.
2. **Five review surfaces.** `/transactions?view=review` (ReviewView), `/review` "By label",
   ReviewQueue, ReviewQueue `?view=labels` (embeds "By label" again), and the `/inbox` alias. `/review`
   means a different page depending on `ft_journey`.
3. **Nav numbering disagrees with itself.** `App.tsx` GROUPS reads "1 Bring in … 5 Save, 6 File" with
   no Set up. `JourneySpine` reads "Set up, Bring in, Sort, Check, Position, File" with no Save. The
   spine's "Set up" links to `/settings` (not `/onboarding`), and its "Position" links to `/`, while
   GROUPS' "Position" is `/reports`. `FtShell` has 4 steps but its comments still say six.
4. **Three AI helpers on three endpoints**: the floating chat (`/api/chat`), the Why? drawer
   (`/api/ask`) and `TabGuide` (`/api/guide`). With `ft_journey` ON the floating chat is not mounted.
5. **Position shown in three places**: Dashboard, Home and Reports. With `ft_journey` ON, `/reports`
   and `/transactions` have no nav entry.
6. **Duplicate filing surfaces.** Filing and ShipIt both do sign-off, the lodged mark, NOA and the CSV.
   Onboarding and AboutYou both do consent, people and employers. ConnectPage embeds all of Accounts
   and Income. Loan interest lives in Accounts, `LoanInterestCard` and Settings loans.
   `WorkMethodsCard`/`CarMethodsCard` render on Dashboard, Reports and RecordCards.
7. **Security flags that read as "shipped" are OFF**: `d1_backups` (the daily export cron no-ops, so no
   automated backups run), `security_monitoring`, `admin_mfa_required`, `qbo_token_fail_closed`.
   Clerk is still on the DEV instance with open signup. These matter for the Fiskil submission (#633).
8. **Dead or near-dead flags.** `phi_tax_inputs` is OFF and has **no runtime reader**.
   `partnership_losses` is OFF pending a decision. 89 ON flags are mostly permanent now. Several
   registry comments still say "OFF in prod until validated" for flags that are ON (`cgt_engine`,
   `ess_engine`, `gst_bas`, `trust_distributions`, `smsf_engine`, `attribution_engine`,
   `accountant_schedule`, `apply_to_siblings`, `loan_interest_v2`). See
   [`first-timer/flag-collapse-audit.md`](../first-timer/flag-collapse-audit.md) for the safe-collapse
   batches.
9. **Bank provider default is the declined one.** `BANK_FEED_PROVIDER` is unset, so a new connect
   would use Basiq, though Basiq declined (#631) and Fiskil is the target.
10. **Unused client methods** in `web/src/api.ts` with live server routes: entity-roles (3),
    property-owners (3), `situationPeriods` read, `chatHistory`, `clarifyScan`, `computeAsset`,
    `disposeAsset`, `cgt` (property CGT), `matchUnlink`, `phiSetHospital`, `usage`. The
    entity-roles and property-owners gaps line up with engine gaps (Div 7A, co-owner split).
11. **`property_owners` is written but never read** by report or attribution, so co-ownership depends
    on per-transaction attribution.
12. **Settings has no Appearance UI.** `components/AppearanceSwitch.tsx` is never rendered.
13. **Naming clash.** `api.reconcile` calls `/api/qbo/reconcile`, while `reconcilePairs` calls
    `/api/reconcile`. `/partner` is the commercial partner portal but reads as "spouse" in a tax app.
14. **Default inference is Anthropic (US)** (`DEFAULT_INFERENCE_PROVIDER=anthropic`). Every new user
    hits the APP-8 consent step, and CDR data would need Bedrock per tenant (#641 tracks the flip).
15. **`/agents/*` is in `run_worker_first`** although the transport is deliberately unmounted. It is
    harmless (it falls through to ASSETS), but it reads like an exposed route.
