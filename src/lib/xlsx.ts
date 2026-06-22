// Minimal, dependency-light .xlsx (OOXML SpreadsheetML) writer for the Worker.
//
// WHY hand-rolled: the only thing we need is to WRITE a fixed, structured multi-sheet workbook —
// no reading, no formulas, no charts. Full-featured writers (exceljs, sheetjs) pull Node built-ins
// or are large; write-excel-file's universal `toBlob()` routes through fflate's ASYNC `zip()` (Web
// Workers), which is unreliable on workerd. fflate's SYNCHRONOUS `zipSync` IS workerd-safe, and an
// .xlsx is just a ZIP of a handful of XML parts — so we emit those parts ourselves and zip them
// synchronously. No Node built-ins, no Web Workers, no async. (Local runtime is deploy-only, so the
// fewer runtime surprises the better.)
//
// Strings are written as inline strings (`t="inlineStr"`) to avoid a sharedStrings table. Callers
// MUST neutralise spreadsheet formula injection on attacker-influenceable text BEFORE handing it
// here (see csvCell's leading =,+,-,@ guard) — this writer does not interpret cell content, but it
// also does not add the guard.

import { zipSync, strToU8 } from "fflate";

export interface XlsxCell {
  /** Number → numeric cell; string → inline-string cell. */
  v: string | number;
  bold?: boolean;
  /** Render a numeric cell with the money format (#,##0.00). Ignored for string cells. */
  money?: boolean;
}

export interface XlsxSheet {
  /** Tab name. Sanitised + truncated to Excel's 31-char limit and de-duplicated by buildXlsx. */
  name: string;
  rows: XlsxCell[][];
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function escapeXml(s: string): string {
  // Strip characters that are illegal in XML 1.0 (C0 controls except tab/LF/CR) — bank-feed/OCR
  // merchant strings can carry stray control bytes that would make the worksheet XML malformed and
  // the whole workbook unopenable in Excel. Then escape the five markup-significant characters.
  return s
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

// 0-based column index → A1 column letters (0→A, 25→Z, 26→AA …).
function colLetter(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Excel forbids these in a sheet/tab name and caps the length at 31. De-dup with a numeric suffix.
function sanitiseSheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim() || "Sheet";
  if (base.length > 31) base = base.slice(0, 31).trim();
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` ${n++}`;
    candidate = (base.length + suffix.length > 31 ? base.slice(0, 31 - suffix.length).trim() : base) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// Style indices into the cellXfs table emitted by stylesXml(): 0 normal, 1 bold, 2 money, 3 bold money.
function styleIndex(c: XlsxCell): number {
  const money = typeof c.v === "number" && c.money;
  if (money && c.bold) return 3;
  if (money) return 2;
  if (c.bold) return 1;
  return 0;
}

function cellXml(c: XlsxCell, ref: string): string {
  const s = styleIndex(c);
  const sAttr = s ? ` s="${s}"` : "";
  if (typeof c.v === "number") {
    return `<c r="${ref}"${sAttr}><v>${c.v}</v></c>`;
  }
  return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(c.v)}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet): string {
  // Auto column widths from content length, clamped to a sensible range.
  const widths: number[] = [];
  for (const row of sheet.rows) {
    row.forEach((c, i) => {
      const len = String(c.v).length;
      if (len > (widths[i] ?? 0)) widths[i] = len;
    });
  }
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(70, Math.max(10, w + 2))}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const rowsXml = sheet.rows
    .map((row, r) => {
      const cells = row.map((c, i) => cellXml(c, `${colLetter(i)}${r + 1}`)).join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return (
    XML_HEADER +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    cols +
    `<sheetData>${rowsXml}</sheetData>` +
    "</worksheet>"
  );
}

function stylesXml(): string {
  return (
    XML_HEADER +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // 0 normal
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' + // 1 bold
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' + // 2 money
    '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' + // 3 bold money
    "</cellXfs>" +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    "</styleSheet>"
  );
}

/**
 * Build an .xlsx workbook from sheets. Returns the raw file bytes (a ZIP of OOXML parts), produced
 * SYNCHRONOUSLY via fflate.zipSync (workerd-safe). Sheet names are sanitised + de-duplicated.
 */
export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  const used = new Set<string>();
  const named = sheets.map((s) => ({ ...s, name: sanitiseSheetName(s.name, used) }));

  const stylesRid = `rId${named.length + 1}`;
  const workbookXml =
    XML_HEADER +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    "<sheets>" +
    named.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    "</sheets></workbook>";

  const workbookRels =
    XML_HEADER +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    named
      .map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join("") +
    `<Relationship Id="${stylesRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    "</Relationships>";

  const contentTypes =
    XML_HEADER +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    named.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    "</Types>";

  const rootRels =
    XML_HEADER +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>";

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "xl/workbook.xml": strToU8(workbookXml),
    "xl/_rels/workbook.xml.rels": strToU8(workbookRels),
    "xl/styles.xml": strToU8(stylesXml()),
  };
  named.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s));
  });

  return zipSync(files, { level: 6 });
}
