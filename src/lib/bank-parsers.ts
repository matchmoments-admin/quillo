/**
 * Bank / merchant transaction-alert email body parser.
 *
 * Parses plain-text bodies of automated spend/alert emails into structured fields.
 * Pure and side-effect-free — no Claude calls, no I/O. Each parser function is
 * independently testable against sample strings.
 *
 * Conservative design: if anything is ambiguous or doesn't match, return null and
 * let the caller fall back to `needs_review`. Never guess at a partial match.
 *
 * Callers MUST redact the body with src/lib/redact.ts before passing it here
 * (card PANs, TFNs, bank account numbers are stripped before parsing).
 */

export interface ParsedAlert {
  /** Merchant / supplier name as extracted from the alert text. */
  merchant: string;
  /** Transaction amount in cents (integer, positive). */
  amount_cents: number;
  /** ISO date string YYYY-MM-DD, or null if not present in the alert. */
  txn_date: string | null;
}

// ── Pattern 1: CommBank-style spend alert ──────────────────────────────────
// Examples:
//   "You spent $42.50 at Shell Coles Express on 01/06/2026"
//   "You spent $1,234.56 at Amazon AU on 31 May 2026"
//   "You've spent $9.99 at Netflix on 01/06/2026"
const CBA_PATTERN =
  /you(?:'ve)?\s+spent\s+\$([0-9,]+(?:\.[0-9]{2})?)\s+at\s+(.+?)\s+on\s+([0-9]{1,2}[\/\s][A-Za-z0-9]+[\/\s][0-9]{4})/i;

// ── Pattern 2: Generic merchant receipt / "payment received" style ─────────
// Examples:
//   "Payment of $99.00 to BUNNINGS WAREHOUSE 1234 on 2026-06-01"
//   "Transaction: $250.00 to Officeworks Parramatta 2026-05-31"
//   "Amount: $45.20 | Merchant: JB Hi-Fi | Date: 01/06/2026"
const GENERIC_PAYMENT_PATTERN =
  /(?:payment\s+of|transaction[:\s]+|amount[:\s]+)\$([0-9,]+(?:\.[0-9]{2})?)\s+(?:(?:to|at)\s+|[|]\s*merchant[:\s]+)([A-Za-z0-9 &'\-,./]+?)(?:\s*[|]?\s*(?:date[:\s]+|on\s+))([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2})/i;

// ── Pattern 3: ANZ / Westpac / NAB one-liner style ─────────────────────────
// Examples:
//   "ANZ Alert: Card spend $55.00 WOOLWORTHS 1234 31/05/2026"
//   "Westpac: $18.50 UBER* EATS AU 2026-06-01"
//   "NAB: You made a $12.00 purchase at Boost Juice on 01-06-2026"
//   "Payment of $99.00 to BUNNINGS WAREHOUSE on 2026-06-01"  (also caught here)
const BANK_ALERT_PATTERN =
  /(?:(?:anz|westpac|nab|bankwest|st\.?\s*george|bendigo|suncorp|macquarie)\s*[:\-]?\s*)?(?:card\s+spend|purchase\s+at|you\s+made\s+a)?\s*\$([0-9,]+(?:\.[0-9]{2})?)\s+(?:(?:at|to)\s+)?([A-Za-z0-9 &'\-,.*]+?)\s+(?:on\s+)?([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2})/i;

/** Parse a dollar amount string like "1,234.56" → cents integer. */
function parseCents(raw: string): number | null {
  const n = parseFloat(raw.replace(/,/g, ""));
  if (isNaN(n) || n <= 0 || n > 1_000_000) return null;
  return Math.round(n * 100);
}

/**
 * Parse a date string in various Australian formats to ISO YYYY-MM-DD.
 * Handles: DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, "01 Jun 2026", "01/Jun/2026".
 * Returns null if the date cannot be parsed with confidence.
 */
function parseDate(raw: string): string | null {
  raw = raw.trim();

  // Already ISO: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    const dd = dmy[1] ?? "";
    const mm = dmy[2] ?? "";
    const yyyy = dmy[3] ?? "";
    const d = parseInt(dd, 10);
    const m = parseInt(mm, 10);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }

  // "01 Jun 2026" or "01/Jun/2026"
  const mon: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const named = raw.match(/^(\d{1,2})[\/\s]([A-Za-z]{3})[\/\s](\d{4})$/);
  if (named) {
    const dd = named[1] ?? "";
    const monStr = named[2] ?? "";
    const yyyy = named[3] ?? "";
    const mm = mon[monStr.toLowerCase()];
    if (!mm) return null;
    return `${yyyy}-${mm}-${dd.padStart(2, "0")}`;
  }

  return null;
}

/** Trim and normalise a raw merchant string: collapse whitespace, strip trailing digits/punctuation. */
function cleanMerchant(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[*]+/g, " ")           // "UBER* EATS" → "UBER  EATS"
    .replace(/\s+/g, " ")
    .replace(/\s+\d{3,}$/, "")      // strip trailing reference numbers like "WOOLWORTHS 1234"
    .trim();
}

/**
 * Attempt to parse a bank/merchant transaction-alert email body into structured fields.
 *
 * @param body - Plain text email body, ALREADY redacted via redact() from src/lib/redact.ts.
 * @returns ParsedAlert if a known pattern matched with sufficient confidence, or null.
 */
export function parseTransactionAlert(body: string): ParsedAlert | null {
  if (!body || body.length < 10) return null;

  // Normalise line endings and collapse runs of whitespace to single spaces.
  const text = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[ \t]+/g, " ").trim();

  // Try patterns in order of specificity (most specific first).
  const attempts: Array<[RegExp, string]> = [
    [CBA_PATTERN, "cba"],
    [GENERIC_PAYMENT_PATTERN, "generic"],
    [BANK_ALERT_PATTERN, "bank-alert"],
  ];

  for (const [pattern] of attempts) {
    const m = text.match(pattern);
    if (!m) continue;

    const amtRaw = m[1] ?? "";
    const merchantRaw = m[2] ?? "";
    const dateRaw = m[3] ?? "";
    const amount_cents = parseCents(amtRaw);
    if (!amount_cents) continue;

    const merchant = cleanMerchant(merchantRaw);
    if (!merchant || merchant.length < 2) continue;

    const txn_date = parseDate(dateRaw);
    // txn_date may be null for some patterns — still yield the result.

    return { merchant, amount_cents, txn_date };
  }

  return null;
}
