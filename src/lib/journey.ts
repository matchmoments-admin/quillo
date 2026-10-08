// The first-timer journey state (spec docs/first-timer/spec.md A11, ticket #582; flag ft_journey).
//
// `GET /api/journey?fy=` is ONE composite fetch for the new app shell + Home: the four steps with a status
// and a count, the readiness hero, the "What's left" list, `grow` (src/lib/grow.ts, A11b #592) and the
// slot A7 fills (`records`). The step rules live here as a PURE function (assessJourney) so they are unit-tested
// offline; journeySignals() does the D1 counting for the DO's journey() (the goldens cover the pure rules).
//
// Signals other tickets own are NOT guessed at here: journeySignals leaves the open "we noticed" signal count
// at 0 and `records` null; the composer (journey-read.ts readJourney) fills both — open signals from A3's
// noticed_signals (wages_payer, #595) and A7's records block. Claims reads A4's
// relevance lists when relevance_scan is ON, else the legacy review queue. Lodged = #572's fy_signoff rule
// (lodged_at OR a NOA close — fy-signoff.ts), so Lodge in myTax agrees with the Filing page and /api/lodged.
//
// FOUR steps since the design review of 2026-10-04 (spec §0, #585): setup (Get set up) → connect (Connect) →
// review (Review) → lodge (Lodge in myTax). The signal groups below keep their original names (about,
// bring_in, claims, records, check, ship) — they are the INPUTS, not steps: Review folds claims + records +
// check + the "we noticed" signals into one queue, so its status/count is computed from all of them.
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
import type { GrowPayload } from "./grow";

export const JOURNEY_STEPS = ["setup", "connect", "review", "lodge"] as const;
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
  /** #589: the finding's general-information note and the kind of its first evidence ref, so the Check step
   *  can show each item with its fix link without a second (audited) readiness read. */
  note: string;
  evidence_kind: string | null;
}

export interface Journey {
  fy: string;
  lodging_fy: number;
  lodged: boolean;
  steps: JourneyStep[];
  records: JourneyRecords | null;
  /** Grow layer (A11 ticket b, src/lib/grow.ts): every available layer + its visibility, and open suggestions. */
  grow: GrowPayload;
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
  occupation_missing: "setup",
  residency_unsure: "setup",
  study_loan_passthrough: "setup",
  nothing_captured: "connect",
  income_not_recorded: "connect",
  income_needs_review: "connect",
  payg_unresolved: "connect",
  fx_unconverted: "connect",
  franking_no_doc: "connect",
  reportable_amounts: "connect",
};
const CATEGORY_STEP: Partial<Record<FindingCategory, JourneyStepKey>> = {
  completeness: "connect",
  income: "connect",
};

/** Setup / Connect findings by id or category; everything else (classification, evidence, checks) is a Review card. */
export function stepForFinding(f: Pick<ReadinessFinding, "id" | "category">): JourneyStepKey {
  return FINDING_STEP[f.id] ?? CATEGORY_STEP[f.category] ?? "review";
}

/** The four step statuses + counts. Pure. */
export function journeySteps(s: JourneySignals, findings: ReadinessFinding[]): JourneyStep[] {
  const blockersIn = new Map<JourneyStepKey, number>();
  for (const f of findings) {
    if (f.severity !== "blocker") continue;
    const k = stepForFinding(f);
    blockersIn.set(k, (blockersIn.get(k) ?? 0) + 1);
  }
  const base: Record<JourneyStepKey, { status: Exclude<JourneyStepStatus, "needs_attention">; count: number }> = {
    setup: (() => {
      const facts = [s.about.residency_answered, s.about.occupation_set, ...(s.about.ticks_saved === null ? [] : [s.about.ticks_saved])];
      const missing = facts.filter((x) => !x).length;
      return { status: missing === 0 ? "done" : missing === facts.length ? "not_started" : "in_progress", count: missing };
    })(),
    connect: {
      status: s.bring_in.accounts_with_lines >= 1 ? "done" : s.bring_in.any_data ? "in_progress" : "not_started",
      count: 0,
    },
    review: (() => {
      // ONE queue (spec §0): undecided claim lines + records still needed + receipt-match proposals + open
      // "we noticed" signals. Records waits for A7: a null block is never a false "done" once lines exist.
      const r = s.records;
      const recordsLeft = r
        ? Math.max(0, r.claims_total - r.claims_with_record - r.claims_exception) + r.facts_needed.filter((x) => !r.facts_done.includes(x)).length
        : 0;
      const recordsPending = !r && s.claims.any_lines;
      const count = s.claims.undecided + recordsLeft + s.check.proposals + s.bring_in.open_signals;
      if (!s.bring_in.any_data && !s.claims.any_lines && count === 0) return { status: "not_started", count };
      return { status: count === 0 && !recordsPending ? "done" : "in_progress", count };
    })(),
    lodge: { status: s.ship.lodged ? "done" : s.ship.signed_off ? "in_progress" : "not_started", count: 0 },
  };
  return JOURNEY_STEPS.map((key) => {
    const b = base[key];
    // A blocker pointing into a step outranks every other state — including "done" (a fact the user
    // already entered can still be flagged), except Lodge once the year is lodged.
    const attention = (blockersIn.get(key) ?? 0) > 0 && !(key === "lodge" && s.ship.lodged);
    return { key, status: attention ? "needs_attention" : b.status, count: b.count };
  });
}

