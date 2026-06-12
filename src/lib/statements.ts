import { parseDate, cleanMerchant } from "./bank-parsers";
import { sha256hex } from "./base64";

/**
 * Bank/credit-card statement (CSV) parsing. AU bank CSVs vary wildly, so Claude infers a
 * ColumnMap once per file (which column is what + date format + sign convention) and this
 * module does the deterministic parsing of every row, reusing the battle-tested date/amount
 * helpers from bank-parsers. PDF statements (later) emit the same StatementLine shape.
 */

export interface ColumnMap {
  header_row: number; // 0-based index of the header row (skip CommBank-style preamble)
  date_col: number;
  description_col: number;
  amount_col?: number | null; // single signed amount column
  debit_col?: number | null; // separate debit column (spend, usually positive)
  credit_col?: number | null; // separate credit column (income, usually positive)
  balance_col?: number | null;
  // how to read a single signed amount column:
  sign_convention?: "negative_is_debit" | "positive_is_debit" | "split";
}

export interface StatementLine {
  date: string | null; // YYYY-MM-DD
  amount_cents: number; // absolute
  direction: "debit" | "credit";
  description: string; // cleaned
  raw_description: string;
  balance_cents: number | null; // running balance after this line, if the statement shows it
}

/** Signed amount in cents: debits reduce the balance, credits increase it. */
export function signedCents(line: { amount_cents: number; direction: "debit" | "credit" }): number {
  return line.direction === "debit" ? -line.amount_cents : line.amount_cents;
}

// Liability accounts (credit cards, loans) move the OPPOSITE way to an asset account: a debit
// (purchase / draw-down) INCREASES the balance owed and a credit (payment / refund) reduces it.
// Reconciliation flips the running-balance sign for these so opening + Σ moves == closing holds.
const LIABILITY_ACCOUNT_TYPES = new Set(["credit_card", "loan"]);
export function isLiabilityAccount(type: string | null | undefined): boolean {
  return type != null && LIABILITY_ACCOUNT_TYPES.has(type);
}

/** 0..1 token-overlap similarity between two merchant/description strings (for receipt↔line matching). */
export function fuzzyMerchant(a: string, b: string): number {
  const toks = (s: string) =>
    new Set(
      cleanMerchant(s)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3),
    );
  const A = toks(a);
  const B = toks(b);
  if (A.size === 0 || B.size === 0) return 0;
  let overlap = 0;
  for (const t of A) if (B.has(t)) overlap++;
  return overlap / Math.min(A.size, B.size);
}

/** Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes, embedded commas/newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // drop fully-empty rows
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

function num(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = parseFloat(raw.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Turn raw CSV rows into normalised statement lines using the inferred column map. */
export function applyColumnMap(rows: string[][], map: ColumnMap): StatementLine[] {
  const out: StatementLine[] = [];
  const start = Math.max(0, (map.header_row ?? 0) + 1);
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const rawDesc = (r[map.description_col] ?? "").trim();
    const date = parseDate((r[map.date_col] ?? "").trim());
    if (!rawDesc && !date) continue;

    let amount_cents: number | null = null;
    let direction: "debit" | "credit" = "debit";

    if (map.debit_col != null || map.credit_col != null) {
      const d = map.debit_col != null ? num(r[map.debit_col]) : null;
      const c = map.credit_col != null ? num(r[map.credit_col]) : null;
      if (d && Math.abs(d) > 0) {
        amount_cents = Math.round(Math.abs(d) * 100);
        direction = "debit";
      } else if (c && Math.abs(c) > 0) {
        amount_cents = Math.round(Math.abs(c) * 100);
        direction = "credit";
      }
    } else if (map.amount_col != null) {
      const a = num(r[map.amount_col]);
      if (a != null && a !== 0) {
        const positiveIsDebit = map.sign_convention === "positive_is_debit";
        direction = a < 0 ? "debit" : positiveIsDebit ? "debit" : "credit";
        amount_cents = Math.round(Math.abs(a) * 100);
      }
    }
    if (amount_cents == null || amount_cents <= 0) continue; // skip unparseable / zero rows

    const balRaw = map.balance_col != null ? num(r[map.balance_col]) : null;
    out.push({
      date,
      amount_cents,
      direction,
      description: cleanMerchant(rawDesc) || rawDesc,
      raw_description: rawDesc,
      balance_cents: balRaw != null ? Math.round(balRaw * 100) : null,
    });
  }
  return out;
}

