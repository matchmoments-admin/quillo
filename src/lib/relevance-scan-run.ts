// Relevance scan — the D1 side (first-timer spec A4, #578, flag `relevance_scan`). The pure sorter is
// relevance-scan.ts; this module reads the tenant's lines + situation profile + rule pack, writes
// transactions.relevance / relevance_rule_id, and keeps the 'worth a look' claim_suggestions rows in step.
//
// One entry point, `runRelevanceScan`, called from:
//   - the Durable Object after stampDeductibility at every bank-line ingest site (statement sync + async
//     batch, afterLinesImported, bank feed) — via its `afterIngestStamped` hook;
//   - situation-write.ts after any situation-period write and after a Settings occupation edit (re-scan).
// The persona goldens call the same function.
//
// HARD INVARIANTS
//  - Never touches `deductibility` / `deductible_amount_cents`. The position is unchanged until the user
//    confirms a card (confirmWorthALook → confirmed_deductible). No auto-claim, ever (#555).
//  - Deterministic, no model calls. Flag OFF ⇒ returns null before any read or write.
//  - Writes are DIFFED: a re-scan with nothing changed writes nothing.
//  - Multi-tenant: every statement is scoped by user_id; identity comes from the caller (server-derived).

import type { Env } from "../env";
import { featureOn } from "./features";
import { fyBoundsFor, fyStartYearForDate, resolveJurisdictionForUser, type JurisdictionDescriptor } from "./jurisdiction";
import { resolveRulePack } from "./report";
import { buildProfile, listSituationPeriods, type SituationPeriod, type SituationProfile } from "./situation-profile";
import { ruleKey, type ClaimRule } from "./claimability";
import type { DeductibilitySection } from "./deductibility";
import { canonicalOccupationScope, occupationGuide } from "./occupations";
import {
  confirmNeedsAsset,
  coveredByWfhFixedRate,
  wfhFixedRateCovers,
  confirmNeedsShare,
  isScannedBucket,
  relevanceFloorCents,
  resolveConfirmLabel,
  ruleLabelOptions,
  scanLines,
  worthALookText,
  type Relevance,
  type ScanLine,
  type ScanProfile,
  type ScanResult,
} from "./relevance-scan";

/** Situation facts whose change can move the scan (spec A4 "Re-scan"). */
export const RESCAN_FACTS = ["employment", "abn_activity", "wfh", "car_for_work", "foreign_income"] as const;

