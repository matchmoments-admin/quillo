// Situation profile (first-timer spec A1, #571, flag `situation_profile`).
//
// A person's situation — residency type, spouse, state, jobs, ABN activities, study / study loan, WFH,
// car for work, foreign income, private hospital cover — stored as DATED PERIODS in `situation_periods`
// (migration 0078). This module is the one reader: the period validator, the per-FY profile the scan /
// nudges / worksheet / foreign-income exclusion read, and the pure mirror computation that keeps the legacy
// scalar readers (persons.occupation, persons.tax_residency, profiles.private_health) correct. Writes live
// in situation-write.ts.
//
// The profile shape follows spec A1's fact table (docs/first-timer/spec.md §A1), which refines the sketch in
// relevance-scan.md §8: residency is an ARRAY of periods, the flags are study_loan / private_hospital_cover,
// and payer names / GST status are reached through ref_id (entities / income_activities), not copied here.
//
// Facts and values come from the rule pack (`situation_facts`), never a TS literal, so a jurisdiction adds
// or renames facts without code (jurisdiction-neutral by construction). Read from the BUNDLED pack, like
// occupations.ts: validation must not depend on whether the KV copy has been pushed yet.
//
// The position never reads a period (pft7 asserts taxable_position_cents byte-identical ON vs OFF). The
// MIRRORS are different by design: persons.tax_residency feeds the legacy CGT-discount eligibility
// (is_resident_individual) and the non-resident defer, and persons.occupation feeds claimability. So a
// residency period CAN move a disposal's discount through the mirror — the spec's intent (keep legacy
// readers correct). A13 (#580) reads the periods directly for foreign-income assessability, but did NOT move the CGT
// discount / non-resident-defer readers off the mirror (still open). computeMirrors has the guard rails.

import type { Env } from "../env";
import auV1RulePack from "../rulepacks/au-v1.json";
import { featureOn } from "./features";
import { AU_DESCRIPTOR, fyBoundsFor, fyStartYearForDate, type JurisdictionDescriptor } from "./jurisdiction";

