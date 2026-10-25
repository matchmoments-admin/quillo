/**
 * The tenant data handle: the ONE way tenant code reaches D1 (ADR-0005).
 *
 *   const db = tenantDb(env, userId);
 *   await db.prepare(`SELECT … FROM transactions WHERE id = ? AND user_id = ?`).bind(txnId).first();
 *
 * The caller never binds the tenant. `prepare` finds the tenant placeholders in the SQL — every
 * `user_id = ?` (optionally alias-qualified) and, in an `INSERT … (cols) VALUES (…)`, the `?` in the
 * user_id column's slot — and `bind(...rest)` splices the handle's userId into those positions, returning a
 * real D1PreparedStatement (so `.first/.all/.run` and `batch` are unchanged). It throws, before anything
 * reaches D1, when:
 *
 * - the SQL has NO tenant placeholder (an unscoped statement on the tenant handle — use platformDb), or
 * - the argument count doesn't match the remaining placeholders (a misbind would shift every parameter).
 *
 * This is also the sharding seam ADR-0001 anticipates: which D1 a tenant lives in is decided HERE (today
 * always env.DB), so moving tenants to per-shard databases is a change in one function, not 800 call sites.
 *
 * Cross-tenant code (cron sweeps, founder admin, retention purge by scope, migrations) uses
 * `platformDb(env)`, the explicit and reviewed escape hatch. check-units ratchets the raw `DB.prepare(`
 * count so it can only go down.
 */
import type { Env } from "../env";

type Plan = { total: number; tenant: number[] };

const planCache = new Map<string, Plan>();
const PLAN_CACHE_MAX = 2000;

/** Index just past the string literal, quoted identifier or comment starting at `i`, or `i` if none starts there. */
function skipQuotedOrComment(sql: string, i: number): number {
  const c = sql[i];
  if (c === "'" || c === '"' || c === "`") {
    for (let j = i + 1; j < sql.length; j++) {
      if (sql[j] === c) {
        if (sql[j + 1] === c) j++; // doubled quote = escaped
        else return j + 1;
      }
    }
    return sql.length;
  }
  if (c === "-" && sql[i + 1] === "-") {
    const nl = sql.indexOf("\n", i);
    return nl < 0 ? sql.length : nl;
  }
  if (c === "/" && sql[i + 1] === "*") {
    const end = sql.indexOf("*/", i + 2);
    return end < 0 ? sql.length : end + 2;
  }
  return i;
}

/** The anonymous `?` positions in `sql` (string literals, quoted identifiers and comments skipped). */
export function placeholderOffsets(sql: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < sql.length; i++) {
    const skip = skipQuotedOrComment(sql, i);
    if (skip !== i) {
      i = skip - 1;
      continue;
    }
    if (sql[i] === "?") {
      if (/[0-9]/.test(sql[i + 1] ?? "")) throw new Error("tenantDb: numbered placeholders (?N) are not supported; use anonymous ?");
      out.push(i);
    }
  }
  return out;
}

/** The top-level comma-separated item ranges of the parenthesised tuple opening at `open` (same skipping). */
function topLevelItems(sql: string, open: number): { ranges: [number, number][]; end: number } | null {
  const ranges: [number, number][] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < sql.length; i++) {
    const skip = skipQuotedOrComment(sql, i);
    if (skip !== i) {
      i = skip - 1;
      continue;
    }
    const c = sql[i]!;
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        ranges.push([start, i]);
        return { ranges, end: i };
      }
    } else if (c === "," && depth === 1) {
      ranges.push([start, i]);
      start = i + 1;
    }
  }
  return null;
}

/** A VALUES item is the tenant slot only if it is exactly `?` once comments are removed. */
const bareParam = (item: string) => item.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "").trim() === "?";

const PREDICATE = /(?:\b[A-Za-z_][A-Za-z0-9_]*\.)?\buser_id\s*=\s*$/i;
const NEGATED = /\bNOT\s*\(?\s*(?:[A-Za-z_][A-Za-z0-9_]*\.)?user_id\s*=\s*$/i;
const INSERT_HEAD = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)\s*VALUES\s*/i;

