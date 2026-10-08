// "We noticed…" signals — the D1 side of the credit triage (first-timer spec A3, #577, flag `wages_payer`).
//
// The Durable Object calls these (serialised behind its period-write lock, so a confirm and a situation-period
// edit can't race the overlap check), and so do the persona goldens (scripts/check-personas.ts pft8), so there
// is ONE definition of every write to be right or wrong about.
//
// What a confirm does, per kind (spec A3 table; owner ruling #554 for wages):
//   payroll    → create/match the employer entity, link an `employment` period, stamp payer_entity_id on that
//                payer's credits in the FY. NO income row, ever — a deposit is take-home pay; the user is asked
//                for the income statement instead (it carries gross pay and tax withheld).
//   platform   → an `abn_activity` period + a business income activity, and the payouts recorded as business
//                income through the DO's direction-safe recordCreditAsIncome (passed in as a dependency).
//   government / interest → nothing recorded; the worksheet gains a "check this matches" line and the card
//                offers manual entry.
//   foreign    → the `foreign_income` situation fact; manual entry offered. A transfer is never treated as income.
// Dismiss is terminal for that FY + kind + payer key: the scan's upsert only refreshes rows still 'open'.

import type { Env } from "../env";
import { featureOn } from "./features";
import { fyBounds, fyLabel, parseFyStartYear } from "./ledger-totals";
import { fyForDate, resolveRulePack } from "./report";
import { AU_DESCRIPTOR, type JurisdictionDescriptor } from "./jurisdiction";
import { creditSignalLists, payerStem, triageCredits, type CreditSignalLists, type SignalEvidence, type SignalKind, type TriageCredit } from "./credit-triage";
import { addEntity, addIncomeActivity, upsertSituationPeriod } from "./situation-write";
import { listSituationPeriods, rangesOverlap, situationFacts } from "./situation-profile";
import { payerKey } from "./first-timer-signals";
import { FX_CONVERTED, COUNTABLE_INCOME } from "./queries";

/** The copy every wages confirm shows (#554). General information; no figure. */
export const INCOME_STATEMENT_PROMPT =
  "Your income statement in myTax shows your gross pay and tax withheld. Check it's there and enter it here, and Quillo will use it.";

export class NoticedError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

export interface NoticedSignal {
  id: string;
  fy: string;
  kind: SignalKind | string;
  signal_key: string;
  status: "open" | "confirmed" | "dismissed" | string;
  evidence: SignalEvidence;
  ref_id: string | null;
  created_at: string;
  decided_at: string | null;
}

interface SignalRow {
  id: string;
  fy: string;
  kind: string;
  signal_key: string;
  status: string;
  evidence_json: string;
  ref_id: string | null;
  created_at: string;
  decided_at: string | null;
}

const toSignal = (r: SignalRow): NoticedSignal => {
  let evidence = {} as SignalEvidence;
  try { evidence = JSON.parse(r.evidence_json) as SignalEvidence; } catch { /* malformed ⇒ empty evidence */ }
  return { id: r.id, fy: r.fy, kind: r.kind, signal_key: r.signal_key, status: r.status, evidence, ref_id: r.ref_id, created_at: r.created_at, decided_at: r.decided_at };
};

const selfPersonId = (userId: string) => `person_self_${userId}`;

/**
 * The rows an income answer may record (Clarify "rental / business / personal income"): a credit stamped as pay
 * from a marked employer is take-home pay and is NEVER recorded as income (#554 — it would double-count once the
 * income statement arrives). `refused` when the group's only recordable credits are payer-stamped, so the
 * answer is rejected with a plain message instead of silently doing nothing. Pure (the DO + pft8 call it).
 */
export function incomeAnswerRows<T extends { direction: string | null; matched_income_id: string | null; payer_entity_id?: string | null }>(
  group: ReadonlyArray<T>,
): { refused: boolean; rows: T[] } {
  const stamped = group.some((r) => r.direction === "credit" && !!r.payer_entity_id);
  const rows = group.filter((r) => !r.payer_entity_id);
  const recordable = rows.some((r) => r.direction === "credit" && !r.matched_income_id);
  return { refused: stamped && !recordable, rows };
}

export const STAMPED_INCOME_REFUSAL =
  "These are pay from an employer you've marked, so they can't be recorded as income. Add the employer's income statement on the Income page instead.";

