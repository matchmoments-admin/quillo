// The Records step (first-timer spec docs/first-timer/spec.md A7, ticket #588; flag ft_journey).
//
// For every CONFIRMED claim in an FY: does a record back it, and which facts must the person state that no
// bank feed can carry (WFH hours, car km, platform gross + fees)? The output is COUNTS for the completeness
// meter (the journey's `records` block) plus one row per claim line for the page. It never computes tax,
// a refund or a figure the meter shows; per-line claim amounts are only echoed back for the row label.
//
// "Has a record" (spec A7 Server) = a receipt matched to the line (`matched_txn_id`), the line is itself a
// photographed receipt, a `document_id`, or a `claim_links` row. The record-keeping exception
// (`transactions.record_exception`, migration 0084) is a user ATTESTATION, never evidence: it is counted
// separately (claims_exception), and only while the line is still eligible — re-checked on every read, so
// a line stops counting as an exception once the covered total passes the pack's limit.
//
// POSITION-NEUTRAL: nothing here writes money or is read by report.ts / ledger-totals.ts. The only write is
// the attestation column, which no countable predicate reads.
//
// JURISDICTION-NEUTRAL: exception keys, limits, labels, platform activities and fact names come from the
// rule pack's `record_keeping` block (bundled au-v1 when a KV-shadowed pack predates it).

import type { Env } from "../env";
import auV1RulePack from "../rulepacks/au-v1.json";
import { COUNTABLE } from "./queries";
import { claimExpr } from "./report";
import { featureOn } from "./features";
import { fyBounds, fyLabel } from "./ledger-totals";
import { profileForFy } from "./situation-profile";
import { workUseRatesForFy } from "./work-use";
import { AU_DESCRIPTOR, type JurisdictionDescriptor } from "./jurisdiction";
import type { JourneyRecords } from "./journey";

// ── Pack config ──────────────────────────────────────────────────────────────────────────────────

export interface RecordExceptionSpec {
  key: string;
  limit_cents: number;
  /** Return labels whose confirmed claims make up the covered total (and which lines it may cover). */
  labels: string[];
  /** Description substrings (lowercase) a line must contain to be covered; empty = any line on `labels`. */
  match: string[];
  /** Add the fixed-rate WFH claim (hours × the FY rate) to the covered total. */
  include_wfh: boolean;
  title: string;
  wording: string;
}

export interface RecordKeepingConfig {
  exceptions: RecordExceptionSpec[];
  platform_activities: string[];
  facts: Record<string, string>;
}

export type FactKey = "wfh_hours" | "car_km" | "platform_fees";
export const FACT_KEYS: readonly FactKey[] = ["wfh_hours", "car_km", "platform_fees"];

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The pack's `record_keeping` block, normalised. A pack without one (an older KV copy) falls back to the bundled au-v1 block. */
export function recordKeepingFromPack(pack: unknown): RecordKeepingConfig {
  const own = (pack as { record_keeping?: unknown } | null)?.record_keeping;
  const raw = (own && typeof own === "object" ? own : (auV1RulePack as { record_keeping?: unknown }).record_keeping) as
    | { exceptions?: Record<string, unknown>; platform_activities?: unknown; facts?: Record<string, unknown> }
    | undefined;
  const exceptions: RecordExceptionSpec[] = [];
  for (const [key, v] of Object.entries(raw?.exceptions ?? {})) {
    if (key.startsWith("_") || !v || typeof v !== "object") continue;
    const e = v as Record<string, unknown>;
    const limit = typeof e.limit_cents === "number" && Number.isFinite(e.limit_cents) && e.limit_cents > 0 ? Math.round(e.limit_cents) : null;
    if (limit == null) continue;
    exceptions.push({
      key,
      limit_cents: limit,
      labels: strArr(e.labels),
      match: strArr(e.match).map((s) => s.toLowerCase()),
      include_wfh: e.include_wfh === true,
      title: typeof e.title === "string" ? e.title : key,
      wording: typeof e.wording === "string" ? e.wording : "",
    });
  }
  const facts: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw?.facts ?? {})) if (!k.startsWith("_") && typeof v === "string") facts[k] = v;
  return { exceptions, platform_activities: strArr(raw?.platform_activities), facts };
}