// Local FY helpers (same as ledger-totals) so this guidance module doesn't import the money pipeline.
const fyBounds = (startYear: number, d: JurisdictionDescriptor = AU_DESCRIPTOR) => fyBoundsFor(d, startYear);
const fyLabel = (startYear: number) => `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;

// ── Pack ────────────────────────────────────────────────────────────────────────

export interface SituationFactSpec {
  values: string[] | "token";
  extra?: string[];
  multi: boolean;
  ref?: "employment_entity" | "business_activity";
  detail_flags?: string[]; // boolean detail keys a period may carry (employment: wfh, uses_own_car)
  home?: { value: string; tax_residency: string };
  non_home_tax_residency?: string;
  unsure_value?: string;
}

export type SituationFacts = Record<string, SituationFactSpec>;

/** The pack's situation facts (metadata keys starting with '_' dropped). */
export function situationFacts(pack: unknown = auV1RulePack): SituationFacts {
  const raw = ((pack as { situation_facts?: Record<string, unknown> }).situation_facts ?? {}) as Record<string, unknown>;
  const out: SituationFacts = {};
  for (const [k, v] of Object.entries(raw)) if (!k.startsWith("_") && v && typeof v === "object") out[k] = v as SituationFactSpec;
  return out;
}

// A free occupation token: lowercase, starts with a letter, letters/digits/underscore. Matches the pack's
// occupation keys (nurse, it_professional) and the free-text scopes Settings already stores.
const TOKEN_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** Most periods one subject may hold for one fact — bounds multi-valued facts (jobs, ABN activities). */
export const MAX_PERIODS_PER_FACT = 20;

/** Normalise a caller-supplied FY start year: a plausible integer year, else null. */
export function normaliseFyStart(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 1900 && n < 3000 ? n : null;
}

// ── Types ───────────────────────────────────────────────────────────────────────

export interface SituationPeriod {
  id: string;
  user_id: string;
  subject_kind: string;
  subject_id: string;
  fact: string;
  value: string | null;
  ref_id: string | null;
  starts_on: string | null;
  ends_on: string | null;
  source: string;
  detail_json: string;
  created_at?: string;
  updated_at?: string;
}

/** A period clipped to one FY (both ends concrete). */
export interface ClippedPeriod {
  period_id: string;
  starts_on: string;
  ends_on: string;
}

export interface ProfileJob extends ClippedPeriod {
  occupation_token: string;
  ref_id: string | null; // entities.id (kind employment), NULL until the employer is known
  wfh: boolean;
  uses_own_car: boolean;
}

export interface ProfileAbnActivity extends ClippedPeriod {
  kind: string; // rideshare | delivery | freelance | other
  ref_id: string | null; // income_activities.id (type business)
}

export interface ProfileResidency extends ClippedPeriod {
  type: string; // resident | temporary | foreign | whm | unsure
}

export interface SituationProfile {
  person_id: string;
  fy: string; // '2025-26'
  fy_start: string;
  fy_end: string;
  jobs: ProfileJob[]; // employment periods overlapping the FY ('none' = not working, excluded)
  abn_activities: ProfileAbnActivity[];
  residency: ProfileResidency[]; // sorted by start, clipped to the FY
  flags: {
    spouse: boolean | null; // null = not answered for this FY
    study: boolean;
    study_loan: boolean; // opt-in: only ever true (data minimisation — a "no" is never stored)
    wfh: boolean;
    car_for_work: boolean;
    foreign_income: boolean;
    private_hospital_cover: boolean | null;
  };
  state: string | null; // education content only; return maths stays federal
}

// ── Pure date helpers ───────────────────────────────────────────────────────────

/** Strict ISO calendar date ('YYYY-MM-DD' that round-trips — rejects 2026-02-30). */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Inclusive overlap of two possibly-open ranges (NULL start = −∞, NULL end = +∞). ISO dates compare lexically. */
export function rangesOverlap(aStart: string | null, aEnd: string | null, bStart: string | null, bEnd: string | null): boolean {
  return (aStart == null || bEnd == null || aStart <= bEnd) && (bStart == null || aEnd == null || bStart <= aEnd);
}

function clip(p: { starts_on: string | null; ends_on: string | null }, start: string, end: string): { starts_on: string; ends_on: string } | null {
  if (!rangesOverlap(p.starts_on, p.ends_on, start, end)) return null;
  return { starts_on: p.starts_on && p.starts_on > start ? p.starts_on : start, ends_on: p.ends_on && p.ends_on < end ? p.ends_on : end };
}

function daysInclusive(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
}

function detailOf(p: { detail_json?: string | null }): Record<string, unknown> {
  try {
    const d = JSON.parse(p.detail_json || "{}") as unknown;
    return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── Validation ──────────────────────────────────────────────────────────────────

export interface PeriodInput {
  id?: string; // set on edit — excluded from its own overlap check
  subject_kind: string;
  subject_id: string;
  fact: string;
  value: string | null;
  ref_id: string | null;
  starts_on: string | null;
  ends_on: string | null;
}

const FACT_WORDS: Record<string, string> = {
  residency: "residency",
  spouse: "spouse",
  state: "state",
  study: "study",
  study_loan: "study loan",
  wfh: "working from home",
  car_for_work: "car for work",
  foreign_income: "foreign income",
  private_hospital_cover: "private hospital cover",
};

/**
 * Validate one period against the pack and the subject's other periods for the same fact (`existing`, all
 * of that subject+fact). Returns a plain-English error for a 400, or null when valid. Pure.
 * Rules: person subject; known fact; value allowed for the fact; ref_id only where the fact has a ref; ISO
 * dates; starts_on ≤ ends_on; single-valued facts may not overlap another period of the same fact; at most
 * MAX_PERIODS_PER_FACT periods per subject+fact.
 */
export function validatePeriod(p: PeriodInput, existing: ReadonlyArray<Pick<SituationPeriod, "id" | "starts_on" | "ends_on">>, facts: SituationFacts = situationFacts()): string | null {
  if (p.subject_kind !== "person") return "Only a person's situation can be recorded for now.";
  const spec = facts[p.fact];
  if (!spec) return `"${p.fact}" isn't a situation fact Quillo records.`;
  const v = p.value;
  if (spec.values === "token") {
    if (!v || !(TOKEN_RE.test(v) || (spec.extra ?? []).includes(v))) return `Pick an occupation for this job (or "none" if you're not working yet).`;
  } else if (!v || !spec.values.includes(v)) {
    return `"${(v ?? "").slice(0, 40)}" isn't a valid answer for ${FACT_WORDS[p.fact] ?? p.fact}. Choose one of: ${spec.values.join(", ")}.`;
  }
  if (p.ref_id != null && !spec.ref) return `A ${FACT_WORDS[p.fact] ?? p.fact} period can't link to another record.`;
  if (p.starts_on != null && !isIsoDate(p.starts_on)) return "The start date must be a real date (YYYY-MM-DD).";
  if (p.ends_on != null && !isIsoDate(p.ends_on)) return "The end date must be a real date (YYYY-MM-DD).";
  if (p.starts_on && p.ends_on && p.starts_on > p.ends_on) return "The start date must be on or before the end date.";
  const others = existing.filter((e) => e.id !== p.id);
  if (others.length >= MAX_PERIODS_PER_FACT) return `That's the most ${FACT_WORDS[p.fact] ?? p.fact} periods Quillo keeps for one person. Remove an old one first.`;
  if (!spec.multi) {
    const clash = others.find((e) => rangesOverlap(p.starts_on, p.ends_on, e.starts_on, e.ends_on));
    if (clash) {
      const span = `${clash.starts_on ?? "the start"} to ${clash.ends_on ?? "now"}`;
      return `You already have a ${FACT_WORDS[p.fact] ?? p.fact} answer covering ${span}. Only one can apply at a time, so end or change that one first.`;
    }
  }
  return null;
}

