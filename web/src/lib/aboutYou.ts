// About you (first-timer spec A2, #585; flags ft_journey + situation_profile): the pure model behind the
// first-run questions. Answers → situation-period writes (POSTed with fill_only, so re-entry never
// overwrites), and existing periods → answers (so re-entering first run shows what's already recorded).
// No React, no fetch: unit-tested in scripts/check-units.ts and replayed by the pft7a persona golden
// through the real writer.

import type { SituationPeriod, SituationPeriodWrite } from "../types";

/** Q1 (myTax Personalise order). */
export type ResidencyChoice = "all_year" | "part_year" | "not_resident" | "unsure";
export type PartYearDirection = "arrived" | "left";
export type VisaChoice = "whm" | "student" | "other";
/** Q5 tick-what-applies keys. `job` mirrors Q4 (one state, two views); `study_loan` only counts with `study`. */
export type TickKey = "job" | "study" | "study_loan" | "abn" | "wfh" | "car" | "foreign";
export type AbnKind = "rideshare" | "delivery" | "freelance" | "other";

export interface AboutAnswers {
  residency: ResidencyChoice | "";
  partYear: { direction: PartYearDirection; date: string };
  visa: VisaChoice | "";
  spouse: "yes" | "no" | "";
  spouseFrom: string;
  spouseTo: string;
  state: string;
  /** Occupation token, "none" (not working yet), or "" (not answered). */
  occupation: string;
  ticks: TickKey[];
  abnKind: AbnKind;
}

export const emptyAnswers = (): AboutAnswers => ({
  residency: "",
  partYear: { direction: "arrived", date: "" },
  visa: "",
  spouse: "",
  spouseFrom: "",
  spouseTo: "",
  state: "",
  occupation: "",
  ticks: [],
  abnKind: "other",
});