/** Whole-dollar money for pack copy ("{limit}" → "$150"); cents only when present. */
export function formatLimit(cents: number): string {
  const c = Math.max(0, Math.round(cents));
  return `$${c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2)}`;
}

// ── Pure assessment ──────────────────────────────────────────────────────────────────────────────

export interface RecordLine {
  id: string;
  kind: string; // receipt | bank_line
  txn_date: string | null;
  description: string | null;
  ato_label: string | null;
  bucket: string | null;
  /** The amount the engine counts for this line (claimExpr) — echoed for the row only. */
  claim_cents: number;
  receipt_key: string | null;
  matched_receipt_id: string | null;
  document_id: string | null;
  links: number;
  record_exception: string | null;
}

export interface RecordFacts {
  wfh: boolean;
  car: boolean;
  platform: boolean;
  wfh_done: boolean;
  car_done: boolean;
  platform_done: boolean;
  /** Platform payouts already recorded as business income from bank credits this FY (the "we noticed"
   *  platform confirm, #577). Those rows already count the payouts, so the Review queue doesn't add the
   *  annual summary's gross on top (it would count the money twice). */
  platform_payouts?: number;
  /** The fixed-rate WFH claim for the FY, for exceptions with include_wfh. null = hours unknown (a diary
   *  drives them) — such exceptions are then not offered, because the covered total can't be shown to fit. */
  wfh_claim_cents: number | null;
}

export type RecordStatusKey = "recorded" | "needs_record" | "exception";
export type RecordKind = "receipt" | "document" | "claim_link";

export interface RecordRowView {
  id: string;
  txn_date: string | null;
  description: string | null;
  ato_label: string | null;
  /** The return label this line groups under ("D5"), or null when it has none. */
  group: string | null;
  claim_cents: number;
  status: RecordStatusKey;
  record: { kind: RecordKind; id: string | null } | null;
  /** The attested exception (stored), and the exceptions this line may use right now. */
  exception: { set: string | null; eligible: string[] };
}

export interface RecordsAssessment {
  block: JourneyRecords;
  rows: RecordRowView[];
  exceptions: { key: string; title: string; wording: string; limit_cents: number; total_cents: number | null; open: boolean }[];
}

/** The return label at the start of an ato_label ("D3/D5" → "D3", "D5" → "D5"); null when it isn't one. */
export function returnLabelOf(ato_label: string | null | undefined): string | null {
  const m = /^(D\d+)(?!\d)/.exec(ato_label ?? "");
  return m ? m[1]! : null;
}

function recordOf(l: RecordLine): RecordRowView["record"] {
  if (l.matched_receipt_id) return { kind: "receipt", id: l.matched_receipt_id };
  if (l.kind === "receipt" && l.receipt_key) return { kind: "receipt", id: l.id };
  if (l.document_id) return { kind: "document", id: l.document_id };
  if (l.links > 0) return { kind: "claim_link", id: null };
  return null;
}

function covers(spec: RecordExceptionSpec, l: RecordLine): boolean {
  const label = returnLabelOf(l.ato_label);
  if (!label || !spec.labels.includes(label)) return false;
  if (!spec.match.length) return true;
  const text = (l.description ?? "").toLowerCase();
  return spec.match.some((m) => text.includes(m));
}

/**
 * Classify every confirmed claim line and build the journey `records` block. Pure.
 * Facts needed = what the profile implies, plus any fact already entered (the person has it, so it counts).
 */
