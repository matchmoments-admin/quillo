# Backups and disaster recovery

> **Stub.** Ticket [#635] (A2) builds the backups and fills in this document with the runbook and a
> recorded restore test. Schedule 2 controls 2(a) (encrypted backup media) and 3(c) (backup as part of
> the asset lifecycle). Version 0.1, 2026-10-08.

## Current state (honest)

| Store | Protection today | Gap |
|---|---|---|
| D1 `tax-agent-db` | Cloudflare D1 **Time Travel**: point-in-time restore for the last 30 days | No independent copy; an account compromise or deletion of the database loses everything; no restore has been tested |
| R2 `tax-agent-receipts` | Cloudflare R2 durability; objects keyed `${userId}/…` | No versioning or second copy |
| KV `RULES` | Rule pack is re-pushable from git (`npm run rulepack:push`); other keys are caches/counters with TTLs | None material: rebuildable |
| Durable Object storage | Declared but unused (ADR-0001) | n/a |
| Code and config | GitHub + local clones | — |

## To be completed by #635

- [ ] Daily cron exports D1 to a dedicated, access-restricted R2 backup bucket (encrypted at rest).
- [ ] Lifecycle rule: 35 dailies + 12 monthlies.
- [ ] Restore runbook: (a) Time Travel restore (`wrangler d1 time-travel restore`), (b) restore from export
      into a new database, then re-point the binding.
- [ ] Restore test into a scratch D1 with row counts matched; record below.
- [ ] RPO / RTO targets (proposed: RPO 24h, RTO 8h).
- [ ] Deletion interaction: a purged consumer's data ages out of backups within the retention window;
      backups are never restored into production without re-applying deletions recorded in
      `cdr_audit_log` since the backup date.

## Restore test record

| Date | Backup used | Target | Tables / rows checked | Result | By |
|---|---|---|---|---|---|
| ⬜ | | | | | |

[#635]: https://github.com/matchmoments-admin/quillo/issues/635
