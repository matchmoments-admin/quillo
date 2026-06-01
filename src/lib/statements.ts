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

/** Per-line fingerprint for re-upload de-dup (account-scoped). Includes balance when present. */
export function lineFingerprint(accountId: string, line: StatementLine): Promise<string> {
  const norm = cleanMerchant(line.raw_description).toLowerCase();
  const bal = line.balance_cents != null ? `|${line.balance_cents}` : "";
  return sha256hex(`${accountId}|${line.date}|${line.amount_cents}|${norm}${bal}`);
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
 * Derive opening/closing from per-line balances (CSV). The balance shown is AFTER the line,
 * so opening = first line's balance − its signed amount; closing = last line's balance.
 */
export function deriveBalances(lines: StatementLine[]): { opening_cents: number; closing_cents: number } | null {
  const withBal = lines.filter((l) => l.balance_cents != null);
  if (withBal.length < 1 || lines[0]?.balance_cents == null || lines[lines.length - 1]?.balance_cents == null) return null;
  const first = lines[0]!;
  const last = lines[lines.length - 1]!;
  return { opening_cents: (first.balance_cents as number) - signedCents(first), closing_cents: last.balance_cents as number };
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
): Reconciliation {
  const txn_count = lines.length;
  if (opening_cents == null || closing_cents == null) {
    return { available: false, ok: false, opening_cents, closing_cents, expected_cents: null, diff_cents: 0, txn_count, first_bad_line: null };
  }
  let running = opening_cents;
  let first_bad_line: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    running += signedCents(lines[i]!);
    const bal = lines[i]!.balance_cents;
    if (first_bad_line === null && bal != null && Math.abs(running - bal) > 1) first_bad_line = i;
  }
  const expected_cents = running;
  const diff_cents = expected_cents - closing_cents;
  const ok = Math.abs(diff_cents) <= 1 && first_bad_line === null;
  return { available: true, ok, opening_cents, closing_cents, expected_cents, diff_cents, txn_count, first_bad_line };
}
