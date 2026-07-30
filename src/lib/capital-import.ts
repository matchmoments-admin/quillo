// Capital CSV import (C6, `capital_statement_ingest`) — PURE parsing. NO I/O, no model calls.
// Golden-tested in scripts/check-units.ts.
//
// WHY THIS EXISTS. Holdings and disposals were hand-entry only, and a BANK LINE FUNDAMENTALLY CANNOT TELL
// YOU units, price or brokerage — it knows a sum of money left the account and nothing else. A broker or
// exchange export does know. Every source the taxpayer actually has is a CSV: CommSec/Stake/SelfWealth
// transaction exports, share-registry statements, and crypto exchange exports (which will never have a
// "named format" worth special-casing — there are hundreds).
//
// So this is a GENERIC column-mapper, not a per-broker parser. The model infers which column is what, once
// per file (`extractCapitalColumnMap` in src/extract.ts), and everything here is deterministic. That is
// exactly the division of labour the bank-CSV path already uses: an LLM for the shape, pure code for every
// row. It also means a format we have never seen works on the first try.
//
// CONFIRM-BEFORE-WRITE is non-negotiable (see docs/capital-cgt-handoff.md §3 C6). This module produces
// DRAFT rows for the taxpayer to review. Nothing here writes, and the caller must never auto-commit an
// extraction: a wrong cost base silently distorts a capital gain years later, at disposal.
//
// JURISDICTION-NEUTRAL BY CONSTRUCTION. No currency, financial year or date convention is assumed here:
// `dayFirst` is a parameter (AU/UK read 03/04 as 3 April, the US as 4 March), amounts are plain minor units
// resolved against the tenant's base currency by the caller, and the FY of a disposal is derived by the
// caller's `fyForDate(date, jur)`. Adding a jurisdiction means passing a different descriptor, not editing
// this file.

import { parseDate } from "./bank-parsers";
import { cgtUnits } from "./cgt";

/** The asset kinds a CSV row may resolve to — mirrors the register's picker (CGT_KINDS). */
export const IMPORT_ASSET_KINDS = ["shares", "crypto", "managed_fund", "other"] as const;
export type ImportAssetKind = (typeof IMPORT_ASSET_KINDS)[number];

/**
 * Which column is what, for a holdings/disposals export. Deliberately a SUPERSET of what any one broker
 * emits — every field beyond `side` is optional, because a holdings-only export has no proceeds and a
 * disposal-only export has no acquisition date.
 *
 * All indexes are 0-based into the parsed row array.
 */
export interface CapitalColumnMap {
  /** 0-based index of the header row; rows above it are preamble and are skipped. */
  header_row: number;
  /** Ticker / asset code column (e.g. "VAS", "BTC"). */
  code_col?: number | null;
  /** Free-text asset name, used when there is no code. */
  label_col?: number | null;
  /** The trade/settlement date. For a BUY this is the acquisition date; for a SELL, the disposal date. */
  date_col?: number | null;
  /** Quantity of units/shares/coins. Fractional is normal (DRP, crypto) and is never rounded. */
  units_col?: number | null;
  /** Price PER UNIT. Multiplied by units when there is no total column. */
  unit_price_col?: number | null;
  /** Total consideration for the row, excluding fees. Preferred over unit_price × units when both exist. */
  total_col?: number | null;
  /** Brokerage/commission/exchange fee on this row. */
  fee_col?: number | null;
  /**
   * The column saying whether the row is an acquisition or a disposal ("BUY"/"SELL", "Buy"/"Sale").
   * Absent ⇒ every row is treated as an acquisition, which is the shape of a pure holdings export.
   */
  side_col?: number | null;
  /** Asset kind column, if the file distinguishes them. Absent ⇒ the caller's default kind is used. */
  kind_col?: number | null;
  /** True when dates read day-first (03/04 = 3 April). Set from the tenant's jurisdiction, never guessed. */
  day_first?: boolean;
}

