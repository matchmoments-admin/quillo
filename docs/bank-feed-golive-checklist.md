# Fiskil go-live checklist — with Quillo's answers

> Source: Fiskil's *Go Live Checklist* (owner-supplied, 2026-10-06). Live access is requested and
> granted in the **Fiskil Console** (onboarding questionnaire) — no separate paperwork. Status legend:
> ✅ done · 🟡 partly done / in progress · ⬜ to do · 👤 owner action. Keep this file current; it is the
> single place we track production readiness for the bank feed (the GitHub ticket is #596).
>
> Context: Basiq declined to onboard Quillo; **Fiskil** is the CDR principal we're applying to as a
> CDR Representative ([provider options](bank-feed-provider-options.md)). Sandbox credentials exist
> (`.dev.vars`, verified 2026-10-06); the Fiskil adapter is being built.

## 1. Request live access (Fiskil Console)

| # | Fiskil step | Quillo answer / status |
|---|---|---|
| 1 | Complete application + company profile | ⬜👤 Young Milton Pty Ltd (trading as Quillo), ABN, contact `brendan@quillo.au` (forwards to the owner's Gmail via Cloudflare Email Routing). Use case: read-only bank transactions so first-time taxpayers can find work-related deductions and keep records for **their own** myTax return. Not lending, not payments, no action initiation |
| 2 | Submit security questionnaire | ⬜👤 Draft answers from: ADR-0003 (architecture + controls), `docs/cdr-ps8-findings.md`, auth (Clerk, fail-closed — #504), tenant isolation (every table `user_id`, identity server-side), encryption in transit (TLS everywhere), secrets in Cloudflare secrets, audit logs (`audit_log`, `cdr_audit_log` 0085), residency guard (`getLLM` refuses non-AU inference for CDR-tainted tenants). **Open for the questionnaire:** cyber-insurance (Fiskil's checks ask), data-at-rest location (see §2 *Data sovereignty*) |
| 3 | Review compliance checklist | 🟡 This document, §2 |
| 4 | Work through developer checklist | 🟡 This document, §3 — the Fiskil adapter (in progress) covers most items |
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
| Data minimisation strategy (store only essential data) | ✅ Account picker / auto-select only **consented** accounts; transactions fetched **per selected account** with server-side filters (verified on Basiq #512; Fiskil filter semantics being verified in the adapter); full account number / BSB **never read** past the provider boundary (last 4 only); vendor categories are a hint, never stored as truth. **Retention model** (#534): keep all credits + relevant/unsorted debits; irrelevant debits shrink to per-account totals after the year is lodged + 60 days (backstop: 31 Oct + 60 days) — core built (#581, flag `bank_minimisation`), cron + user notice = #594 ⬜ |
| Deletion / de-identification when no longer needed | 🟡 Built: consent withdrawal → upstream revoke → PS12 deletion of CDR lines (#576); account deletion → `purgeTenant` revokes the provider user (#576) and reseats a clean tenant (#623); minimisation shrink (#581). To do: scheduled retention job + notice (#594); **inactive end-user deletion** policy (see §3) |
| Testing procedures for data-management compliance | 🟡 Automated: consent lifecycle tests (#576), minimisation goldens `pft10/pft10b` (#581), purge reseat checks (#623), PURGE_TABLES schema-drift test. To add: Fiskil-adapter equivalents (in progress) |
| Identifiable customer data stored per data-sovereignty rules | 🟡 **Open — needs the lawyer.** Inference: CDR-tainted tenants are forced to AWS Bedrock `ap-southeast-2/-4` (`au.` profile, IAM-denied outside AU) — but the **Anthropic use-case form is still unsubmitted** (blocks all Bedrock) 👤. Storage: Cloudflare D1 with `locationHint: "oc"` — a latency hint, **not** a residency guarantee; Cloudflare is US-incorporated. PS8 analysis (`docs/cdr-ps8-findings.md`, #474) recommends Option A (reasonable steps via contract) — needs counsel + Fiskil's written OK to name **Cloudflare and AWS as OSPs**. Fiskil itself is onshore-only |

## 3. Developer checklist

| Requirement | Quillo answer / status |
|---|---|
| Handle every Fiskil error type | 🟡 Fiskil adapter (in progress): typed errors from Fiskil's error shape (`name/id/message/temporary/timeout/fault`). Sync already records failed/partial runs with retry in the UI (#511, #586) |
| Retry / handle intermittent data-holder outages | 🟡 Adapter: back-off retry only when `temporary`/`timeout`/5xx/network; never on 4xx. Bounded resumable backfill (#511) resumes from saved progress |
| Log Fiskil identifiers securely: `end_user_id`, `consent_id`, `session_id` (every consent created **or attempted**), `error_id` | 🟡 Adapter requirement (sent to the build): IDs only — never CDR content — into `bank_connections`, `bank_sync_runs.error`, and the CDR audit log (`cdr_audit_log`, 0085) |
| Delete end users no longer using the product | 🟡 Done on account deletion (purge → provider end-user delete). ⬜ To decide: delete the Fiskil end user when **all consents are withdrawn/expired** and after a period of inactivity — proposed rule: on last consent withdrawal/expiry + 30 days |
| Pagination for historical transactions | ✅ Bounded, resumable, cursor-only paging (#511); Fiskil adapter stores only the opaque `page[after]` token |
| Fiskil `categories` taxonomy | ✅ Policy (ADR-0003): may **seed** but must **never override** Quillo's ATO-rule categorisation. Optional later: download the Categories Taxonomy CSV to use as a categoriser hint |

## Owner actions, in order

1. 👤 Send Fiskil the intro message (`docs/bank-feed-provider-options.md`) from `brendan@quillo.au`.
2. 👤 Complete the Console **application + company profile**, then the **security questionnaire** (I can draft answers from the table above).
3. 👤 **Customize UI**: branding, 12-month consent, the purpose text above, accounts + transactions scopes only.
4. 👤 Submit the **Anthropic use-case form** in the Bedrock console (Sydney + Melbourne).
5. 👤 Book an Australian privacy/CDR **lawyer**: representative agreement + PS8 data-at-rest position + OSP naming.
6. 👤 Get a **cyber-insurance** quote (Fiskil's checks ask).
7. Then: production keys → final end-to-end test → flip `bank_feed_cdr`.
