// The first-timer journey state (spec docs/first-timer/spec.md A11, ticket #582; flag ft_journey).
//
// `GET /api/journey?fy=` is ONE composite fetch for the new app shell + Home: the six steps with a status
// and a count, the readiness hero, the "What's left" list, and the slots later tickets fill (`records` from
// A7, `grow` from A11b). The step rules live here as a PURE function (assessJourney) so they are unit-tested
// offline; journeySignals() does the D1 counting for the DO's journey() (the goldens cover the pure rules).
//
// Signals other tickets own are NOT guessed at here: until they land, Bring in's open payroll/platform
// signals are 0 (A3 noticed_signals wires its own count) and `records` is null (A7). Claims reads A4's
// relevance lists when relevance_scan is ON, else the legacy review queue. Lodged = #572's fy_signoff rule
// (lodged_at OR a NOA close — fy-signoff.ts), so Ship it agrees with the Filing page and /api/lodged.
//
// GENERAL-INFO only: nothing here computes tax, a refund or a rate. The estimate on Home is the readiness
// engine's own indicative taxable position (labelled "estimate only"), shown only when there are 0 blockers.

import type { Env } from "../env";
import type { ReadinessFinding, FilingReadiness, FindingCategory } from "./readiness";
import type { Situation } from "./db";
import { COUNTABLE, NEEDS_REVIEW } from "./queries";
import { featureOn } from "./features";
import { getFyLodged, isFyMarkedLodged, listLodgedFys } from "./fy-signoff";
import { fyBounds, fyLabel } from "./ledger-totals";
import { listSituationPeriods, situationFacts } from "./situation-profile";
import { AU_DESCRIPTOR, type JurisdictionDescriptor } from "./jurisdiction";

export const JOURNEY_STEPS = ["about", "bring_in", "claims", "records", "check", "ship"] as const;
export type JourneyStepKey = (typeof JOURNEY_STEPS)[number];
export type JourneyStepStatus = "not_started" | "in_progress" | "needs_attention" | "done";

export interface JourneyStep {
  key: JourneyStepKey;
  status: JourneyStepStatus;
  /** Items left in the step (0 when nothing is outstanding or the step can't count yet). */
  count: number;
}

/** A7's records block (spec A7 "Server"). null until the Records ticket supplies it. */
export interface JourneyRecords {
  claims_total: number;
  claims_with_record: number;
  claims_exception: number;
  facts_needed: string[];
  facts_done: string[];
}

export interface JourneyWhatsLeft {
  id: string;
  kind: "finding";
  severity: "blocker" | "review";
  title: string;
  step: JourneyStepKey;
}

export interface Journey {
  fy: string;
  lodging_fy: number;
  lodged: boolean;
  steps: JourneyStep[];
  records: JourneyRecords | null;
  /** Grow layer (A11 ticket b fills this; empty until then, so a first-timer sees no Grow items). */
  grow: { layers: { key: string; state: string; reason: string }[]; suggestions: unknown[] };
  readiness: {
    blockers: number;
    review: number;
    ready: boolean;
    /** Present only when blockers === 0 and something is captured. Never tax payable or a refund. */
    estimate: { tracked_cents: number; confirmed_cents: number | null; caption: string } | null;
    disclaimer: string;
  };
  whats_left: JourneyWhatsLeft[];
}

/** The plain values assessJourney classifies (journeySignals gathers them). */
export interface JourneySignals {
  about: {
    residency_answered: boolean;
    occupation_set: boolean;
    /** A2's "tick what applies" saved state. null = not tracked yet (A2 not landed) ⇒ not required. */
    ticks_saved: boolean | null;
  };
  bring_in: { accounts_with_lines: number; any_data: boolean; open_signals: number };
  claims: { any_lines: boolean; undecided: number };
  records: JourneyRecords | null;
  check: { proposals: number };
  ship: { signed_off: boolean; lodged: boolean };
}

// Which step a readiness finding "points into" (spec A11: needs attention = a blocker points into that
// step). Explicit ids first, then the finding's category; anything else is a Check-step item.
const FINDING_STEP: Record<string, JourneyStepKey> = {
  occupation_missing: "about",
  residency_unsure: "about",
  study_loan_passthrough: "about",
  nothing_captured: "bring_in",
  income_not_recorded: "bring_in",
  income_needs_review: "bring_in",
  payg_unresolved: "bring_in",
  fx_unconverted: "bring_in",
  franking_no_doc: "bring_in",
  reportable_amounts: "bring_in",
  unknown_bucket: "claims",
  low_confidence_txns: "claims",
  worksheet_unlabelled: "claims",
  company_unattributed: "claims",
  property_unattributed: "claims",
  undated_receipts: "records",
  refunds_unmatched: "check",
};
const CATEGORY_STEP: Partial<Record<FindingCategory, JourneyStepKey>> = {
  completeness: "bring_in",
  income: "bring_in",
  classification: "claims",
  evidence: "records",
};