/** Compose the journey payload from readiness + the step signals. Pure. */
export function assessJourney(input: { readiness: FilingReadiness; signals: JourneySignals; lodgingFy: number; grow?: GrowPayload }): Journey {
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
    grow: input.grow ?? { layers: [], suggestions: [] },
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
      .map((f) => ({ id: f.id, kind: "finding" as const, severity: f.severity, title: f.title, step: stepForFinding(f), note: f.general_info_note, evidence_kind: f.evidence_refs[0]?.kind ?? null })),
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

/** FYs that count as lodged, for #572's lodging-year default. Same flag split as journeySignals' Lodge read. */
export async function journeyLodgedFys(env: Env, userId: string): Promise<number[]> {
  if (featureOn(env, "situation_profile")) return listLodgedFys(env, userId);
  const res = await env.DB.prepare(`SELECT fy FROM fy_signoff WHERE user_id = ? AND status = 'closed_with_noa' ORDER BY fy`).bind(userId).all<{ fy: number }>();
  return (res.results ?? []).map((r) => Number(r.fy));
}

// ── D1 signal gathering ────────────────────────────────────────────────────────────────────────────

/** Situation-period sources that are the user's own answer (0078: user | onboarding | noticed). */
const USER_ANSWER_SOURCES = new Set(["user", "onboarding"]);

/** The "undecided claim line" predicate: A4's relevance lists with relevance_scan ON, else the legacy review queue. */
function undecidedWhere(env: Env): string {
  return featureOn(env, "relevance_scan")
    ? `kind = 'bank_line' AND status NOT IN ('duplicate','ignored')
         AND relevance IN ('relevant','worth_a_look')
         AND COALESCE(deductibility,'undetermined') NOT IN ('confirmed_deductible','confirmed_not')`
    : NEEDS_REVIEW;
}

/**
 * How many of `txnIds` (this FY) journeySignals counted as undecided lines. The composer subtracts these when
 * an open "We noticed" card already stands for them, so one payroll deposit is never two Review items (#595).
 */
export async function undecidedAmong(env: Env, userId: string, startYear: number, txnIds: string[], descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): Promise<number> {
  if (!txnIds.length) return 0;
  const { start, end } = fyBounds(startYear, descriptor);
  let total = 0;
  for (let i = 0; i < txnIds.length; i += 90) { // D1 caps bound parameters at 100 per statement
    const chunk = txnIds.slice(i, i + 90);
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND ${undecidedWhere(env)}
         AND id IN (${chunk.map(() => "?").join(",")})`,
    ).bind(userId, start, end, ...chunk).first<{ n: number }>();
    total += r?.n ?? 0;
  }
  return total;
}

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
    // Only the user's own answer counts (#595): persons.tax_residency defaults to 'AU' on every new person,
    // so falling back to it made a brand-new tenant's Get set up read "in progress" before any question
    // was answered. A residency period the user (or first run) wrote is the answer; a default is not.
    const res = periods.filter((p) => p.fact === "residency" && USER_ANSWER_SOURCES.has(p.source));
    residencyAnswered = res.length > 0 && res.every((p) => p.value != null && p.value !== unsure);
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
  const undecided = await n(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND ${undecidedWhere(env)}`, userId, start, end);
  // Lodge in myTax: a sign-off row means the user reached the hand-off; #572's lodged rule means the year is lodged.
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