// Internal movements / card payments are NOT spend — counting them would double-count (the
// card's purchases are the real expenses). DELIBERATELY conservative: wrongly dropping a real
// expense is worse than occasionally counting a transfer (the user can mark it ignored).
// So we only AUTO-flag (a) credit-card bill payments and (b) clearly-internal transfers to one's
// own savings. NOT BPAY/Osko/PayAnyone — those pay real third parties (deductible bills).
const CARD_PAYMENT_RE = /\b(credit\s?card\s?payment|card\s?member\s?payment|payment\s?to\s?card|mastercard\s?payment|visa\s?payment|amex\s?payment|cardmember\s?payment)\b/i;
const INTERNAL_RE = /\b(to\s?savings|from\s?savings|own\s?account|internal\s?transfer|netbank\s?transfer|transfer\s?to\s?savings)\b/i;
// A MASKED own-account transfer, e.g. "Transfer to xx6819", "Transfer from xx6819 CommBank app".
// Deliberately MATCHES ONLY the masked xx#### form banks render for one's OWN linked accounts — NOT
// a bare BSB/account number (PayAnyone like "Transfer To 062000 12345678 Joe Tradie" is a real
// third-party payment) and NOT a name ("Transfer From Catherine Soper" is rental income). Because
// even a masked transfer can occasionally be ambiguous, this class is NEVER auto-ignored at ingest —
// it rides the Stage-A pre-checked CONFIRM list (autoIgnoreSafe stays false).
const NUMBERED_TRANSFER_RE = /\btransfer\s+(?:to|from)\b[^a-z]*x{2,4}\d{2,}/i;
// Loan / mortgage repayments and redraws. These can hide a DEDUCTIBLE investment-loan INTEREST
// component (s8-1), so they are NEVER auto-ignored AND never offered for one-tap exclusion — only
// surfaced for review (Stage A B3). The bare "loan" token is intentionally broad: false positives
// only land in the review list (no one-tap exclude), so over-matching can't silently drop spend.
const LOAN_REPAYMENT_RE = /\b(loan|ln\s?repay|mortgage|redraw)\b/i;
// Deposits into investment / brokerage / micro-invest apps — capital movements (money OUT), not
// spend. Only treated as a movement on a DEBIT (a credit from one of these is likely a dividend /
// capital return = assessable income, never swept) — see movementTreatment.
const INVESTMENT_DEPOSIT_RE = /\b(stake(?:shop)?|commsec|pearler|spaceship|raiz|superhero|selfwealth|vanguard\s?personal|sharesight)\b/i;

/** What a bank line really is, for the deterministic Stage-A clean-up sweep. */
export type MovementClass =
  | "internal_transfer" // own-account / to savings / masked numbered transfer
  | "card_payment" // credit-card bill payment
  | "loan_repayment" // loan/mortgage/redraw — REVIEW only (may hide deductible interest)
  | "investment_deposit" // deposit into a brokerage / micro-invest app
  | "none";

export interface MovementVerdict {
  /** The detected class of non-spend movement (or "none"). */
  klass: MovementClass;
  /** True ONLY for the conservative legacy set safe to auto-ignore at INGEST (no user confirm). */
  autoIgnoreSafe: boolean;
  /** GENERAL-INFO phrasing for the confirm list (why this looks like a non-spend movement). */
  reason: string;
}