const SOURCE = "relevance_scan";
/** "2025-26" for a 2025 start year — the key of the pack's thresholds_by_fy and the API's fy label. */
const fyLabelOf = (startYear: number): string => `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
/** Upper bound on statements written by one scan run (see runRelevanceScan). */
export const MAX_WRITES_PER_RUN = 2000;

interface LineRow {
  id: string;
  bucket: string | null;
  ato_label: string | null;
  merchant: string | null;
  raw_description: string | null;
  amount_cents: number | null;
  deductibility: string | null;
  reimbursed: number | null;
  txn_date: string | null;
  direction: string | null;
  status: string | null;
  relevance: string | null;
  relevance_rule_id: string | null;
}

interface ScanContext {
  descriptor: JurisdictionDescriptor;
  rules: ClaimRule[];
  section: DeductibilitySection | null;
  floor: number;
  /** The pack's per-FY thresholds ("2025-26" → …), for the confirm's immediate-deduction ceiling (#587). */
  thresholds: Record<string, { immediate_non_business_cents?: number } | undefined>;
  /** The resolved (KV-first) pack, for occupation-guide lookups on the read side. */
  pack: unknown;
}

async function loadContext(env: Env, userId: string, descriptor?: JurisdictionDescriptor): Promise<ScanContext> {
  const d = descriptor ?? (await resolveJurisdictionForUser(env, userId));
  const pack = (await resolveRulePack(env, userId, d)) as unknown as {
    claimability?: ClaimRule[];
    payg_deductibility?: DeductibilitySection;
    thresholds_by_fy?: ScanContext["thresholds"];
  };
  const ver = (await env.DB.prepare(`SELECT rule_pack_ver FROM profiles WHERE user_id = ?`).bind(userId).first<{ rule_pack_ver: string | null }>())?.rule_pack_ver ?? d.rulePackId ?? "au-v1";
  // Same tenant scope as the DO's loadClaimRules: global overrides (user_id IS NULL) + this tenant's own rows.
  const d1 = (
    await env.DB.prepare(
      `SELECT id, scope_type, scope_value, merchant_hint, ato_label, claim_type, default_method, general_info_note, defer_to_agent
         FROM claimability_rules WHERE rule_pack_ver = ? AND (user_id IS NULL OR user_id = ?)`,
    ).bind(ver, userId).all<ClaimRule>()
  ).results ?? [];
  return { descriptor: d, rules: [...(pack.claimability ?? []), ...d1], section: pack.payg_deductibility ?? null, floor: relevanceFloorCents(pack), thresholds: pack.thresholds_by_fy ?? {}, pack };
}

/**
 * Per-FY scan profile: every person's occupation tokens in that FY. With `situation_profile` ON a person's
 * tokens are their employment periods overlapping the FY (+ ABN activity kinds); a person with NO employment
 * periods at all falls back to persons.occupation (the Settings field, still the legacy writer). OFF ⇒
 * persons.occupation only. Self first, so a shared token is attributed to the primary taxpayer.
 */
function profileBuilder(env: Env, persons: { id: string; role: string; occupation: string | null }[], periods: SituationPeriod[], entityKinds: string[], descriptor: JurisdictionDescriptor) {
  const useProfile = featureOn(env, "situation_profile");
  const hasEmployment = new Set(periods.filter((p) => p.fact === "employment").map((p) => p.subject_id));
  const memo = new Map<number, ScanProfile>();
  return (startYear: number): ScanProfile => {
    const hit = memo.get(startYear);
    if (hit) return hit;
    const occupations: ScanProfile["occupations"] = [];
    const push = (token: string | null | undefined, person_id: string) => {
      const t = canonicalOccupationScope(token);
      if (t && !occupations.some((o) => o.token === t && o.person_id === person_id)) occupations.push({ token: t, person_id });
    };
    for (const p of persons) {
      if (useProfile && hasEmployment.has(p.id)) {
        const prof: SituationProfile = buildProfile(p.id, periods, startYear, fyBoundsFor(descriptor, startYear));
        for (const j of prof.jobs) push(j.occupation_token, p.id);
        for (const a of prof.abn_activities) push(a.kind, p.id);
      } else {
        push(p.occupation, p.id);
        if (useProfile) for (const a of buildProfile(p.id, periods, startYear, fyBoundsFor(descriptor, startYear)).abn_activities) push(a.kind, p.id);
      }
    }
    const out = { occupations, entity_kinds: entityKinds };
    memo.set(startYear, out);
    return out;
  };
}

function inScope(r: LineRow): boolean {
  return (r.direction ?? "debit") === "debit" && r.status !== "duplicate" && r.status !== "ignored" && isScannedBucket(r.bucket);
}

export interface RelevanceScanSummary {
  scanned: number;
  changed: number;
  suggested: number;
  removed: number;
  truncated: boolean;
}

/**
 * Scan the tenant's bank lines and persist the result. Idempotent and diffed. Returns null when the flag is
 * OFF (nothing read, nothing written).
 */
export async function runRelevanceScan(env: Env, userId: string, opts: { descriptor?: JurisdictionDescriptor } = {}): Promise<RelevanceScanSummary | null> {
  if (!featureOn(env, "relevance_scan")) return null;
  const ctx = await loadContext(env, userId, opts.descriptor);
  // Bounded to the two latest FYs the tenant has bank lines in (the one usually being lodged + the current
  // one) — anchored on the data, not the clock, so it is deterministic. Older lines keep whatever they had;
  // the position never reads relevance anyway.
  const latest = (await env.DB.prepare(`SELECT MAX(txn_date) AS d FROM transactions WHERE user_id = ? AND kind = 'bank_line' AND txn_date <= date('now', '+31 days')`).bind(userId).first<{ d: string | null }>())?.d ?? null;
  const latestFy = fyStartYearForDate(ctx.descriptor, latest);
  if (Number.isNaN(latestFy)) return { scanned: 0, changed: 0, suggested: 0, removed: 0, truncated: false };
  const windowStart = fyBoundsFor(ctx.descriptor, latestFy - 1).start;
  const [lineRes, personRes, entityRes, periods, existingRes] = await Promise.all([
    env.DB.prepare(
      `SELECT id, bucket, ato_label, merchant, raw_description, COALESCE(amount_aud_cents, amount_cents) AS amount_cents,
              deductibility, reimbursed, txn_date, direction, status, relevance, relevance_rule_id
         FROM transactions
        WHERE user_id = ? AND kind = 'bank_line' AND txn_date >= ?
          AND ((COALESCE(direction,'debit') = 'debit' AND status NOT IN ('duplicate','ignored') AND (bucket IS NULL OR bucket IN ('payg','unknown')))
               OR relevance IS NOT NULL)`,
    ).bind(userId, windowStart).all<LineRow>(),
    env.DB.prepare(`SELECT id, role, occupation FROM persons WHERE user_id = ? ORDER BY role = 'self' DESC, created_at, id`).bind(userId).all<{ id: string; role: string; occupation: string | null }>(),
    env.DB.prepare(`SELECT DISTINCT kind FROM entities WHERE user_id = ?`).bind(userId).all<{ kind: string }>(),
    featureOn(env, "situation_profile") ? listSituationPeriods(env, userId) : Promise.resolve([] as SituationPeriod[]),
    env.DB.prepare(`SELECT id, txn_id, rule_id, status FROM claim_suggestions WHERE user_id = ? AND source = ?`).bind(userId, SOURCE).all<{ id: string; txn_id: string | null; rule_id: string | null; status: string | null }>(),
  ]);
  const rows = lineRes.results ?? [];
  const profileFor = profileBuilder(env, personRes.results ?? [], periods, (entityRes.results ?? []).map((e) => e.kind), ctx.descriptor);

  // Group in-scope dated lines by FY (the profile is per FY); everything else is cleared to NULL.
  const byFy = new Map<number, LineRow[]>();
  const target = new Map<string, ScanResult | null>();
  for (const r of rows) {
    const fy = inScope(r) ? fyStartYearForDate(ctx.descriptor, r.txn_date) : NaN;
    if (Number.isNaN(fy)) {
      target.set(r.id, null);
      continue;
    }
    const arr = byFy.get(fy) ?? [];
    arr.push(r);
    byFy.set(fy, arr);
  }
  for (const [fy, lines] of byFy) {
    const scan: ScanLine[] = lines.map((l) => ({
      id: l.id,
      bucket: l.bucket,
      ato_label: l.ato_label,
      merchant: l.merchant ?? l.raw_description,
      amount_cents: Math.abs(l.amount_cents ?? 0),
      deductibility: l.deductibility,
      reimbursed: l.reimbursed,
    }));
    for (const res of scanLines(scan, profileFor(fy), ctx.rules, ctx.section, ctx.floor)) target.set(res.id, res);
  }

  // Diffed writes to transactions.
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    const t = target.get(r.id) ?? null;
    const rel = t?.relevance ?? null;
    const rid = t?.rule_id ?? null;
    if (rel === r.relevance && rid === r.relevance_rule_id) continue;
    stmts.push(env.DB.prepare(`UPDATE transactions SET relevance = ?, relevance_rule_id = ? WHERE id = ? AND user_id = ?`).bind(rel, rid, r.id, userId));
  }
  const changed = stmts.length;

  // Keep the 'worth a look' cards in step: one per (line, rule). INSERT OR IGNORE on the partial unique
  // index, so a dismissed card is never re-created; a card that no longer applies is removed only while it is
  // still an untouched suggestion (dismissed / capturing rows are the user's history and stay).
  const desired = new Map<string, ScanResult>();
  for (const t of target.values()) if (t && t.relevance === "worth_a_look" && t.rule) desired.set(`${t.id}|${t.rule_id}`, t);
  const existing = existingRes.results ?? [];
  const have = new Set(existing.map((e) => `${e.txn_id}|${e.rule_id}`));
  let suggested = 0;
  for (const [key, t] of desired) {
    if (have.has(key)) continue;
    const label = occupationGuide(t.occupation)?.label ?? t.occupation ?? null;
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO claim_suggestions (id, user_id, person_id, txn_id, rule_id, suggestion, claim_type, estimated_deduction_cents, status, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'suggested', ?)`,
      ).bind(crypto.randomUUID(), userId, t.person_id ?? `person_self_${userId}`, t.id, t.rule_id, worthALookText(t.rule!, label), t.rule!.claim_type, SOURCE),
    );
    suggested++;
  }
  let removed = 0;
  for (const e of existing) {
    if (e.status !== "suggested" || desired.has(`${e.txn_id}|${e.rule_id}`)) continue;
    stmts.push(env.DB.prepare(`DELETE FROM claim_suggestions WHERE id = ? AND user_id = ? AND source = ? AND status = 'suggested'`).bind(e.id, userId, SOURCE));
    removed++;
  }
  // Capped per run so a first scan over a large tenant can't exhaust one request; the writes are diffed, so the
  // next ingest / re-scan simply carries on where this one stopped.
  const capped = stmts.slice(0, MAX_WRITES_PER_RUN);
  for (let i = 0; i < capped.length; i += 50) await env.DB.batch(capped.slice(i, i + 50));
  return { scanned: target.size, changed, suggested, removed, truncated: stmts.length > MAX_WRITES_PER_RUN };
}

