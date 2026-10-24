// Weekly work-from-home diary (#787, flag `wfh_weekly_diary`, migration 0088).
//
// The fixed-rate method needs a record of the ACTUAL hours worked from home for the whole year, kept
// contemporaneously (PCG 2023/1 para 58; docs/research/wfh-records.md). Most weeks look the same, so the
// user sets a TYPICAL WEEK once and then CONFIRMS each week (one tap) or adjusts a day. The pattern only
// pre-fills the form: a week's hours count only once that week is confirmed.
//
// The rules this module owns (one place, so the API, the CSV and the goldens can't disagree):
//   • A week can be confirmed from its Friday (CONFIRM_OPENS_AFTER_DAYS), never in advance.
//   • A save is ON TIME when it happens no later than 7 days after the week ends (ON_TIME_DAYS); any later
//     save (a first catch-up OR a change to an older week) makes the week LATE and needs a `source`.
//   • A late week counts only when it was rebuilt from a record made at the time (calendar, timesheet,
//     roster, employer system logs). Rebuilt from memory = an estimate ⇒ kept, shown, never counted.
//   • Timestamps come from the server clock (callers pass `now`); the client can't backdate a week.
//   • The FY's counted total is written into work_use_inputs.wfh_hours, so report.ts's fixed-rate maths is
//     untouched (hours × the FY rate).
// GENERAL INFO ONLY: this records hours; it never says what is deductible.

import type { Env } from "../env";
import { fyBoundsFor, fyStartYearForDate, AU_DESCRIPTOR, type JurisdictionDescriptor } from "./jurisdiction";

export const DAY_REASONS = ["office", "leave", "sick", "public_holiday", "other"] as const;
export type DayReason = (typeof DAY_REASONS)[number];
export const LATE_SOURCES = ["calendar", "timesheet", "roster", "system_log", "memory"] as const;
export type LateSource = (typeof LATE_SOURCES)[number];
export type DiaryEntry = "on_time" | "late";

export interface DiaryDay { h: number; why?: DayReason }
export interface DiaryWeek {
  week_start: string;
  days: DiaryDay[];         // 7, Mon..Sun
  entry: DiaryEntry;
  source: LateSource | null;
  note: string | null;
  recorded_at: string;
  updated_at: string;
}

/** Days after the week's Monday before it can be confirmed (3 ⇒ Thursday UTC, i.e. Friday morning in AU). */
export const CONFIRM_OPENS_AFTER_DAYS = 3;
/** A save is on time up to and including week_start + 13 (the Sunday after the week ends). */
export const ON_TIME_DAYS = 13;
export const MAX_HOURS_PER_DAY = 24;
const EARLIEST_WEEK = "2020-01-06";

const SOURCE_LABEL: Record<LateSource, string> = {
  calendar: "Work calendar",
  timesheet: "Timesheet",
  roster: "Roster",
  system_log: "Employer system logs",
  memory: "Memory (not counted)",
};
const REASON_LABEL: Record<DayReason, string> = {
  office: "Office day",
  leave: "Leave",
  sick: "Sick",
  public_holiday: "Public holiday",
  other: "Other",
};
const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

// ── Pure date helpers (UTC, ISO YYYY-MM-DD) ──────────────────────────────────────────────────────
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
export function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function isMonday(iso: string): boolean {
  return ISO_RE.test(iso) && !Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) && new Date(`${iso}T00:00:00Z`).getUTCDay() === 1
    && new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso;
}
export function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return addDaysIso(iso, -((d.getUTCDay() + 6) % 7));
}
const todayIso = (now: Date) => now.toISOString().slice(0, 10);

/** When a week can be confirmed, and the last day a save still counts as on time. */
export function weekWindow(weekStart: string): { opens: string; on_time_until: string; week_end: string } {
  return { opens: addDaysIso(weekStart, CONFIRM_OPENS_AFTER_DAYS), on_time_until: addDaysIso(weekStart, ON_TIME_DAYS), week_end: addDaysIso(weekStart, 6) };
}
export function entryFor(weekStart: string, now: Date): DiaryEntry {
  return todayIso(now) <= weekWindow(weekStart).on_time_until ? "on_time" : "late";
}
export function canConfirm(weekStart: string, now: Date): boolean {
  return todayIso(now) >= weekWindow(weekStart).opens;
}
/** A week's hours count when it was recorded on time, or caught up from a record made at the time. */
export function weekCounts(w: Pick<DiaryWeek, "entry" | "source">): boolean {
  return w.entry === "on_time" || (w.source != null && w.source !== "memory");
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clampHours = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? round2(Math.min(MAX_HOURS_PER_DAY, Math.max(0, n))) : 0;
};