/**
 * Classify a bank line as a non-spend MOVEMENT (transfer / card payment / loan repayment /
 * investment deposit) or "none". Pure + unit-tested. ONLY the conservative legacy set — card
 * payments and keyword-internal transfers — is `autoIgnoreSafe` (used at ingest, byte-identical to
 * the old isTransferLike). Masked numbered transfers, loan repayments and investment deposits are
 * detected but are NEVER auto-ignored — they ride the Stage-A pre-checked confirm/review surface,
 * so a deductible component can't be silently dropped from the position/review queue.
 */
export function classifyMovement(description: string): MovementVerdict {
  const s = description ?? "";
  if (CARD_PAYMENT_RE.test(s))
    return { klass: "card_payment", autoIgnoreSafe: true, reason: "Looks like a credit-card bill payment (the card's purchases are the real expenses)." };
  if (INTERNAL_RE.test(s))
    return { klass: "internal_transfer", autoIgnoreSafe: true, reason: "Looks like a transfer between your own accounts (not spend)." };
  if (NUMBERED_TRANSFER_RE.test(s))
    return { klass: "internal_transfer", autoIgnoreSafe: false, reason: "Looks like a transfer to one of your own linked accounts (not spend) — confirm before excluding." };
  if (LOAN_REPAYMENT_RE.test(s))
    return { klass: "loan_repayment", autoIgnoreSafe: false, reason: "Looks like a loan/mortgage repayment. Review before excluding — any investment-loan interest may be deductible." };
  if (INVESTMENT_DEPOSIT_RE.test(s))
    return { klass: "investment_deposit", autoIgnoreSafe: false, reason: "Looks like a deposit into an investment/brokerage app (a capital movement, not spend)." };
  return { klass: "none", autoIgnoreSafe: false, reason: "" };
}

/** Conservative auto-ignore predicate used at ingest — byte-identical to the legacy set (card payments + keyword-internal transfers). */
export function isTransferLike(description: string): boolean {
  return classifyMovement(description).autoIgnoreSafe;
}

/**
 * Detect an itemised "interest charged" line on a LOAN statement (#165). Used only when aggregating a
 * loan account's own lines, so any line that mentions interest is the lender's interest charge — EXCEPT
 * non-charge mentions (a rate notice, an interest-saver/offset sweep, "interest free"). Summing these
 * per FY pre-populates a statement_parsed loan-interest summary the user then confirms. Pure + unit-tested.
 */
export function isLoanInterestLine(description: string): boolean {
  const d = (description ?? "").toLowerCase();
  if (!/\binterest\b/.test(d)) return false;
  // Non-charge mentions (either side of "interest"): rate notices, interest-saver / offset / free /
  // bonus / redraw lines. A genuine charge reads "interest charged / debit interest / loan interest".
  if (/\b(rate|saver|free|offset|bonus|redraw)\b/.test(d)) return false;
  return true;
}

/**
 * How the Stage-A sweep should treat a classified line, given its direction. Shared by the read
 * (sweepMovements) and write (applyMovementSweep) paths so they can never disagree:
 *  - "ignorable" → safe to offer for one-tap exclusion (pre-checked confirm list);
 *  - "review"    → surfaced read-only, NEVER one-tap excluded (loan lines — possible deductible interest, B3);
 *  - "skip"      → not a sweepable movement (e.g. a credit that may be income).
 */
export function movementTreatment(klass: MovementClass, direction: string | null | undefined): "ignorable" | "review" | "skip" {
  if (klass === "none") return "skip";
  if (klass === "loan_repayment") return "review"; // B3 — may carry deductible interest; never one-tap exclude
  // An investment/brokerage deposit is a CAPITAL movement — not a deduction, not income, but
  // CGT-relevant. Route BOTH directions to "skip" so it falls THROUGH the sweep into the clarify queue,
  // where the user explicitly tags it via the "capital" answer (Investment / shares) rather than having
  // it silently one-tap excluded. (A credit into a brokerage app is likely a dividend / capital return
  // = assessable income — also a clarify decision, never a sweep exclude.)
  if (klass === "investment_deposit") return "skip";
  return "ignorable"; // internal_transfer / card_payment — non-income movements either direction
}