/**
 * Two employer names are the same payer: equal payerKeys, or the shorter (at least TWO words) is a leading run of
 * the longer's words ("Big Retail" ≡ "Big Retail Group"). A one-word name never subset-matches ("Coles" is not
 * "Coles Express"), and words out of order don't ("Big Retail" is not "Big W Retail").
 */
export function employerMatches(a: unknown, b: unknown): boolean {
  const ka = payerKey(a);
  const kb = payerKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [short, long] = ka.length <= kb.length ? [ka.split(" "), kb.split(" ")] : [kb.split(" "), ka.split(" ")];
  return short.length >= 2 && short.every((w, i) => long[i] === w);
}

// The credits the triage reads: live bank credits not already recorded as income, linked to a refund, or
// owned by another step. Payer-stamped credits stay in (their confirmed signal is a no-op on re-scan).
const TRIAGE_WHERE =
  "kind = 'bank_line' AND direction = 'credit' AND status NOT IN ('ignored','duplicate') AND matched_income_id IS NULL " +
  "AND refund_for_txn_id IS NULL AND COALESCE(bucket, '') <> 'refund' AND txn_date IS NOT NULL";

type CreditRow = TriageCredit & { payer_entity_id: string | null; direction: string | null; matched_income_id: string | null; currency: string | null };

async function creditsBetween(env: Env, userId: string, start: string | null, end: string | null): Promise<CreditRow[]> {
  const range = start && end ? " AND txn_date >= ? AND txn_date <= ?" : "";
  return (
    (await env.DB.prepare(
      `SELECT id, raw_description, merchant, amount_cents, amount_aud_cents, txn_date, payer_entity_id, direction, matched_income_id, currency
         FROM transactions WHERE user_id = ? AND ${TRIAGE_WHERE}${range}`,
    )
      .bind(...(range ? [userId, start, end] : [userId]))
      .all<CreditRow>()).results ?? []
  );
}

async function listsFor(env: Env, userId: string, descriptor: JurisdictionDescriptor): Promise<CreditSignalLists> {
  return creditSignalLists(await resolveRulePack(env, userId, descriptor));
}

/**
 * Run the triage over every FY the tenant's credits reach and upsert one signal per FY + kind + payer key.
 * Called after stampDeductibility on every ingest path (statement + feed). A row the user already decided is
 * never touched (refresh is `WHERE status = 'open'`), so a dismissal survives every re-import. Flag OFF ⇒ no-op.
 */
export async function noticeSignals(env: Env, userId: string, descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): Promise<{ upserted: number }> {
  if (!featureOn(env, "wages_payer")) return { upserted: 0 };
  const lists = await listsFor(env, userId, descriptor);
  const rows = await creditsBetween(env, userId, null, null);
  const stemOf = new Map(rows.map((r) => [r.id, payerStem(r.raw_description ?? r.merchant, lists)]));
  const employerKeys = new Set([...rows].filter((r) => r.payer_entity_id).map((r) => stemOf.get(r.id)).filter((k): k is string => !!k));
  const byFy = new Map<string, CreditRow[]>();
  for (const r of rows) {
    const fy = fyForDate(r.txn_date, descriptor);
    if (!fy) continue;
    const g = byFy.get(fy);
    if (g) g.push(r);
    else byFy.set(fy, [r]);
  }
  const stmts: D1PreparedStatement[] = [];
  // Payroll payers already confirmed (per FY + key → employer entity): every NEW deposit from the same payer stem
  // is stamped with the employer too — whether or not the triage still emits the signal (a bonus outside the
  // amount band must not leave next month's pay unstamped and recordable as income). Records nothing.
  const confirmed = (await env.DB.prepare(`SELECT fy, signal_key, ref_id FROM noticed_signals WHERE user_id = ? AND kind = 'payroll' AND status = 'confirmed' AND ref_id IS NOT NULL`)
    .bind(userId)
    .all<{ fy: string; signal_key: string; ref_id: string }>()).results ?? [];
  for (const c of confirmed) {
    const ids = (byFy.get(c.fy) ?? []).filter((r) => !r.payer_entity_id && stemOf.get(r.id) === c.signal_key).map((r) => r.id);
    stmts.push(...stampStatements(env, userId, c.ref_id, ids));
  }
  let upserted = 0;
  for (const [fy, rs] of byFy) {
    for (const s of triageCredits(rs, lists, employerKeys)) {
      upserted++;
      // A decided row is never touched; an open row only when its evidence actually changed.
      stmts.push(
        env.DB.prepare(
          `INSERT INTO noticed_signals (id, user_id, fy, kind, signal_key, status, evidence_json) VALUES (?, ?, ?, ?, ?, 'open', ?)
           ON CONFLICT(user_id, fy, kind, signal_key) DO UPDATE SET evidence_json = excluded.evidence_json
           WHERE noticed_signals.status = 'open' AND noticed_signals.evidence_json <> excluded.evidence_json`,
        ).bind(crypto.randomUUID(), userId, fy, s.kind, s.signal_key, JSON.stringify(s.evidence)),
      );
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { upserted };
}

/** UPDATEs stamping credits with their employer (≤ 80 ids per statement — D1's 100-bind limit). Never re-stamps. */
function stampStatements(env: Env, userId: string, entityId: string, ids: string[]): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    out.push(
      env.DB.prepare(
        `UPDATE transactions SET payer_entity_id = ? WHERE user_id = ? AND direction = 'credit' AND payer_entity_id IS NULL AND id IN (${chunk.map(() => "?").join(",")})`,
      ).bind(entityId, userId, ...chunk),
    );
  }
  return out;
}