// ── Profile ─────────────────────────────────────────────────────────────────────

/** Build one person's profile for the FY [start, end] from their periods. Pure. */
export function buildProfile(personId: string, periods: ReadonlyArray<SituationPeriod>, startYear: number, bounds: { start: string; end: string }): SituationProfile {
  const { start, end } = bounds;
  const mine = periods.filter((p) => p.subject_kind === "person" && p.subject_id === personId);
  const inFy = (fact: string) =>
    mine
      .filter((p) => p.fact === fact)
      .map((p) => ({ p, c: clip(p, start, end) }))
      .filter((x): x is { p: SituationPeriod; c: { starts_on: string; ends_on: string } } => x.c != null)
      .sort((a, b) => (a.c.starts_on < b.c.starts_on ? -1 : a.c.starts_on > b.c.starts_on ? 1 : a.p.id < b.p.id ? -1 : 1));
  const any = (fact: string, value = "yes") => inFy(fact).some((x) => x.p.value === value);
  // Single-valued yes/no facts: the latest-starting answer in the FY wins; null when unanswered.
  const yesNo = (fact: string): boolean | null => {
    const xs = inFy(fact);
    const last = xs[xs.length - 1];
    return last ? last.p.value === "yes" : null;
  };
  const wfh = any("wfh");
  const car = any("car_for_work");
  const stateRows = inFy("state");
  return {
    person_id: personId,
    fy: fyLabel(startYear),
    fy_start: start,
    fy_end: end,
    jobs: inFy("employment")
      .filter((x) => x.p.value && x.p.value !== "none")
      .map((x) => {
        const d = detailOf(x.p);
        return {
          period_id: x.p.id,
          ...x.c,
          occupation_token: x.p.value as string,
          ref_id: x.p.ref_id,
          wfh: typeof d.wfh === "boolean" ? d.wfh : wfh,
          uses_own_car: typeof d.uses_own_car === "boolean" ? d.uses_own_car : car,
        };
      }),
    abn_activities: inFy("abn_activity").map((x) => ({ period_id: x.p.id, ...x.c, kind: x.p.value ?? "other", ref_id: x.p.ref_id })),
    residency: inFy("residency").map((x) => ({ period_id: x.p.id, ...x.c, type: x.p.value ?? "unsure" })),
    flags: {
      spouse: yesNo("spouse"),
      study: any("study"),
      study_loan: any("study_loan"),
      wfh,
      car_for_work: car,
      foreign_income: any("foreign_income"),
      private_hospital_cover: yesNo("private_hospital_cover"),
    },
    state: stateRows.length ? stateRows[stateRows.length - 1]!.p.value : null,
  };
}

/** The residency type covering `isoDate`, or null when no residency period covers it. */
export function residencyOn(profile: SituationProfile, isoDate: string): string | null {
  return profile.residency.find((r) => r.starts_on <= isoDate && isoDate <= r.ends_on)?.type ?? null;
}

