// Weekly work-from-home diary (#787, flag `wfh_weekly_diary`, migration 0088).
//
// The fixed-rate method needs a record of the ACTUAL hours worked from home for the whole year, kept
// contemporaneously (PCG 2023/1 para 58; docs/research/wfh-records.md). Most weeks look the same, so the
// user sets a TYPICAL WEEK once and then CONFIRMS each week (one tap) or adjusts a day. The pattern only
// pre-fills the form: a week's hours count only once that week is confirmed.
//
// The rules this module owns (one place, so the API, the CSV and the goldens can't disagree):
//   • "Today" is the tenant's LOCAL date (the jurisdiction's time zone, Australia/Sydney for AU), never UTC.
//   • A week can be confirmed from its local Friday (CONFIRM_OPENS_AFTER_DAYS), never in advance.
//   • A save is ON TIME when it happens no later than 7 local days after the week's Sunday (ON_TIME_DAYS); any
//     later save (a first catch-up OR a change to an older week) makes the week LATE and needs a `source`.
//   • A late week counts only when it was rebuilt from a record made at the time (calendar, timesheet,
//     roster, employer system logs). Rebuilt from memory = an estimate ⇒ kept, shown, never counted.
//   • Timestamps come from the server clock (callers pass `now`); the client can't backdate a week.
//   • The FY's counted total is written into work_use_inputs.wfh_hours, so report.ts's fixed-rate maths is
//     untouched (hours × the FY rate).
//   • F6: hours already recorded for the FY when the diary STARTS are kept in wfh_hours_pre_diary (0089) and
//     the FY's hours are pre-diary + counted diary hours. Neither a confirmed week nor a deleted one ever
//     overwrites that figure; only the user's own edit (which needs a source) changes it.
// GENERAL INFO ONLY: this records hours; it never says what is deductible.

import type { Env } from "../env";
import { fyBoundsFor, fyStartYearForDate, AU_DESCRIPTOR, type JurisdictionDescriptor } from "./jurisdiction";
import { csvCell } from "./csv-cell";

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