/** Which placeholder indexes are the tenant. Exported for the goldens. */
export function tenantPlan(sql: string): Plan {
  const cached = planCache.get(sql);
  if (cached) return cached;
  const offs = placeholderOffsets(sql);
  const tenant = new Set<number>();
  offs.forEach((o, idx) => {
    const before = sql.slice(Math.max(0, o - 64), o);
    if (!PREDICATE.test(before)) return;
    // `NOT user_id = ?` reads every OTHER tenant's rows: refuse it rather than count it as a scope.
    if (NEGATED.test(before)) throw new TenantScopeError("a negated tenant predicate (NOT user_id = ?) is not a tenant scope");
    tenant.add(idx);
  });
  const ins = INSERT_HEAD.exec(sql);
  if (ins) {
    const col = ins[1]!.split(",").map((c) => c.trim().toLowerCase()).indexOf("user_id");
    if (col >= 0) {
      // Each VALUES tuple: when the user_id slot is a bare `?`, that placeholder is the tenant.
      let p = ins[0].length;
      while (sql[p] === "(") {
        const items = topLevelItems(sql, p);
        if (!items) break;
        const slot = items.ranges[col];
        if (slot && bareParam(sql.slice(slot[0], slot[1]))) {
          const idx = offs.findIndex((o) => o >= slot[0] && o < slot[1]);
          if (idx >= 0) tenant.add(idx);
        }
        p = items.end + 1;
        while (/[\s,]/.test(sql[p] ?? "")) p++;
      }
    }
  }
  const plan = { total: offs.length, tenant: [...tenant].sort((a, b) => a - b) };
  if (planCache.size >= PLAN_CACHE_MAX) planCache.clear();
  planCache.set(sql, plan);
  return plan;
}

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(`tenantDb: ${message}`);
    this.name = "TenantScopeError";
  }
}

/** A statement on the tenant handle: `bind` takes only the NON-tenant arguments. */
export interface TenantStatement {
  bind(...args: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(col?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

export interface TenantDb {
  readonly userId: string;
  prepare(sql: string): TenantStatement;
  batch<T = unknown>(stmts: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

/** Where a tenant's rows live. The ONE place a shard map would go. */
function databaseFor(env: Env, _userId: string): D1Database {
  return env.DB;
}

export function tenantDb(env: Env, userId: string): TenantDb {
  if (!userId) throw new TenantScopeError("empty userId");
  const db = databaseFor(env, userId);
  return {
    userId,
    prepare(sql: string): TenantStatement {
      const plan = tenantPlan(sql);
      if (!plan.tenant.length) throw new TenantScopeError(`no user_id placeholder in: ${sql.replace(/\s+/g, " ").slice(0, 120)}`);
      const bind = (...args: unknown[]) => {
        const want = plan.total - plan.tenant.length;
        if (args.length !== want) throw new TenantScopeError(`expected ${want} argument(s) besides the tenant, got ${args.length}`);
        const merged: unknown[] = [];
        let a = 0;
        for (let i = 0; i < plan.total; i++) merged.push(plan.tenant.includes(i) ? userId : args[a++]);
        return db.prepare(sql).bind(...merged);
      };
      return {
        bind,
        first: <T>(col?: string) => (col === undefined ? bind().first<T>() : bind().first<T>(col)) as Promise<T | null>,
        all: <T>() => bind().all<T>(),
        run: <T>() => bind().run<T>(),
        raw: <T>() => bind().raw<T>() as Promise<T[]>,
      };
    },
    batch: <T>(stmts: D1PreparedStatement[]) => db.batch<T>(stmts),
  };
}

/** Cross-tenant access (cron sweeps, founder admin, purge-by-scope). Every caller is a reviewed exception. */
export function platformDb(env: Env): D1Database {
  return env.DB;
}
