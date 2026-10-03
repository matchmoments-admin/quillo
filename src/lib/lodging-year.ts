// Lodging-year default + the retention "treated as lodged" backstop (#572, first-timer spec A1 ticket b).
//
// PURE — no DB, no env. The "is this FY lodged?" rule and the fy_signoff reads/writes live in fy-signoff.ts, the
// route in api.ts.
//
// The rule (#536): a first-timer prepares the year being LODGED, not the calendar's current FY. In FY N the
// default is N − 1, unless FY N − 1 is already lodged (fy_signoff.lodged_at set, or the year was closed off a
// Notice of Assessment), then N. Quillo can't lodge (#530), so "lodged" is only ever the user's own mark or a
// confirmed NOA.
//
// The backstop (owner ruling, 2026-10-03): bank-data minimisation (A5, #581/#594) may only shrink a year's
// irrelevant debits once that year is lodged. A user who never taps "mark as lodged" would hold every line
// forever, so an FY with no lodged mark is TREATED as lodged for retention from the self-lodger due date
// + retention_backstop_days. The due date comes from the rule pack (lodgement.self_lodge_due_after_fy_end),
// never a TS literal — jurisdiction-neutral by construction. This backstop is for RETENTION ONLY: it never
// moves the lodging-year default (a late lodger still lands on the unlodged year).

import auV1RulePack from "../rulepacks/au-v1.json";
import { fyBoundsFor, fyStartYearForDate, type JurisdictionDescriptor, type TaxPeriod } from "./jurisdiction";
import { isFyMarkedLodged, type FyLodgedRow } from "./fy-signoff";

export { isFyMarkedLodged };

/** The slice of an fy_signoff row the retention rules read. */
export type FySignoffState = Pick<FyLodgedRow, "lodged_at" | "status" | "signed_off_at">;

