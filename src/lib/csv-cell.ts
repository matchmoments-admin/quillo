// One CSV cell writer for every CSV the app hands a user (the accountant pack, the WFH diary), so the
// escaping and the formula-injection guard can't drift between exports (review: CSV).
//
// Formula injection (OWASP "CSV Injection"): a cell whose text starts with = + - @ TAB or CR can be
// evaluated by a spreadsheet. Merchant / description / note text is user- or statement-supplied, so such a
// cell is prefixed with ' and the spreadsheet shows it as literal text. Then RFC 4180: a cell holding a
// quote, comma, CR or LF is wrapped in quotes with inner quotes doubled. Numbers pass through untouched;
// null/undefined is an empty cell.

export type CsvCellValue = string | number | null | undefined;

/** The OWASP leading-character set: = + - @ TAB CR. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** Prefix a formula-looking string with ' (shared by the CSV and xlsx emitters). */
export function neutraliseFormula(s: string): string {
  return FORMULA_LEAD.test(s) ? `'${s}` : s;
}

export function csvCell(v: CsvCellValue): string {
  if (v == null) return "";
  if (typeof v === "number") return String(v);
  const s = neutraliseFormula(v);
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