/**
 * Re-scan after a situation write (spec A4 "Re-scan"). Best-effort: a scan failure must never fail the write
 * that already persisted. `fact` undefined = an occupation edit through Settings (always re-scans).
 */
export async function rescanAfterSituationChange(env: Env, userId: string, fact?: string | null): Promise<void> {
  if (!featureOn(env, "relevance_scan")) return;
  if (fact != null && !(RESCAN_FACTS as readonly string[]).includes(fact)) return;
  try {
    await runRelevanceScan(env, userId);
  } catch (e) {
    console.warn("relevance re-scan failed", (e as Error).message);
  }
}

/** What the user told the Claims step alongside the tap (#587). */
export interface WorthALookConfirmInput {
  /** The return label they picked, when the rule names alternatives ("D3/D5"). Must be one of them. */
  atoLabel?: string | null;
  /** Their work-use share (1–100) for a mixed-use line. Applied to THIS line's amount. */
  workUsePct?: number | null;
}

export interface WorthALookConfirmResult {
  ok: boolean;
  /** Mixed-use line: send the work-use share (workUsePct) to confirm it. */
  needs_apportionment?: boolean;
  /** The rule names several return labels: send one of `label_options` as atoLabel. */
  needs_label?: boolean;
  label_options?: string[];
  /** Above the FY's immediate-deduction threshold on a depreciating rule: it belongs in Assets, not a confirm. */
  needs_asset?: boolean;
  /** #587: WFH hours are stated and the fixed rate per hour already covers this item (no separate claim). */
  covered_by_wfh_rate?: boolean;
}