function isoDay(d: Date | string): string {
  if (typeof d === "string") return d.slice(0, 10);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function descriptorOf(taxPeriod: TaxPeriod): JurisdictionDescriptor {
  // fyStartYearForDate / fyBoundsFor read only `taxPeriod`; the rest of the descriptor is irrelevant here.
  return { taxPeriod } as JurisdictionDescriptor;
}

/**
 * The FY (start year) a user should be preparing by default on `today`. In FY N: N − 1 unless N − 1 is in
 * `lodgedFys`, then N. `today` is a Date (UTC day) or an ISO date; `lodgedFys` are FY start years.
 */
export function lodgingFy(today: Date | string, taxPeriod: TaxPeriod, lodgedFys: Iterable<number>): number {
  const current = fyStartYearForDate(descriptorOf(taxPeriod), isoDay(today));
  const lodged = new Set(lodgedFys);
  return lodged.has(current - 1) ? current : current - 1;
}

export interface LodgementTiming {
  /** The first {month, day} after the FY ends (AU: 31 October). */
  due: { month: number; day: number };
  /** Days after the due date that an unmarked FY is treated as lodged for retention. */
  backstopDays: number;
}

/**
 * The tenant's lodgement timing. `pack` is REQUIRED and must be the tenant's resolved rule pack —
 * `lodgementTiming(await resolveRulePack(env, userId, descriptor))` (report.ts) — so a KV-pushed pack (or a
 * non-AU jurisdiction's pack) is honoured. The bundled pack only fills keys a KV pack pushed before #572 doesn't
 * carry. Every retention helper below takes the result as a required `timing`: none of them may silently fall
 * back to the bundled AU dates.
 */
export function lodgementTiming(pack: unknown): LodgementTiming {
  const read = (p: unknown) => (p as { lodgement?: { self_lodge_due_after_fy_end?: { month?: unknown; day?: unknown }; retention_backstop_days?: unknown } })?.lodgement;
  const p = read(pack);
  const b = read(auV1RulePack)!;
  const okDue = (d: { month?: unknown; day?: unknown } | undefined): d is { month: number; day: number } =>
    !!d && Number.isInteger(d.month) && Number.isInteger(d.day) && (d.month as number) >= 1 && (d.month as number) <= 12 && (d.day as number) >= 1 && (d.day as number) <= 31;
  const due = okDue(p?.self_lodge_due_after_fy_end) ? p!.self_lodge_due_after_fy_end : b.self_lodge_due_after_fy_end!;
  const days = Number.isInteger(p?.retention_backstop_days) && (p!.retention_backstop_days as number) >= 0 ? (p!.retention_backstop_days as number) : (b.retention_backstop_days as number);
  return { due: { month: due.month as number, day: due.day as number }, backstopDays: days };
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
}

/** The self-lodger due date for FY `fy` (ISO): the first pack {month, day} strictly after the FY's last day. */
export function selfLodgeDueDate(fy: number, descriptor: JurisdictionDescriptor, timing: LodgementTiming): string {
  const end = fyBoundsFor(descriptor, fy).end;
  const endYear = Number(end.slice(0, 4));
  const p = (n: number) => String(n).padStart(2, "0");
  const sameYear = `${endYear}-${p(timing.due.month)}-${p(timing.due.day)}`;
  return sameYear > end ? sameYear : `${endYear + 1}-${p(timing.due.month)}-${p(timing.due.day)}`;
}

/** The date an UNMARKED FY is treated as lodged for retention: due date + backstop days (AU FY 2025 → 2026-12-30). */
export function retentionBackstopDate(fy: number, descriptor: JurisdictionDescriptor, timing: LodgementTiming): string {
  return addDays(selfLodgeDueDate(fy, descriptor, timing), timing.backstopDays);
}

/**
 * The date FY `fy` counts as lodged for RETENTION (A5), or null if it isn't yet:
 * - the user's mark (lodged_at, a 'YYYY-MM-DD' day) when set;
 * - a NOA-closed year with no mark: lodged from the day the NOA close was confirmed (its signed_off_at day);
 * - otherwise the backstop date, once `today` has reached it.
 * A5 composes this with its own per-line 60-day hold ("lodged or ~60 days, whichever is later").
 */
export function retentionLodgedOn(
  fy: number,
  row: FySignoffState | null | undefined,
  today: Date | string,
  descriptor: JurisdictionDescriptor,
  timing: LodgementTiming,
): string | null {
  const t = isoDay(today);
  if (row?.lodged_at) return row.lodged_at.slice(0, 10);
  // A NOA close stamps signed_off_at when it's confirmed — a FIXED day, so A5's "lodged + 60 days" hold can
  // actually elapse (returning today would move the date forward on every run and never release a line).
  if (row?.status === "closed_with_noa") return row.signed_off_at.slice(0, 10);
  const backstop = retentionBackstopDate(fy, descriptor, timing);
  return t >= backstop ? backstop : null;
}

/** Convenience predicate for A5: is FY `fy` lodged (marked, NOA-closed, or past the backstop) as of `today`? */
export function isFyLodgedForRetention(
  fy: number,
  row: FySignoffState | null | undefined,
  today: Date | string,
  descriptor: JurisdictionDescriptor,
  timing: LodgementTiming,
): boolean {
  return retentionLodgedOn(fy, row, today, descriptor, timing) !== null;
}

/**
 * The latest FY that the backstop alone treats as lodged on `today` (every FY ≤ this is lodged for retention
 * whatever its signoff row says). Lets A5 write one SQL bound (`fy <= ?`) instead of enumerating years.
 */
export function backstopLodgedThroughFy(today: Date | string, descriptor: JurisdictionDescriptor, timing: LodgementTiming): number {
  const t = isoDay(today);
  let fy = fyStartYearForDate(descriptor, t);
  while (retentionBackstopDate(fy, descriptor, timing) > t) fy--;
  return fy;
}

/**
 * Validate the user's "I lodged on" day for FY `fy`. A return can be lodged early (leaving the country), so the
 * only hard bounds are: a real ISO day, not before the FY started, and not after today (one day of slack for a
 * client a timezone ahead of UTC). Returns an error message or null.
 */
export function lodgedOnError(lodgedOn: string, fy: number, today: Date | string, descriptor: JurisdictionDescriptor): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lodgedOn) || isoDay(new Date(`${lodgedOn}T00:00:00Z`)) !== lodgedOn) return "lodged_on must be a date (YYYY-MM-DD)";
  if (lodgedOn < fyBoundsFor(descriptor, fy).start) return "That date is before this financial year started";
  if (lodgedOn > addDays(isoDay(today), 1)) return "That date is in the future";
  return null;
}

export { isoDay as isoDayOf };
