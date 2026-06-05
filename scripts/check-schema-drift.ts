#!/usr/bin/env tsx
// Schema-drift guard: a fresh DB built from migrations/*.sql (applied IN ORDER) must reproduce the
// same tables + columns as schema.sql. This catches the class of bug the 0001 baseline fixed —
// schema.sql and the migration chain silently diverging, so a rebuild-from-migrations (DR, a fresh
// preview DB, a new tenant region) gets a different schema than production.
//
// Implementation: shell out to the `sqlite3` CLI (present on macOS dev + GitHub ubuntu runners).
// If sqlite3 isn't installed we SKIP (exit 0) with a loud notice rather than block — the check is a
// safety net, not a hard dependency for every environment.
//
// Scope: tables + column names (robust to column ordering and index/trigger differences). Index
// parity is a future tightening. Run: npx tsx scripts/check-schema-drift.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function have(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!have("sqlite3")) {
  console.log("⚠ sqlite3 CLI not found — skipping schema-drift check (install sqlite3 to run it).");
  process.exit(0);
}

const root = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quillo-drift-"));
const migDb = path.join(tmp, "mig.db");
const schemaDb = path.join(tmp, "schema.db");

function apply(db: string, sqlFile: string) {
  const sql = fs.readFileSync(sqlFile, "utf8");
  execFileSync("sqlite3", [db], { input: sql, stdio: ["pipe", "ignore", "pipe"] });
}

// Tables + columns as a sorted "table.column" set, ignoring SQLite/Cloudflare internal tables.
function columnSet(db: string): string[] {
  const out = execFileSync(
    "sqlite3",
    [
      db,
      "SELECT m.name||'.'||p.name FROM sqlite_master m JOIN pragma_table_info(m.name) p " +
        "WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '\\_cf%' ESCAPE '\\' ORDER BY 1;",
    ],
    { encoding: "utf8" },
  );
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

let failed = false;
try {
  // Build from migrations, in lexical order (0001, 0002, …).
  const migrations = fs.readdirSync(path.join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const f of migrations) {
    try {
      apply(migDb, path.join(root, "migrations", f));
    } catch (e) {
      console.error(`✗ migration ${f} failed to apply on a fresh DB:\n${(e as Error).message}`);
      process.exit(1);
    }
  }
  apply(schemaDb, path.join(root, "schema.sql"));

  const mig = new Set(columnSet(migDb));
  const schema = new Set(columnSet(schemaDb));
  const missingFromMig = [...schema].filter((c) => !mig.has(c)); // in schema.sql, not produced by migrations
  const extraInMig = [...mig].filter((c) => !schema.has(c)); // produced by migrations, absent from schema.sql

  console.log("schema drift (migrations/* vs schema.sql)");
  console.log(`  migrations build: ${mig.size} columns · schema.sql: ${schema.size} columns`);
  if (missingFromMig.length) {
    failed = true;
    console.log(`  ✗ ${missingFromMig.length} column(s) in schema.sql but NOT reproduced by migrations:`);
    for (const c of missingFromMig) console.log(`      - ${c}`);
  }
  if (extraInMig.length) {
    failed = true;
    console.log(`  ✗ ${extraInMig.length} column(s) produced by migrations but ABSENT from schema.sql:`);
    for (const c of extraInMig) console.log(`      + ${c}`);
  }
  if (!failed) console.log("  ✓ migrations reproduce schema.sql exactly (tables + columns)");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