/**
 * Stamp every FY credit from this payer stem with the employer. Returns how many were stamped now, plus how many
 * of the payer's credits were ALREADY recorded as income (the pre-#554 Clarify "personal income" path) — those
 * would double-count once the income statement arrives, so the caller surfaces them for the user to undo.
 */
async function stampPayer(env: Env, userId: string, fy: string, stem: string, entityId: string, lists: CreditSignalLists, descriptor: JurisdictionDescriptor): Promise<{ stamped: number; previously_recorded: number }> {
  const { start, end } = fyBounds(parseFyStartYear(fy), descriptor);
  const rows = (await env.DB.prepare(
    `SELECT t.id, t.raw_description, t.merchant, t.payer_entity_id, i.income_type AS recorded_type FROM transactions t
       LEFT JOIN income i ON i.id = t.matched_income_id AND i.user_id = t.user_id
      WHERE t.user_id = ? AND t.kind = 'bank_line' AND t.direction = 'credit' AND t.status <> 'duplicate' AND t.txn_date >= ? AND t.txn_date <= ?`,
  ).bind(userId, start, end).all<{ id: string; raw_description: string | null; merchant: string | null; payer_entity_id: string | null; recorded_type: string | null }>()).results ?? [];
  const mine = rows.filter((r) => payerStem(r.raw_description ?? r.merchant, lists) === stem);
  // Only live, unlinked credits are stamped (the same set the triage reads).
  const live = new Set((await creditsBetween(env, userId, start, end)).map((r) => r.id));
  const ids = mine.filter((r) => !r.payer_entity_id && live.has(r.id)).map((r) => r.id);
  let stamped = 0;
  for (const st of stampStatements(env, userId, entityId, ids)) stamped += (await st.run()).meta?.changes ?? 0;
  // A credit linked to a salary row is a match, not a double count; one recorded AS 'personal' income is.
  return { stamped, previously_recorded: mine.filter((r) => r.recorded_type === "personal").length };
}

/** Open signals for one FY (start year), payroll first then biggest total. */
export async function listNoticed(env: Env, userId: string, startYear: number): Promise<NoticedSignal[]> {
  const rows = (await env.DB.prepare(
    `SELECT id, fy, kind, signal_key, status, evidence_json, ref_id, created_at, decided_at
       FROM noticed_signals WHERE user_id = ? AND fy = ? AND status = 'open'
      ORDER BY CASE kind WHEN 'payroll' THEN 0 WHEN 'platform' THEN 1 WHEN 'government' THEN 2 WHEN 'interest' THEN 3 WHEN 'foreign' THEN 4 ELSE 5 END,
               json_extract(evidence_json, '$.total_cents') DESC, signal_key`,
  ).bind(userId, fyLabel(startYear)).all<SignalRow>()).results ?? [];
  return rows.map(toSignal);
}

async function getSignal(env: Env, userId: string, id: string): Promise<NoticedSignal> {
  const r = await env.DB.prepare(
    `SELECT id, fy, kind, signal_key, status, evidence_json, ref_id, created_at, decided_at FROM noticed_signals WHERE id = ? AND user_id = ?`,
  ).bind(id, userId).first<SignalRow>();
  if (!r) throw new NoticedError("signal not found", 404);
  return toSignal(r);
}

