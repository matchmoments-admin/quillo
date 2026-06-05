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
] as const;

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
  // 1. Revoke + delete the QuickBooks connection first (also clears its KV account cache).
  let qboRevoked = false;
  try {
    const r = await revokeAndDisconnect(env, userId);
    qboRevoked = r.revoked;
  } catch {
    /* best-effort — never block the erasure on a remote revoke */
  }

  // 2. D1: delete every tenant table except audit_log, in one batch. daily_cost is keyed by `scope`
  // (not user_id), so it's purged explicitly by scope here rather than via the user_id list — this
  // erases the tenant's per-day AI-spend rows; the 'global' platform tally is untouched.
  const stmts = [
    ...PURGE_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(userId)),
    env.DB.prepare(`DELETE FROM daily_cost WHERE scope = ?`).bind(userId),
  ];
  const results = await env.DB.batch(stmts);
  const rowsDeleted = results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);

  // Re-seat a CLEAN, empty profile (all columns default: consent reset to 0, no PII). Profiles are
  // only ever created by the onboarding scripts, and requireProfile throws without one — so without
  // this, a tenant who deletes their data would be bricked. Instead they get a brand-new empty
  // account and are sent back through onboarding. Full identity removal (Clerk) is a separate step.
  await env.DB.prepare(`INSERT INTO profiles (user_id) VALUES (?)`).bind(userId).run();

  // 3. R2: every object is keyed `${userId}/…` — list + bulk-delete in pages. Best-effort: the D1
  // wipe has already committed, so a transient store error must NOT reject (which would skip the
  // post-audit and report a failure for an account that's effectively gone).
  let r2Objects = 0;
  try {
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
  } catch (e) {
    console.warn(`purge: R2 cleanup incomplete for ${userId}: ${(e as Error).message}`);
  }

  // 4. KV: per-tenant caches. Single keys + the day-bucketed cost keys (prefix list). Best-effort.
  let kvKeys = 0;
  try {
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
  } catch (e) {
    console.warn(`purge: KV cleanup incomplete for ${userId}: ${(e as Error).message}`);
  }

  return { tables: PURGE_TABLES.length, rowsDeleted, r2Objects, kvKeys, qboRevoked };
}

/**
 * APP 12 export: the tenant's data as round-trippable JSON (situation + records + metadata).
 * Statement/document bytes themselves stay in R2 (downloadable separately); we export their metadata.
 */
export async function exportTenant(env: Env, userId: string): Promise<Record<string, unknown>> {
  const profile = await getProfile(env, userId);
  const situation = profile ? await getSituation(env, userId, profile) : null;
  // Dump every record table in FULL (no UI list caps / no matched-receipt filter) so the access
  // request is complete. Each is scoped to user_id.
  const dump = async (table: string): Promise<unknown[]> => {
    const r = await env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).bind(userId).all();
    return r.results ?? [];
  };
  const [transactions, income, assets, depreciation, documents, statements, accounts, corrections, notifications, claims, checklist] =
    await Promise.all([
      dump("transactions"),
      dump("income"),
      dump("assets"),
      dump("depreciation_schedule"),
      dump("documents"),
      dump("statements"),
      dump("accounts"),
      dump("corrections"),
      dump("notifications"),
      dump("claim_suggestions"),
      dump("fy_checklist"),
    ]);
  return {
    exported_at: new Date().toISOString(),
    user_id: userId,
    situation,
    transactions,
    income,
    assets,
    depreciation,
    documents,
    statements,
    accounts,
    corrections,
    notifications,
    claims,
    checklist,
  };
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
