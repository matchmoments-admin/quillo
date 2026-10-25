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
// What must precede `[alias.]user_id = ?` for it to RESTRICT the statement: a WHERE / AND / ON conjunction
// (optionally after an opening paren), or the one shared-or-tenant form `user_id IS NULL OR user_id = ?`
// (global rule-pack overrides plus this tenant's own rows). Anything else — `SET user_id = ?` (moves a row
// into this tenant), a bare `OR user_id = ?`, a select-list comparison — is not a scope and throws.
const CONJUNCTIVE = /(?:\bWHERE|\bAND|\bON)\s*(?:\(\s*)*(?:\b[A-Za-z_][A-Za-z0-9_]*\.)?user_id\s*=\s*$/i;
const SHARED_OR_TENANT = /\buser_id\s+IS\s+NULL\s+OR\s+(?:\b[A-Za-z_][A-Za-z0-9_]*\.)?user_id\s*=\s*$/i;
const INSERT_HEAD = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)\s*(VALUES|SELECT)\s*/i;

/** The open-paren offsets enclosing `at` (quotes and comments skipped), innermost last. */
function enclosingParens(sql: string, at: number): number[] {
  const stack: number[] = [];
  for (let i = 0; i < at; i++) {
    const skip = skipQuotedOrComment(sql, i);
    if (skip !== i) {
      i = skip - 1;
      continue;
    }
    if (sql[i] === "(") stack.push(i);
    else if (sql[i] === ")") stack.pop();
  }
  return stack;
}

/** The top-level items of a SELECT list starting at `start`, up to the first top-level FROM / WHERE. */
function selectListItems(sql: string, start: number): [number, number][] {
  const ranges: [number, number][] = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < sql.length; i++) {
    const skip = skipQuotedOrComment(sql, i);
    if (skip !== i) {
      i = skip - 1;
      continue;
    }
    const c = sql[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && c === ",") {
      ranges.push([from, i]);
      from = i + 1;
    } else if (depth === 0 && /\s/.test(c) && /^\s+(FROM|WHERE)\b/i.test(sql.slice(i))) break;
  }
  ranges.push([from, sql.length]);
  return ranges;
}

/** The keywords at paren depth 0 of the group opening at `open` (-1 = the whole statement), with offsets. */
function groupWords(sql: string, open: number): { w: string; at: number }[] {
  const out: { w: string; at: number }[] = [];
  let depth = 0;
  for (let i = open + 1; i < sql.length; i++) {
    const skip = skipQuotedOrComment(sql, i);
    if (skip !== i) {
      i = skip - 1;
      continue;
    }
    const c = sql[i]!;
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && /[A-Za-z_]/.test(c) && !/[A-Za-z0-9_.]/.test(sql[i - 1] ?? "")) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i))!;
      out.push({ w: m[0].toUpperCase(), at: i });
      i += m[0].length - 1;
    }
  }
  return out;
}

const CLAUSE_START = new Set(["WHERE", "ON", "HAVING"]);
const CLAUSE_END = new Set(["WHERE", "ON", "HAVING", "GROUP", "ORDER", "LIMIT", "RETURNING", "UNION", "EXCEPT", "INTERSECT", "JOIN", "LEFT", "INNER", "CROSS", "SET", "VALUES", "FROM", "WINDOW"]);

/**
 * An OR anywhere in the predicate's own WHERE/ON clause (same paren level) means `user_id = ?` is one
 * alternative, not a restriction: `WHERE user_id = ? OR id = ?` reads any tenant's row by id, and AND binds
 * tighter than OR, so `WHERE id = ? OR k = 'x' AND user_id = ?` is unscoped too. The one allowed OR is the
 * shared-or-tenant form's own `user_id IS NULL OR user_id = ?`.
 */
function orInClause(sql: string, o: number, open: number): boolean {
  const words = groupWords(sql, open);
  let from = -1;
  let to = sql.length;
  for (const { w, at } of words) {
    if (at < o && CLAUSE_START.has(w)) from = at;
    if (at > o && CLAUSE_END.has(w)) { to = at; break; }
  }
  if (from < 0) return false;
  return words.some(({ w, at }) => w === "OR" && at > from && at < to
    && !(/\buser_id\s+IS\s+NULL\s+$/i.test(sql.slice(Math.max(0, at - 24), at)) && /^OR\s+(?:[A-Za-z_][A-Za-z0-9_]*\.)?user_id\s*=\s*\?/i.test(sql.slice(at))));
}