/** "No" — dismiss for this FY + payer key. Terminal for the scan (it never re-opens a decided row). */
export async function dismissNoticed(env: Env, userId: string, id: string): Promise<{ ok: true; status: string }> {
  const s = await getSignal(env, userId, id);
  if (s.status === "confirmed") throw new NoticedError("This one is already confirmed.", 409);
  await env.DB.prepare(`UPDATE noticed_signals SET status = 'dismissed', decided_at = datetime('now') WHERE id = ? AND user_id = ? AND status = 'open'`)
    .bind(id, userId)
    .run();
  return { ok: true, status: "dismissed" };
}

export interface ConfirmBody {
  occupation?: unknown; // payroll: the job's occupation token (else the person's current occupation)
  employer_name?: unknown; // payroll: correct the payer's display name
  person_id?: unknown; // whose job / activity (default: the primary taxpayer)
}

export interface ConfirmDeps {
  /** Record ONE credit as income and link it (the DO's recordCreditAsIncome). Returns the income id, or null if skipped. */
  recordCreditAsIncome: (row: CreditRow, opts: { incomeType: string; fy: string }) => Promise<string | null>;
  descriptor?: JurisdictionDescriptor;
  now?: Date;
}

export interface ConfirmResult {
  kind: string;
  status: "confirmed";
  already?: boolean;
  income_recorded: number;
  entity_id?: string;
  employer_name?: string;
  stamped?: number;
  period_id?: string | null;
  needs_occupation?: boolean;
  activity_id?: string;
  prompt?: string;
  offer_manual_income?: string[];
  residency_unanswered?: boolean;
  /** payroll: this payer's credits ALREADY recorded as personal income before #554 — undo them, or gross counts twice. */
  previously_recorded?: number;
}

const optStr = (v: unknown, max = 80): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** The FY's credits that belong to this signal — re-derived with the SAME triage, so confirm acts on what was shown. */
async function signalCredits(env: Env, userId: string, s: NoticedSignal, lists: CreditSignalLists, descriptor: JurisdictionDescriptor): Promise<CreditRow[]> {
  const { start, end } = fyBounds(parseFyStartYear(s.fy), descriptor);
  const rows = await creditsBetween(env, userId, start, end);
  if (s.kind === "payroll") return rows.filter((r) => payerStem(r.raw_description ?? r.merchant, lists) === s.signal_key);
  const hit = triageCredits(rows, lists).find((t) => t.kind === s.kind && t.signal_key === s.signal_key);
  const ids = new Set(hit?.txn_ids ?? []);
  return rows.filter((r) => ids.has(r.id));
}

/**
 * The transaction ids behind a set of signals (re-derived with the SAME triage confirm uses — evidence stores
 * counts only, never ids). The journey's Review count uses it so a credit an open card already stands for
 * isn't counted again as an undecided line (#595). Read-only.
 */
export async function signalTxnIds(env: Env, userId: string, signals: NoticedSignal[], descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): Promise<string[]> {
  if (!signals.length) return [];
  const lists = await listsFor(env, userId, descriptor);
  const ids = new Set<string>();
  for (const s of signals) for (const r of await signalCredits(env, userId, s, lists, descriptor)) ids.add(r.id);
  return [...ids];
}

/**
 * "Yes" on a signal. Claims the row first (open|dismissed → confirmed, guarded) so a double tap can't apply it
 * twice; a failure part-way restores the prior status so the user can retry. Situation periods are written
 * only when `situation_profile` is ON (the profile's writer and mirrors are that flag's).
 */
