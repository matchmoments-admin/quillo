# Glossary

Domain and architecture terms for Quillo. One line each. Link the ADR or module that owns the term.

- **Tenant**: one Quillo account (`user_id`). Every tenant table carries `user_id`, and isolation is a column
  predicate ([ADR-0001](docs/adr-0001-do-write-coordinator-d1-ceiling.md)).
- **Tenant handle**: `tenantDb(env, userId)`, the only way tenant code reaches D1. The caller never binds the
  tenant; the handle splices it in and refuses unscoped SQL ([ADR-0005](docs/adr-0005-tenant-data-handle.md),
  `src/lib/tenant-db.ts`).
- **Platform handle**: `platformDb(env)`, the reviewed escape hatch for cross-tenant reads and writes (founder
  admin, partners, waitlist, the global spend rollup, cron sweeps).
- **Sharding seam**: `databaseFor` in `src/lib/tenant-db.ts`, the one place that decides which D1 a tenant's
  rows live in. Today that is always `env.DB`.
- **Raw-D1 ratchet**: the check-units golden that fails when any file gains a raw `DB.prepare(`. The baseline is
  `scripts/raw-db-baseline.json`.
- **Table manifest**: `src/lib/table-manifest.ts`, one entry per schema table recording its tenant key, whether it's
  purged and exported, its retention class, its secret columns, and why it's dark. `PURGE_TABLES` is derived from it.
- **Retention class**: `ledger` (tax records: flagged after the window, never auto-deleted), `keep` (audit, billing,
  compliance) or `{ log: days }` (operational logs the daily prune deletes; flag `log_retention`).
- **Dark table**: a table with no live writer or no live reader. The manifest must say why, and check-units derives
  the set from `src/` so the label can't drift.
- **Weekly sweep**: the per-tenant maintenance pass (proactive scan, roll-forward, retention flagging, consent
  lifecycle). The Monday cron starts it and the 10-minute tick continues it until done
  (`src/lib/weekly-sweep.ts`).
- **Canonical money source**: exactly one of `cdr_feed`, `statement` or `qbo_feed` per account, enforced by
  `assertCanonicalSource` ([ADR-0002](docs/adr-0002-canonical-sources.md)).
- **Life situation module**: one `src/lib/situations/<key>.ts` plugged into the registry; `composePosition` is the
  only place money is combined ([ADR-0004](docs/adr-0004-life-situation-modules.md)).
- **Primary taxpayer (self)**: the tenant's own `persons` row, `person_self_<userId>`. A row whose `person_id` is
  NULL also belongs to them. Built and compared only in `src/lib/self-person.ts`
  ([ADR-0006](docs/adr-0006-income-supersession.md)).
- **Income supersession**: when a newly read document's income replaces rows on file (a reprinted income
  statement, an annual agent summary over the monthlies) or adds nothing (a statement already covered). Weaker
  matches are held for review, never deleted (`src/lib/income-supersession.ts`, ADR-0006).
- **Superseded document**: a document another document restates. It is kept with its original as evidence
  (`extracted_json.superseded_by`), shown as "not counted", and none of its figures count.