/**
 * Confirm a 'worth a look' line into the position (the user's tap — never the scan). Called by the DO's
 * confirmSuggestedDeduction. Re-checks against the CURRENT profile + rules first: the line must still be
 * worth a look (the job still covers it and the rule still matches), so a stale card can't count after the
 * user removed the job.
 *
 *  - Label (#587, the #578 deferral): the line takes the RULE's single return label (a nurse's AHPRA renewal
 *    goes to the rule's work-expense label, not the categoriser's "Health"), so the worksheet puts it on the
 *    right line. A rule naming alternatives ("D3/D5") needs the user's pick — refused with needs_label + the
 *    options until given.
 *  - Mixed use: a line stamped needs_apportionment, or on a non-'immediate' rule, needs the work-use share.
 *    Without `workUsePct` it is refused with needs_apportionment; with it, the claimable amount is this
 *    line's amount × pct (per row, like setDeductibility), so a tap never counts a private-use bill whole.
 *  - Depreciating rule above the FY's immediate threshold ⇒ needs_asset (Assets, never an immediate claim).
 *  - Otherwise confirmed_deductible, clearing ONLY a denied stamp's $0 claimable to NULL (else the position
 *    would read $0); any other stored amount stays. The card moves to 'capturing' (the line is its evidence).
 *
 * Returns null when the flag is OFF or the line is not a worth-a-look line (caller keeps its legacy answer).
 */
