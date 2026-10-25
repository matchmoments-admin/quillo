/**
 * The ONE in-memory D1 adapter for the test scripts: the D1Database surface the Worker uses, over real
 * SQLite (node:sqlite). It replaced a dozen hand-copied shims that disagreed on batch atomicity and
 * result shapes. It is faithful to production where tests have been fooled before:
 *
 * - batch() is atomic (BEGIN…COMMIT, ROLLBACK on any failure), as D1's is;
 * - more than D1_MAX_BINDS bound parameters throws, as D1 does (a 100+ id IN list must be chunked);
 * - undefined binds become NULL; run() reports meta.changes; first(col) returns one column.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { D1_MAX_BINDS } from "../../src/lib/d1-limits";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

export class SqliteD1Stmt {
  private params: unknown[] = [];
  constructor(private readonly sqlite: DatabaseSync, readonly sql: string) {}
  bind(...args: unknown[]) {
    if (args.length > D1_MAX_BINDS) throw new Error(`D1_ERROR: too many SQL variables (${args.length} > ${D1_MAX_BINDS})`);
    this.params = args.map((a) => (a === undefined ? null : a));
    return this;
  }
  async all<T = unknown>() {
    return { results: this.sqlite.prepare(this.sql).all(...(this.params as never[])) as T[], success: true, meta: {} };
  }
  async first<T = unknown>(col?: string): Promise<T | null> {
    const row = (this.sqlite.prepare(this.sql).get(...(this.params as never[])) as Record<string, unknown> | undefined) ?? null;
    if (row && col !== undefined) return (row[col] ?? null) as T;
    return row as T | null;
  }
  async run() {
    const r = this.sqlite.prepare(this.sql).run(...(this.params as never[]));
    return { success: true, meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
  }
  async raw<T = unknown[]>() {
    return this.sqlite.prepare(this.sql).all(...(this.params as never[])).map((r) => Object.values(r as object)) as T[];
  }
  /** What D1's batch returns per statement: SELECTs carry `.results`, writes carry `.meta`. */
  async settle() {
    return /^\s*(select|with)/i.test(this.sql) ? this.all() : this.run();
  }
}

export class SqliteD1 {
  /** How many batch() calls ran (some goldens assert a write happened in ONE round trip). */
  batches = 0;
  constructor(readonly sqlite: DatabaseSync = new DatabaseSync(":memory:")) {}
  prepare(sql: string) {
    return new SqliteD1Stmt(this.sqlite, sql);
  }
  async batch(stmts: SqliteD1Stmt[]) {
    this.batches++;
    this.sqlite.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) out.push(await s.settle());
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }
  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }
}

/** A fresh database built from every migration in order (what prod ran). */
export function migratedDb(): SqliteD1 {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.join(root, "migrations");
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(fs.readFileSync(path.join(dir, f), "utf8"));
  return new SqliteD1(sqlite);
}

/** A fresh database built from schema.sql (the lockstep snapshot). */
export function schemaDb(): SqliteD1 {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync(path.join(root, "schema.sql"), "utf8"));
  return new SqliteD1(sqlite);
}