/** A single draft row for the confirm screen. Never written without the taxpayer's say-so. */
export interface CapitalDraftRow {
  /** 1-based row number in the ORIGINAL file, so a problem row is findable in the user's spreadsheet. */
  source_row: number;
  side: "acquire" | "dispose";
  code: string | null;
  label: string | null;
  asset_kind: ImportAssetKind;
  date: string | null;
  units: number | null;
  /** Consideration excluding fees, in minor units (cents). */
  consideration_cents: number;
  /** Brokerage/fees on this row, in minor units. */
  fee_cents: number;
  /**
   * For an acquisition: cost base = consideration + fees (fees on a BUY increase the cost base).
   * For a disposal: proceeds = consideration − fees (selling costs REDUCE proceeds; they do NOT increase
   * the cost base, and counting them both ways would understate the gain — see costBaseFromElements).
   */
  amount_cents: number;
  /** Human-readable reason this row can't be imported as-is. Non-null ⇒ excluded from the commit. */
  problem: string | null;
}

export interface CapitalImportPreview {
  rows: CapitalDraftRow[];
  acquisitions: number;
  disposals: number;
  /** Rows that parsed but carry a problem — surfaced, never silently dropped. */
  problems: number;
  /** Rows skipped entirely as blank/unparseable noise (trailing spreadsheet junk). */
  skipped: number;
}

const cell = (row: string[], idx: number | null | undefined): string =>
  idx == null || idx < 0 || idx >= row.length ? "" : (row[idx] ?? "").trim();

/**
 * Money → integer minor units. Tolerates currency symbols, thousands separators, and parenthesised
 * negatives. Returns null (not 0) when there is no parseable number, so "missing" and "zero" stay
 * distinguishable — a zero cost base is a real, reportable state and must not be manufactured from a blank.
 */
export function parseMoneyCents(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || s.startsWith("-");
  // Strip everything that isn't a digit or a decimal point. Handles "$1,234.56", "AUD 1 234,56" is NOT
  // handled deliberately — a comma decimal separator is ambiguous against thousands grouping, and guessing
  // wrong by 100x on a cost base is far worse than refusing the row.
  const cleaned = s.replace(/[()]/g, "").replace(/[^0-9.]/g, "");
  if (!cleaned || !/[0-9]/.test(cleaned)) return null;
  const parts = cleaned.split(".");
  if (parts.length > 2) return null; // "1.234.56" — ambiguous, refuse rather than guess
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) * (negative ? -1 : 1);
}

/** Quantity → number. Fractional is normal and nothing is rounded (crypto, DRP). */
export function parseUnits(raw: string): number | null {
  const s = raw.trim().replace(/,/g, "");
  if (!s) return null;
  const v = Number(s.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(v) && v !== 0 ? cgtUnits(v) : null;
}

const DISPOSE_WORDS = /\b(sell|sale|sold|dispose|disposal|withdraw|redeem|redemption)\b/i;
const ACQUIRE_WORDS = /\b(buy|bought|purchase|acquire|acquisition|deposit|reinvest|drp)\b/i;

/** Read the BUY/SELL column. Unrecognised or absent ⇒ acquisition (the holdings-export shape). */
export function parseSide(raw: string): "acquire" | "dispose" {
  if (DISPOSE_WORDS.test(raw)) return "dispose";
  if (ACQUIRE_WORDS.test(raw)) return "acquire";
  return "acquire";
}

/** Normalise a free-text kind to one we model. Unrecognised ⇒ null so the caller's default applies. */
export function parseAssetKind(raw: string): ImportAssetKind | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (/crypto|coin|token|btc|eth|digital/.test(s)) return "crypto";
  if (/etf|fund|trust|managed/.test(s)) return "managed_fund";
  if (/share|stock|equity|security/.test(s)) return "shares";
  return null;
}

/**
 * Apply a column map to the parsed CSV rows, producing draft rows for review.
 *
 * Every row that cannot be imported carries a `problem` string rather than being dropped: a taxpayer whose
 * 40-row export silently became 37 holdings has no way to notice. Blank/structural rows ARE dropped, and
 * counted in `skipped`.
 */
