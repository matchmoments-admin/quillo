/**
 * PII redaction for FREE TEXT before it is sent to a text LLM call (fix H7).
 *
 * Scope note: receipt IMAGES are sent to Claude vision as-is (that is the OCR
 * input and cannot be redacted pre-OCR). This helper applies to free text only —
 * e.g. an email body used as a fallback "receipt", or any reasoning/advice prompt.
 * The cross-border exposure of image data is governed by the explicit APP-8
 * consent recorded per tenant (recordConsent), not by this function.
 *
 * AU identifiers covered: TFN (9 digits), ABN (11 digits), BSB+account, and
 * card PANs (13-19 digits). Patterns are deliberately conservative.
 */
const PATTERNS: Array<{ label: string; re: RegExp }> = [
  // Card PAN 13-19 digits, optionally separated by spaces/hyphens. Check first (longest).
  { label: "CARD", re: /\b(?:\d[ -]?){13,19}\b/g },
  // ABN: 11 digits, often grouped 2 3 3 3.
  { label: "ABN", re: /\b\d{2}[ ]?\d{3}[ ]?\d{3}[ ]?\d{3}\b/g },
  // TFN: 8-9 digits, often grouped 3 3 3 / 3 3 2.
  { label: "TFN", re: /\b\d{3}[ ]?\d{3}[ ]?\d{2,3}\b/g },
  // BSB (3-3) + account (5-10).
  { label: "BANK", re: /\b\d{3}[ -]?\d{3}\b(?:[ -]?\d{5,10})?/g },
];

export function redact(text: string): string {
  let out = text;
  for (const { label, re } of PATTERNS) {
    out = out.replace(re, `[REDACTED:${label}]`);
  }
  return out;
}

// ── S8b: statement-line redaction (ADR-0003 §10 S8b, #639; flag `redact_statement_lines`) ────────────────
//
// Why not redact()? It replaces ANY 6+ digit run (its TFN / BANK patterns), and statement descriptions are
// full of harmless ones the model uses to categorise — "UBER *TRIP 123456", store numbers, BPAY billers,
// receipt refs. Applying it to statement lines would change what the model sees for ordinary lines, hence the
// categorisation, hence the tax position (the reason S8b was declined alongside S8a in #507).
//
// So this is NARROW: it only touches text SHAPED like a bank identifier, and keeps merchant words, amounts
// ("12.50", "1,234.00"), dates ("12/03/2025", "2025-03-12"), order / invoice refs ("123-456") and bare digit runs:
//   * BANK (keyword) — "BSB 062000", "BSB: 062-000 ACC 12345678": the BSB and any account after it.
//   * ACCT — digit groups after an explicit account keyword ("ACCT 12345678", "Account No: 1234-5678", "ACC NO
//     1234 5678", "A/C 98765432"); the keyword is kept, the number replaced. Stops before a date ("…-03-12").
//   * CARD — a full PAN that passes Luhn AND has a card shape: 4-digit groups split by one space/hyphen, or a
//     contiguous run whose length + leading digits match a card scheme (Visa 4…, Mastercard 51–55 / 22–27, Amex
//     34/37, 6… debit) on a line with no BPAY / CRN / REF / INV marker (BPAY CRNs are Luhn-checked by design).
//     Masked forms ("xxxx 1234", "****1234") carry no PAN and are left alone.
//   * BANK (shape) — a BSB written with a hyphen FOLLOWED by an account ("062-000 12345678", "062000-12345678"),
//     not preceded by a letter or digit. A lone "123-456" is an order ref, not redacted.
// A line with none of these shapes is returned BYTE-IDENTICAL — which is what golden pfts8b relies on.