export function stepForFinding(f: Pick<ReadinessFinding, "id" | "category">): JourneyStepKey {
  return FINDING_STEP[f.id] ?? CATEGORY_STEP[f.category] ?? "check";
}

/** The six step statuses + counts. Pure. */
export function journeySteps(s: JourneySignals, findings: ReadinessFinding[]): JourneyStep[] {
  const blockersIn = new Map<JourneyStepKey, number>();
  let blockers = 0;
  for (const f of findings) {
    if (f.severity !== "blocker") continue;
    blockers++;
    const k = stepForFinding(f);
    blockersIn.set(k, (blockersIn.get(k) ?? 0) + 1);
  }
  const base: Record<JourneyStepKey, { status: Exclude<JourneyStepStatus, "needs_attention">; count: number }> = {
    about: (() => {
      const facts = [s.about.residency_answered, s.about.occupation_set, ...(s.about.ticks_saved === null ? [] : [s.about.ticks_saved])];
      const missing = facts.filter((x) => !x).length;
      return { status: missing === 0 ? "done" : missing === facts.length ? "not_started" : "in_progress", count: missing };
    })(),
    bring_in: {
      status: s.bring_in.accounts_with_lines >= 1 && s.bring_in.open_signals === 0 ? "done" : s.bring_in.any_data ? "in_progress" : "not_started",
      count: s.bring_in.open_signals,
    },
    claims: {
      status: !s.claims.any_lines ? "not_started" : s.claims.undecided === 0 ? "done" : "in_progress",
      count: s.claims.undecided,
    },
    records: (() => {
      const r = s.records;
      if (!r) return { status: s.claims.any_lines ? "in_progress" : "not_started", count: 0 };
      const factsLeft = r.facts_needed.filter((x) => !r.facts_done.includes(x)).length;
      const claimsLeft = Math.max(0, r.claims_total - r.claims_with_record - r.claims_exception);
      const done = claimsLeft === 0 && factsLeft === 0;
      return { status: done ? "done" : r.claims_total + r.facts_needed.length === 0 ? "not_started" : "in_progress", count: claimsLeft + factsLeft };
    })(),
    check: {
      status: !s.bring_in.any_data ? "not_started" : blockers === 0 && s.check.proposals === 0 ? "done" : "in_progress",
      count: blockers + s.check.proposals,
    },
    ship: { status: s.ship.lodged ? "done" : s.ship.signed_off ? "in_progress" : "not_started", count: 0 },
  };
  return JOURNEY_STEPS.map((key) => {
    const b = base[key];
    // A blocker pointing into a step outranks every other state — including "done" (a fact the user
    // already entered can still be flagged), except Ship it once the year is lodged.
    const attention = (blockersIn.get(key) ?? 0) > 0 && !(key === "ship" && s.ship.lodged);
    return { key, status: attention ? "needs_attention" : b.status, count: b.count };
  });
}

/** Compose the journey payload from readiness + the step signals. Pure. */
export function assessJourney(input: { readiness: FilingReadiness; signals: JourneySignals; lodgingFy: number }): Journey {
  const { readiness, signals } = input;
  const score = readiness.readiness_score;
  const nothing = readiness.findings.some((f) => f.id === "nothing_captured");
  const pos = readiness.position;
  return {
    fy: readiness.fy,
    lodging_fy: input.lodgingFy,
    lodged: signals.ship.lodged,
    steps: journeySteps(signals, readiness.findings),
    records: signals.records,
    grow: { layers: [], suggestions: [] },
    readiness: {
      blockers: score.blockers,
      review: score.review,
      ready: score.ready,
      estimate: score.blockers === 0 && !nothing
        ? { tracked_cents: pos.indicative_taxable_position_cents, confirmed_cents: pos.taxable_position_confirmed_cents ?? null, caption: pos.caption }
        : null,
      disclaimer: readiness.disclaimer,
    },
    whats_left: readiness.findings
      .filter((f): f is ReadinessFinding & { severity: "blocker" | "review" } => f.severity === "blocker" || f.severity === "review")
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "blocker" ? -1 : 1))
      .map((f) => ({ id: f.id, kind: "finding" as const, severity: f.severity, title: f.title, step: stepForFinding(f) })),
  };
}

/** The journey for a tenant with no profile yet (pre-onboarding): every step not started, no findings. */
export function coldJourney(startYear: number, lodgingFyDefault: number): Journey {
  return {
    fy: fyLabel(startYear),
    lodging_fy: lodgingFyDefault,
    lodged: false,
    steps: JOURNEY_STEPS.map((key) => ({ key, status: "not_started" as const, count: 0 })),
    records: null,
    grow: { layers: [], suggestions: [] },
    readiness: { blockers: 0, review: 0, ready: false, estimate: null, disclaimer: "General information only, not tax advice." },
    whats_left: [],
  };
}

