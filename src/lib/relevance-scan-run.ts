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
import { isScannedBucket, relevanceFloorCents, scanLines, worthALookText, type Relevance, type ScanLine, type ScanProfile, type ScanResult } from "./relevance-scan";

/** Situation facts whose change can move the scan (spec A4 "Re-scan"). */
export const RESCAN_FACTS = ["employment", "abn_activity", "wfh", "car_for_work", "foreign_income"] as const;

const SOURCE = "relevance_scan";

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
}

async function loadContext(env: Env, userId: string, descriptor?: JurisdictionDescriptor): Promise<ScanContext> {
  const d = descriptor ?? (await resolveJurisdictionForUser(env, userId));
  const pack = (await resolveRulePack(env, userId, d)) as unknown as { claimability?: ClaimRule[]; payg_deductibility?: DeductibilitySection };
  const ver = (await env.DB.prepare(`SELECT rule_pack_ver FROM profiles WHERE user_id = ?`).bind(userId).first<{ rule_pack_ver: string | null }>())?.rule_pack_ver ?? d.rulePackId ?? "au-v1";
  // Same tenant scope as the DO's loadClaimRules: global overrides (user_id IS NULL) + this tenant's own rows.
  const d1 = (
    await env.DB.prepare(
      `SELECT id, scope_type, scope_value, merchant_hint, ato_label, claim_type, default_method, general_info_note, defer_to_agent
         FROM claimability_rules WHERE rule_pack_ver = ? AND (user_id IS NULL OR user_id = ?)`,
    ).bind(ver, userId).all<ClaimRule>()
  ).results ?? [];
  return { descriptor: d, rules: [...(pack.claimability ?? []), ...d1], section: pack.payg_deductibility ?? null, floor: relevanceFloorCents(pack) };
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
}

/**
 * Scan the tenant's bank lines and persist the result. Idempotent and diffed. Returns null when the flag is
 * OFF (nothing read, nothing written).
 */
