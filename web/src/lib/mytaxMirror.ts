// The myTax mirror (#790, flag mytax_mirror): the Ship it worksheet re-cut into one card per myTax SCREEN,
// in myTax's own order, so a first-timer can work down Quillo in one window and myTax in the other.
//
// PRESENTATION ONLY, and pure (no React, no DOM) so scripts/check-units.ts and the persona goldens can test it.
// It only re-groups the lines GET /api/mytax-worksheet already returns: every worksheet line lands on exactly
// one screen, unchanged, so the worksheet's tie_back to the report still holds for the mirror (pinned by the
// P1 Maya golden). No figure is computed here.
//
// Ticks reuse the worksheet's (lib/worksheetTicks.ts, profiles.ui_state.worksheet_ticks, per FY): a line keeps
// its worksheet tick id, so ticks made on the old worksheet carry over. A screen with nothing to tick line by
// line (only notes, or an income statement not entered yet) gets one screen-level tick, `mirror:<screen key>`.

import type { MytaxWorksheetLine, MytaxWorksheetSection } from "../types";
import type { AnyGlossaryKey } from "../content/glossary";
import { MIRROR_LINE_TERM, MIRROR_SCREENS, deductionScreenCopy, type FixedMirrorScreenKey, type MirrorScreenCopy } from "../content/mytaxMirror";
import { isTickable, tickId, tickState, type WorksheetTicks } from "./worksheetTicks";

export interface MirrorLine {
  /** The worksheet section the line came from (its tick id is `${sectionKey}:${line.key}`, unchanged). */
  sectionKey: string;
  line: MytaxWorksheetLine;
  tickId: string;
  term?: AnyGlossaryKey;
}

export interface MirrorScreen extends MirrorScreenCopy {
  key: string;
  lines: MirrorLine[];
  /** Set when no line is tickable: the card carries one "Done this screen" tick under this id. */
  screenTickId: string | null;
}

/** The fixed screen order (myTax's). Per-label deduction screens slot in after work_expenses, D6 → D15. */
export const SCREEN_ORDER: readonly FixedMirrorScreenKey[] = [
  "contact", "bank", "personalise",
  "salary", "government", "interest", "dividends", "rent", "managed_funds", "business", "foreign", "other_income",
  "work_expenses",
  "adjustments", "medicare", "spouse_tests",
];

export const SCREEN_TICK_SECTION = "mirror";

/** myTax's Income banner for a worksheet income line, from its paper item number (the pack's mytax_income_items). */
const INCOME_ITEM_SCREEN: Record<string, FixedMirrorScreenKey> = {
  "1": "salary", "5/6": "government", "10": "interest", "11": "dividends", "13": "managed_funds",
  "21": "rent", P8: "business", "20": "foreign", "24": "other_income",
};

/** D-label number ("D5", "D1/D5" ⇒ 1); null when it isn't a D-label. */
function dNumber(label: string): number | null {
  const m = /^D(\d+)/.exec(label);
  return m ? Number(m[1]) : null;
}

/** Which screen a worksheet line belongs on. Deduction labels past D5 get their own `deduction:<label>` screen. */
export function screenKeyFor(sectionKey: string, line: Pick<MytaxWorksheetLine, "key" | "label">): string {
  switch (sectionKey) {
    case "contact_bank":
      return line.key === "bank_details" ? "bank" : "contact";
    case "personalise":
      return "personalise";
    case "income_check":
    case "income_type_in":
      return INCOME_ITEM_SCREEN[line.label] ?? "other_income";
    case "rental":
      return "rent";
    case "business":
      return "business";
    case "deductions": {
      const n = dNumber(line.label);
      return n == null || n <= 5 ? "work_expenses" : `deduction:${line.label.split("/")[0]}`;
    }
    case "adjustments":
      return "adjustments";
    case "medicare":
      return "medicare";
    case "spouse_income_tests":
      return "spouse_tests";
    default:
      return "other_income";
  }
}

function lineTerm(line: MytaxWorksheetLine): AnyGlossaryKey | undefined {
  if (MIRROR_LINE_TERM[line.key]) return MIRROR_LINE_TERM[line.key];
  if (line.key.startsWith("rental_dep:")) return "depreciation";
  if (line.key === "tick:business") return "psi_status";
  if (line.key === "tick:whm_adjustment") return "working_holiday_maker";
  if (/working from home/i.test(line.note ?? "")) return "wfh_fixed_rate";
  return undefined;
}

/**
 * Re-cut the worksheet's sections into myTax screens. Every line lands on exactly one screen; empty screens
 * drop out. Line order within a screen keeps the worksheet's (check lines before type-ins, as myTax lists them).
 */
export function buildMirror(sections: readonly MytaxWorksheetSection[]): MirrorScreen[] {
  const byScreen = new Map<string, MirrorLine[]>();
  const deductionNames = new Map<string, string>();
  for (const s of sections) {
    for (const line of s.lines) {
      const key = screenKeyFor(s.key, line);
      if (key.startsWith("deduction:") && !deductionNames.has(key)) deductionNames.set(key, line.name);
      const list = byScreen.get(key) ?? [];
      const term = lineTerm(line);
      list.push({ sectionKey: s.key, line, tickId: tickId(s.key, line.key), ...(term ? { term } : {}) });
      byScreen.set(key, list);
    }
  }
  const deductionKeys = [...deductionNames.keys()].sort((a, b) => (dNumber(a.slice(10)) ?? 99) - (dNumber(b.slice(10)) ?? 99) || a.localeCompare(b));
  const order: string[] = [];
  for (const k of SCREEN_ORDER) {
    order.push(k);
    if (k === "work_expenses") order.push(...deductionKeys);
  }
  const screens: MirrorScreen[] = [];
  for (const key of order) {
    const lines = byScreen.get(key);
    if (!lines?.length) continue;
    const copy: MirrorScreenCopy = key.startsWith("deduction:")
      ? deductionScreenCopy(key.slice(10), deductionNames.get(key) ?? key.slice(10))
      : MIRROR_SCREENS[key as FixedMirrorScreenKey];
    const tickable = lines.some((l) => isTickable(l.line));
    screens.push({ ...copy, key, lines, screenTickId: tickable ? null : tickId(SCREEN_TICK_SECTION, key) });
  }
  return screens;
}

/** A screen is done when every tickable line is ticked at its current figure, or (nothing to tick) its screen tick is set. */
export function screenDone(screen: MirrorScreen, ticks: WorksheetTicks, fy: number): boolean {
  if (screen.screenTickId) return tickState(ticks, fy, screen.screenTickId, null) === "ticked";
  return screen.lines.every((l) => !isTickable(l.line) || tickState(ticks, fy, l.tickId, l.line.amount_cents) === "ticked");
}

/** "n of m screens done", and the first screen still to do (the "pick up where you left off" link). */
export function mirrorProgress(screens: readonly MirrorScreen[], ticks: WorksheetTicks, fy: number): { done: number; total: number; next: MirrorScreen | null } {
  let done = 0;
  let next: MirrorScreen | null = null;
  for (const s of screens) {
    if (screenDone(s, ticks, fy)) done++;
    else next ??= s;
  }
  return { done, total: screens.length, next };
}

/** Lines ticked on a screen (for the card's own "2 of 3" count). */
export function screenLineProgress(screen: MirrorScreen, ticks: WorksheetTicks, fy: number): { done: number; total: number } {
  const t = screen.lines.filter((l) => isTickable(l.line));
  return { done: t.filter((l) => tickState(ticks, fy, l.tickId, l.line.amount_cents) === "ticked").length, total: t.length };
}