export async function confirmWorthALook(env: Env, userId: string, txnId: string, input: WorthALookConfirmInput = {}): Promise<WorthALookConfirmResult | null> {
  if (!featureOn(env, "relevance_scan")) return null;
  const row = await env.DB.prepare(
    `SELECT id, bucket, ato_label, merchant, raw_description, COALESCE(amount_aud_cents, amount_cents) AS amount_cents,
            deductibility, reimbursed, txn_date, direction, status, relevance, relevance_rule_id
       FROM transactions WHERE id = ? AND user_id = ? AND kind = 'bank_line'`,
  ).bind(txnId, userId).first<LineRow>();
  if (!row || row.relevance !== "worth_a_look") return null;
  if (row.deductibility === "confirmed_deductible" || row.deductibility === "confirmed_not") return { ok: false };
  const pct = input.workUsePct ?? null;
  if (pct != null && (typeof pct !== "number" || !Number.isFinite(pct) || pct < 1 || pct > 100)) return { ok: false, needs_apportionment: true };
  const ctx = await loadContext(env, userId);
  const fy = fyStartYearForDate(ctx.descriptor, row.txn_date);
  if (!inScope(row) || Number.isNaN(fy)) return { ok: false };
  const [personRes, entityRes, periods] = await Promise.all([
    env.DB.prepare(`SELECT id, role, occupation FROM persons WHERE user_id = ? ORDER BY role = 'self' DESC, created_at, id`).bind(userId).all<{ id: string; role: string; occupation: string | null }>(),
    env.DB.prepare(`SELECT DISTINCT kind FROM entities WHERE user_id = ?`).bind(userId).all<{ kind: string }>(),
    featureOn(env, "situation_profile") ? listSituationPeriods(env, userId) : Promise.resolve([] as SituationPeriod[]),
  ]);
  const profile = profileBuilder(env, personRes.results ?? [], periods, (entityRes.results ?? []).map((e) => e.kind), ctx.descriptor)(fy);
  const amount = Math.abs(row.amount_cents ?? 0);
  const [res] = scanLines(
    [{ id: row.id, bucket: row.bucket, ato_label: row.ato_label, merchant: row.merchant ?? row.raw_description, amount_cents: amount, deductibility: row.deductibility, reimbursed: row.reimbursed }],
    profile,
    ctx.rules,
    ctx.section,
    ctx.floor,
  );
  if (res?.relevance !== "worth_a_look" || !res.rule) return { ok: false };
  const rule = res.rule;
  const threshold = ctx.thresholds[fyLabelOf(fy)]?.immediate_non_business_cents ?? null;
  if (confirmNeedsAsset(rule, amount, threshold)) return { ok: false, needs_asset: true };
  // #587: with WFH hours stated, the fixed rate per hour already includes energy / internet / phone /
  // stationery (the report counts it under work_method), so a line for one of those is not claimed again.
  if (featureOn(env, "wfh_car_methods") && coveredByWfhFixedRate(row.merchant ?? row.raw_description, wfhFixedRateCovers(ctx.pack))) {
    const wu = await env.DB.prepare(`SELECT wfh_hours FROM work_use_inputs WHERE user_id = ? AND fy = ?`).bind(userId, fy).first<{ wfh_hours: number | null }>();
    if (Number(wu?.wfh_hours) > 0) return { ok: false, covered_by_wfh_rate: true };
  }
  // A confirm without a share counts the WHOLE line, so it is only for an 'immediate' rule on a line nobody has
  // said is mixed-use (review finding, #578). With the user's share it counts amount × pct.
  if (confirmNeedsShare(rule, row.deductibility) && pct == null) return { ok: false, needs_apportionment: true };
  const label = resolveConfirmLabel(rule.ato_label, input.atoLabel);
  if (label.needs_label) return { ok: false, needs_label: true, label_options: label.options };
  // The guard re-checks the stamp so a concurrent confirmed_not / confirm is never overwritten. The label is
  // written only when the rule names one (COALESCE keeps the line's own label otherwise).
  const res2 = await env.DB.batch([
    pct != null
      ? env.DB.prepare(
          `UPDATE transactions SET deductibility = 'confirmed_deductible', ato_label = COALESCE(?, ato_label),
                  deductible_amount_cents = CAST(ROUND(COALESCE(amount_aud_cents, amount_cents) * ? / 100.0) AS INTEGER)
            WHERE id = ? AND user_id = ? AND relevance = 'worth_a_look' AND COALESCE(deductibility, 'undetermined') = ?`,
        ).bind(label.label, pct, txnId, userId, row.deductibility ?? "undetermined")
      : env.DB.prepare(
          `UPDATE transactions SET deductibility = 'confirmed_deductible', ato_label = COALESCE(?, ato_label),
                  deductible_amount_cents = CASE WHEN deductibility = 'likely_not' THEN NULL ELSE deductible_amount_cents END
            WHERE id = ? AND user_id = ? AND relevance = 'worth_a_look' AND COALESCE(deductibility, 'undetermined') = ?`,
        ).bind(label.label, txnId, userId, row.deductibility ?? "undetermined"),
  ]);
  if (!(res2[0]?.meta as { changes?: number } | undefined)?.changes) return { ok: false };
  await env.DB.prepare(`UPDATE claim_suggestions SET status = 'capturing' WHERE user_id = ? AND txn_id = ? AND source = ? AND status = 'suggested'`).bind(userId, txnId, SOURCE).run();
  return { ok: true };
}