export async function confirmNoticed(env: Env, userId: string, id: string, rawBody: ConfirmBody | null | undefined, deps: ConfirmDeps): Promise<ConfirmResult> {
  if (!featureOn(env, "wages_payer")) throw new NoticedError("not available", 404);
  const body: ConfirmBody = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {};
  const descriptor = deps.descriptor ?? AU_DESCRIPTOR;
  const s = await getSignal(env, userId, id);
  if (s.status === "confirmed") return confirmedAgain(env, userId, s, descriptor);
  const personId = optStr(body.person_id, 200) ?? selfPersonId(userId);
  const person = await env.DB.prepare(`SELECT id, occupation FROM persons WHERE id = ? AND user_id = ?`).bind(personId, userId).first<{ id: string; occupation: string | null }>();
  if (!person) throw new NoticedError("person not found", 404);

  const claim = await env.DB.prepare(
    `UPDATE noticed_signals SET status = 'confirmed', decided_at = datetime('now') WHERE id = ? AND user_id = ? AND status IN ('open','dismissed')`,
  ).bind(id, userId).run();
  if (!(claim.meta?.changes ?? 0)) return confirmedAgain(env, userId, await getSignal(env, userId, id), descriptor);
  try {
    const result = await applyConfirm(env, userId, s, body, person, deps, descriptor);
    if (result.ref) await env.DB.prepare(`UPDATE noticed_signals SET ref_id = ? WHERE id = ? AND user_id = ?`).bind(result.ref, id, userId).run();
    return result.out;
  } catch (e) {
    await env.DB.prepare(`UPDATE noticed_signals SET status = ?, decided_at = ? WHERE id = ? AND user_id = ?`).bind(s.status, s.decided_at, id, userId).run();
    throw e;
  }
}

/**
 * "Yes" on a signal that is already confirmed: nothing is re-applied, but a payroll payer's newer credits are
 * stamped with its employer (the Clarify "My wages" answer lands here when the card was confirmed first).
 */
async function confirmedAgain(env: Env, userId: string, s: NoticedSignal, descriptor: JurisdictionDescriptor): Promise<ConfirmResult> {
  const base: ConfirmResult = { kind: s.kind, status: "confirmed", already: true, income_recorded: 0, ...(s.ref_id ? { entity_id: s.ref_id } : {}) };
  if (s.kind !== "payroll" || !s.ref_id) return base;
  const r = await stampPayer(env, userId, s.fy, s.signal_key, s.ref_id, await listsFor(env, userId, descriptor), descriptor);
  return { ...base, stamped: r.stamped, prompt: INCOME_STATEMENT_PROMPT, ...(r.previously_recorded ? { previously_recorded: r.previously_recorded } : {}) };
}

