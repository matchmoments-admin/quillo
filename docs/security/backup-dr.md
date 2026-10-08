# Backups and disaster recovery (security A2, #635)

Evidence for CDR Rules Schedule 2 controls **2(a)** (encrypted backups) and **3(c)** (backup in the
information asset lifecycle), and for the Security & compliance page's **Backups and DR** panel.
Version 1.0, last checked 2026-10-08.

## 1. What holds data, and how each store is protected

| Store | What's in it | Protection | Recovery source |
|---|---|---|---|
| **D1** `tax-agent-db` | The system of record: every tenant table (transactions, income, assets, documents metadata, consents, audit logs) | (a) **Time Travel**: Cloudflare's built-in point-in-time restore, any minute in the last **30 days** (Workers Paid). (b) **Daily SQL export** to the private R2 bucket `tax-agent-backups`, kept **35 daily + 12 monthly** | Time Travel first. Use the export for anything older than 30 days, or if Time Travel itself is unavailable |
| **R2** `tax-agent-receipts` | Receipt and document files (5-year ATO retention) | R2 is built for 99.999999999% (11 nines) annual durability and stores data redundantly across its infrastructure. Encrypted at rest. Nothing auto-deletes inside the retention window | R2 itself. R2 has **no object versioning**, so a file deleted by the app (or by a user's own deletion request) can't be recovered. That's the intended behaviour for user deletions. See §7 for the residual risk |
| **KV** `RULES` | Rebuildable state only: the rule pack (`rulepack:au-v1`), TTL caches (FX rates, QBO discovery, ledger account maps), anti-replay nonces, OAuth `state` values, rate and cost counters, cron cursors, one-time backfill guards, and the security dashboard's snapshot and source records | Nothing irreplaceable | Rule pack: `npm run rulepack:push` (from `src/rulepacks/au-v1.json` in git). Caches and counters refill themselves. The backfill guards re-run, and the backfills are idempotent by design. Security records regenerate on the next check or cron run |
| **Durable Objects** `TaxAgent` | Nothing durable. The DO is a write coordinator and D1 is the store ([ADR-0001](../adr-0001-do-write-coordinator-d1-ceiling.md)) | n/a | n/a |
| **Worker code and config** | `src/`, `web/`, `wrangler.toml`, migrations | Git (GitHub `matchmoments-admin/quillo`) | `npm run web:build && npm run deploy` from `main` |
| **Secrets** | Worker secrets (Clerk, AWS, QBO key, tokens) | Cloudflare secret store. Inventory in [secrets-and-encryption.md](secrets-and-encryption.md) | Re-issue from each provider. `QBO_TOKEN_KEY` also lives in the password manager |

## 2. Targets

| | Target | How it's met |
|---|---|---|
| **RPO** (max data loss) | **24 hours**, and in practice minutes | Time Travel restores to any minute in the last 30 days. The daily export bounds loss at 24h even if Time Travel is unavailable |
| **RTO** (time to restore service) | **4 hours** | Time Travel restore takes minutes. Restoring from an export into a new DB plus a redeploy took **under 10 seconds of tool time** at today's size (§6). The rest of the budget is diagnosis and the decision to restore |

## 3. The daily export: how it works

- **Where:** `src/lib/backups.ts` (`runD1Backup`), started by the cron `30 16 * * *` (16:30 UTC =
  02:30 AEST / 03:30 AEDT) in `wrangler.toml`. Flag: `d1_backups`. With the flag OFF, the cron
  returns before touching anything.
- **Why it runs in a Worker:** D1's binding has no dump call, but the account REST endpoint
  `POST /accounts/{account}/d1/database/{db}/export` (`output_format: "polling"`) produces a full SQL
  dump (schema and data) and returns a one-hour signed download URL. This is the same endpoint
  `wrangler d1 export --remote` uses, and Cloudflare's documented backup pattern
  ([Workflows example: backup D1](https://developers.cloudflare.com/workflows/examples/backup-d1/),
  [API: export](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/)).
  Running it in the Worker means no GitHub Actions secret and no separate pipeline.
- **Key dates are UTC.** The run at 16:30 UTC is already the *next* day in Australia, so
  `d1/daily/2026-10-08.sql` is the state at about **02:30 AEST on 9 October**. When you choose an
  export, read its `exported_at` metadata.
- **Steps:** start the export → poll with `current_bookmark` until `status: complete` (an export that
  stops being polled cancels itself) → download the signed URL → `BACKUPS.put("d1/daily/<YYYY-MM-DD>.sql")`.
  The first export of each month is copied to `d1/monthly/<YYYY-MM>.sql`. The object's metadata
  records the export's **Time Travel bookmark** (`at_bookmark`). A retried cron on the same day
  finds the daily object and skips.
- **Status:** after every run, one record goes to KV `security:source:backups`, which the
  Security & compliance page reads (#636 contract). It holds counts, keys and timestamps only: last
  run, result, object key and size, bookmark, retention, and the last restore test. The signed URL is
  a bearer credential for the whole DB, so it is **never logged or stored**. API errors are reduced
  to their HTTP status.
- **Impact on users:** D1 doesn't serve queries while an export runs. The prod export took about
  **6 seconds end to end** on 2026-10-08 (4.7 MB, about 6,000 rows), which is why it runs in the quietest hour.
- **Growth limit:** dumps up to 48 MB are buffered in memory. Larger dumps stream into R2 (a fetch
  body with `Content-Length` has the known length R2 requires). If the dump approaches the Worker's
  memory or the cron's 15-minute wall clock, move the job to a Workflow with multipart upload.

### Bucket: private, encrypted, lifecycle-managed

- `tax-agent-backups`, location hint `oc` (Oceania). No `r2.dev` public URL and no custom domain,
  which is R2's default and must stay that way. Only the Worker binding `BACKUPS` and account admins can
  read it.
- Encrypted at rest by R2 (AES-256, Cloudflare-managed keys). The dump is plain SQL inside an encrypted,
  private bucket. We don't add application-level encryption, because a key held by the same Worker
  would add no protection against the only principal that can read the bucket.
- Lifecycle rules (on the bucket, not in code):

  | Rule | Prefix | Expire after |
  |---|---|---|
  | `d1-daily-35d` | `d1/daily/` | 35 days |
  | `d1-monthly-12m` | `d1/monthly/` | 366 days |

### One-time setup (coordinator)

```sh
# 1. The bucket (must exist BEFORE the next deploy, because wrangler.toml binds it)
npx wrangler r2 bucket create tax-agent-backups --location oc
npx wrangler r2 bucket dev-url get tax-agent-backups        # must say public access is DISABLED

# 2. Retention
npx wrangler r2 bucket lifecycle add tax-agent-backups d1-daily-35d d1/daily/ --expire-days 35 -y
npx wrangler r2 bucket lifecycle add tax-agent-backups d1-monthly-12m d1/monthly/ --expire-days 366 -y
npx wrangler r2 bucket lifecycle list tax-agent-backups

# 3. The export token: dash.cloudflare.com → My Profile → API Tokens → Create Custom Token
#    Name: quillo-d1-export
#    Permissions: Account · D1 · Read          (export accepts D1 Read; nothing else)
#    Account resources: Include · Matchmoments@outlook.com's Account (192777a993ba94d262ede60d8f9a480c)
#    Client IP filtering: none (Workers egress IPs aren't fixed). TTL: optional, set a calendar reminder to rotate yearly.
#    The API reference lists "D1 Read" / "D1 Write" as accepted for export. Verify Read is enough BEFORE
#    storing it (this starts an export job and changes nothing):
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"output_format":"polling"}' \
  https://api.cloudflare.com/client/v4/accounts/192777a993ba94d262ede60d8f9a480c/d1/database/76e1c20a-efa2-4042-858a-7e24be4c14ce/export | head -c 300
#    "success":true means good. HTTP 403 means re-issue the token with Account · D1 · Edit and note it here.
npx wrangler secret put D1_EXPORT_TOKEN

# 4. Turn it on: add d1_backups to FEATURES in wrangler.toml, then deploy
npm run web:build && npm run deploy

# 5. Next day: confirm the first object and the status record
npx wrangler r2 bucket info tax-agent-backups                # object count > 0
# or: Admin → Security & compliance → "Run checks now" (needs security_monitoring ON) shows the newest export
npx wrangler kv key get --binding RULES security:source:backups --remote
```

`CF_ACCOUNT_ID` and `D1_DATABASE_ID` are plain `[vars]` in `wrangler.toml`. They are identifiers,
not secrets.

## 4. Restore runbook

**Before any restore:** pause writes if you can. Tell the owner, and note the time and the reason
in the incident log. **Never** restore over prod
without first capturing its current bookmark, because that capture is your undo.

### A. Time Travel (preferred, last 30 days, in place)

1. Find the point to go back to:
   ```sh
   npx wrangler d1 time-travel info tax-agent-db                                   # current bookmark: WRITE IT DOWN (your undo)
   npx wrangler d1 time-travel info tax-agent-db --timestamp=2026-10-08T03:00:00Z  # bookmark at a moment before the incident
   ```
   The `at_bookmark` in a daily export's R2 metadata, or in the status record, is also a valid
   bookmark.
2. Restore. This **overwrites** the DB in place and is undoable by restoring the bookmark from step 1:
   ```sh
   npx wrangler d1 time-travel restore tax-agent-db --bookmark=<bookmark>
   ```
3. Verify with §5. Then re-run any migration newer than the restore point (`migrations/`, in order;
   all are idempotent).

### B. From an export (older than 30 days, or Time Travel unavailable), into a NEW database, then swap

1. Pick the export and download it:
   ```sh
   npx wrangler r2 object get tax-agent-backups/d1/daily/2026-10-08.sql --file restore.sql --remote
   ```
2. Create a **new** database. Never import into prod:
   ```sh
   npx wrangler d1 create tax-agent-db-restore-20261008 --location oc
   npx wrangler d1 execute tax-agent-db-restore-20261008 --remote --file restore.sql -y
   ```
   (The dump starts with `PRAGMA defer_foreign_keys=TRUE;` and creates every table and index. The
   target must be empty.)
3. Verify the new DB with §5 against the expected counts.
4. Swap the binding: in `wrangler.toml`, change the `DB` binding's `database_name` and `database_id`
   to the new database, and update `D1_DATABASE_ID` in `[vars]` so backups follow. Then deploy
   (`npm run web:build && npm run deploy`) and check `curl -s https://app.quillo.au/healthz`.
5. Keep the old DB untouched for at least 30 days (its Time Travel history is evidence). Delete it only
   by an explicit owner decision.
6. Record the restore (date, export used, counts) in §6.

### C. Deletions after the restore point (must do, before reopening)

A restore brings back everything as it was at the restore point. That includes data a consumer has
since asked us to delete: a PS12 withdrawal, an account deletion, or a retention purge. **Before reopening
writes**, re-apply every deletion recorded after the restore point:

```sh
npx wrangler d1 execute <restored-db> --remote --command \
  "SELECT user_id, connection_id, event, created_at FROM cdr_audit_log WHERE created_at > '<restore point UTC>' AND event IN ('consent_withdrawn','data_deleted','tenant_purged') ORDER BY created_at"
```

Read the list from the **pre-restore** database (or its Time Travel bookmark), then re-run the same
purge path for each tenant (`purge` / withdrawal flow in `src/lib/retention.ts` /
`src/lib/bank-consent.ts`). Export copies age out on their own: a deleted consumer's data leaves the
backups within the retention window (35 days for dailies, 12 months for monthlies). This is
disclosed in [data-handling.md](data-handling.md).

## 5. Verifying a restore

`scripts/backup-restore-check.mjs` is read-only. It opens SQLite files with `readOnly` and only prints a
SELECT for remote use.

```sh
# local scratch DB vs its source (counts + schema objects + content hash)
node scripts/backup-restore-check.mjs compare <source.sqlite> <restored.sqlite>

# remote DB counts vs a restored copy (D1 rejects a long UNION ALL, so it's one SELECT of scalar subqueries)
node scripts/backup-restore-check.mjs count-sql <restored.sqlite> > count.sql
npx wrangler d1 execute <db> --remote --json --command "$(cat count.sql)" > remote.json
node scripts/backup-restore-check.mjs compare-remote <restored.sqlite> remote.json
```

Local D1 files: `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`, or
`<persist-to>/v3/d1/...` for a scratch DB created with `--persist-to`.

## 6. Restore test record

| Date | Backup used | Target | Tables / rows checked | Result | By |
|---|---|---|---|---|---|
| 2026-10-08 | Local seeded D1 export (`wrangler d1 export --local`) | Empty local scratch DB | 80/80 tables, 2,859/2,859 rows, 118/118 indexes, content hash equal | ✅ PASS | Claude (agent), #635 |
| 2026-10-08 | **Production** export (`wrangler d1 export --remote`, read-only) | Empty local scratch DB | 80/80 tables, 6,037/6,037 rows vs a read-only count on prod | ✅ PASS | Claude (agent), #635 |

### 2026-10-08: local seeded DB → scratch DB: **PASS**

- Source: local D1 (`schema.sql`-seeded) plus a synthetic fixture (2,500 transactions and 300 income
  rows, with quotes, unicode, embedded newlines and semicolons, NULLs and REALs; no real data).
- `npx wrangler d1 export tax-agent-db --local --output local-export.sql` (3.7 MB), then
  `npx wrangler d1 execute tax-agent-db --local --persist-to <scratch> --file local-export.sql`
  into an empty scratch persistence dir (about 1.6 s).
- `compare`: **80/80 tables, 2,859/2,859 rows, 118/118 indexes, content hash identical
  (`0616d452ca11144d`)**, 0 mismatches.

### 2026-10-08: production export (read-only) → local scratch DB: **PASS**

- `npx wrangler d1 export tax-agent-db --remote --output prod-export.sql`. This is a read-only export
  (4.7 MB, about 6 s end to end). Nothing was written to the prod DB.
- Imported into an empty **local** scratch DB (`--local --persist-to <scratch>`): 6,238 statements
  ran successfully in about 2.4 s.
- `compare-remote` against a read-only count query on prod: **80/80 tables, 6,037/6,037 rows, 38
  non-empty tables, 0 mismatches.**
- The prod dump and the scratch copy were deleted from the workstation right after the test.

The dashboard shows the latest test via `LAST_RESTORE_TEST` in `src/lib/backups.ts`. Update it
whenever you add a record here. Re-test **quarterly** and after any schema-heavy change, and run the
first test from a real `d1/daily/` object once the bucket has one.

## 7. Residual risks and follow-ups

- **R2 receipts have no second copy.** A bug that deletes objects, or a compromised account, could
  lose files. Options, in cost order: an R2 bucket lock (retention rule) on `tax-agent-receipts` for
  the ATO window, which blocks deletion including user-requested deletion, so it needs a product
  decision first; or a periodic copy to a second bucket. Not done. Needs an owner decision.
- **Backup-bucket deletion:** the Worker binding can delete from `tax-agent-backups`. An R2 bucket lock
  on `d1/` (for example, 30 days) would make recent exports immutable even to the app:
  `npx wrangler r2 bucket lock add tax-agent-backups d1-lock d1/ --retention-days 30`. Recommended,
  but optional.
- **Same-provider backups:** exports live in the same Cloudflare account as prod. Account loss (billing,
  account compromise) takes both. An occasional off-platform copy (a monthly download to encrypted
  owner storage) closes this. Owner decision.
- **Export blocks queries** for its duration, which is seconds today. Watch the duration as data grows.
