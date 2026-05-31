/**
 * Offline test for src/lib/bank-parsers.ts (no Claude calls, no network).
 *
 * Run: node scripts/test-bank-parsers.mjs
 *
 * Each case asserts the expected output from parseTransactionAlert().
 * Uses inline assertions (no test framework dependency).
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execSync } from "node:child_process";

// Compile the TS module to a temp CJS file so we can require it from this ESM script.
const __dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dir, "..");
const outFile = path.join(root, "node_modules", ".cache", "test-bank-parsers.cjs");

import fs from "node:fs";
fs.mkdirSync(path.dirname(outFile), { recursive: true });

// Transpile with tsc --module commonjs to a temp file for this test
execSync(
  `npx tsc --noEmit false --module commonjs --outDir ${path.dirname(outFile)} --rootDir ${path.join(root, "src")} ${path.join(root, "src/lib/bank-parsers.ts")} ${path.join(root, "src/lib/redact.ts")} --target es2022 --declaration false --sourceMap false 2>&1`,
  { cwd: root, stdio: "inherit" },
);

const require = createRequire(import.meta.url);
const { parseTransactionAlert } = require(path.join(path.dirname(outFile), "lib", "bank-parsers.js"));
const { redact } = require(path.join(path.dirname(outFile), "lib", "redact.js"));

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`         expected: ${JSON.stringify(expected)}`);
    console.error(`         actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertNull(label, actual) {
  assert(label, actual, null);
}

function assertParsed(label, body, expected) {
  const safe = redact(body);
  const result = parseTransactionAlert(safe);
  assert(label, result, expected);
}

console.log("\n── bank-parsers.ts offline tests ──\n");

// ── CommBank-style patterns ─────────────────────────────────────────────────

assertParsed(
  "CBA: 'You spent $X at MERCHANT on DD/MM/YYYY'",
  "You spent $42.50 at Shell Coles Express on 01/06/2026",
  { merchant: "Shell Coles Express", amount_cents: 4250, txn_date: "2026-06-01" },
);

assertParsed(
  "CBA with comma: 'You spent $1,234.56 at Amazon AU on 31 May 2026'",
  "You spent $1,234.56 at Amazon AU on 31 May 2026",
  { merchant: "Amazon AU", amount_cents: 123456, txn_date: "2026-05-31" },
);

assertParsed(
  "CBA with apostrophe: 'You've spent $9.99 at Netflix on 01/06/2026'",
  "You've spent $9.99 at Netflix on 01/06/2026",
  { merchant: "Netflix", amount_cents: 999, txn_date: "2026-06-01" },
);

// ── Generic payment patterns ────────────────────────────────────────────────

assertParsed(
  "Generic: 'Payment of $99.00 to BUNNINGS WAREHOUSE on 2026-06-01'",
  "Payment of $99.00 to BUNNINGS WAREHOUSE on 2026-06-01",
  { merchant: "BUNNINGS WAREHOUSE", amount_cents: 9900, txn_date: "2026-06-01" },
);

// ── Redaction integration ───────────────────────────────────────────────────

// A body with a card PAN — after redact(), the PAN is gone but merchant/amount remain parseable.
assertParsed(
  "CBA alert after redaction (card PAN stripped)",
  "You spent $55.00 at Woolworths on 31/05/2026 using card 4321 1234 5678 9012",
  { merchant: "Woolworths", amount_cents: 5500, txn_date: "2026-05-31" },
);

// ── Null cases (conservative fallback) ─────────────────────────────────────

assertNull(
  "Empty string → null",
  parseTransactionAlert(""),
);

assertNull(
  "Random email body with no spend pattern → null",
  parseTransactionAlert("Hi there, just confirming your order has been dispatched. Thank you for shopping with us!"),
);

assertNull(
  "Partial match (amount only, no merchant) → null",
  parseTransactionAlert("Your account has been debited $50.00"),
);

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