export async function runRelevanceScan(env: Env, userId: string, opts: { descriptor?: JurisdictionDescriptor } = {}): Promise<RelevanceScanSummary | null> {
  if (!featureOn(env, "relevance_scan")) return null;
  const ctx = await loadContext(env, userId, opts.descriptor);
  const [lineRes, personRes, entityRes, periods, existingRes] = await Promise.all([
    env.DB.prepare(
      `SELECT id, bucket, ato_label, merchant, raw_description, COALESCE(amount_aud_cents, amount_cents) AS amount_cents,
              deductibility, reimbursed, txn_date, direction, status, relevance, relevance_rule_id
         FROM transactions
        WHERE user_id = ? AND kind = 'bank_line'
          AND ((COALESCE(direction,'debit') = 'debit' AND status NOT IN ('duplicate','ignored') AND (bucket IS NULL OR bucket IN ('payg','unknown')))
               OR relevance IS NOT NULL)`,
    ).bind(userId).all<LineRow>(),
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
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { scanned: target.size, changed, suggested, removed };
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

/**
 * Confirm a 'worth a look' line into the position (the user's tap — never the scan). Called by the DO's
 * confirmSuggestedDeduction when the line is not a plain suggested_deductible stamp. Re-checks against the
 * CURRENT profile + rules first: the line must still be worth a look (the job still covers it and the rule
 * still matches), so a stale card can't count after the user removed the job. Then confirmed_deductible with
 * the claimable amount cleared to NULL (a denied stamp carries deductible_amount_cents = 0, which the
 * position would otherwise read as $0 claimable), and the card moves to 'capturing' (the line is its evidence).
 * Returns null when the flag is OFF or the line is not a worth-a-look line (caller keeps its legacy answer).
 */
export async function confirmWorthALook(env: Env, userId: string, txnId: string): Promise<{ ok: boolean } | null> {
  if (!featureOn(env, "relevance_scan")) return null;
  const row = await env.DB.prepare(
    `SELECT id, bucket, ato_label, merchant, raw_description, COALESCE(amount_aud_cents, amount_cents) AS amount_cents,
            deductibility, reimbursed, txn_date, direction, status, relevance, relevance_rule_id
       FROM transactions WHERE id = ? AND user_id = ? AND kind = 'bank_line'`,
  ).bind(txnId, userId).first<LineRow>();
  if (!row || row.relevance !== "worth_a_look") return null;
  if (row.deductibility === "confirmed_deductible" || row.deductibility === "confirmed_not") return { ok: false };
  const ctx = await loadContext(env, userId);
  const fy = fyStartYearForDate(ctx.descriptor, row.txn_date);
  if (!inScope(row) || Number.isNaN(fy)) return { ok: false };
  const [personRes, entityRes, periods] = await Promise.all([
    env.DB.prepare(`SELECT id, role, occupation FROM persons WHERE user_id = ? ORDER BY role = 'self' DESC, created_at, id`).bind(userId).all<{ id: string; role: string; occupation: string | null }>(),
    env.DB.prepare(`SELECT DISTINCT kind FROM entities WHERE user_id = ?`).bind(userId).all<{ kind: string }>(),
    featureOn(env, "situation_profile") ? listSituationPeriods(env, userId) : Promise.resolve([] as SituationPeriod[]),
  ]);
  const profile = profileBuilder(env, personRes.results ?? [], periods, (entityRes.results ?? []).map((e) => e.kind), ctx.descriptor)(fy);
  const [res] = scanLines(
    [{ id: row.id, bucket: row.bucket, ato_label: row.ato_label, merchant: row.merchant ?? row.raw_description, amount_cents: Math.abs(row.amount_cents ?? 0), deductibility: row.deductibility, reimbursed: row.reimbursed }],
    profile,
    ctx.rules,
    ctx.section,
    ctx.floor,
  );
  if (res?.relevance !== "worth_a_look") return { ok: false };
  await env.DB.batch([
    env.DB.prepare(`UPDATE transactions SET deductibility = 'confirmed_deductible', deductible_amount_cents = NULL WHERE id = ? AND user_id = ? AND relevance = 'worth_a_look'`).bind(txnId, userId),
    env.DB.prepare(`UPDATE claim_suggestions SET status = 'capturing' WHERE user_id = ? AND txn_id = ? AND source = ? AND status = 'suggested'`).bind(userId, txnId, SOURCE),
  ]);
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

export interface RelevanceView {
  fy: string;
  counts: Record<Relevance | "unscanned", number>;
  worth_a_look: { txn_id: string; merchant: string | null; txn_date: string | null; amount_cents: number; rule_id: string | null; suggestion_id: string | null; suggestion: string | null; status: string | null; deductibility: string | null }[];
  prompts: ScanPrompt[];
}

/** GET /api/relevance?fy= — the FY's three lists as counts, the worth-a-look cards, and the prompts. */
export async function relevanceView(env: Env, userId: string, startYear: number): Promise<RelevanceView> {
  const descriptor = await resolveJurisdictionForUser(env, userId);
  const { start, end } = fyBoundsFor(descriptor, startYear);
  const [countRes, cardRes, profiles] = await Promise.all([
    env.DB.prepare(
      `SELECT COALESCE(relevance, 'unscanned') AS r, COUNT(*) AS n FROM transactions
        WHERE user_id = ? AND kind = 'bank_line' AND COALESCE(direction,'debit') = 'debit' AND status NOT IN ('duplicate','ignored')
          AND txn_date >= ? AND txn_date <= ? GROUP BY 1`,
    ).bind(userId, start, end).all<{ r: string; n: number }>(),
    env.DB.prepare(
      `SELECT t.id AS txn_id, t.merchant, t.txn_date, ABS(COALESCE(t.amount_aud_cents, t.amount_cents, 0)) AS amount_cents, t.relevance_rule_id AS rule_id,
              cs.id AS suggestion_id, cs.suggestion, cs.status, t.deductibility
         FROM transactions t
         LEFT JOIN claim_suggestions cs ON cs.user_id = t.user_id AND cs.txn_id = t.id AND cs.rule_id = t.relevance_rule_id AND cs.source = '${SOURCE}'
        WHERE t.user_id = ? AND t.relevance = 'worth_a_look' AND t.txn_date >= ? AND t.txn_date <= ?
        ORDER BY t.txn_date DESC, t.id LIMIT 500`,
    ).bind(userId, start, end).all<RelevanceView["worth_a_look"][number]>(),
    featureOn(env, "situation_profile")
      ? (async () => {
          const periods = await listSituationPeriods(env, userId);
          const persons = (await env.DB.prepare(`SELECT id FROM persons WHERE user_id = ? ORDER BY role = 'self' DESC, created_at, id`).bind(userId).all<{ id: string }>()).results ?? [];
          return persons.map((p) => buildProfile(p.id, periods, startYear, { start, end }));
        })()
      : Promise.resolve([] as SituationProfile[]),
  ]);
  const counts: RelevanceView["counts"] = { relevant: 0, worth_a_look: 0, irrelevant: 0, unscanned: 0 };
  for (const c of countRes.results ?? []) if (c.r in counts) counts[c.r as keyof typeof counts] = c.n;
  return { fy: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`, counts, worth_a_look: cardRes.results ?? [], prompts: scanPrompts(profiles) };
}