// ── Read side (for the Claims step, A6, and Records prompts, A7) ──────────────

export interface ScanPrompt {
  kind: "wfh_hours" | "work_km" | "residency_dates";
  person_id: string;
}

/** Facts to state that no bank line can carry (spec A4 list 2). Pure. */
export function scanPrompts(profiles: SituationProfile[]): ScanPrompt[] {
  const out: ScanPrompt[] = [];
  for (const p of profiles) {
    if (p.flags.wfh || p.jobs.some((j) => j.wfh)) out.push({ kind: "wfh_hours", person_id: p.person_id });
    if (p.flags.car_for_work || p.jobs.some((j) => j.uses_own_car) || p.abn_activities.length > 0) out.push({ kind: "work_km", person_id: p.person_id });
    if (p.flags.foreign_income && p.residency.length === 0) out.push({ kind: "residency_dates", person_id: p.person_id });
  }
  return out;
}

interface CardRow {
  txn_id: string;
  merchant: string | null;
  txn_date: string | null;
  amount_cents: number;
  rule_id: string | null;
  suggestion_id: string | null;
  suggestion: string | null;
  status: string | null;
  deductibility: string | null;
  /** The line's current return label (the rule's once confirmed, #587). */
  ato_label: string | null;
  deductible_amount_cents: number | null;
  reimbursed: number;
  /** A receipt is matched to the line (golden rule 3 evidence). */
  has_record: number;
}

/**
 * One worth-a-look line as the Claims step (#587) renders it. Everything the card needs to ask the right
 * question BEFORE the tap: which return labels the rule allows, whether a work-use share is needed, whether
 * it belongs in Assets, and the occupation guide behind the "why". No figure here is an estimate of tax.
 */
export interface RelevanceCard extends CardRow {
  label_options: string[];
  needs_work_use_pct: boolean;
  needs_asset: boolean;
  occupation: string | null;
  occupation_label: string | null;
  ato_url: string | null;
  defer_to_agent: boolean;
}

export interface RelevanceView {
  fy: string;
  counts: Record<Relevance | "unscanned", number>;
  worth_a_look: RelevanceCard[];
  /** The pack's names for every label in the cards' label_options (#587). */
  label_names: Record<string, string>;
  prompts: ScanPrompt[];
}

