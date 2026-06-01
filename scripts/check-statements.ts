#!/usr/bin/env tsx
// Statement extraction test harness — the confidence number for statement import.
// For each evals/statements/*.csv with a matching *.expected.json, parse with the golden
// column map, reconcile, and diff the parsed lines against the expected set. Prints an
// accuracy % + reconcile pass-rate. CSV cases run fully offline (deterministic). PDF cases
// (a *.pdf + *.expected.json) need a worker runtime + Claude and are reported as skipped here.
//
// Run: npm run eval:statements
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv, applyColumnMap, deriveBalances, reconcileStatement } from "../src/lib/statements";

const dir = join(import.meta.dirname ?? "scripts", "..", "evals", "statements");
const files = readdirSync(dir);
const csvCases = files.filter((f) => f.endsWith(".csv"));

let totalExpected = 0,
  totalMatched = 0,
  reconPass = 0,
  reconTotal = 0,
  cases = 0;

for (const csv of csvCases) {
  const base = csv.replace(/\.csv$/, "");
  if (!files.includes(`${base}.expected.json`)) continue;
  cases++;
  const expected = JSON.parse(readFileSync(join(dir, `${base}.expected.json`), "utf8"));
  const lines = applyColumnMap(parseCsv(readFileSync(join(dir, csv), "utf8")), expected.columnMap);

  // Diff: a parsed line matches when (date, amount_cents, direction) all agree.
  const key = (l: { date: string | null; amount_cents: number; direction: string }) => `${l.date}|${l.amount_cents}|${l.direction}`;
  const got = new Set(lines.map(key));
  const exp: { date: string | null; amount_cents: number; direction: string }[] = expected.lines;
  const matched = exp.filter((e) => got.has(key(e))).length;
  const missed = exp.length - matched;
  const extra = lines.length - matched;

  const bal = deriveBalances(lines);
  const recon = reconcileStatement(lines, bal?.opening_cents ?? null, bal?.closing_cents ?? null);
  reconTotal++;
  const reconOk = recon.ok === (expected.reconcile_ok ?? true);
  if (reconOk) reconPass++;

  totalExpected += exp.length;
  totalMatched += matched;

  const acc = exp.length ? ((matched / exp.length) * 100).toFixed(0) : "—";
  console.log(
    `${base}: ${matched}/${exp.length} lines (${acc}%)  missed=${missed} extra=${extra}  ` +
      `reconcile ${recon.ok ? "✓" : "✗"}${reconOk ? "" : " (UNEXPECTED)"}  diff=$${(recon.diff_cents / 100).toFixed(2)}`,
  );
}

const pdfCases = files.filter((f) => f.endsWith(".pdf")).length;
const accuracy = totalExpected ? ((totalMatched / totalExpected) * 100).toFixed(1) : "—";
console.log(`\n=== ${cases} CSV case(s): line accuracy ${accuracy}% · reconcile ${reconPass}/${reconTotal} ===`);
if (pdfCases) console.log(`(${pdfCases} PDF case(s) skipped — run against the deployed worker with a real Claude call.)`);
process.exit(totalMatched === totalExpected && reconPass === reconTotal ? 0 : 1);
