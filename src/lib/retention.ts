import type { Env } from "../env";
import { getProfile, getSituation } from "./db";
import { revokeAndDisconnect } from "./qbo-oauth";

// APP 11.2 / APP 12 / APP 13 support: export a tenant's data, purge it across every store, and a
// weekly FLAG sweep for records past the retention window (never auto-deletes — surfaces a nudge).

// Every table carrying user_id EXCEPT audit_log — the hash-chained log is intentionally kept as the
// deletion breadcrumb (APP allows a minimal record of the erasure). This list is asserted complete
// against schema.sql by a unit test, so a new tenant table can't silently escape the purge.
export const PURGE_TABLES = [
  "tenants",
  "tenant_keys",
  "profiles",
  "transactions",
  "accounts",
  "statements",
  "corrections",
  "ai_edits",                // 0057: AI-driven/manual entity-write undo log
  "traces",
  "eval_cases",
  "notifications",
  "qbo_connections",
  "persons",
  "property_owners",
  "properties",
  "entities",
  "user_rules",
  "llm_usage",
  "batch_jobs",
  "income",
  "documents",
  "assets",
  "depreciation_schedule",
  "fy_checklist",
  "claim_suggestions",
  "claimability_rules", // only per-tenant rows: DELETE WHERE user_id=? leaves global (NULL) pack overrides intact
  "clarify_questions",
  "claim_links",
  "accountant_runs",
  "work_use_inputs",
  "loans_properties",
  "fy_signoff",
  "capital_loss_carryins",
  "depreciation_opening_balances",
  "entity_roles",            // 0032
  "income_activities",       // 0033
  "transaction_attributions",// 0034
  "company_tax_positions",   // 0035
  // blackhole_costs + shareholder_loans dropped in 0052 (dark tables — no live read path)
  "rd_claims",               // 0035
  "cgt_assets",              // 0037 (#138)
  "cgt_events",              // 0037 (#138)
  "ess_grants",              // 0038 (#141)
  "bas_periods",             // 0039 (#137)
  "payg_instalments",        // 0039 (#137)
  "vehicle_logbooks",        // 0040 (#142)
  "car_inputs",              // 0061 (#245)
  "trust_distributions",     // 0041 (#139)
  "smsf_members",            // 0042 (#140)
  "super_contributions",     // 0042 (#140)
  "loan_interest_summaries", // 0045 (#157 S4)
  "chat_sessions",           // 0046 (#173 C2)
  "chat_messages",           // 0046 (#173 C2)
  "recurring_bills",         // 0047 (advisory)
  "opportunities",           // 0047 (advisory)
  "partner_members",         // 0049 (advisory phase 2 scaffold) — staff↔org link
  "referrals",               // 0049 — consumer referrals (user_id = the consumer)
  "referral_consents",       // 0049 — Tier-2 consent (created now, used in Phase 3)
] as const;

// Columns that must NEVER leave the system in an APP-12 export, even though the row belongs to the
// tenant: the HMAC ingest secret and the live QuickBooks OAuth tokens. Everything else in those
// tables (key_id, label, realm_id, expiries…) is fine to return.
const SECRET_COLUMNS: Record<string, readonly string[]> = {
  tenant_keys: ["secret"],
  qbo_connections: ["access_token", "refresh_token"],
};

/** Strip the secret columns (if any) from a table's rows before they leave the system in an export. */
export function redactSecrets(table: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const secrets = SECRET_COLUMNS[table];
  if (!secrets?.length) return rows;
  return rows.map((row) => {
    const copy = { ...row };
    for (const s of secrets) delete copy[s];
    return copy;
  });
}

export interface PurgeResult {
  tables: number;
  rowsDeleted: number;
  r2Objects: number;
  kvKeys: number;
  qboRevoked: boolean;
}

/**
 * Erase EVERYTHING for a tenant: D1 rows (every table but audit_log), R2 objects under `${userId}/`,
 * per-tenant KV caches, and the (revoked) QuickBooks tokens. The TaxAgent DO holds no durable storage
 * of its own, so there's no DO state to clear beyond these stores. Leaves only an audit_log breadcrumb
 * (written by the caller). Scoped to user_id throughout — never a cross-tenant delete.
 */