/** GET /api/relevance?fy= — the FY's three lists as counts, the worth-a-look cards, and the prompts. */
export async function relevanceView(env: Env, userId: string, startYear: number): Promise<RelevanceView> {
  const descriptor = await resolveJurisdictionForUser(env, userId);
  const { start, end } = fyBoundsFor(descriptor, startYear);
  const [countRes, cardRes, profiles, ctx] = await Promise.all([
    env.DB.prepare(
      `SELECT COALESCE(relevance, 'unscanned') AS r, COUNT(*) AS n FROM transactions
        WHERE user_id = ? AND kind = 'bank_line' AND COALESCE(direction,'debit') = 'debit' AND status NOT IN ('duplicate','ignored')
          AND txn_date >= ? AND txn_date <= ? GROUP BY 1`,
    ).bind(userId, start, end).all<{ r: string; n: number }>(),
    env.DB.prepare(
      `SELECT t.id AS txn_id, t.merchant, t.txn_date, ABS(COALESCE(t.amount_aud_cents, t.amount_cents, 0)) AS amount_cents, t.relevance_rule_id AS rule_id,
              cs.id AS suggestion_id, cs.suggestion, cs.status, t.deductibility, t.ato_label, t.deductible_amount_cents,
              COALESCE(t.reimbursed, 0) AS reimbursed,
              CASE WHEN t.receipt_key IS NOT NULL OR EXISTS (SELECT 1 FROM transactions r WHERE r.user_id = t.user_id AND r.matched_txn_id = t.id) THEN 1 ELSE 0 END AS has_record
         FROM transactions t
         LEFT JOIN claim_suggestions cs ON cs.user_id = t.user_id AND cs.txn_id = t.id AND cs.rule_id = t.relevance_rule_id AND cs.source = '${SOURCE}'
        WHERE t.user_id = ? AND t.relevance = 'worth_a_look' AND t.txn_date >= ? AND t.txn_date <= ?
        ORDER BY t.txn_date DESC, t.id LIMIT 500`,
    ).bind(userId, start, end).all<CardRow>(),
    featureOn(env, "situation_profile")
      ? (async () => {
          const periods = await listSituationPeriods(env, userId);
          const persons = (await env.DB.prepare(`SELECT id FROM persons WHERE user_id = ? ORDER BY role = 'self' DESC, created_at, id`).bind(userId).all<{ id: string }>()).results ?? [];
          return persons.map((p) => buildProfile(p.id, periods, startYear, { start, end }));
        })()
      : Promise.resolve([] as SituationProfile[]),
    loadContext(env, userId, descriptor),
  ]);
  const ruleById = new Map(ctx.rules.map((r) => [ruleKey(r), r] as const));
  const threshold = ctx.thresholds[fyLabelOf(startYear)]?.immediate_non_business_cents ?? null;
  const cards: RelevanceCard[] = (cardRes.results ?? []).map((c) => {
    const rule = c.rule_id ? ruleById.get(c.rule_id) : undefined;
    const guide = rule ? occupationGuide(rule.scope_value, ctx.pack) : null;
    return {
      ...c,
      label_options: ruleLabelOptions(rule?.ato_label),
      needs_work_use_pct: rule ? confirmNeedsShare(rule, c.deductibility) : false,
      needs_asset: rule ? confirmNeedsAsset(rule, c.amount_cents, threshold) : false,
      occupation: rule?.scope_value ?? null,
      occupation_label: guide?.label ?? null,
      ato_url: guide?.ato_url && /^https:\/\//.test(guide.ato_url) ? guide.ato_url : null,
      defer_to_agent: !!rule?.defer_to_agent,
    };
  });
  const counts: RelevanceView["counts"] = { relevant: 0, worth_a_look: 0, irrelevant: 0, unscanned: 0 };
  for (const c of countRes.results ?? []) if (c.r in counts) counts[c.r as keyof typeof counts] = c.n;
  // The pack's own names for the labels the cards can be confirmed to (D5 → "Other work-related expenses"),
  // so the label pick reads in words without the SPA hard-coding any jurisdiction's return labels.
  const packNames = (ctx.pack as { mytax_deduction_labels?: Record<string, unknown> } | null)?.mytax_deduction_labels ?? {};
  const label_names: Record<string, string> = {};
  for (const c of cards) for (const l of c.label_options) if (typeof packNames[l] === "string") label_names[l] = packNames[l] as string;
  return { fy: fyLabelOf(startYear), counts, worth_a_look: cards, label_names, prompts: scanPrompts(profiles) };
}