async function applyConfirm(
  env: Env,
  userId: string,
  s: NoticedSignal,
  body: ConfirmBody,
  person: { id: string; occupation: string | null },
  deps: ConfirmDeps,
  descriptor: JurisdictionDescriptor,
): Promise<{ ref: string | null; out: ConfirmResult }> {
  const startYear = parseFyStartYear(s.fy);
  const { start, end } = fyBounds(startYear, descriptor);
  const profileOn = featureOn(env, "situation_profile");
  const lists = await listsFor(env, userId, descriptor);
  const periodsFor = async (fact: string) =>
    (await listSituationPeriods(env, userId, person.id)).filter((p) => p.fact === fact && rangesOverlap(p.starts_on, p.ends_on, start, end));

  if (s.kind === "payroll") {
    const name = optStr(body.employer_name) ?? (optStr(s.evidence.label) || s.signal_key);
    // Fill-gaps match on kind + name, so a second confirm (or next year's) reuses the same employer.
    // Scoped to this person (a spouse's employer is not this person's job).
    const jobs = (await env.DB.prepare(`SELECT id, name FROM entities WHERE user_id = ? AND kind = 'employment' AND (person_id IS NULL OR person_id = ?)`).bind(userId, person.id).all<{ id: string; name: string | null }>()).results ?? [];
    const entityId = jobs.find((j) => employerMatches(j.name, name))?.id ?? (await addEntity(env, userId, { kind: "employment", name, person_id: person.id }));

    let periodId: string | null = null;
    let needsOccupation = false;
    if (profileOn) {
      const emp = await periodsFor("employment");
      const linked = emp.find((p) => p.ref_id === entityId);
      const gap = emp.find((p) => p.ref_id == null && p.value && p.value !== "none");
      const occupation = optStr(body.occupation, 60)?.toLowerCase() ?? gap?.value ?? person.occupation ?? null;
      if (linked) periodId = linked.id;
      else if (gap && !optStr(body.occupation, 60)) periodId = (await upsertSituationPeriod(env, userId, { ref_id: entityId }, { id: gap.id, descriptor, now: deps.now })).id;
      else if (occupation) {
        periodId = (await upsertSituationPeriod(env, userId, { person_id: person.id, fact: "employment", value: occupation, ref_id: entityId, source: "noticed" }, { fy: startYear, descriptor, now: deps.now })).id;
      } else needsOccupation = true; // no job known yet — the employer is still marked; the card asks which job
    }

    const { stamped, previously_recorded } = await stampPayer(env, userId, s.fy, s.signal_key, entityId, lists, descriptor);
    return {
      ref: entityId,
      out: {
        kind: "payroll", status: "confirmed", income_recorded: 0, entity_id: entityId, employer_name: name, stamped, period_id: periodId,
        ...(needsOccupation ? { needs_occupation: true } : {}),
        ...(previously_recorded ? { previously_recorded } : {}),
        prompt: INCOME_STATEMENT_PROMPT,
      },
    };
  }

  if (s.kind === "platform") {
    const label = optStr(s.evidence.label) ?? s.signal_key;
    const acts = (await env.DB.prepare(`SELECT id, label FROM income_activities WHERE user_id = ? AND activity_type = 'business'`).bind(userId).all<{ id: string; label: string | null }>()).results ?? [];
    const activityId = acts.find((a) => (a.label ?? "").toLowerCase() === label.toLowerCase())?.id ?? (await addIncomeActivity(env, userId, { activity_type: "business", label }));
    let periodId: string | null = null;
    if (profileOn) {
      const kinds = situationFacts().abn_activity?.values;
      const value = Array.isArray(kinds) && s.evidence.activity && kinds.includes(s.evidence.activity) ? s.evidence.activity : "other";
      const existing = (await periodsFor("abn_activity")).find((p) => p.ref_id === activityId);
      periodId = existing?.id ?? (await upsertSituationPeriod(env, userId, { person_id: person.id, fact: "abn_activity", value, ref_id: activityId, source: "noticed" }, { fy: startYear, descriptor, now: deps.now })).id;
    }
    // Business income is assessable as received: each payout is recorded once and its credit linked (single count).
    let recorded = 0;
    for (const c of await signalCredits(env, userId, s, lists, descriptor)) {
      if (c.payer_entity_id) continue; // pay from a marked employer is never business income
      if (await deps.recordCreditAsIncome(c, { incomeType: "business", fy: s.fy })) recorded++;
    }
    return { ref: activityId, out: { kind: "platform", status: "confirmed", income_recorded: recorded, activity_id: activityId, period_id: periodId } };
  }

  if (s.kind === "government" || s.kind === "interest") {
    const type = s.evidence.income_type ?? (s.kind === "government" ? "government_payment" : "interest");
    return { ref: null, out: { kind: s.kind, status: "confirmed", income_recorded: 0, offer_manual_income: [type] } };
  }

  if (s.kind === "foreign") {
    let periodId: string | null = null;
    let residencyUnanswered = false;
    if (profileOn) {
      const existing = (await periodsFor("foreign_income"))[0];
      periodId = existing?.id ?? (await upsertSituationPeriod(env, userId, { person_id: person.id, fact: "foreign_income", value: "yes", source: "noticed" }, { fy: startYear, descriptor, now: deps.now })).id;
      residencyUnanswered = (await periodsFor("residency")).length === 0;
    }
    return { ref: periodId, out: { kind: "foreign", status: "confirmed", income_recorded: 0, period_id: periodId, residency_unanswered: residencyUnanswered, offer_manual_income: ["foreign_employment", "other"] } };
  }

  throw new NoticedError(`"${s.kind}" signals are confirmed elsewhere.`, 409);
}

/**
 * Ensure a payroll signal exists for a payer stem in an FY and return its id — the Clarify "My wages" answer
 * routes through the SAME confirm as the card (spec A3: retire income_personal for wages).
 */
export async function ensurePayrollSignal(env: Env, userId: string, startYear: number, stem: string, evidence: SignalEvidence): Promise<string> {
  const fy = fyLabel(startYear);
  await env.DB.prepare(
    `INSERT INTO noticed_signals (id, user_id, fy, kind, signal_key, status, evidence_json) VALUES (?, ?, ?, 'payroll', ?, 'open', ?)
     ON CONFLICT(user_id, fy, kind, signal_key) DO NOTHING`,
  ).bind(crypto.randomUUID(), userId, fy, stem, JSON.stringify(evidence)).run();
  const r = await env.DB.prepare(`SELECT id FROM noticed_signals WHERE user_id = ? AND fy = ? AND kind = 'payroll' AND signal_key = ?`).bind(userId, fy, stem).first<{ id: string }>();
  if (!r) throw new NoticedError("could not record the employer", 409);
  return r.id;
}