export async function purgeTenant(env: Env, userId: string): Promise<PurgeResult> {
  // Ordering matters (APP-13 integrity): erase the EXTERNAL stores (R2 bytes, KV caches) BEFORE the
  // D1 wipe, and let their failures PROPAGATE. Previously D1 was wiped first and R2/KV were best-
  // effort, so a mid-stream store error left receipt bytes orphaned while the caller still audited the
  // purge as "complete". Now a store failure aborts before D1 is touched — the tenant's data is intact
  // and the delete is simply retried (every step is idempotent), and the caller never records a
  // false "complete". The D1 wipe is last so nothing references bytes that are already gone.

  // 1. Revoke + delete the QuickBooks connection (also clears its KV account cache). Best-effort: a
  // remote revoke failure must not block the local erasure, and the token ROW is wiped by the D1 step.
  let qboRevoked = false;
  try {
    const r = await revokeAndDisconnect(env, userId);
    qboRevoked = r.revoked;
  } catch {
    /* best-effort — never block the erasure on a remote revoke */
  }

  // 2. R2: every object is keyed `${userId}/…` — list + bulk-delete in pages. Throws on failure so we
  // don't proceed to wipe D1 (and falsely report success) while bytes remain.
  let r2Objects = 0;
  let cursor: string | undefined;
  do {
    const page = await env.RECEIPTS.list({ prefix: `${userId}/`, cursor, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) {
      await env.RECEIPTS.delete(keys);
      r2Objects += keys.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // 3. KV: per-tenant caches — single keys + the day-bucketed cost keys (prefix list). Also throws.
  let kvKeys = 0;
  for (const k of [`accounts:${userId}`, `taxcodes:${userId}`]) {
    await env.RULES.delete(k);
    kvKeys++;
  }
  let kvCursor: string | undefined;
  do {
    const page = await env.RULES.list({ prefix: `cost:${userId}:`, cursor: kvCursor });
    for (const k of page.keys) {
      await env.RULES.delete(k.name);
      kvKeys++;
    }
    kvCursor = page.list_complete ? undefined : page.cursor;
  } while (kvCursor);

  // 4. D1 (LAST): delete every tenant table except audit_log AND re-seat a clean empty profile, in ONE
  // atomic batch. daily_cost is keyed by `scope` (not user_id), so it's purged explicitly by scope —
  // this erases the tenant's per-day AI-spend rows; the 'global' platform tally is untouched. The
  // empty-profile reseat is in the SAME batch (after the profiles DELETE) so the tenant is never left
  // profile-less between wipe and reseat (requireProfile throws without one → bricked). They get a
  // brand-new empty account and go back through onboarding; full identity removal (Clerk) is separate.
  // INSERT OR IGNORE keeps a re-run on an already-purged tenant from hitting a PRIMARY KEY conflict.
  const deletes = [
    ...PURGE_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(userId)),
    env.DB.prepare(`DELETE FROM daily_cost WHERE scope = ?`).bind(userId),
  ];
  const results = await env.DB.batch([
    ...deletes,
    env.DB.prepare(`INSERT OR IGNORE INTO profiles (user_id) VALUES (?)`).bind(userId),
  ]);
  // Count only the DELETE results (exclude the trailing reseat INSERT) so rowsDeleted stays truthful.
  const rowsDeleted = results.slice(0, deletes.length).reduce((n, r) => n + (r.meta?.changes ?? 0), 0);

  return { tables: PURGE_TABLES.length, rowsDeleted, r2Objects, kvKeys, qboRevoked };
}

/**
 * APP 12 export: the tenant's data as round-trippable JSON (situation + records + metadata).
 * Statement/document bytes themselves stay in R2 (downloadable separately); we export their metadata.
 */
export async function exportTenant(env: Env, userId: string): Promise<Record<string, unknown>> {
  const profile = await getProfile(env, userId);
  const situation = profile ? await getSituation(env, userId, profile) : null;

  // The export is the DUAL of the purge: dump every table the purge erases, plus audit_log (kept, not
  // purged, but it's the tenant's own trail) — so the access request is complete and can't silently
  // omit a table that deletion would destroy. Secret columns (HMAC ingest secret, live QBO tokens)
  // are STRIPPED — they belong to the tenant's row but must never leave the system. (Previously the
  // export hand-listed ~11 tables and used SELECT *, so it both omitted data and would dump secrets.)
  const dumpByUser = async (table: string): Promise<unknown[]> => {
    const r = await env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).bind(userId).all<Record<string, unknown>>();
    return redactSecrets(table, r.results ?? []);
  };

  const entries = await Promise.all(PURGE_TABLES.map(async (t) => [t, await dumpByUser(t)] as const));
  const tables: Record<string, unknown[]> = Object.fromEntries(entries);
  // daily_cost is scope-keyed (not user_id); audit_log is kept rather than purged but is the tenant's
  // record. Both are part of a complete access request.
  tables.daily_cost = ((await env.DB.prepare(`SELECT * FROM daily_cost WHERE scope = ?`).bind(userId).all()).results ?? []);
  tables.audit_log = ((await env.DB.prepare(`SELECT * FROM audit_log WHERE user_id = ?`).bind(userId).all()).results ?? []);

  return {
    exported_at: new Date().toISOString(),
    user_id: userId,
    situation, // friendly structured view (persons/properties/entities/rules); raw rows are in `tables`
    tables,
  };
}

/**
 * Shared nudge dedup: true when a notification whose body matches `bodyPattern` (a SQL LIKE pattern)
 * already exists — so a caller can skip re-notifying and avoid nudge fatigue. Default mode matches an
 * UNREAD nudge (the flagOldData pattern: re-notify once the user has actioned the last one). Pass
 * `withinDays` to instead suppress while ANY such nudge was created in that window REGARDLESS of read
 * state — used by the advisory layer so a standing set of opportunities isn't re-announced every weekly
 * cron after the user reads it ("accrue quietly", not nagging).
 */
export async function hasPendingNudge(env: Env, userId: string, bodyPattern: string, opts: { withinDays?: number } = {}): Promise<boolean> {
  const existing = opts.withinDays != null
    ? await env.DB.prepare(
        `SELECT 1 FROM notifications WHERE user_id = ? AND body LIKE ? AND created_at > datetime('now', ?) LIMIT 1`,
      )
        .bind(userId, bodyPattern, `-${opts.withinDays} days`)
        .first()
    : await env.DB.prepare(
        `SELECT 1 FROM notifications WHERE user_id = ? AND read_at IS NULL AND body LIKE ? LIMIT 1`,
      )
        .bind(userId, bodyPattern)
        .first();
  return existing != null;
}

/**
 * Weekly FLAG sweep (called from the cron): if the tenant has countable records older than their
 * retention window (default 5y from FY end), surface ONE notification so they can decide. Never
 * deletes. Idempotent within the window — won't re-notify if a retention nudge is already pending.
 */
export async function flagOldData(env: Env, userId: string, now = new Date()): Promise<boolean> {
  const profile = await getProfile(env, userId);
  const years = profile?.retention_years ?? 5;
  // Oldest dated record (FY runs Jul–Jun; a record dated in FY Y "expires" at 30 Jun (Y+1) + years).
  const oldest = await env.DB.prepare(
    `SELECT MIN(txn_date) AS d FROM transactions
      WHERE user_id = ? AND txn_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
  )
    .bind(userId)
    .first<{ d: string | null }>();
  if (!oldest?.d) return false;
  const oldestYear = Number(oldest.d.slice(0, 4));
  const oldestMonth = Number(oldest.d.slice(5, 7));
  const fyStart = oldestMonth >= 7 ? oldestYear : oldestYear - 1;
  const expiryYear = fyStart + 1 + years; // 30 Jun of (fyStart+1), plus the retention window
  const expired = now.getTime() > Date.UTC(expiryYear, 5, 30); // month 5 = June
  if (!expired) return false;

  // Don't pile up nudges — skip if an unread retention notice already exists.
  const existing = await env.DB.prepare(
    `SELECT 1 FROM notifications WHERE user_id = ? AND read_at IS NULL AND body LIKE '%retention%' LIMIT 1`,
  )
    .bind(userId)
    .first();
  if (existing) return false;

  await env.DB.prepare(
    `INSERT INTO notifications (id, user_id, body, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      userId,
      `Some of your records are now past your ${years}-year retention window. They're kept until you choose to delete them — you can export or delete your data anytime in Settings → Privacy. (General information only.)`,
    )
    .run();
  return true;
}
