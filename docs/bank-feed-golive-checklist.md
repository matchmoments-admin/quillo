# Fiskil go-live checklist — with Quillo's answers

> Source: Fiskil's *Go Live Checklist* (owner-supplied, 2026-10-06). Live access is requested and
> granted in the **Fiskil Console** (onboarding questionnaire) — no separate paperwork. Status legend:
> ✅ done · 🟡 partly done / in progress · ⬜ to do · 👤 owner action. Keep this file current; it is the
> single place we track production readiness for the bank feed (the GitHub ticket is #596).
>
> Context: Basiq declined to onboard Quillo; **Fiskil** is the CDR principal we're applying to as a
> CDR Representative ([provider options](bank-feed-provider-options.md)). Sandbox credentials exist
> (`.dev.vars`, verified 2026-10-06). The Fiskil adapter is on `main` and deployed (PR #631) behind
> `BANK_FEED_PROVIDER` (still the `basiq` default) and `bank_feed_cdr` (OFF). Statuses re-checked
> against `main` and prod version `39c7df14` on **2026-10-17**.
>
> **Security pack:** the Schedule 2 security controls, policies, OSP register, incident response plan and
> questionnaire answer bank live in [`docs/security/`](security/README.md). Its
> [control matrix](security/control-matrix.md) is the master tracker for security readiness (epic #633);
> owner actions are in [`docs/security/owner-tasks.md`](security/owner-tasks.md) (C1–C9).

## 1. Request live access (Fiskil Console)

| # | Fiskil step | Quillo answer / status |
|---|---|---|
| 1 | Complete application + company profile | ⬜👤 Young Milton Pty Ltd (trading as Quillo), ABN, contact `brendan@quillo.au` (forwards to the owner's Gmail via Cloudflare Email Routing). Use case: read-only bank transactions so first-time taxpayers can find work-related deductions and keep records for **their own** myTax return. Not lending, not payments, no action initiation |
| 2 | Submit security questionnaire | ⬜👤 Answer bank: [`docs/security/questionnaire-answers.md`](security/questionnaire-answers.md); submit once every [control-matrix](security/control-matrix.md) row is ✅ (2026-10-17: 6 ✅ · 40 🟡 · 9 ⬜; the matrix summary lists the exact flags, secrets and owner actions). Also drawn from: ADR-0003 (architecture + controls), `docs/cdr-ps8-findings.md`, auth (Clerk, fail-closed — #504), tenant isolation (every table `user_id`, identity server-side), encryption in transit (TLS everywhere), secrets in Cloudflare secrets, audit logs (`audit_log`, `cdr_audit_log` 0085), residency guard (`getLLM` refuses non-AU inference for CDR-tainted tenants). **Open for the questionnaire:** cyber-insurance (Fiskil's checks ask), data-at-rest location (see §2 *Data sovereignty*) |
| 3 | Review compliance checklist | 🟡 This document, §2 |
| 4 | Work through developer checklist | 🟡 This document, §3. The Fiskil adapter (PR #631) and A6 data controls (PR #679) cover every item in code; inactive end-user deletion waits on its flag |
| 5 | Set up production environment + final E2E test | ⬜ After approval: production `FISKIL_CLIENT_ID/SECRET` via `wrangler secret put`, `BANK_FEED_PROVIDER=fiskil`, `FISKIL_ENV=production`, redirect URL `https://app.quillo.au/api/bank/callback` (no trailing '.' — that broke the Basiq test), first real consent smoke test, then flip `bank_feed_cdr` |

## 2. Compliance checklist (all mandatory)

### Consent UI (Fiskil Console → "Customize UI")

| Requirement | Quillo answer / status |
|---|---|
| Branding matches the product | ⬜👤 Quillo name + logo; production brand (forest/sage/cream). Owner rule: **no new colours/fonts** — match app.quillo.au |
| Consent period fits the use case | ✅ decided: **12 months**, ongoing (a tax year of records + next year's). History requested: up to 24 months, clamped in code to the CDR wall and the year being lodged (`syncWindow`, PR #612) |
| Data-usage purposes clearly documented in the Consent UI | ⬜👤 Purpose text to enter: **"Help you find what you may be able to claim and keep records for your own tax return. Quillo is general information only, not a registered tax agent."** Scopes: accounts + transactions only. **Do not** request name/contact details or saved payees (found requested by default in the Basiq test — minimisation) |

### Data management

| Requirement | Quillo answer / status |
|---|---|
| Data minimisation strategy (store only essential data) | ✅ Account picker / auto-select only **consented** accounts; transactions fetched **per selected account** with server-side filters (verified on Basiq #512; Fiskil filter semantics being verified in the adapter); full account number / BSB **never read** past the provider boundary (last 4 only); vendor categories are a hint, never stored as truth. **Retention model** (#534): keep all credits + relevant/unsorted debits; irrelevant debits shrink to per-account totals after the year is lodged + 60 days (backstop: 31 Oct + 60 days) — core, weekly retention cron and user notice built (#581, PR #679 for #594), behind flag `bank_minimisation` (OFF until the owner flips it) |
| Deletion / de-identification when no longer needed | 🟡 See [`docs/security/data-handling.md`](security/data-handling.md) §5. **Live:** consent withdrawal → upstream revoke → PS12 deletion of CDR lines and the feed's rollups (#576, PR #679); account deletion → `purgeTenant` revokes the provider user (#576) and reseats a clean tenant (PR #623). **Built, needs a flag flip:** consent-expiry deletion (`cdr_expiry_delete`), inactive end-user deletion 30 days after the last consent ends (`cdr_inactive_user_delete`), the weekly retention cron + notice (`bank_minimisation`), all PR #679. Derived leftovers not keyed to a line await the #524 ruling |
| Testing procedures for data-management compliance | ✅ Automated in `npm test`: consent lifecycle tests (#576), Fiskil adapter tests (PR #631), expiry / inactive end-user / non-prod guard / retention cron tests and the `pfts8b` redaction golden (PR #679), minimisation goldens `pft10/pft10b` (#581), purge reseat checks (PR #623), PURGE_TABLES schema-drift test |
| Identifiable customer data stored per data-sovereignty rules | 🟡 **Open — needs the lawyer.** OSPs and locations: [`docs/security/osp-register.md`](security/osp-register.md). Inference: CDR-tainted tenants are forced to AWS Bedrock `ap-southeast-2/-4` (`au.` profile, IAM-denied outside AU) — and Bedrock `au.` is live (probe 5/5, 2026-10-22; evidence for #641). Storage: Cloudflare D1 with `locationHint: "oc"` — a latency hint, **not** a residency guarantee; Cloudflare is US-incorporated. PS8 analysis (`docs/cdr-ps8-findings.md`, #474) recommends Option A (reasonable steps via contract) — needs counsel + Fiskil's written OK to name **Cloudflare and AWS as OSPs**. Fiskil itself is onshore-only |

## 3. Developer checklist

| Requirement | Quillo answer / status |
|---|---|
| Handle every Fiskil error type | ✅ Fiskil adapter (PR #631, `src/lib/fiskil.ts`): every failure is a typed `FiskilError` from Fiskil's error shape (`name/id/message/temporary/timeout/fault`). Sync records failed/partial runs with retry in the UI (#511, #586). Confirm in the final E2E test |
| Retry / handle intermittent data-holder outages | ✅ Adapter (PR #631): back-off retry only when `temporary`/`timeout`/5xx/429/network; never on other 4xx. Bounded resumable backfill (#511) resumes from saved progress |
| Log Fiskil identifiers securely: `end_user_id`, `consent_id`, `session_id` (every consent created **or attempted**), `error_id` | ✅ PR #631: IDs only, never CDR content. `end_user_id` / `consent_id` in `bank_connections`; `session_id` audited on every connect start (`bank_connect_started`), so abandoned attempts are traceable; `error_id` on every `FiskilError` and in `cdr_audit_log` (0085) failure records |
| Delete end users no longer using the product | 🟡 Live on account deletion (purge → provider end-user delete). Built (PR #679), needs flag `cdr_inactive_user_delete`: weekly, an end user with no live consent (withdrawn, expired or abandoned) for 30 days is deleted through the provider seam and recorded as `end_user_deleted` |
| Pagination for historical transactions | ✅ Bounded, resumable, cursor-only paging (#511); Fiskil adapter stores only the opaque `page[after]` token |
| Fiskil `categories` taxonomy | ✅ Policy (ADR-0003): may **seed** but must **never override** Quillo's ATO-rule categorisation. Optional later: download the Categories Taxonomy CSV to use as a categoriser hint |

## Owner actions, in order

1. 👤 Send Fiskil the intro message (`docs/bank-feed-provider-options.md`) from `brendan@quillo.au`.
2. 👤 Complete the Console **application + company profile**, then the **security questionnaire** (answers: [`docs/security/questionnaire-answers.md`](security/questionnaire-answers.md); full owner checklist: [`docs/security/owner-tasks.md`](security/owner-tasks.md)).
3. 👤 **Customize UI**: branding, 12-month consent, the purpose text above, accounts + transactions scopes only.
4. ✅ ~~Submit the **Anthropic use-case form**~~ Done 2026-10-22 (plus the Haiku 4.5 Marketplace agreement); `npm run probe:bedrock` 5/5.
5. 👤 Book an Australian privacy/CDR **lawyer**: representative agreement + PS8 data-at-rest position + OSP naming.
6. 👤 Get a **cyber-insurance** quote (Fiskil's checks ask).
7. Before the first real consent, turn on the CDR data controls already deployed (PR #679):
   `bank_minimisation`, `cdr_expiry_delete`, `cdr_inactive_user_delete` (and `redact_statement_lines`).
   Also set `D1_EXPORT_TOKEN` + flag `d1_backups` (PR #674) so CDR data is backed up from day one.
8. Then: production keys (`FISKIL_CLIENT_ID/SECRET`, `BANK_FEED_PROVIDER=fiskil`, `FISKIL_ENV=production`)
   → final end-to-end test → flip `bank_feed_cdr`.