/** Normalise a typical week to 7 clamped hour values (Mon..Sun). */
export function normalisePattern(hours: unknown): number[] {
  const arr = Array.isArray(hours) ? hours : [];
  return Array.from({ length: 7 }, (_, i) => clampHours(arr[i]));
}

/**
 * Normalise a week's days. Omitted ⇒ the typical week as-is ("same as usual"). A day with a reason other than
 * "other" is a day not worked from home, so its hours are 0 whatever was sent (sick/leave/office/holiday).
 */
export function normaliseDays(days: unknown, pattern: number[]): DiaryDay[] {
  if (!Array.isArray(days)) return pattern.map((h) => ({ h }));
  return Array.from({ length: 7 }, (_, i) => {
    const raw = (days[i] ?? {}) as { h?: unknown; why?: unknown };
    const why = DAY_REASONS.includes(raw.why as DayReason) ? (raw.why as DayReason) : undefined;
    const h = why && why !== "other" ? 0 : clampHours(raw.h);
    return why ? { h, why } : { h };
  });
}

export interface DiaryTotals {
  counted_hours: number;     // what feeds work_use_inputs.wfh_hours
  on_time_hours: number;
  late_counted_hours: number;
  not_counted_hours: number; // late weeks rebuilt from memory
  weeks_on_time: number;
  weeks_late: number;
}

/** FY totals: each DAY is attributed to the FY its date falls in (a week can straddle 30 June). */
export function diaryTotals(weeks: DiaryWeek[], bounds: { start: string; end: string }): DiaryTotals {
  const t: DiaryTotals = { counted_hours: 0, on_time_hours: 0, late_counted_hours: 0, not_counted_hours: 0, weeks_on_time: 0, weeks_late: 0 };
  for (const w of weeks) {
    let inFy = false;
    let h = 0;
    w.days.forEach((d, i) => {
      const iso = addDaysIso(w.week_start, i);
      if (iso < bounds.start || iso > bounds.end) return;
      inFy = true;
      h += d.h;
    });
    if (!inFy) continue;
    if (w.entry === "on_time") { t.on_time_hours += h; t.weeks_on_time++; }
    else { t.weeks_late++; if (weekCounts(w)) t.late_counted_hours += h; else t.not_counted_hours += h; }
  }
  t.on_time_hours = round2(t.on_time_hours);
  t.late_counted_hours = round2(t.late_counted_hours);
  t.not_counted_hours = round2(t.not_counted_hours);
  t.counted_hours = round2(t.on_time_hours + t.late_counted_hours);
  return t;
}

// ── D1 reads/writes ──────────────────────────────────────────────────────────────────────────────
type WeekRow = { week_start: string; days_json: string; entry: string; source: string | null; note: string | null; recorded_at: string; updated_at: string };
const parseDays = (s: string): DiaryDay[] => {
  try { return normaliseDays(JSON.parse(s), [0, 0, 0, 0, 0, 0, 0]); } catch { return normaliseDays([], [0, 0, 0, 0, 0, 0, 0]); }
};
const toWeek = (r: WeekRow): DiaryWeek => ({
  week_start: r.week_start,
  days: parseDays(r.days_json),
  entry: r.entry === "on_time" ? "on_time" : "late",
  source: LATE_SOURCES.includes(r.source as LateSource) ? (r.source as LateSource) : null,
  note: r.note,
  recorded_at: r.recorded_at,
  updated_at: r.updated_at,
});

export async function getPattern(env: Env, userId: string): Promise<number[] | null> {
  const r = await env.DB.prepare(`SELECT hours_json FROM wfh_diary_pattern WHERE user_id = ?`).bind(userId).first<{ hours_json: string }>();
  if (!r) return null;
  try { return normalisePattern(JSON.parse(r.hours_json)); } catch { return null; }
}

export async function setPattern(env: Env, userId: string, hours: unknown): Promise<number[]> {
  const p = normalisePattern(hours);
  await env.DB.prepare(
    `INSERT INTO wfh_diary_pattern (user_id, hours_json, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET hours_json = excluded.hours_json, updated_at = datetime('now')`,
  ).bind(userId, JSON.stringify(p)).run();
  return p;
}

/** Weeks with at least one day inside the FY (the Monday can be up to 6 days before the FY starts). */
export async function listWeeksForFy(env: Env, userId: string, bounds: { start: string; end: string }): Promise<DiaryWeek[]> {
  const rows = await env.DB.prepare(
    `SELECT week_start, days_json, entry, source, note, recorded_at, updated_at FROM wfh_diary_weeks
      WHERE user_id = ? AND week_start >= ? AND week_start <= ? ORDER BY week_start`,
  ).bind(userId, addDaysIso(bounds.start, -6), bounds.end).all<WeekRow>();
  return (rows.results ?? []).map(toWeek);
}