/**
 * Per-line fingerprint for re-upload de-dup (account-scoped). Includes balance when present.
 *
 * `direction` is part of the key so a charge and its same-day same-amount refund never collide
 * (amount_cents is stored unsigned). `occurrence` distinguishes genuine repeats — two identical
 * lines on the same day (common on credit cards, which carry no running balance to separate them):
 * the Nth such line gets a `#N` suffix so it isn't silently dropped by the unique-fingerprint guard.
 * Occurrence is assigned by the caller in parse order, so an exact re-upload reproduces the same
 * fingerprints (idempotent); only the first occurrence is unsuffixed to keep unique lines stable.
 */
export function lineFingerprint(accountId: string, line: StatementLine, occurrence = 0): Promise<string> {
  const norm = cleanMerchant(line.raw_description).toLowerCase();
  const bal = line.balance_cents != null ? `|${line.balance_cents}` : "";
  const dir = line.direction ?? "debit";
  const occ = occurrence > 0 ? `|#${occurrence}` : "";
  return sha256hex(`${accountId}|${line.date}|${line.amount_cents}|${dir}|${norm}${bal}${occ}`);
}

export interface Reconciliation {
  available: boolean; // false when the statement carries no balances to check against
  ok: boolean; // expected closing == stated closing (to the cent) AND continuity holds
  opening_cents: number | null;
  closing_cents: number | null;
  expected_cents: number | null; // opening + Σ signed amounts
  diff_cents: number; // expected - closing (0 when ok)
  txn_count: number;
  first_bad_line: number | null; // 0-based index of the first line whose running balance breaks
}

/**
 * Derive opening/closing from per-line balances (CSV). The balance shown is AFTER the line, so
 * opening = first line's balance − the signed move that produced it; closing = last line's balance.
 * MUST use the same liability sign-flip as reconcileStatement (a liability debit INCREASES the balance):
 * without it, a credit-card/loan CSV's opening is off by 2×signedCents and reconcile fails at line 0,
 * blocking every such import.
 */
export function deriveBalances(lines: StatementLine[], isLiability = false): { opening_cents: number; closing_cents: number } | null {
  const withBal = lines.filter((l) => l.balance_cents != null);
  if (withBal.length < 1 || lines[0]?.balance_cents == null || lines[lines.length - 1]?.balance_cents == null) return null;
  const first = lines[0]!;
  const last = lines[lines.length - 1]!;
  const dir = isLiability ? -1 : 1;
  return { opening_cents: (first.balance_cents as number) - dir * signedCents(first), closing_cents: last.balance_cents as number };
}

/**
 * Balance reconciliation — the mathematical proof an import is complete + accurate.
 * Checks opening + Σ(signed amounts) == closing, and per-line running-balance continuity to
 * pinpoint the first broken line. `available:false` when the statement has no balances.
 */
export function reconcileStatement(
  lines: StatementLine[],
  opening_cents: number | null,
  closing_cents: number | null,
  isLiability = false,
): Reconciliation {
  const txn_count = lines.length;
  if (opening_cents == null || closing_cents == null) {
    return { available: false, ok: false, opening_cents, closing_cents, expected_cents: null, diff_cents: 0, txn_count, first_bad_line: null };
  }
  // Asset accounts: debit reduces the balance. Liability accounts (credit card / loan): debit
  // INCREASES the balance owed — so flip the sign of every signed move for those.
  const dir = isLiability ? -1 : 1;
  let running = opening_cents;
  let first_bad_line: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    running += dir * signedCents(lines[i]!);
    const bal = lines[i]!.balance_cents;
    if (first_bad_line === null && bal != null && Math.abs(running - bal) > 1) first_bad_line = i;
  }
  const expected_cents = running;
  const diff_cents = expected_cents - closing_cents;
  const ok = Math.abs(diff_cents) <= 1 && first_bad_line === null;
  return { available: true, ok, opening_cents, closing_cents, expected_cents, diff_cents, txn_count, first_bad_line };
}