export function assessRecords(lines: readonly RecordLine[], facts: RecordFacts, cfg: RecordKeepingConfig): RecordsAssessment {
  // Covered totals per exception: every confirmed claim the exception covers (+ WFH where the pack says so).
  const open = new Map<string, boolean>();
  const exceptions = cfg.exceptions.map((spec) => {
    const lineTotal = lines.filter((l) => covers(spec, l)).reduce((s, l) => s + Math.max(0, l.claim_cents), 0);
    const total = spec.include_wfh ? (facts.wfh_claim_cents == null ? null : lineTotal + Math.max(0, facts.wfh_claim_cents)) : lineTotal;
    const isOpen = total != null && total <= spec.limit_cents;
    open.set(spec.key, isOpen);
    const lim = formatLimit(spec.limit_cents);
    return { key: spec.key, title: spec.title.replaceAll("{limit}", lim), wording: spec.wording.replaceAll("{limit}", lim), limit_cents: spec.limit_cents, total_cents: total, open: isOpen };
  });

  const rows: RecordRowView[] = lines.map((l) => {
    const record = recordOf(l);
    const eligible = record ? [] : cfg.exceptions.filter((s) => open.get(s.key) && covers(s, l)).map((s) => s.key);
    const set = l.record_exception && cfg.exceptions.some((s) => s.key === l.record_exception) ? l.record_exception : null;
    const status: RecordStatusKey = record ? "recorded" : set && eligible.includes(set) ? "exception" : "needs_record";
    return { id: l.id, txn_date: l.txn_date, description: l.description, ato_label: l.ato_label, group: returnLabelOf(l.ato_label), claim_cents: l.claim_cents, status, record, exception: { set, eligible } };
  });

  const needed: FactKey[] = [];
  const done: FactKey[] = [];
  const fact = (k: FactKey, need: boolean, isDone: boolean) => {
    if (need || isDone) needed.push(k);
    if (isDone) done.push(k);
  };
  fact("wfh_hours", facts.wfh, facts.wfh_done);
  fact("car_km", facts.car || facts.platform, facts.car_done);
  fact("platform_fees", facts.platform, facts.platform_done);

  return {
    block: {
      claims_total: rows.length,
      claims_with_record: rows.filter((r) => r.status === "recorded").length,
      claims_exception: rows.filter((r) => r.status === "exception").length,
      facts_needed: needed,
      facts_done: done,
    },
    rows,
    exceptions,
  };
}

// ── D1 gathering ─────────────────────────────────────────────────────────────────────────────────

/** Every confirmed, counted, non-reimbursed claim line in the FY, with what backs it. Read-only. */
export async function recordLines(env: Env, userId: string, startYear: number, descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): Promise<RecordLine[]> {
  const { start, end } = fyBounds(startYear, descriptor);
  const res = await env.DB.prepare(
    `SELECT id, kind, txn_date, COALESCE(merchant, raw_description) AS description, ato_label, bucket,
            ${claimExpr("")} AS claim_cents, receipt_key, document_id, record_exception,
            (SELECT r.id FROM transactions r WHERE r.user_id = transactions.user_id AND r.kind = 'receipt'
                AND r.matched_txn_id = transactions.id AND r.status <> 'duplicate' ORDER BY r.id LIMIT 1) AS matched_receipt_id,
            (SELECT COUNT(*) FROM claim_links cl WHERE cl.user_id = transactions.user_id AND cl.txn_id = transactions.id) AS links
       FROM transactions
      WHERE user_id = ? AND txn_date >= ? AND txn_date <= ?
        AND deductibility = 'confirmed_deductible' AND COALESCE(reimbursed, 0) = 0
        AND ${COUNTABLE}
      ORDER BY ato_label, txn_date, id`,
  )
    .bind(userId, start, end)
    .all<RecordLine>();
  return (res.results ?? []).map((r) => ({ ...r, claim_cents: Number(r.claim_cents) || 0, links: Number(r.links) || 0 }));
}

