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
- **Weekly sweep**: the per-tenant maintenance pass (proactive scan, roll-forward, retention flagging, consent
  lifecycle). The Monday cron starts it and the 10-minute tick continues it until done
  (`src/lib/weekly-sweep.ts`).
- **Canonical money source**: exactly one of `cdr_feed`, `statement` or `qbo_feed` per account, enforced by
  `assertCanonicalSource` ([ADR-0002](docs/adr-0002-canonical-sources.md)).
- **Life situation module**: one `src/lib/situations/<key>.ts` plugged into the registry; `composePosition` is the
  only place money is combined ([ADR-0004](docs/adr-0004-life-situation-modules.md)).