/** The person's residency periods for the profile's FY, clipped and sorted by start (A13 reads these). */
export function residencyPeriodsForFy(profile: SituationProfile): ProfileResidency[] {
  return [...profile.residency];
}

const PERIOD_COLS = "id, user_id, subject_kind, subject_id, fact, value, ref_id, starts_on, ends_on, source, detail_json, created_at, updated_at";

/**
 * Every situation period for a tenant (optionally one subject), in a stable order. A person's periods are KEPT
 * when the person is deleted (not cascaded) and hidden here instead, so undoing the delete (ai_edit_feed
 * restores the persons row with the same id) brings them back intact. Orphans have no live reader and go with
 * the tenant purge (PURGE_TABLES).
 */
export async function listSituationPeriods(env: Env, userId: string, subjectId?: string): Promise<SituationPeriod[]> {
  const where = subjectId ? " AND subject_id = ?" : "";
  return (
    (await env.DB.prepare(
      `SELECT ${PERIOD_COLS} FROM situation_periods
        WHERE user_id = ?${where}
          AND (subject_kind <> 'person' OR subject_id IN (SELECT id FROM persons WHERE user_id = ?))
        ORDER BY subject_id, fact, COALESCE(starts_on, ''), created_at, id`,
    )
      .bind(...(subjectId ? [userId, subjectId, userId] : [userId, userId]))
      .all<SituationPeriod>()).results ?? []
  );
}

async function personsAndProfiles(env: Env, userId: string, startYear: number, descriptor: JurisdictionDescriptor) {
  const [persons, periods] = await Promise.all([
    env.DB.prepare(`SELECT id, display_name, role FROM persons WHERE user_id = ? ORDER BY role = 'self' DESC, created_at`)
      .bind(userId)
      .all<{ id: string; display_name: string; role: string }>(),
    listSituationPeriods(env, userId),
  ]);
  const bounds = fyBounds(startYear, descriptor);
  const rows = persons.results ?? [];
  return { persons: rows, profiles: rows.map((p) => buildProfile(p.id, periods, startYear, bounds)) };
}

/** One profile per person for the FY (persons in getSituation order: self first). */
export async function profileForFy(env: Env, userId: string, startYear: number, descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): Promise<SituationProfile[]> {
  return (await personsAndProfiles(env, userId, startYear, descriptor)).profiles;
}

// ── Mirrors (legacy scalar readers) ─────────────────────────────────────────────

export interface SituationMirrors {
  occupation?: string | null; // persons.occupation — undefined = leave unchanged
  tax_residency?: string; // persons.tax_residency
  private_health?: 0 | 1; // profiles.private_health (self person only)
}

/**
 * The FY a fact's mirror is computed for. The mirrored columns are FY-less scalars that the LIVE readers use
 * (CGT discount, claimability), so the mirror follows the most RECENT FY — up to the current one — that any of
 * the person's periods for the fact reaches. Editing history never moves the live scalar back to an old year.
 * A period wholly in the future is ignored; no periods ⇒ the current FY. Pure.
 */
export function mirrorFyForFact(periods: ReadonlyArray<SituationPeriod>, personId: string, fact: string, currentStartYear: number, descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): number {
  let best: number | null = null;
  for (const p of periods) {
    if (p.subject_id !== personId || p.fact !== fact) continue;
    const startFy = p.starts_on ? fyStartYearForDate(descriptor, p.starts_on) : -Infinity;
    if (startFy > currentStartYear) continue;
    const endFy = p.ends_on ? fyStartYearForDate(descriptor, p.ends_on) : currentStartYear;
    const eff = Number.isNaN(endFy) ? currentStartYear : Math.min(endFy, currentStartYear);
    if (best == null || eff > best) best = eff;
  }
  return best ?? currentStartYear;
}

