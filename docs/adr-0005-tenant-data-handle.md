# ADR-0005 — The tenant data handle: tenant code never binds its own user_id

**Status:** Accepted · **Date:** 2026-10-25 · **Context:** the D1-at-scale architecture review

## Context

Every tenant table carries `user_id`, and isolation is a column predicate (ADR-0001). Before this ADR, each
of about 800 `env.DB.prepare(...)` call sites, spread over 47 files, wrote that predicate and bound the
tenant by hand. The review found what that costs:

- writes that left the predicate out (`markStatus`, the `ledger_ref` write, the statement and batch-job
  status writes);
- correlated probes that left out `ta.user_id`, so every report line scanned every tenant's rows;
- binds where the tenant sits in a different position in each statement (`WHERE id = ? AND user_id = ?`
  next to `WHERE user_id = ? AND id = ?`), so a misplaced argument fails silently.

ADR-0001's future path, sharding tenants across several D1s, would also have meant editing all ~800 call
sites.

## Decision

1. **Tenant code reaches D1 through `tenantDb(env, userId)`** (`src/lib/tenant-db.ts`). The SQL is written
   as before, with `user_id = ?`, but the caller binds only the other arguments. The handle splices the
   tenant into every `user_id = ?` placeholder, and into the `user_id` slot of an
   `INSERT … (cols) VALUES (…)`. It returns a real `D1PreparedStatement`, so `.first/.all/.run` and
   `batch` are unchanged.
2. **It throws before anything reaches D1** in three cases:
   - the SQL has no tenant placeholder (an unscoped statement on the tenant handle);
   - a `user_id = ?` doesn't restrict the statement. A tenant placeholder must sit in a WHERE / AND / ON
     conjunction or in an INSERT value slot (`VALUES` or `SELECT`), or take the one shared-or-tenant form
     `user_id IS NULL OR user_id = ?`. So `SET user_id = ?`, a bare `OR user_id = ?`, a select-list
     comparison and any predicate inside `NOT ( … )` all throw;
   - the argument count is wrong.

   Failing loudly is the safe default for tenant isolation. check-units also plans every `tenantDb` call
   site statically, so a bad predicate or a misbind fails the build rather than throwing at runtime.
3. **Cross-tenant code uses `platformDb(env)`.** This covers founder admin, partner and referral data, the
   waitlist, the global spend rollup, the security dashboard and cron sweeps. Each use is an explicit,
   greppable exception.
4. **Which D1 a tenant lives in is decided in `databaseFor` in tenant-db.ts.** That one function is the
   sharding seam. Today it always returns `env.DB`.
5. **A ratchet keeps the raw count falling.** check-units counts raw `DB.prepare(` per file against
   `scripts/raw-db-baseline.json`. A file that gains one fails the build, and a gain must be locked in with
   `UPDATE_DB_BASELINE=1`.

## How the call sites moved

A TypeScript-AST codemod converted 648 call sites. It converted a call only when it could prove which bind
arguments were the tenant, which required all three of:

- the SQL is a literal;
- every interpolation is on a reviewed list of fragments that contain no `?` and no `user_id`;
- every tenant argument is the same `userId` expression.

The rest stay raw and are counted by the ratchet:

- dynamic `WHERE` builders such as `${where.join(" AND ")}`;
- `IN (…)` lists that come before the tenant placeholder;
- modules that take a `db: D1Database` parameter.

They move by hand, a file at a time.

## Consequences

- An unscoped tenant statement can no longer be written through the handle. One case still passes: a tenant
  predicate that only scopes a subquery. The guard is a strong default, not a proof.
- Sharding means changing `databaseFor`, plus the reviewed `platformDb` callers, which need a fan-out
  query or a roll-up database.
- The placeholder scan runs once per distinct SQL string (cached), which is negligible next to a D1 round
  trip.

_Related: ADR-0001 (D1 is the store and the ceiling), `src/lib/tenant-db.ts`, `scripts/raw-db-baseline.json`._