/** The facts the person must state for the FY, and which they have. Read-only. */
export async function recordFacts(
  env: Env,
  userId: string,
  startYear: number,
  cfg: RecordKeepingConfig,
  pack: unknown,
  descriptor: JurisdictionDescriptor = AU_DESCRIPTOR,
): Promise<RecordFacts> {
  const fy = fyLabel(startYear);
  // The profile's ticks (A1 dated periods) only exist with situation_profile ON; OFF, facts are needed only
  // once entered (the "already have it" rule in assessRecords).
  let wfh = false;
  let car = false;
  let platform = false;
  if (featureOn(env, "situation_profile")) {
    const self = (await profileForFy(env, userId, startYear, descriptor))[0];
    if (self) {
      wfh = self.flags.wfh || self.jobs.some((j) => j.wfh);
      car = self.flags.car_for_work || self.jobs.some((j) => j.uses_own_car);
      platform = self.abn_activities.some((a) => cfg.platform_activities.includes(a.kind));
    }
  }
  const [wu, carRow, logbooks, platformRows, payoutRows] = await Promise.all([
    env.DB.prepare(`SELECT wfh_hours, car_work_km, wfh_generate_diary, wfh_has_record, wfh_weekdays FROM work_use_inputs WHERE user_id = ? AND fy = ?`)
      .bind(userId, startYear)
      .first<{ wfh_hours: number | null; car_work_km: number | null; wfh_generate_diary: number | null; wfh_has_record: number | null; wfh_weekdays: string | null }>(),
    env.DB.prepare(`SELECT work_km FROM car_inputs WHERE user_id = ? AND fy = ?`).bind(userId, startYear).first<{ work_km: number | null }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM vehicle_logbooks WHERE user_id = ? AND fy = ?`).bind(userId, fy).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM income WHERE user_id = ? AND fy = ? AND income_type = 'business' AND json_extract(detail_json, '$.platform_fees_cents') IS NOT NULL`)
      .bind(userId, fy)
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM income i WHERE i.user_id = ? AND i.fy = ? AND i.income_type = 'business'
          AND EXISTS (SELECT 1 FROM transactions t WHERE t.user_id = i.user_id AND t.matched_income_id = i.id AND t.direction = 'credit')`,
    )
      .bind(userId, fy)
      .first<{ n: number }>(),
  ]);
  const payouts = Number(payoutRows?.n) || 0;
  const hours = Number(wu?.wfh_hours) > 0 ? Number(wu!.wfh_hours) : 0;
  let weekdays = 0;
  try {
    const w = JSON.parse(wu?.wfh_weekdays ?? "[]") as unknown;
    weekdays = Array.isArray(w) ? w.length : 0;
  } catch { /* malformed ⇒ none */ }
  // Same rule as the accountant hand-off's diary (accountant-schedule.ts): only when the diary feature is on.
  const diaryDrives = featureOn(env, "wfh_generate_diary") && !hours && wu?.wfh_generate_diary === 1 && !wu?.wfh_has_record && weekdays > 0;
  const rates = workUseRatesForFy((pack as { thresholds_by_fy?: Record<string, { wfh_fixed_rate_cents_per_hour?: number }> } | null)?.thresholds_by_fy?.[fy]);
  return {
    wfh,
    car,
    platform,
    wfh_done: hours > 0 || diaryDrives,
    car_done: Number(carRow?.work_km) > 0 || Number(wu?.car_work_km) > 0 || (logbooks?.n ?? 0) > 0,
    // Stated = the annual summary was entered, or the payouts are already recorded from the bank lines.
    platform_done: (platformRows?.n ?? 0) > 0 || payouts > 0,
    platform_payouts: payouts,
    wfh_claim_cents: diaryDrives ? null : Math.round(hours * rates.wfh_cents_per_hour),
  };
}

export interface PlatformEntry {
  id: string;
  label: string | null;
  gross_cents: number;
  fees_cents: number;
  txn_date: string | null;
}

/** Platform income rows the person entered through the Records prompt (business income carrying platform_fees_cents). */
export async function platformEntries(env: Env, userId: string, startYear: number): Promise<PlatformEntry[]> {
  const res = await env.DB.prepare(
    `SELECT id, json_extract(detail_json, '$.platform') AS label, gross_cents,
            json_extract(detail_json, '$.platform_fees_cents') AS fees_cents, txn_date
       FROM income WHERE user_id = ? AND fy = ? AND income_type = 'business' AND json_extract(detail_json, '$.platform_fees_cents') IS NOT NULL
      ORDER BY created_at, id`,
  )
    .bind(userId, fyLabel(startYear))
    .all<PlatformEntry>();
  return (res.results ?? []).map((r) => ({ ...r, gross_cents: Number(r.gross_cents) || 0, fees_cents: Number(r.fees_cents) || 0 }));
}

function groupLabels(pack: unknown, rows: readonly RecordRowView[]): Record<string, string> {
  const own = (pack as { mytax_deduction_labels?: unknown } | null)?.mytax_deduction_labels;
  const names = (own && typeof own === "object" ? own : (auV1RulePack as { mytax_deduction_labels?: unknown }).mytax_deduction_labels) as Record<string, unknown> | undefined;
  const out: Record<string, string> = {};
  for (const r of rows) {
    const n = r.group ? names?.[r.group] : undefined;
    if (r.group && typeof n === "string") out[r.group] = n;
  }
  return out;
}

export interface RecordsView extends RecordsAssessment {
  fy: string;
  facts: { key: FactKey; label: string; needed: boolean; done: boolean }[];
  platform: { activities: string[]; entries: PlatformEntry[]; payouts_recorded: number };
  /** Return-label names for the row groups present ("D5" → "Other work-related expenses"), from the pack. */
  group_labels: Record<string, string>;
  disclaimer: string;
}

export const RECORDS_DISCLAIMER =
  "General information only, not tax advice. A record-keeping exception is your own statement, not a record; confirm with a registered tax agent.";

/** The whole Records read (GET /api/records and the journey's `records` block). Read-only. */
export async function recordsView(env: Env, userId: string, startYear: number, pack: unknown, descriptor: JurisdictionDescriptor = AU_DESCRIPTOR): Promise<RecordsView> {
  const cfg = recordKeepingFromPack(pack);
  const [lines, facts, entries] = await Promise.all([
    recordLines(env, userId, startYear, descriptor),
    recordFacts(env, userId, startYear, cfg, pack, descriptor),
    platformEntries(env, userId, startYear),
  ]);
  const a = assessRecords(lines, facts, cfg);
  return {
    fy: fyLabel(startYear),
    ...a,
    facts: FACT_KEYS.map((k) => ({ key: k, label: cfg.facts[k] ?? k, needed: a.block.facts_needed.includes(k), done: a.block.facts_done.includes(k) })),
    platform: { activities: cfg.platform_activities, entries, payouts_recorded: facts.platform_payouts ?? 0 },
    group_labels: groupLabels(pack, a.rows),
    disclaimer: RECORDS_DISCLAIMER,
  };
}

/**
 * Validate an attestation write. `kind` null clears. A non-null kind must be one this line may use right
 * now (a confirmed claim with no record whose covered total is within the limit). Returns the error to show,
 * or null when the write may go ahead. Pure.
 */
export function exceptionWriteError(view: Pick<RecordsAssessment, "rows">, txnId: string, kind: string | null): string | null {
  const row = view.rows.find((r) => r.id === txnId);
  if (!row) return "That isn't one of your confirmed claims for this year.";
  if (kind == null) return null;
  if (row.record) return "This claim already has a record, so it doesn't need the exception.";
  if (!row.exception.eligible.includes(kind)) return "That record-keeping exception doesn't cover this claim.";
  return null;
}

/**
 * The attestation write (the DO's setRecordException calls this, then audits): re-derive the view, refuse a
 * line the exception doesn't cover, else set / clear `record_exception`. Returns the refusal, or null when
 * written. Touches only the attestation column, which no position query reads.
 */
export async function applyRecordException(
  env: Env,
  userId: string,
  startYear: number,
  pack: unknown,
  txnId: string,
  kind: string | null,
  descriptor: JurisdictionDescriptor = AU_DESCRIPTOR,
): Promise<string | null> {
  const err = exceptionWriteError(await recordsView(env, userId, startYear, pack, descriptor), txnId, kind);
  if (err) return err;
  await env.DB.prepare(`UPDATE transactions SET record_exception = ? WHERE id = ? AND user_id = ?`).bind(kind, txnId, userId).run();
  return null;
}