/**
 * The mirror values implied by one person's periods for the FY, for the facts in `touched` only (a WFH tick
 * must never rewrite an occupation the user set in Settings). Pure. undefined ⇒ leave the column alone.
 * - occupation ← the value of the person's LONGEST employment period in the FY (ties: earliest start). When
 *   every employment period in the FY is 'none' (not working yet) ⇒ NULL. No employment periods ⇒ unchanged.
 * - tax_residency ← the pack's home code (AU) when the residency period covering the FY's LAST day is the home
 *   value (resident), else the pack's non-home code ('foreign'). 'unsure' ⇒ unchanged: an "I don't know" must
 *   not flip the binary that the CGT discount and the non-resident defer read (residency_unsure defers
 *   instead). No period covering the last day ⇒ unchanged.
 * - private_health ← private_hospital_cover (yes ⇒ 1, no ⇒ 0) of the latest answer in the FY.
 */
export function computeMirrors(personId: string, periods: ReadonlyArray<SituationPeriod>, startYear: number, bounds: { start: string; end: string }, touched: ReadonlyArray<string>, facts: SituationFacts = situationFacts()): SituationMirrors {
  const out: SituationMirrors = {};
  const profile = buildProfile(personId, periods, startYear, bounds);
  if (touched.includes("employment")) {
    const jobs = [...profile.jobs].sort((a, b) => daysInclusive(b.starts_on, b.ends_on) - daysInclusive(a.starts_on, a.ends_on) || (a.starts_on < b.starts_on ? -1 : a.starts_on > b.starts_on ? 1 : 0));
    if (jobs[0]) out.occupation = jobs[0].occupation_token;
    else {
      const anyNone = periods.some((p) => p.subject_id === personId && p.fact === "employment" && p.value === "none" && rangesOverlap(p.starts_on, p.ends_on, bounds.start, bounds.end));
      if (anyNone) out.occupation = null;
    }
  }
  if (touched.includes("residency")) {
    const spec = facts.residency;
    const type = residencyOn(profile, bounds.end);
    if (type && spec?.home && type !== spec.unsure_value) out.tax_residency = type === spec.home.value ? spec.home.tax_residency : spec.non_home_tax_residency ?? "foreign";
  }
  if (touched.includes("private_hospital_cover") && profile.flags.private_hospital_cover != null) {
    out.private_health = profile.flags.private_hospital_cover ? 1 : 0;
  }
  return out;
}

/**
 * When the LAST period of a fact is deleted there is nothing left to derive the mirror from. If the column still
 * holds exactly what the deleted period produced, revert it to the legacy default (occupation NULL, residency the
 * pack's home code) — so a mistaken "foreign" that is then deleted doesn't leave the CGT reader on 'foreign'.
 * If the column holds anything else (set in Settings, or by another path) it is left alone. Pure.
 */
export function revertMirrorsOnLastDelete(deleted: SituationPeriod, current: { occupation: string | null; tax_residency: string | null }, facts: SituationFacts = situationFacts()): SituationMirrors {
  if (deleted.fact === "employment") {
    const produced = deleted.value === "none" ? null : deleted.value;
    return current.occupation === produced && produced != null ? { occupation: null } : {};
  }
  if (deleted.fact === "residency") {
    const spec = facts.residency;
    if (!spec?.home || !deleted.value || deleted.value === spec.unsure_value) return {};
    const produced = deleted.value === spec.home.value ? spec.home.tax_residency : spec.non_home_tax_residency ?? "foreign";
    return current.tax_residency === produced && produced !== spec.home.tax_residency ? { tax_residency: spec.home.tax_residency } : {};
  }
  return {};
}

// ── Readiness signals ───────────────────────────────────────────────────────────

export interface SituationProfileSignals {
  situationProfileEnabled?: boolean;
  situationProfiles?: SituationProfile[];
  situationPersonNames?: Record<string, string>;
  situationResidencyUnsureValue?: string | null;
}

/**
 * The readiness signals the two situation findings read (residency_unsure, study_loan_passthrough). The DO
 * and the persona goldens call this same function. Flag OFF ⇒ {} ⇒ findings byte-identical (and no D1 reads).
 */
export async function situationProfileSignals(env: Env, userId: string, startYear: number, descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): Promise<SituationProfileSignals> {
  if (!featureOn(env, "situation_profile")) return {};
  const { persons, profiles } = await personsAndProfiles(env, userId, startYear, descriptor);
  return {
    situationProfileEnabled: true,
    situationProfiles: profiles,
    situationPersonNames: Object.fromEntries(persons.map((n) => [n.id, n.role === "self" ? "" : n.display_name])),
    situationResidencyUnsureValue: situationFacts().residency?.unsure_value ?? null,
  };
}
