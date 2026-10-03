// "Done in myTax" ticks for the Ship it worksheet (spec A9, #590; flag ft_journey). Pure logic, free of React
// and the DOM so scripts/check-units.ts can test it directly.
//
// Persisted per FY in profiles.ui_state.worksheet_ticks (house rule: no localStorage), as
// { [fyStartYear]: { [sectionKey:lineKey]: amount_cents_when_ticked } }. Storing the figure the user ticked
// lets the page notice when a line's figure has changed since (a late receipt, a relabel): that tick goes
// stale and the line asks to be checked again, so a tick can never vouch for a number the user didn't see.
//
// ui_state is a small capped blob (8 KB server-side) shared with other UI flags, so only the most recent
// MAX_TICK_FYS years are kept and only ticked lines are stored.

import type { MytaxWorksheetLine, MytaxWorksheetSection } from "../types";

export type WorksheetTicks = Record<string, Record<string, number | null>>;
export type TickState = "ticked" | "stale" | "none";

export const MAX_TICK_FYS = 3;

/** A line's identity within one FY's worksheet. Line keys are only unique within their section. */
export const tickId = (sectionKey: string, lineKey: string): string => `${sectionKey}:${lineKey}`;

/**
 * Lines a user can tick: everything except information-only notes, and a prefilled line Quillo has no figure
 * for yet ("not entered" — there's nothing to compare until the income statement is added).
 */
export const isTickable = (line: Pick<MytaxWorksheetLine, "kind" | "amount_cents">): boolean =>
  line.kind !== "note" && !(line.kind === "check" && line.amount_cents == null);

/** Read the ticks out of the raw ui_state JSON. Anything malformed reads as "no ticks", never throws. */
export function parseTicks(uiState: string | null | undefined): WorksheetTicks {
  if (!uiState) return {};
  try {
    const raw = (JSON.parse(uiState) as { worksheet_ticks?: unknown }).worksheet_ticks;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: WorksheetTicks = {};
    for (const [fy, lines] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^\d{4}$/.test(fy) || !lines || typeof lines !== "object" || Array.isArray(lines)) continue;
      const clean: Record<string, number | null> = {};
      for (const [id, v] of Object.entries(lines as Record<string, unknown>)) {
        if (v === null || (typeof v === "number" && Number.isFinite(v))) clean[id] = v;
      }
      out[fy] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

/** Whether a line is ticked for this FY, and whether the figure still matches the one that was ticked. */
export function tickState(ticks: WorksheetTicks, fy: number, id: string, amountCents: number | null): TickState {
  const year = ticks[String(fy)];
  if (!year || !(id in year)) return "none";
  return year[id] === amountCents ? "ticked" : "stale";
}

/**
 * Tick (record the figure seen) or untick a line. Returns a new object; never mutates. Keeps only the most
 * recent MAX_TICK_FYS years, so the blob stays small however many years someone uses Quillo.
 */
export function withTick(ticks: WorksheetTicks, fy: number, id: string, tick: { amountCents: number | null } | null): WorksheetTicks {
  const key = String(fy);
  const year = { ...(ticks[key] ?? {}) };
  if (tick) year[id] = tick.amountCents;
  else delete year[id];
  const next: WorksheetTicks = { ...ticks, [key]: year };
  if (!Object.keys(year).length) delete next[key];
  // The year being ticked always stays (ticking an older year must stick); the newest others fill the rest.
  const others = Object.keys(next).filter((k) => k !== key).sort().slice(-(MAX_TICK_FYS - (key in next ? 1 : 0)));
  const keep = [...others, ...(key in next ? [key] : [])].sort();
  return Object.fromEntries(keep.map((k) => [k, next[k] as Record<string, number | null>]));
}

/** "n of m done": tickable lines whose tick still matches the figure. */
export function tickProgress(sections: readonly MytaxWorksheetSection[], ticks: WorksheetTicks, fy: number): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const s of sections) {
    for (const l of s.lines) {
      if (!isTickable(l)) continue;
      total++;
      if (tickState(ticks, fy, tickId(s.key, l.key), l.amount_cents) === "ticked") done++;
    }
  }
  return { done, total };
}