/** Days after the week's Monday before it can be confirmed (4 ⇒ the week's Friday, in the tenant's local date). */
export const CONFIRM_OPENS_AFTER_DAYS = 4;
/** A save is on time up to and including week_start + 13 (7 local days after the week's Sunday). */
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
/** The fallback when a jurisdiction descriptor carries no time zone. */
export const DEFAULT_TIME_ZONE = "Australia/Sydney";
export const timeZoneOf = (descriptor: JurisdictionDescriptor): string => descriptor.timeZone || DEFAULT_TIME_ZONE;
/** The calendar date (YYYY-MM-DD) `now` falls on in `timeZone` — DST-aware via Intl. */
export function localDateIso(now: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
const todayIso = (now: Date, timeZone: string) => localDateIso(now, timeZone);

/** When a week can be confirmed, and the last day a save still counts as on time. */
export function weekWindow(weekStart: string): { opens: string; on_time_until: string; week_end: string } {
  return { opens: addDaysIso(weekStart, CONFIRM_OPENS_AFTER_DAYS), on_time_until: addDaysIso(weekStart, ON_TIME_DAYS), week_end: addDaysIso(weekStart, 6) };
}
export function entryFor(weekStart: string, now: Date, timeZone: string = DEFAULT_TIME_ZONE): DiaryEntry {
  return todayIso(now, timeZone) <= weekWindow(weekStart).on_time_until ? "on_time" : "late";
}
export function canConfirm(weekStart: string, now: Date, timeZone: string = DEFAULT_TIME_ZONE): boolean {
  return todayIso(now, timeZone) >= weekWindow(weekStart).opens;
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

// ── Hours recorded before the diary (F6, migration 0089) ─────────────────────────────────────────
/** Hours a user recorded for the FY before the diary started (e.g. from a timesheet), and what they came from. */
export interface PreDiary { hours: number; source: LateSource | null; counts: boolean }
/** Hours in a year (366 × 24): the most a pre-diary figure can be. */
export const MAX_PRE_DIARY_HOURS = 8784;
/**
 * A pre-diary figure counts unless it was rebuilt from memory (an estimate, like a memory-sourced week).
 * No source yet = carried over from the typed hours field, which counted before the diary started, so it
 * still counts (the card asks the user to say where it came from).
 */
export function preDiaryCounts(p: { hours: number | null; source: LateSource | null }): boolean {
  return p.hours != null && p.hours > 0 && p.source !== "memory";
}
/** The FY's hours figure: counted pre-diary hours + counted diary hours. */
export function fyHoursTotal(pre: { hours: number | null; source: LateSource | null } | null, diaryCounted: number): number {
  return round2((pre && preDiaryCounts(pre) ? pre.hours! : 0) + diaryCounted);
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

/** The hours recorded before the diary for an FY (null when none were kept). */
export async function getPreDiary(env: Env, userId: string, fyStartYear: number): Promise<PreDiary | null> {
  const r = await env.DB.prepare(`SELECT wfh_hours_pre_diary AS h, wfh_hours_pre_diary_source AS s FROM work_use_inputs WHERE user_id = ? AND fy = ?`)
    .bind(userId, fyStartYear).first<{ h: number | null; s: string | null }>();
  if (!r || r.h == null) return null;
  const source = LATE_SOURCES.includes(r.s as LateSource) ? (r.s as LateSource) : null;
  return { hours: round2(r.h), source, counts: preDiaryCounts({ hours: r.h, source }) };
}

/**
 * The FY's hours while the diary is in use (pre-diary + counted diary hours), or null when the FY has no
 * diary weeks (the diary isn't in use, so the typed figure stands).
 */
export async function diaryHoursForFy(env: Env, userId: string, fyStartYear: number, descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): Promise<number | null> {
  const bounds = fyBoundsFor(descriptor, fyStartYear);
  const weeks = await listWeeksForFy(env, userId, bounds);
  if (!diaryInUse(weeks, bounds)) return null;
  return fyHoursTotal(await getPreDiary(env, userId, fyStartYear), diaryTotals(weeks, bounds).counted_hours);
}

/** The FYs a week's days fall in (two when it straddles the FY end). */
function fysOfWeek(weekStart: string, descriptor: JurisdictionDescriptor): number[] {
  return [...new Set([fyStartYearForDate(descriptor, weekStart), fyStartYearForDate(descriptor, addDaysIso(weekStart, 6))])];
}

/**
 * Re-write work_use_inputs.wfh_hours for one FY. `capture` = the diary has just started for this FY, so the
 * figure already in wfh_hours (typed or estimated) is kept as the pre-diary hours first. With the diary in
 * use the FY's hours are pre-diary + diary. With no weeks left they fall back to the kept pre-diary figure
 * as entered; with none kept, the week's own FY is cleared (as before) and an FY it spills into untouched.
 */
async function syncFy(env: Env, userId: string, fy: number, descriptor: JurisdictionDescriptor, opts: { capture: boolean; own: boolean }): Promise<void> {
  const bounds = fyBoundsFor(descriptor, fy);
  const weeks = await listWeeksForFy(env, userId, bounds);
  const inUse = diaryInUse(weeks, bounds);
  if (opts.capture && inUse) {
    // SET expressions read the OLD row, so the source survives only when the kept figure is unchanged.
    await env.DB.prepare(
      `UPDATE work_use_inputs SET wfh_hours_pre_diary = wfh_hours,
              wfh_hours_pre_diary_source = CASE WHEN wfh_hours_pre_diary = wfh_hours THEN wfh_hours_pre_diary_source ELSE NULL END
        WHERE user_id = ? AND fy = ?`,
    ).bind(userId, fy).run();
  }
  const pre = await getPreDiary(env, userId, fy);
  const hours = inUse ? fyHoursTotal(pre, diaryTotals(weeks, bounds).counted_hours) : pre ? pre.hours : null;
  // An FY the week only spills into is written only when there is something to write (never null-out a
  // figure typed for it).
  if (hours == null && !opts.own) return;
  await env.DB.prepare(
    `INSERT INTO work_use_inputs (user_id, fy, wfh_hours, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, fy) DO UPDATE SET wfh_hours = excluded.wfh_hours, updated_at = datetime('now')`,
  ).bind(userId, fy, hours).run();
}

/** Re-write the hours for every FY the week touches. `started` = FYs where this save starts the diary. */
async function syncHours(env: Env, userId: string, weekStart: string, descriptor: JurisdictionDescriptor, started: Set<number> = new Set()): Promise<void> {
  const own = fyStartYearForDate(descriptor, weekStart);
  for (const fy of fysOfWeek(weekStart, descriptor)) await syncFy(env, userId, fy, descriptor, { capture: started.has(fy), own: fy === own });
}

/** FYs the week touches where the diary isn't in use yet (so saving this week may start it there). */
async function notYetInUse(env: Env, userId: string, weekStart: string, descriptor: JurisdictionDescriptor): Promise<Set<number>> {
  const out = new Set<number>();
  for (const fy of fysOfWeek(weekStart, descriptor)) {
    const bounds = fyBoundsFor(descriptor, fy);
    if (!diaryInUse(await listWeeksForFy(env, userId, bounds), bounds)) out.add(fy);
  }
  return out;
}

export interface SetPreDiaryInput { fy: unknown; hours: unknown; source: unknown }
/**
 * The user edits the hours recorded before the diary. It needs a source (the same list as a late week), and
 * only applies once the diary is in use for the FY: before that, the typed hours field is the figure.
 */
export async function setPreDiary(env: Env, userId: string, input: SetPreDiaryInput, descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): Promise<PreDiary> {
  const fy = Number(input.fy);
  if (!Number.isInteger(fy) || fy < 1900 || fy > 2200) throw new DiaryError("bad fy");
  const n = Number(input.hours);
  if (input.hours == null || input.hours === "" || !Number.isFinite(n) || n < 0 || n > MAX_PRE_DIARY_HOURS) throw new DiaryError(`hours must be a number from 0 to ${MAX_PRE_DIARY_HOURS}`);
  if (!LATE_SOURCES.includes(input.source as LateSource)) throw new DiaryError("Say what these hours come from (calendar, timesheet, roster, system logs or memory)");
  const bounds = fyBoundsFor(descriptor, fy);
  if (!diaryInUse(await listWeeksForFy(env, userId, bounds), bounds)) throw new DiaryError("Confirm a week in your hours diary first. Until then, type your hours in the hours field.");
  await env.DB.prepare(
    `INSERT INTO work_use_inputs (user_id, fy, wfh_hours_pre_diary, wfh_hours_pre_diary_source, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, fy) DO UPDATE SET wfh_hours_pre_diary = excluded.wfh_hours_pre_diary, wfh_hours_pre_diary_source = excluded.wfh_hours_pre_diary_source, updated_at = datetime('now')`,
  ).bind(userId, fy, round2(n), input.source as string).run();
  await syncFy(env, userId, fy, descriptor, { capture: false, own: true });
  return (await getPreDiary(env, userId, fy))!;
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
  const tz = timeZoneOf(descriptor);
  if (!canConfirm(ws, now, tz)) throw new DiaryError("This week can be confirmed from its Friday, once the days have happened");
  const pattern = (await getPattern(env, userId)) ?? [0, 0, 0, 0, 0, 0, 0];
  const days = normaliseDays(input.days, pattern);
  const entry = entryFor(ws, now, tz);
  const source = entry === "late" && LATE_SOURCES.includes(input.source as LateSource) ? (input.source as LateSource) : null;
  if (entry === "late" && !source) throw new DiaryError("This week is being recorded late: say what you're working from (calendar, timesheet, roster, system logs or memory)");
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 200) : null;
  const stamp = now.toISOString();
  const started = await notYetInUse(env, userId, ws, descriptor);
  await env.DB.prepare(
    `INSERT INTO wfh_diary_weeks (user_id, week_start, days_json, entry, source, note, recorded_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, week_start) DO UPDATE SET days_json = excluded.days_json, entry = excluded.entry, source = excluded.source, note = excluded.note, updated_at = excluded.updated_at`,
  ).bind(userId, ws, JSON.stringify(days), entry, source, note, stamp, stamp).run();
  await syncHours(env, userId, ws, descriptor, started);
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
  /** F6: hours recorded before the diary started (null when none were kept). */
  pre_diary: PreDiary | null;
  /** The FY's hours while the diary is in use: counted pre-diary hours + counted diary hours. */
  fy_hours: number;
  rules: { confirm_opens_after_days: number; on_time_days: number };
}

export async function diaryView(env: Env, userId: string, fyStartYear: number, now: Date, descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): Promise<DiaryView> {
  const bounds = fyBoundsFor(descriptor, fyStartYear);
  const [pattern, weeks, pre] = await Promise.all([getPattern(env, userId), listWeeksForFy(env, userId, bounds), getPreDiary(env, userId, fyStartYear)]);
  const totals = diaryTotals(weeks, bounds);
  const today = todayIso(now, timeZoneOf(descriptor));
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
    totals,
    pre_diary: pre,
    fy_hours: fyHoursTotal(pre, totals.counted_hours),
    rules: { confirm_opens_after_days: CONFIRM_OPENS_AFTER_DAYS, on_time_days: ON_TIME_DAYS },
  };
}

/** Where the pre-diary hours came from, for the CSV and the accountant pack. */
export function preDiarySourceLabel(source: LateSource | null): string {
  return source ? SOURCE_LABEL[source] : "source not given yet";
}

// ── The record the user keeps: one CSV row per day ────────────────────────────────────────────────
// Cells go through the shared writer (formula-injection guard + RFC 4180 quoting), the same one the accountant pack uses.

/** Day-by-day CSV of the FY's diary: what, when recorded, on time or late, and whether it counts. */
export function diaryCsv(view: Pick<DiaryView, "bounds" | "weeks" | "totals"> & Partial<Pick<DiaryView, "pre_diary" | "fy_hours">>): string {
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
  if (view.pre_diary) {
    // F6: hours recorded before the diary started, and the year's figure (only when some were kept).
    lines.push([`Hours recorded before the diary (${preDiarySourceLabel(view.pre_diary.source)})`, view.pre_diary.hours].map(csvCell).join(","));
    lines.push(["Total hours for the year (before the diary + diary)", view.fy_hours ?? fyHoursTotal(view.pre_diary, view.totals.counted_hours)].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}