/**
 * The diary is "in use" for an FY once it has a week starting in it, or a week from the previous FY with
 * hours on this FY's days. A straddling week with no hours here doesn't count, so it can't overwrite an
 * hours figure typed for this FY with 0.
 */
export function diaryInUse(weeks: DiaryWeek[], bounds: { start: string; end: string }): boolean {
  return weeks.some((w) => w.week_start >= bounds.start || w.days.some((d, i) => d.h > 0 && addDaysIso(w.week_start, i) >= bounds.start));
}

/** The counted diary total for an FY, or null when the FY has no diary weeks (the diary isn't in use). */
export async function diaryHoursForFy(env: Env, userId: string, fyStartYear: number, descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): Promise<number | null> {
  const bounds = fyBoundsFor(descriptor, fyStartYear);
  const weeks = await listWeeksForFy(env, userId, bounds);
  return diaryInUse(weeks, bounds) ? diaryTotals(weeks, bounds).counted_hours : null;
}

/** Re-write work_use_inputs.wfh_hours for every FY the week touches (null when the FY has no weeks left). */
async function syncHours(env: Env, userId: string, weekStart: string, descriptor: JurisdictionDescriptor): Promise<void> {
  const own = fyStartYearForDate(descriptor, weekStart);
  const fys = new Set([own, fyStartYearForDate(descriptor, addDaysIso(weekStart, 6))]);
  for (const fy of fys) {
    const hours = await diaryHoursForFy(env, userId, fy, descriptor);
    // The next FY only gets written once the diary is in use there (never null-out a figure typed for it).
    if (hours == null && fy !== own) continue;
    await env.DB.prepare(
      `INSERT INTO work_use_inputs (user_id, fy, wfh_hours, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, fy) DO UPDATE SET wfh_hours = excluded.wfh_hours, updated_at = datetime('now')`,
    ).bind(userId, fy, hours).run();
  }
}

export interface SaveWeekInput { week_start: string; days?: unknown; source?: unknown; note?: unknown }
export class DiaryError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

/**
 * Confirm (or change) one week. Omitting `days` means "same as my typical week". The server decides
 * on time vs late from `now`; a late save must say what it was rebuilt from. recorded_at is kept from the
 * first save, updated_at moves on every save.
 */
export async function saveWeek(env: Env, userId: string, input: SaveWeekInput, now: Date, descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): Promise<DiaryWeek> {
  const ws = String(input.week_start ?? "");
  if (!isMonday(ws) || ws < EARLIEST_WEEK) throw new DiaryError("week_start must be a Monday (YYYY-MM-DD)");
  if (!canConfirm(ws, now)) throw new DiaryError("This week can be confirmed from its Friday, once the days have happened");
  const pattern = (await getPattern(env, userId)) ?? [0, 0, 0, 0, 0, 0, 0];
  const days = normaliseDays(input.days, pattern);
  const entry = entryFor(ws, now);
  const source = entry === "late" && LATE_SOURCES.includes(input.source as LateSource) ? (input.source as LateSource) : null;
  if (entry === "late" && !source) throw new DiaryError("This week is being recorded late: say what you're working from (calendar, timesheet, roster, system logs or memory)");
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 200) : null;
  const stamp = now.toISOString();
  await env.DB.prepare(
    `INSERT INTO wfh_diary_weeks (user_id, week_start, days_json, entry, source, note, recorded_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, week_start) DO UPDATE SET days_json = excluded.days_json, entry = excluded.entry, source = excluded.source, note = excluded.note, updated_at = excluded.updated_at`,
  ).bind(userId, ws, JSON.stringify(days), entry, source, note, stamp, stamp).run();
  await syncHours(env, userId, ws, descriptor);
  const row = await env.DB.prepare(`SELECT week_start, days_json, entry, source, note, recorded_at, updated_at FROM wfh_diary_weeks WHERE user_id = ? AND week_start = ?`)
    .bind(userId, ws).first<WeekRow>();
  return toWeek(row!);
}

export async function deleteWeek(env: Env, userId: string, weekStart: string, descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): Promise<boolean> {
  if (!isMonday(weekStart)) throw new DiaryError("week_start must be a Monday (YYYY-MM-DD)");
  const r = await env.DB.prepare(`DELETE FROM wfh_diary_weeks WHERE user_id = ? AND week_start = ?`).bind(userId, weekStart).run();
  const changed = Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
  if (changed) await syncHours(env, userId, weekStart, descriptor);
  return changed;
}