export function applyCapitalColumnMap(
  rows: string[][],
  map: CapitalColumnMap,
  defaultKind: ImportAssetKind = "shares",
): CapitalImportPreview {
  const out: CapitalDraftRow[] = [];
  let skipped = 0;
  const start = Math.max(0, map.header_row + 1);

  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    // Structural noise: entirely blank, or a one-cell "Total"/footer line.
    if (row.every((c) => !c || !c.trim())) { skipped++; continue; }

    const code = cell(row, map.code_col) || null;
    const label = cell(row, map.label_col) || null;
    if (!code && !label) { skipped++; continue; } // nothing identifying the asset — spreadsheet junk

    const side = parseSide(cell(row, map.side_col));
    const kind = parseAssetKind(cell(row, map.kind_col)) ?? defaultKind;
    const date = parseCapitalDate(cell(row, map.date_col), map.day_first !== false);
    const units = parseUnits(cell(row, map.units_col));
    const fee = parseMoneyCents(cell(row, map.fee_col)) ?? 0;

    // Consideration: prefer an explicit total, else unit price × units. A total that already includes the
    // fee is indistinguishable from one that doesn't, so we trust the file's own total column and treat the
    // fee column as additive — which is how every export we have seen presents them.
    let consideration = parseMoneyCents(cell(row, map.total_col));
    if (consideration == null) {
      const price = parseMoneyCents(cell(row, map.unit_price_col));
      if (price != null && units != null) consideration = Math.round(price * units);
    }

    const problems: string[] = [];
    if (consideration == null) problems.push("no amount — needs a total or a unit price");
    if (units == null) problems.push("no quantity");
    if (!date) problems.push("no usable date");
    if (consideration != null && consideration < 0) problems.push("negative amount");

    const absConsideration = Math.abs(consideration ?? 0);
    const absFee = Math.abs(fee);
    out.push({
      source_row: i + 1,
      side,
      code,
      label,
      asset_kind: kind,
      date,
      units,
      consideration_cents: absConsideration,
      fee_cents: absFee,
      // Fees increase a cost base on the way in and reduce proceeds on the way out. Never both.
      amount_cents: side === "acquire" ? absConsideration + absFee : Math.max(0, absConsideration - absFee),
      problem: problems.length ? problems.join("; ") : null,
    });
  }

  return {
    rows: out,
    acquisitions: out.filter((r) => r.side === "acquire" && !r.problem).length,
    disposals: out.filter((r) => r.side === "dispose" && !r.problem).length,
    problems: out.filter((r) => r.problem).length,
    skipped,
  };
}

/**
 * Date parsing for an import row. Wraps the battle-tested bank `parseDate` but takes `dayFirst` as an
 * explicit parameter instead of assuming it: `parseDate` resolves an ambiguous DD/MM against AU convention,
 * which is wrong for the US. Adding a month-first jurisdiction is a change here and at the one call site
 * that supplies the flag — not a rewrite.
 */
export function parseCapitalDate(raw: string, dayFirst: boolean): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (!dayFirst) {
    // Month-first: swap the first two components before handing to the day-first parser.
    const mdy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (mdy) return parseDate(`${mdy[2]}/${mdy[1]}/${mdy[3]}`);
  }
  return parseDate(s);
}

/**
 * Group importable acquisitions by asset so the confirm screen can say "3 parcels of VAS" rather than
 * listing raw rows. Disposals are NOT grouped — each is its own CGT event with its own date and proceeds.
 */
export function summariseDrafts(rows: CapitalDraftRow[]): { key: string; code: string | null; label: string | null; asset_kind: ImportAssetKind; parcels: number; units: number; cost_base_cents: number }[] {
  const by = new Map<string, { key: string; code: string | null; label: string | null; asset_kind: ImportAssetKind; parcels: number; units: number; cost_base_cents: number }>();
  for (const r of rows) {
    if (r.problem || r.side !== "acquire") continue;
    const key = `${r.asset_kind}:${(r.code ?? r.label ?? "").toLowerCase()}`;
    const cur = by.get(key) ?? { key, code: r.code, label: r.label, asset_kind: r.asset_kind, parcels: 0, units: 0, cost_base_cents: 0 };
    cur.parcels++;
    // Plain addition: both operands are already-validated positive quantities, and `cgtUnits` is a
    // validator (null for <= 0), not a rounder. Nothing rounds units here — fractional is the norm.
    cur.units += r.units ?? 0;
    cur.cost_base_cents += r.amount_cents;
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => (a.code ?? a.label ?? "").localeCompare(b.code ?? b.label ?? ""));
}
