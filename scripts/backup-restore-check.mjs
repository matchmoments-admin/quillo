#!/usr/bin/env node
// Restore-test helper for docs/security/backup-dr.md (#635). Read-only: it opens SQLite files with
// readOnly and prints a SELECT for remote counts — it never writes to any database.
//
//   node scripts/backup-restore-check.mjs compare <source.sqlite> <restored.sqlite>
//       per-table row counts + schema-object counts + a content hash, source vs restored → PASS/FAIL
//   node scripts/backup-restore-check.mjs count-sql <restored.sqlite>
//       prints ONE read-only SELECT of every table's COUNT(*) (scalar subqueries — D1 rejects a long
//       UNION ALL with "too many terms in compound SELECT")
//   node scripts/backup-restore-check.mjs compare-remote <restored.sqlite> <wrangler-json-output>
//       compares the restored DB's counts with `wrangler d1 execute --remote --json --command "<that SELECT>"`
//
// Local D1 files live under .wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite (or under
// <persist-to>/v3/d1/... for a scratch DB created with --persist-to).
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const TABLES = `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`;
const open = (p) => new DatabaseSync(p, { readOnly: true });
const tablesOf = (db) => db.prepare(TABLES).all().map((r) => r.name);
const countsOf = (db, tables) => Object.fromEntries(tables.map((t) => [t, Number(db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n)]));
const sum = (o) => Object.values(o).reduce((s, n) => s + n, 0);

function snapshot(p) {
  const db = open(p);
  const tables = tablesOf(db);
  const counts = countsOf(db, tables);
  const objects = Object.fromEntries(
    db.prepare(`SELECT type, COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' GROUP BY type ORDER BY type`).all().map((r) => [r.type, Number(r.n)]),
  );
  const hash = createHash("sha256");
  for (const t of tables) for (const r of db.prepare(`SELECT * FROM "${t}" ORDER BY 1`).all()) hash.update(t + JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
  return { counts, objects, content: hash.digest("hex").slice(0, 16) };
}

const [mode, a, b] = process.argv.slice(2);
if (mode === "compare" && a && b) {
  const [x, y] = [snapshot(a), snapshot(b)];
  const names = [...new Set([...Object.keys(x.counts), ...Object.keys(y.counts)])].sort();
  const mismatches = names.filter((t) => x.counts[t] !== y.counts[t]).map((t) => `${t}: ${x.counts[t]} vs ${y.counts[t]}`);
  const pass = !mismatches.length && x.content === y.content && JSON.stringify(x.objects) === JSON.stringify(y.objects);
  console.log(JSON.stringify({
    source: { tables: Object.keys(x.counts).length, rows: sum(x.counts), objects: x.objects, content: x.content },
    restored: { tables: Object.keys(y.counts).length, rows: sum(y.counts), objects: y.objects, content: y.content },
    non_empty_tables: names.filter((t) => x.counts[t] > 0).length,
    mismatches,
    result: pass ? "PASS" : "FAIL",
  }, null, 2));
  process.exit(pass ? 0 : 1);
} else if (mode === "count-sql" && a) {
  console.log("SELECT " + tablesOf(open(a)).map((t) => `(SELECT COUNT(*) FROM "${t}") AS "${t}"`).join(", "));
} else if (mode === "compare-remote" && a && b) {
  const db = open(a);
  const tables = tablesOf(db);
  const local = countsOf(db, tables);
  const row = JSON.parse(readFileSync(b, "utf8"))[0].results[0];
  const remote = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
  const mismatches = tables.filter((t) => local[t] !== remote[t]).map((t) => `${t}: restored ${local[t]} vs remote ${remote[t]}`);
  console.log(JSON.stringify({ tables: tables.length, remote_rows: sum(remote), restored_rows: sum(local), non_empty_tables: tables.filter((t) => local[t] > 0).length, mismatches, result: mismatches.length ? "FAIL" : "PASS" }, null, 2));
  process.exit(mismatches.length ? 1 : 0);
} else {
  console.error("usage: compare <source.sqlite> <restored.sqlite> | count-sql <db.sqlite> | compare-remote <restored.sqlite> <remote.json>");
  process.exit(2);
}
