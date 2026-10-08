# Data handling standard

> Schedule 2, Part 2, control requirement 3 (3(a) data loss prevention, 3(b) non-production, 3(c)
> information asset lifecycle) and Privacy Safeguard 12 / rules 7.12–7.13. Version 0.1, 2026-10-08.

## 1. Classification

| Class | What | Examples | Handling |
|---|---|---|---|
| **Restricted — CDR** | CDR data and anything derived from it (service data, r1.10AA(5)) | Feed transactions, masked accounts, consent ids, categories/claims derived from feed lines, model inputs built from them | Stays in the CDE ([cdr-data-environment.md](cdr-data-environment.md)); AU-only inference; never on the laptop, in email, tickets, screenshots, chat with AI tools, or non-production; deleted per §5 |
| **Restricted — secrets** | Credentials and keys | Worker secrets, API keys, QBO tokens, HMAC ingest secrets | Cloudflare secrets or password manager only; never in git, logs or chat; QBO tokens sealed with AES-256-GCM (#637) |
| **Confidential — personal** | Other personal and tax information | Receipts, statements uploaded by users, income records, situation profile, email address | Tenant-scoped; APP-8 consent before US inference; deletable by the user; never in non-production |
| **Internal** | Operational data with no personal content | Aggregate counts, cost metrics, audit rows (ids/counts) | Access via admin role or Cloudflare only |
| **Public** | Marketing site, rule pack, docs | quillo.au, `src/rulepacks/*` | No restriction |

When data mixes classes, the highest class applies. A tenant with `profiles.cdr_tainted = 1` is treated
as Restricted — CDR for all model calls.

## 2. Minimisation (collect and keep the least)

- **Scopes:** accounts and transactions only; no name, contact details, payees or other data clusters
  (Fiskil Console "Customize UI" — owner task C9).
- **Accounts:** only accounts the consumer consents to and selects are fetched; transactions are fetched
  per selected account; full account number / BSB never read past the provider boundary (last 4 kept).
- **History:** clamped to the CDR wall and the year being lodged (`syncWindow`, PR #612).
- **Retention model (#534, built in #581, scheduled in #594, flag `bank_minimisation`):** keep all credits and
  relevant or unsorted debits; **irrelevant debits shrink to per-account totals** once the year is lodged and the
  line has been held 60 days (backstop: the 31 October due date + 60 days when the year is never marked). The
  weekly cron runs it; the user gets one notice per year tidied, and Settings › Your data shows the count.
- **Statement-line redaction before inference** (S8b, #639, flag `redact_statement_lines`): account numbers,
  BSBs and full card numbers are removed from statement lines before the categorisation model call; merchant
  words, amounts, dates and bare reference numbers are kept, so categorisation is unchanged (golden `pfts8b`).

## 3. Use

CDR data is used only to provide the service the consumer consented to: help them find what they may be
able to claim and keep records for their own tax return (general information only). No direct marketing,
no sale, no general research, no de-identified disclosure. Vendor categories may seed but never override
Quillo's own categorisation (ADR-0003).

## 4. Retention schedule

| Data | Retained | Then |
|---|---|---|
| CDR transactions (active consent) | While the consent is active and the data is needed for the consumer's open tax year(s) | Minimisation shrink after lodgement (+60 days); full deletion on withdrawal/expiry (§5) |
| CDR transactions after consent withdrawn or expired | **Not retained** — deleted at withdrawal (PS12) and, with `cdr_expiry_delete` ON, at expiry (§5.2) | — |
| Fiskil end user (at Fiskil) | While any consent is live | Deleted 30 days after the last consent ends or a connect is abandoned (§5.6, flag `cdr_inactive_user_delete`), at withdrawal of the last connection, and on account deletion |
| `cdr_audit_log`, `audit_log` | **6 years** from creation (r9.3(5) record-keeping); excluded from tenant purge | Delete when older than 6 years (job to build — not yet scheduled) |
| Receipts and other user records (non-CDR) | 5 years **from the date that year's return was lodged** (ATO record-keeping; the user's mark, a NOA close, or the due date + 60 days if never marked) unless the user deletes earlier | One nudge when the oldest record passes it (`flagOldData`); user-controlled deletion / purge |
| Workers Logs | Cloudflare default (days) | Expire automatically; never contain CDR content |
| Backups (D1 export, [backup-dr.md](backup-dr.md)) | 35 daily + 12 monthly (#635) | Lifecycle rule expiry; a deleted consumer's CDR data ages out of backups within the retention window — disclose in Fiskil's CDR policy |

The weekly cron (`src/index.ts`, Monday 08:00 UTC) runs the retention nudge, minimisation, the consent
lifecycle (incl. expiry deletion) and inactive end-user deletion, then publishes counts to the admin Security &
compliance page ("Data lifecycle", KV `security:source:retention`: last run, nudges, lines deleted, end users
deleted, deletion queue). Each step is behind its own flag, OFF until the owner flips it; withdrawal deletion
and account purge are live today.

## 5. Deletion

### 5.1 Consent withdrawal (PS12, #576)
[`src/lib/bank-consent.ts`](../../src/lib/bank-consent.ts):
1. The connection flips to `revoked` locally **first** (collection stops even if Fiskil is down).
2. Upstream revoke at Fiskil; failures are recorded, shown with Retry, and retried by the weekly sweep.
3. Delete every line with `source='cdr_feed' AND kind='bank_line'` from that connection, plus the
   minimisation totals and tombstones of those accounts' feed lines (#594); the account reverts to
   `statement` source when nothing else feeds it.
4. `cdr_audit_log` records `consent_withdrawn`, `upstream_revoked` (or `upstream_revoke_failed`) and
   `data_deleted` with counts — never content.

### 5.2 Consent expiry
The weekly lifecycle sweep marks a consent past `consent_expires_at` as `expired` and records
`consent_expired`; sync already refuses expired consents, and the consumer gets an `expiry_reminder`
first. Once the use consent ends the data is redundant (PS12, r7.12–7.13), so with `cdr_expiry_delete` ON
the same sweep runs **the withdrawal's deletion** (§5.1 step 3) at expiry — no grace period — and records
`data_deleted` with `reason: consent_expired`. Consents that expired before the flag was flipped are swept
too. Nothing is revoked upstream (the consent already lapsed); the end user goes 30 days later (§5.6). A
re-consent that reactivates the connection clears its deletion stamp, so the new lines are deleted again at
the next withdrawal or expiry. Code: `consentLifecycle` in [`src/lib/bank-consent.ts`](../../src/lib/bank-consent.ts) (#639).

### 5.3 Account deletion (purge, #576 / #623)
[`src/lib/retention.ts`](../../src/lib/retention.ts) `purgeTenant`: delete the Fiskil end user first
(abort if that fails, so CDR data is never orphaned at Fiskil) → R2 objects under `${userId}/` → KV
tenant keys → every table in `PURGE_TABLES` in one atomic D1 batch, reseating an empty profile and self
person (#623). `audit_log` and `cdr_audit_log` are kept as evidence of deletion.

### 5.4 Deletion directed by Fiskil
Rule 1.10AA(4)(e): when Fiskil directs, delete service data and provide deletion records.
1. Identify the tenant from the Fiskil end-user id (`profiles.bank_provider_user_id` /
   `bank_connections.provider_user_id`).
2. Run the per-connection PS12 deletion, or `purgeTenant` if Fiskil directs deletion of all data.
3. Export the tenant's `cdr_audit_log` rows for the deletion and send them to Fiskil as the record.
4. Log the direction and response in the incident register or a support log.

### 5.5 De-identification
Quillo does not de-identify CDR data for any use; redundant CDR data is **deleted**, not de-identified.

### 5.6 Inactive end users (Fiskil developer checklist)
Rule (#639, flag `cdr_inactive_user_delete`): when a tenant has held **no live consent for 30 days** — every
consent withdrawn or expired, or a connect started and abandoned — the weekly sweep deletes the aggregator end
user through the provider seam (`deleteUser`), forgets its id and records `end_user_deleted`. A failure records
`end_user_delete_failed` (error class only) and is retried the next week; it does not restart the 30 days.
Withdrawing the last connection already deletes the end user immediately. Code: `inactiveEndUserSweep` in
[`src/lib/bank-consent.ts`](../../src/lib/bank-consent.ts); the queue size is on the admin dashboard.

## 6. Masking and non-production

- Local development and any preview use the **Fiskil sandbox** (synthetic data from the sandbox data
  holder, institution `88888`). Production CDR data is **never** copied, exported or restored into
  local, preview or test environments, and is never used as a test fixture.
- Test fixtures under `scripts/fixtures/` are synthetic.
- If production data is ever needed to debug a bug, debug in production through counts and ids, or ask
  the consumer to reproduce; do not copy rows out.
- **Enforced in code (#639):** a non-production deployment (`DEV_AUTH_BYPASS=1`; production never sets it)
  refuses a connect on production credentials, drops a real bank's connection at the callback before anything
  is stored, and fails a sync before the first page is fetched. Only the sandbox carve-out passes (Fiskil
  institution `88888` with sandbox credentials, or Basiq sandbox) — `cdrBlockedInThisDeployment` in
  [`src/lib/bank-feed-core.ts`](../../src/lib/bank-feed-core.ts), unit-tested ("non-prod:" checks).

## 7. Data loss prevention

- No product feature exports CDR data to a third party. The APP-12 data export returns the consumer's own
  data to the consumer only, with secret columns stripped (`redactSecrets`).
- Outbound integrations from the browser are limited by CSP; from the Worker, by code review and the
  [OSP register](osp-register.md).
- Staff rules in [acceptable-use.md](acceptable-use.md): no CDR data on the laptop, in email, in AI chat
  tools, on USB media, or in screenshots; no unapproved cloud services.
- Gap (honest): the laptop has no MDM, so USB writes and outbound email are not technically blocked; the
  control is policy plus the fact that CDR data is never downloaded to the laptop.

[#594]: https://github.com/matchmoments-admin/quillo/issues/594
[#639]: https://github.com/matchmoments-admin/quillo/issues/639