export interface FyBounds {
  start: string;
  end: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
/** ISO day ± n days (UTC, so no DST drift). */
export function addDays(isoDay: string, n: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

/** The FY [start, end] for a start year under the tenant's tax period (AU 1 July; UK 6 April). */
export function fyBoundsFor(startYear: number, period: { start_month: number; start_day: number } = { start_month: 7, start_day: 1 }): FyBounds {
  const start = `${startYear}-${pad(period.start_month)}-${pad(period.start_day)}`;
  const next = `${startYear + 1}-${pad(period.start_month)}-${pad(period.start_day)}`;
  return { start, end: addDays(next, -1) };
}

const isIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Why the current Q1 answer can't be saved yet, or null. Part-year needs a date inside the year. */
export function residencyProblem(a: AboutAnswers, fy: FyBounds): string | null {
  if (a.residency === "part_year") {
    if (!isIso(a.partYear.date)) return "Add the date you arrived or left.";
    if (a.partYear.date < fy.start || a.partYear.date > fy.end) return "Pick a date inside the year you're preparing.";
  }
  if (a.residency === "not_resident" && !a.visa) return "Choose the closest match to your visa.";
  return null;
}

/** Why the spouse dates can't be saved yet, or null (dates are optional). */
export function spouseProblem(a: AboutAnswers, fy?: FyBounds): string | null {
  if (a.spouse !== "yes") return null;
  if (a.spouseFrom && !isIso(a.spouseFrom)) return "The 'from' date isn't a real date.";
  if (a.spouseTo && !isIso(a.spouseTo)) return "The 'to' date isn't a real date.";
  // Bounded to the year: an open side defaults to the FY edge, so a date outside it would invert the period.
  if (fy && ((a.spouseFrom && (a.spouseFrom < fy.start || a.spouseFrom > fy.end)) || (a.spouseTo && (a.spouseTo < fy.start || a.spouseTo > fy.end))))
    return "Pick dates inside the year you're preparing.";
  if (a.spouseFrom && a.spouseTo && a.spouseFrom > a.spouseTo) return "The 'from' date must be on or before the 'to' date.";
  return null;
}

const VISA_VALUE: Record<VisaChoice, string> = { whm: "whm", student: "temporary", other: "foreign" };

/** A fact write plus how the page should finish it (an ABN activity also needs its income_activities row). */
export interface PlannedWrite {
  write: SituationPeriodWrite & { fact: string; value: string };
  /** abn_activity: create a business income activity and link it when the period is newly written. */
  linkBusinessActivity?: boolean;
}

/**
 * The periods one person's first-run answers produce. Undated ticks carry no dates (the server spans
 * the active FY, so next year asks again). Unanswered questions write nothing. `source = onboarding`.
 */
export function aboutYouWrites(a: AboutAnswers, personId: string, fy: FyBounds): PlannedWrite[] {
  const out: PlannedWrite[] = [];
  const add = (fact: string, value: string, dates: { starts_on?: string | null; ends_on?: string | null } = {}, extra: Partial<PlannedWrite> = {}) =>
    out.push({ write: { person_id: personId, fact, value, source: "onboarding", ...dates }, ...extra });

  // Q1 residency.
  if (a.residency === "all_year") add("residency", "resident", { starts_on: fy.start, ends_on: fy.end });
  else if (a.residency === "unsure") add("residency", "unsure", { starts_on: fy.start, ends_on: fy.end });
  else if (a.residency === "not_resident" && a.visa) add("residency", VISA_VALUE[a.visa], { starts_on: fy.start, ends_on: fy.end });
  else if (a.residency === "part_year" && residencyProblem(a, fy) == null) {
    const d = a.partYear.date;
    if (a.partYear.direction === "arrived") {
      if (d > fy.start) add("residency", "foreign", { starts_on: fy.start, ends_on: addDays(d, -1) });
      add("residency", "resident", { starts_on: d, ends_on: fy.end });
    } else {
      add("residency", "resident", { starts_on: fy.start, ends_on: d });
      if (d < fy.end) add("residency", "foreign", { starts_on: addDays(d, 1), ends_on: fy.end });
    }
  }

  // Q2 spouse (optional dates; none ⇒ the whole year).
  if (a.spouse === "no") add("spouse", "no", { starts_on: fy.start, ends_on: fy.end });
  else if (a.spouse === "yes" && spouseProblem(a, fy) == null) {
    add("spouse", "yes", { starts_on: a.spouseFrom || fy.start, ends_on: a.spouseTo || fy.end });
  }

  // Q3 state.
  if (a.state) add("state", a.state, { starts_on: fy.start, ends_on: fy.end });

  // Q4 main occupation (+ Q5 'a job', the same state). ref_id stays NULL until an employer is known (A3).
  if (a.occupation) add("employment", a.occupation);

  // Q5 ticks.
  const t = new Set(a.ticks);
  if (t.has("study")) add("study", "yes");
  if (t.has("study") && t.has("study_loan")) add("study_loan", "yes"); // opt-in only (data minimisation)
  if (t.has("abn")) add("abn_activity", a.abnKind, {}, { linkBusinessActivity: true });
  if (t.has("wfh")) add("wfh", "yes");
  if (t.has("car")) add("car_for_work", "yes");
  if (t.has("foreign")) add("foreign_income", "yes");
  return out;
}

const overlapsFy = (p: Pick<SituationPeriod, "starts_on" | "ends_on">, fy: FyBounds) => (p.starts_on ?? "") <= fy.end && (p.ends_on ?? "9999-12-31") >= fy.start;

/**
 * Seed first-run answers from the periods already recorded for this person in the FY, so re-entering
 * shows what's there (and the fill-only writes then skip it). Best effort: shapes the questions can't
 * express (e.g. three residency periods) fall back to "not answered".
 */
export function answersFromPeriods(periods: readonly SituationPeriod[], personId: string, fy: FyBounds): AboutAnswers {
  const a = emptyAnswers();
  const mine = periods
    .filter((p) => p.subject_kind === "person" && p.subject_id === personId && overlapsFy(p, fy))
    .sort((x, y) => ((x.starts_on ?? "") < (y.starts_on ?? "") ? -1 : 1));
  const of = (fact: string) => mine.filter((p) => p.fact === fact);

  const res = of("residency");
  if (res.length === 1) {
    const v = res[0]!.value;
    if (v === "resident") a.residency = "all_year";
    else if (v === "unsure") a.residency = "unsure";
    else if (v === "whm" || v === "temporary" || v === "foreign") {
      a.residency = "not_resident";
      a.visa = v === "whm" ? "whm" : v === "temporary" ? "student" : "other";
    }
  } else if (res.length === 2) {
    const [x, y] = res as [SituationPeriod, SituationPeriod];
    if (x.value !== "resident" && y.value === "resident" && y.starts_on) {
      a.residency = "part_year";
      a.partYear = { direction: "arrived", date: y.starts_on };
    } else if (x.value === "resident" && y.value !== "resident" && x.ends_on) {
      a.residency = "part_year";
      a.partYear = { direction: "left", date: x.ends_on };
    }
  }

  const sp = of("spouse").at(-1);
  if (sp?.value === "yes" || sp?.value === "no") {
    a.spouse = sp.value;
    if (sp.value === "yes") {
      a.spouseFrom = sp.starts_on && sp.starts_on > fy.start ? sp.starts_on : "";
      a.spouseTo = sp.ends_on && sp.ends_on < fy.end ? sp.ends_on : "";
    }
  }
  a.state = of("state").at(-1)?.value ?? "";
  const jobs = of("employment");
  const realJob = jobs.find((j) => j.value && j.value !== "none");
  a.occupation = realJob?.value ?? (jobs.length ? "none" : "");
  const ticks: TickKey[] = [];
  if (realJob) ticks.push("job");
  if (of("study").length) ticks.push("study");
  if (of("study_loan").length) ticks.push("study_loan");
  const abn = of("abn_activity")[0];
  if (abn) {
    ticks.push("abn");
    if (abn.value === "rideshare" || abn.value === "delivery" || abn.value === "freelance" || abn.value === "other") a.abnKind = abn.value;
  }
  if (of("wfh").length) ticks.push("wfh");
  if (of("car_for_work").length) ticks.push("car");
  if (of("foreign_income").length) ticks.push("foreign");
  a.ticks = ticks;
  return a;
}

/**
 * Q4 and Q5's 'a job' chip are one state: ticking the chip with no occupation clears "not working yet"
 * (so Q4 asks again); unticking it sets "not working yet". Picking an occupation ticks it.
 */
export function toggleTick(a: AboutAnswers, key: TickKey): AboutAnswers {
  const on = a.ticks.includes(key);
  let ticks = on ? a.ticks.filter((k) => k !== key) : [...a.ticks, key];
  let occupation = a.occupation;
  if (key === "job") occupation = on ? "none" : occupation === "none" ? "" : occupation;
  if (key === "study" && on) ticks = ticks.filter((k) => k !== "study_loan");
  return { ...a, ticks, occupation };
}

export function setOccupation(a: AboutAnswers, occupation: string): AboutAnswers {
  const working = occupation !== "" && occupation !== "none";
  const ticks = a.ticks.filter((k) => k !== "job");
  return { ...a, occupation, ticks: working ? [...ticks, "job"] : ticks };
}

/** Does this person already have any period recorded for the FY? (No ⇒ first run: next year asks again.) */
export function hasAnswersForFy(periods: readonly SituationPeriod[], personId: string, fy: FyBounds): boolean {
  return periods.some((p) => p.subject_kind === "person" && p.subject_id === personId && overlapsFy(p, fy));
}

/**
 * The first-run writes to actually send. Residency is ONE answer stored as up to two periods (a part-year
 * pair), so fill-gaps applies to it as a unit: when the person already has ANY residency period in the FY,
 * the whole residency answer is skipped — otherwise a changed part-year answer could land half (one side
 * overlaps and skips, the other doesn't) and describe neither answer. Every other fact is left to the
 * server's per-period fill_only check.
 */
export function fillPlan(writes: readonly PlannedWrite[], existing: readonly SituationPeriod[], personId: string, fy: FyBounds): PlannedWrite[] {
  const hasResidency = existing.some((p) => p.subject_kind === "person" && p.subject_id === personId && p.fact === "residency" && overlapsFy(p, fy));
  return hasResidency ? writes.filter((w) => w.write.fact !== "residency") : [...writes];
}

/**
 * First-run screens in order: Get set up's intro (Before you start + the myTax access check, spec §0) first,
 * then the APP-8 consent screen when consent isn't recorded yet, then the six questions in myTax order.
 */
export type AboutScreen = "intro" | "consent" | "residency" | "spouse" | "state" | "occupation" | "ticks" | "confirm";
export function aboutScreens(needsConsent: boolean): AboutScreen[] {
  return ["intro", ...(needsConsent ? (["consent"] as AboutScreen[]) : []), "residency", "spouse", "state", "occupation", "ticks", "confirm"];
}

/** Residency values the person has in the FY (NewcomerCard input). */
export function residencyValuesInFy(periods: readonly SituationPeriod[], personId: string, fy: FyBounds): string[] {
  return periods.filter((p) => p.subject_id === personId && p.fact === "residency" && overlapsFy(p, fy)).map((p) => p.value ?? "");
}

/**
 * Typed or picked occupation → the token the server accepts (pack `employment` values are a lowercase
 * token: /^[a-z][a-z0-9_]{0,39}$/). A known label resolves to its canonical token (via `normalise`, the
 * occupations picklist); free text keeps the user's words as a snake_case token ("Head chef" → "head_chef").
 * "" when nothing usable was typed.
 */
export function occupationToken(text: string, normalise: (s: string) => string): string {
  return normalise(text)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 40)
    .replace(/_+$/, "");
}

/** The residency values the CURRENT first-run answer would write (NewcomerCard while answering). */
export function residencyValuesFromAnswers(a: AboutAnswers, fy: FyBounds): string[] {
  return aboutYouWrites({ ...emptyAnswers(), residency: a.residency, partYear: a.partYear, visa: a.visa }, "_", fy).map((w) => w.write.value);
}

// ── Get set up: the "Can you get into myTax?" self-check (#585, spec §0) ──────────────────────────────

/** The user's own ticks, stored in profiles.ui_state.mytax_check (a UI flag — never credentials). */
export type MyTaxCheck = { mygov: boolean; linked: boolean; myid: boolean };
export const MYTAX_CHECK_KEYS: readonly (keyof MyTaxCheck)[] = ["mygov", "linked", "myid"];

/** Read the ticks from a profile's ui_state JSON; anything missing, malformed or not exactly `true` is unticked. */
export function parseMyTaxCheck(uiState: string | null | undefined): MyTaxCheck {
  const out: MyTaxCheck = { mygov: false, linked: false, myid: false };
  if (!uiState) return out;
  try {
    const v = (JSON.parse(uiState) as { mytax_check?: unknown }).mytax_check;
    if (v && typeof v === "object") for (const k of MYTAX_CHECK_KEYS) out[k] = (v as Record<string, unknown>)[k] === true;
  } catch {
    /* malformed ui_state ⇒ nothing ticked */
  }
  return out;
}