/** Confirmed government / interest signals for an FY — the worksheet's "check this matches" lines. */
export async function confirmedPrefillSignals(env: Env, userId: string, startYear: number): Promise<{ kind: string; label: string; income_type: string }[]> {
  if (!featureOn(env, "wages_payer")) return [];
  const rows = (await env.DB.prepare(
    `SELECT id, fy, kind, signal_key, status, evidence_json, ref_id, created_at, decided_at FROM noticed_signals
      WHERE user_id = ? AND fy = ? AND status = 'confirmed' AND kind IN ('government','interest') ORDER BY kind, signal_key`,
  ).bind(userId, fyLabel(startYear)).all<SignalRow>()).results ?? [];
  return rows.map(toSignal).map((s) => ({ kind: s.kind, label: s.evidence.label ?? s.signal_key, income_type: s.evidence.income_type ?? (s.kind === "government" ? "government_payment" : "interest") }));
}

export interface PayrollEmployerSignal {
  entity_id: string;
  name: string;
  n: number;
  /** An income-statement (salary_payg) row for this employer is recorded for the FY. */
  covered: boolean;
}

/**
 * Per-employer income completeness (readiness): each employer whose pay is stamped on this FY's credits, and
 * whether a salary row naming it (detail_json.employer, matched via payerKey) exists. Plus the stamped
 * personal-income credits, so the generic income_not_recorded finding doesn't count the same wages twice.
 * Flag OFF ⇒ {} ⇒ readiness byte-identical.
 */
export async function payrollEmployerSignals(
  env: Env,
  userId: string,
  startYear: number,
  descriptor: JurisdictionDescriptor = AU_DESCRIPTOR,
): Promise<{ payrollEmployers?: PayrollEmployerSignal[]; stampedPersonalN?: number; stampedPersonalCents?: number }> {
  if (!featureOn(env, "wages_payer")) return {};
  const { start, end } = fyBounds(startYear, descriptor);
  const dedupe = featureOn(env, "income_dedupe") ? " AND matched_income_id IS NULL" : "";
  const [emp, sal, stamped] = await Promise.all([
    env.DB.prepare(
      `SELECT e.id AS entity_id, e.name AS name, COUNT(t.id) AS n FROM transactions t
         JOIN entities e ON e.id = t.payer_entity_id AND e.user_id = t.user_id
        WHERE t.user_id = ? AND t.payer_entity_id IS NOT NULL AND t.direction = 'credit' AND t.status NOT IN ('duplicate')
          AND t.txn_date >= ? AND t.txn_date <= ?
        GROUP BY e.id, e.name ORDER BY e.name`,
    ).bind(userId, start, end).all<{ entity_id: string; name: string | null; n: number }>(),
    env.DB.prepare(`SELECT detail_json FROM income WHERE user_id = ? AND fy = ? AND income_type = 'salary_payg' AND entity_id IS NULL AND ${FX_CONVERTED}`)
      .bind(userId, fyLabel(startYear))
      .all<{ detail_json: string | null }>(),
    // Same row set and sum as report.income_by_bucket's income_personal row, restricted to stamped credits.
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)), 0) AS cents FROM transactions
        WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND bucket = 'income_personal' AND payer_entity_id IS NOT NULL
          AND ${COUNTABLE_INCOME}${dedupe}`,
    ).bind(userId, start, end).first<{ n: number; cents: number }>(),
  ]);
  const employers = (sal.results ?? []).map((r) => {
    try { return (JSON.parse(r.detail_json ?? "{}") as { employer?: unknown }).employer; } catch { return undefined; }
  });
  const named = employers.filter((x) => payerKey(x));
  const unnamedSalary = employers.length - named.length; // hand-keyed salary rows (the manual form has no employer field)
  const list = (emp.results ?? []).map((e) => ({
    entity_id: e.entity_id,
    name: e.name ?? "your employer",
    n: e.n,
    covered: named.some((x) => employerMatches(x, e.name)),
  }));
  // Same rule as the worksheet: with exactly ONE marked employer still uncovered, an unnamed salary row is that
  // employer's — entering the salary by hand (as the finding asks) must clear it.
  const uncovered = list.filter((e) => !e.covered);
  if (uncovered.length === 1 && unnamedSalary > 0) uncovered[0]!.covered = true;
  return {
    payrollEmployers: list,
    stampedPersonalN: stamped?.n ?? 0,
    stampedPersonalCents: stamped?.cents ?? 0,
  };
}
