#!/usr/bin/env tsx
// Offline unit tests for the pure invariants that underpin statement import + async
// categorisation. No worker runtime / D1 / Claude — these are the fast, deterministic
// regression guards for the rules we keep re-learning. Run: npm run test:units
import { reconcileStatement, deriveBalances, isTransferLike, signedCents, lineFingerprint, type StatementLine } from "../src/lib/statements";
import { batchStatementStatus, isStaleBatch, BATCH_MAX_AGE_MS } from "../src/lib/batch";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

const line = (o: Partial<StatementLine> & { amount_cents: number; direction: "debit" | "credit" }): StatementLine => ({
  date: "2026-01-01",
  description: o.description ?? "x",
  raw_description: o.raw_description ?? o.description ?? "x",
  balance_cents: null,
  ...o,
});

// ── Reconciliation: the completeness proof ───────────────────────────────────
console.log("reconcileStatement");
{
  // opening 100.00, -10, -20, +5 → expected 75.00; balances continuous.
  const lines: StatementLine[] = [
    line({ amount_cents: 1000, direction: "debit", balance_cents: 9000 }),
    line({ amount_cents: 2000, direction: "debit", balance_cents: 7000 }),
    line({ amount_cents: 500, direction: "credit", balance_cents: 7500 }),
  ];
  const bal = deriveBalances(lines)!;
  const r = reconcileStatement(lines, bal.opening_cents, bal.closing_cents);
  check("derives opening from first line + signed amount", bal.opening_cents === 10000);
  check("balanced statement reconciles (ok=true)", r.ok && r.available);
  check("diff is exactly 0 when balanced", r.diff_cents === 0);
  check("no first_bad_line when continuous", r.first_bad_line === null);

  // Tamper line 2's balance by $10 → continuity breaks at index 1, not 0.
  const tampered = lines.map((l, i) => (i === 1 ? { ...l, balance_cents: 8000 } : l));
  const t = reconcileStatement(tampered, bal.opening_cents, bal.closing_cents);
  check("tampered balance is caught (ok=false)", !t.ok);
  check("first_bad_line points at the tampered row", t.first_bad_line === 1);

  // Closing off by exactly -$10 (a dropped $10 debit) → diff = +1000 (expected > stated closing).
  const short = reconcileStatement(lines, bal.opening_cents, bal.closing_cents - 1000);
  check("dropped $10 surfaces as a $10 diff", Math.abs(short.diff_cents) === 1000 && !short.ok);

  // No balances → unavailable, not a false pass.
  const noBal = reconcileStatement([line({ amount_cents: 100, direction: "debit" })], null, null);
  check("no-balance statement reports available=false", !noBal.available && !noBal.ok);
}

// ── Transfer detection: conservative (never drop a real expense) ─────────────
console.log("isTransferLike");
{
  check("flags credit-card bill payment", isTransferLike("CREDIT CARD PAYMENT THANK YOU"));
  check("flags internal transfer to savings", isTransferLike("Transfer to Savings"));
  // Regression: BPAY to a real biller (Origin Energy) must NOT be dropped.
  check("does NOT flag BPAY Origin Energy (real bill)", !isTransferLike("BPAY Origin Energy 12345"));
  check("does NOT flag Osko payment to a person", !isTransferLike("Osko Payment John Smith"));
  check("does NOT flag a normal merchant", !isTransferLike("WOOLWORTHS 1234 SYDNEY"));
}

// ── signedCents ──────────────────────────────────────────────────────────────
console.log("signedCents");
{
  check("debit is negative", signedCents({ amount_cents: 500, direction: "debit" }) === -500);
  check("credit is positive", signedCents({ amount_cents: 500, direction: "credit" }) === 500);
}

// ── Batch outcome decisions ──────────────────────────────────────────────────
console.log("batchStatementStatus / isStaleBatch");
{
  check("all-errored, none applied → failed (not stuck categorising)", batchStatementStatus(0, 5) === "failed");
  check("some applied, some errored → imported", batchStatementStatus(3, 2) === "imported");
  check("all applied → imported", batchStatementStatus(10, 0) === "imported");
  check("nothing happened (0,0) → imported (no error to report)", batchStatementStatus(0, 0) === "imported");

  const now = 1_800_000_000_000; // fixed clock (Date.now() is unavailable here anyway)
  const justNow = new Date(now - 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  const old = new Date(now - BATCH_MAX_AGE_MS - 60_000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  check("a fresh submitted job is not stale", !isStaleBatch(justNow, now));
  check("a >24h submitted job is stale", isStaleBatch(old, now));
  check("unparseable timestamp is not treated as stale", !isStaleBatch("not-a-date", now));
}

// ── Fingerprint stability (re-upload de-dup) ─────────────────────────────────
console.log("lineFingerprint");
{
  const a = line({ amount_cents: 1234, direction: "debit", raw_description: "WOOLWORTHS  1234", balance_cents: 5000 });
  const b = line({ amount_cents: 1234, direction: "debit", raw_description: "woolworths 1234", balance_cents: 5000 });
  const c = line({ amount_cents: 9999, direction: "debit", raw_description: "WOOLWORTHS 1234", balance_cents: 5000 });
  const [fa, fb, fc] = await Promise.all([lineFingerprint("acct1", a), lineFingerprint("acct1", b), lineFingerprint("acct1", c)]);
  check("same line (case/whitespace-insensitive) → same fingerprint", fa === fb);
  check("different amount → different fingerprint", fa !== fc);
  const fOther = await lineFingerprint("acct2", a);
  check("account-scoped: same line, different account → different fingerprint", fa !== fOther);
}

console.log(`\n=== units: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