/** True when the paren at `open` starts a subquery, i.e. its rows are not the statement's own rows —
 *  except a derived table or CTE body (after FROM / JOIN / AS), whose rows ARE what the statement reads. */
const scalarOrFilterSubquery = (sql: string, open: number) =>
  /^\(\s*(?:SELECT|WITH)\b/i.test(sql.slice(open, open + 16)) && !/\b(?:FROM|JOIN|AS)\s*$/i.test(sql.slice(Math.max(0, open - 8), open));

/** Which placeholder indexes are the tenant. Throws TenantScopeError on a tenant predicate that doesn't scope. */
export function tenantPlan(sql: string): Plan {
  const cached = planCache.get(sql);
  if (cached) {
    // LRU: a hit moves to the back, so the hot statements survive eviction.
    planCache.delete(sql);
    planCache.set(sql, cached);
    return cached;
  }
  const offs = placeholderOffsets(sql);
  const tenant = new Set<number>();
  // INSERT value slots first: the user_id column's `?` in each VALUES tuple, or in the SELECT list.
  const valueSlots = new Set<number>();
  const ins = INSERT_HEAD.exec(sql);
  if (ins) {
    const col = ins[1]!.split(",").map((c) => c.trim().toLowerCase()).indexOf("user_id");
    if (col >= 0) {
      const take = (slot: [number, number] | undefined) => {
        if (!slot || !bareParam(sql.slice(slot[0], slot[1]))) return;
        const idx = offs.findIndex((o) => o >= slot[0] && o < slot[1]);
        if (idx >= 0) valueSlots.add(idx);
      };
      if (ins[2]!.toUpperCase() === "SELECT") take(selectListItems(sql, ins[0].length)[col]);
      else {
        let p = ins[0].length;
        while (sql[p] === "(") {
          const items = topLevelItems(sql, p);
          if (!items) break;
          take(items.ranges[col]);
          p = items.end + 1;
          while (/[\s,]/.test(sql[p] ?? "")) p++;
        }
      }
    }
  }
  let outer = false;
  offs.forEach((o, idx) => {
    if (valueSlots.has(idx)) return tenant.add(idx);
    const before = sql.slice(Math.max(0, o - 64), o);
    if (!PREDICATE.test(before)) return;
    if (!CONJUNCTIVE.test(before) && !SHARED_OR_TENANT.test(before)) {
      throw new TenantScopeError(`a user_id = ? that doesn't restrict the statement (needs WHERE/AND/ON): …${before.replace(/\s+/g, " ").slice(-40)}`);
    }
    // Inside any NOT ( … ) group the predicate is inverted — it would read every OTHER tenant's rows.
    for (const open of enclosingParens(sql, o)) {
      if (/\bNOT\s*$/i.test(sql.slice(Math.max(0, open - 8), open))) throw new TenantScopeError("a tenant predicate inside NOT ( … ) is not a tenant scope");
    }
    if (/\bNOT\s*\(?\s*(?:[A-Za-z_][A-Za-z0-9_]*\.)?user_id\s*=\s*$/i.test(before)) throw new TenantScopeError("a negated tenant predicate (NOT user_id = ?) is not a tenant scope");
    const parens = enclosingParens(sql, o);
    if (orInClause(sql, o, parens.length ? parens[parens.length - 1]! : -1)) throw new TenantScopeError("a tenant predicate OR-ed with another condition is not a tenant scope");
    if (!parens.some((open) => scalarOrFilterSubquery(sql, open))) outer = true;
    tenant.add(idx);
  });
  // A statement scoped only inside a subquery (`WHERE id IN (SELECT … WHERE user_id = ?)`) still reads or
  // writes its own table across every tenant: at least one predicate (or the INSERT slot) must be on it.
  // (A FROM-less SELECT of scalar subqueries has no table of its own, so it's exempt.)
  if (tenant.size && !outer && !valueSlots.size && groupWords(sql, -1).some(({ w }) => w === "FROM" || w === "UPDATE" || w === "INTO")) throw new TenantScopeError("the tenant predicate is only inside a subquery; the statement's own table is unscoped");
  const plan = { total: offs.length, tenant: [...tenant].sort((a, b) => a - b) };
  if (planCache.size >= PLAN_CACHE_MAX) planCache.delete(planCache.keys().next().value!);
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