/** FYs that count as lodged, for #572's lodging-year default. Same flag split as journeySignals' Ship it read. */
export async function journeyLodgedFys(env: Env, userId: string): Promise<number[]> {
  if (featureOn(env, "situation_profile")) return listLodgedFys(env, userId);
  const res = await env.DB.prepare(`SELECT fy FROM fy_signoff WHERE user_id = ? AND status = 'closed_with_noa' ORDER BY fy`).bind(userId).all<{ fy: number }>();
  return (res.results ?? []).map((r) => Number(r.fy));
}

// ── D1 signal gathering ────────────────────────────────────────────────────────────────────────────

/**
 * Count the per-step signals for one FY. Read-only; called by the DO's journey().
 * `situation` is the tenant's getSituation() (self person first).
 */
export async function journeySignals(
  env: Env,
  userId: string,
  startYear: number,
  situation: Pick<Situation, "persons">,
  descriptor: JurisdictionDescriptor = AU_DESCRIPTOR,
): Promise<JourneySignals> {
  const { start, end } = fyBounds(startYear, descriptor);
  const fy = fyLabel(startYear);
  const n = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0;
  const self = situation.persons.find((p) => p.role === "self") ?? situation.persons[0];

  // About you: residency + occupation. With situation_profile ON the dated periods are the source (an
  // 'unsure' residency is not an answer; an employment period — including "not working" — sets the
  // occupation). OFF: the legacy scalars (tax_residency always has a value; occupation may be null).
  let residencyAnswered = !!self?.tax_residency;
  let occupationSet = !!self?.occupation;
  if (featureOn(env, "situation_profile") && self) {
    // Only periods overlapping this FY (open-ended dates count as unbounded on that side).
    const periods = (await listSituationPeriods(env, userId, self.id)).filter((p) => (!p.starts_on || p.starts_on <= end) && (!p.ends_on || p.ends_on >= start));
    const unsure = situationFacts().residency?.unsure_value ?? null;
    const res = periods.filter((p) => p.fact === "residency");
    if (res.length) residencyAnswered = res.every((p) => p.value != null && p.value !== unsure);
    occupationSet = occupationSet || periods.some((p) => p.fact === "employment");
  }

  const [accountsWithLines, txnsInFy, incomeInFy] = await Promise.all([
    n(`SELECT COUNT(DISTINCT account_id) AS n FROM transactions
        WHERE user_id = ? AND kind = 'bank_line' AND account_id IS NOT NULL AND status NOT IN ('duplicate')
          AND txn_date >= ? AND txn_date <= ?`, userId, start, end),
    n(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND ${COUNTABLE}`, userId, start, end),
    n(`SELECT COUNT(*) AS n FROM income WHERE user_id = ? AND fy = ?`, userId, fy),
  ]);
  // Claims (spec: done = no relevant / worth_a_look line left undecided for the FY). With A4's
  // relevance_scan ON that is the scan's lists (same line filter as relevanceView) minus lines the user
  // has confirmed either way; OFF, the FY's legacy review queue stands in.
  const undecided = featureOn(env, "relevance_scan")
    ? await n(`SELECT COUNT(*) AS n FROM transactions
                WHERE user_id = ? AND kind = 'bank_line' AND status NOT IN ('duplicate','ignored')
                  AND relevance IN ('relevant','worth_a_look')
                  AND COALESCE(deductibility,'undetermined') NOT IN ('confirmed_deductible','confirmed_not')
                  AND txn_date >= ? AND txn_date <= ?`, userId, start, end)
    : await n(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND ${NEEDS_REVIEW}`, userId, start, end);
  // Ship it: a sign-off row means the user reached the hand-off; #572's lodged rule means the year is lodged.
  // lodged_at (0087) is only read with situation_profile ON (fy-signoff.ts: gating is the caller's job);
  // OFF, only a NOA close counts — the same rule minus the user's own mark, which OFF can't record.
  const signoff = featureOn(env, "situation_profile")
    ? await getFyLodged(env, userId, startYear)
    : await env.DB.prepare(`SELECT status FROM fy_signoff WHERE user_id = ? AND fy = ?`).bind(userId, startYear).first<{ status: string | null }>()
        .then((r) => (r ? { lodged_at: null, status: r.status } : null));
  // Reconcile proposals (A8) are counted by the caller (it owns the pack-resolved thresholds).
  return {
    about: { residency_answered: residencyAnswered, occupation_set: occupationSet, ticks_saved: null },
    bring_in: { accounts_with_lines: accountsWithLines, any_data: txnsInFy + incomeInFy > 0, open_signals: 0 },
    claims: { any_lines: txnsInFy > 0, undecided },
    records: null,
    check: { proposals: 0 },
    ship: { signed_off: !!signoff, lodged: isFyMarkedLodged(signoff) },
  };
}
