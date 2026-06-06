# ADR-0001 — The TaxAgent DO is a write-coordinator; D1 is the store and the scale ceiling

**Status:** Accepted · **Date:** 2026-06-06 · **Context:** review finding #78

## Context

`wrangler.toml` declares `new_sqlite_classes = ["TaxAgent"]`, which gives every per-tenant
`TaxAgent` Durable Object its own embedded SQLite. A reader naturally assumes the DO *owns* its
tenant's data. **It doesn't.** `src/agent.ts` never calls `this.sql()` / `this.ctx.storage.sql` —
every read and write goes to the **single shared D1** binding `this.env.DB` (`tax-agent-db`). So:

- The per-tenant DO is a **write-coordinator + audit façade**: it serialises a tenant's audited
  writes (single-writer per tenant for free), runs the APP-8 consent gate and budget gate before any
  model call, and emits the hash-chained `audit_log` — but it is **not a data store**.
- **Reads bypass the DO entirely.** `src/api.ts` GET routes call `src/lib/queries.ts` against D1
  directly (`"Reads hit D1; audited writes go through the Durable Object stub"`), keeping the DO off
  the latency path for Dashboard / Inbox / Report. This is the single best scalability decision here.
- All tenant tables carry `user_id`; isolation is a column predicate, not a per-DO database.

## Decision

1. **D1 is the authoritative store and the real scale ceiling** — not the DO. Aggregate scale is
   bounded by D1's limits (size + write throughput), and D1 is a single point of failure for all
   tenants' reads and writes. Capacity planning and alerting should target **D1**, not DO CPU.
2. **Keep the architecture as-is today.** One shared D1 is correct for this product: cross-tenant
   admin/eval/cost queries (`/admin`, the eval harness, the global daily-spend ceiling) need a single
   queryable database, which per-DO SQLite could not provide.
3. **The per-DO SQLite is currently unused** (declared, never written). We **retain** the
   `new_sqlite_classes` declaration for now rather than remove it: dropping a DO's `sqlite_classes`
   is a Durable Object migration on a live class and is **not** a free no-op, so it needs an explicit
   owner go + a verified deploy — tracked, not done implicitly here.

## Consequences / future path

- If D1 write throughput ever bites, the existing DO boundary makes a **shard-by-tenant** migration
  tractable: route a tenant's writes (and eventually reads) to a per-shard D1, or adopt per-DO SQLite
  for hot per-tenant reads while keeping a roll-up D1 for cross-tenant queries. The call sites only
  see `env.DB` / `queries.ts`, so the blast radius is contained.
- Until then: **monitor D1 size + write rate**; treat the weekly cron's per-tenant fan-out (now
  KV-cursor paged, see #79) and any full-table operations as the things that scale with tenant count.

_Related: `src/index.ts` (`scheduled`, `email`, `fetch` split), `src/api.ts` (read/write split),
`src/agent.ts` (`class TaxAgent`), `wrangler.toml` (`new_sqlite_classes`)._