export interface DiaryView {
  fy: number;
  bounds: { start: string; end: string };
  today: string;
  pattern: number[] | null;
  in_use: boolean;
  weeks: (DiaryWeek & { counts: boolean; hours_in_fy: number })[];
  /** Mondays in the FY up to the latest confirmable week that have no entry yet (newest first). */
  missing: string[];
  /** The newest week that can be confirmed now (null when none in this FY). */
  current: string | null;
  totals: DiaryTotals;
  rules: { confirm_opens_after_days: number; on_time_days: number };
}

export async function diaryView(env: Env, userId: string, fyStartYear: number, now: Date, descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): Promise<DiaryView> {
  const bounds = fyBoundsFor(descriptor, fyStartYear);
  const [pattern, weeks] = await Promise.all([getPattern(env, userId), listWeeksForFy(env, userId, bounds)]);
  const today = todayIso(now);
  const have = new Set(weeks.map((w) => w.week_start));
  // Latest confirmable Monday = the Monday of (today − CONFIRM_OPENS_AFTER_DAYS).
  const latest = mondayOf(addDaysIso(today, -CONFIRM_OPENS_AFTER_DAYS));
  const first = mondayOf(bounds.start);
  const missing: string[] = [];
  let current: string | null = null;
  for (let ws = latest; ws >= first; ws = addDaysIso(ws, -7)) {
    if (addDaysIso(ws, 6) < bounds.start || ws > bounds.end) continue;
    if (current == null) current = ws;
    if (!have.has(ws)) missing.push(ws);
  }
  const inFyHours = (w: DiaryWeek) => round2(w.days.reduce((s, d, i) => { const iso = addDaysIso(w.week_start, i); return iso >= bounds.start && iso <= bounds.end ? s + d.h : s; }, 0));
  return {
    fy: fyStartYear,
    bounds,
    today,
    pattern,
    in_use: diaryInUse(weeks, bounds),
    weeks: weeks.map((w) => ({ ...w, counts: weekCounts(w), hours_in_fy: inFyHours(w) })).reverse(),
    missing,
    current,
    totals: diaryTotals(weeks, bounds),
    rules: { confirm_opens_after_days: CONFIRM_OPENS_AFTER_DAYS, on_time_days: ON_TIME_DAYS },
  };
}

// ── The record the user keeps: one CSV row per day ────────────────────────────────────────────────
const csvCell = (v: string | number | null | undefined): string => {
  const s = v == null ? "" : String(v);
  // Neutralise spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Day-by-day CSV of the FY's diary: what, when recorded, on time or late, and whether it counts. */
export function diaryCsv(view: Pick<DiaryView, "bounds" | "weeks" | "totals">): string {
  const lines: string[] = [];
  lines.push(csvCell("Work-from-home hours diary") + "," + csvCell(`${view.bounds.start} to ${view.bounds.end}`));
  lines.push(csvCell("General information only. Keep this record with your tax records. Weeks marked 'recorded late' were entered after the week; keep the source record named for those weeks."));
  lines.push("");
  lines.push(["Date", "Day", "Hours from home", "Reason (if not from home)", "Week starting", "Recorded", "First recorded at", "Last changed at", "Rebuilt from", "Counted in total", "Note"].map(csvCell).join(","));
  const weeks = [...view.weeks].sort((a, b) => a.week_start.localeCompare(b.week_start));
  for (const w of weeks) {
    w.days.forEach((d, i) => {
      const iso = addDaysIso(w.week_start, i);
      if (iso < view.bounds.start || iso > view.bounds.end) return;
      lines.push([
        iso, WEEKDAY[i], d.h, d.why ? REASON_LABEL[d.why] : "", w.week_start,
        w.entry === "on_time" ? "On time (within a week of the week ending)" : "Recorded late",
        w.recorded_at, w.updated_at, w.source ? SOURCE_LABEL[w.source] : "", weekCounts(w) ? "Yes" : "No", i === 0 ? w.note : "",
      ].map(csvCell).join(","));
    });
  }
  lines.push("");
  lines.push(["Hours recorded on time", view.totals.on_time_hours].map(csvCell).join(","));
  lines.push(["Hours recorded late from a record made at the time", view.totals.late_counted_hours].map(csvCell).join(","));
  lines.push(["Hours recorded late from memory (not counted)", view.totals.not_counted_hours].map(csvCell).join(","));
  lines.push(["Total hours counted", view.totals.counted_hours].map(csvCell).join(","));
  return lines.join("\n") + "\n";
}