/** Luhn checksum over a digit string. */
function luhnOk(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Leading digits + length of a real card scheme (contiguous runs only — grouped 4-4-4-x is already card-shaped). */
function cardScheme(d: string): boolean {
  const n = d.length;
  if (d[0] === "4") return n === 13 || n === 16 || n === 19;
  if (/^(5[1-5]|2[2-7])/.test(d)) return n === 16;
  if (/^3[47]/.test(d)) return n === 15;
  if (d[0] === "6") return n >= 16 && n <= 19;
  return false;
}

// Not preceded / followed by a letter, digit or number-ish joiner, so dates, amounts, phone numbers
// ("1300-123-456") and alphanumeric refs ("INV123-456") never match part-way through.
const NB = String.raw`(?<![A-Za-z\d.,\/-])`;
const NA = String.raw`(?![\d.,\/-])`;
// A card number may END a sentence ("…1111." / "…1111,"): trailing punctuation not followed by a digit is fine.
const NA_CARD = String.raw`(?![\d\/-]|[.,]\d)`;
// The keyword → number separator: ONE run of separators, an optional "no"/"number", and only then a second run.
// (Two adjacent unbounded \s* runs backtrack polynomially on long whitespace.)
const SEP = String.raw`((?:\.?[\s:#]*)(?:(?:no|number|num)\.?[\s:#]*)?)`;
// An account number: digit groups split by single spaces/hyphens, never continuing into a date or an amount.
const ACCT_NUM = String.raw`\d{2,}(?:[ -](?!\d{4}-\d{2}-\d{2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\d{2,}){0,4}(?![\d.,]|-\d)`;
const NO_CARD_LINE = /\b(bpay|crn|ref|inv|invoice|biller)\b/i;

const STATEMENT_PATTERNS: Array<{ re: RegExp; replace: (m: string, ...g: string[]) => string }> = [
  {
    re: new RegExp(String.raw`\b(bsb)([\s:#]*)\d{3}[ -]?\d{3}(?:[\s,]+(?:(?:acc(?:t|ount)?|a\/c)${SEP})?${ACCT_NUM})?(?![\d.,])`, "gi"),
    replace: (_m, kw: string, sep: string) => `${kw}${sep}[REDACTED:BANK]`,
  },
  {
    re: new RegExp(String.raw`\b(acct|acc|accno|account|a\/c)${SEP}(${ACCT_NUM})`, "gi"),
    replace: (m: string, kw: string, sep: string, num: string) => (num.replace(/\D/g, "").length >= 5 ? `${kw}${sep}[REDACTED:ACCT]` : m),
  },
  {
    re: new RegExp(`${NB}(?:\\d{4}[ -]){3}\\d{1,7}${NA_CARD}|${NB}\\d{13,19}${NA_CARD}`, "g"),
    replace: (m: string, ...rest: unknown[]) => {
      const digits = m.replace(/[ -]/g, "");
      if (digits.length < 13 || digits.length > 19 || !luhnOk(digits)) return m;
      if (m === digits) {
        const line = String(rest[rest.length - 1] ?? "");
        if (!cardScheme(digits) || NO_CARD_LINE.test(line)) return m;
      }
      return "[REDACTED:CARD]";
    },
  },
  {
    re: new RegExp(`${NB}(?:\\d{3}-\\d{3}[ -]\\d{5,10}|\\d{6}-\\d{5,10})${NA}`, "g"),
    replace: () => "[REDACTED:BANK]",
  },
];

/**
 * Redact bank-identifier-shaped text (account / card / BSB) from a STATEMENT line's merchant text before a
 * model call. Pure; returns the input unchanged when nothing of that shape is present.
 */
export function redactStatementLine(text: string): string {
  let out = text;
  for (const { re, replace } of STATEMENT_PATTERNS) out = out.replace(re, replace as (substring: string, ...args: string[]) => string);
  return out;
}

/**
 * The statement rows exactly as categoriseStatement hands them to the model (live AND batch). `on` = the
 * `redact_statement_lines` flag. OFF ⇒ the SAME array back (byte-identical). ON ⇒ only `merchant` can differ,
 * and only for a row with an account / card / BSB shape. Shared with golden pfts8b so the test exercises the
 * production mapping, not a copy of it.
 */
export function statementLinesForModel<T extends { merchant: string | null }>(rows: T[], on: boolean): T[] {
  if (!on) return rows;
  return rows.map((r) => (r.merchant == null ? r : { ...r, merchant: redactStatementLine(r.merchant) }));
}
