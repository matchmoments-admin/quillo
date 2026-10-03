import type { Env } from "../env";
import { deleteBasiqConnection, deleteBasiqUser } from "./basiq";
import { clearOrphanedTxnCgt } from "./situation-write";

/**
 * Bank-feed consent lifecycle — withdraw, Privacy Safeguard 12 delete, expiry, CDR audit log
 * (#576, ADR-0003 §6.3 step 7 + §6.4, findings S9/S10).
 *
 * The DO stays the write-coordinator (it calls these and adds its own hash-chained audit_log row);
 * this module holds the logic so it can be unit-tested against an in-memory D1 and a FAKE upstream,
 * with no live aggregator call.
 *
 * Invariants this module exists to hold:
 *
 *  1. A WITHDRAWAL TAKES EFFECT LOCALLY FIRST. The connection flips to status='revoked' before any
 *     vendor call, and bankSync reads only status='active' — so a Basiq outage can never keep a
 *     withdrawn consent collecting. The upstream revoke is then attempted; a failure is recorded
 *     (upstream_revoked_at stays NULL), surfaced on the dashboard with a retry, and retried by the
 *     weekly sweep.
 *  2. PS12 DELETES ONLY CDR-SOURCED LINES. Every delete is `source = 'cdr_feed' AND kind = 'bank_line'`.
 *     Statement, QuickBooks and manual rows are never touched. After the delete an account the feed
 *     owned goes back to `source = 'statement'` (only when no other live connection still feeds it and
 *     no feed line remains on it), so assertCanonicalSource lets the consumer replace the data with
 *     statement uploads — one canonical source per account, before and after.
 *  3. profiles.cdr_tainted IS NEVER CLEARED. Nothing here writes it. A withdrawn consent stops future
 *     collection; it does not change what the safeguards cover for anything derived while it was live
 *     (migration 0077).
 *  4. THE AUDIT LOG HOLDS NO CDR DATA. cdr_audit_log rows carry counts, ids, windows and an error
 *     class — never an account number, description, merchant or payload.
 */

// ── Upstream (the aggregator) ────────────────────────────────────────────────

/** The two aggregator calls a withdrawal needs. Injected so tests run against a fake. */
export interface BankUpstream {
  deleteConnection(providerUserId: string, providerConnectionId: string): Promise<void>;
  deleteUser(providerUserId: string): Promise<void>;
}

export function basiqUpstream(env: Env): BankUpstream {
  return {
    deleteConnection: (u, c) => deleteBasiqConnection(env, u, c),
    deleteUser: (u) => deleteBasiqUser(env, u),
  };
}

// ── CDR audit log ────────────────────────────────────────────────────────────

export type CdrEvent =
  | "consent_granted"
  | "collected"
  | "consent_expired"
  | "expiry_reminder"
  | "consent_withdrawn"
  | "upstream_revoked"
  | "upstream_revoke_failed"
  | "data_deleted"
  | "tenant_purged";

export interface CdrAuditEntry {
  event: CdrEvent;
  connectionId?: string | null;
  provider?: string | null;
  accessType?: string | null;
  accountCount?: number | null;
  rowCount?: number | null;
  fromDate?: string | null;
  toDate?: string | null;
  /** Counts / ids / error class ONLY. Never CDR content. */
  detail?: Record<string, string | number | boolean | null>;
}

export async function cdrAudit(env: Env, userId: string, e: CdrAuditEntry): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cdr_audit_log
       (id, user_id, connection_id, provider, access_type, event, account_count, row_count, from_date, to_date, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), userId, e.connectionId ?? null, e.provider ?? null, e.accessType ?? null, e.event,
    e.accountCount ?? null, e.rowCount ?? null, e.fromDate ?? null, e.toDate ?? null,
    e.detail ? JSON.stringify(e.detail) : null,
  ).run();
}

/** A vendor error reduced to something safe to persist: status/code class, never a body. */
function errorClass(e: unknown): string {
  const err = e as { status?: number; code?: string; name?: string };
  if (typeof err?.status === "number") return `http_${err.status}${err.code ? `_${err.code}` : ""}`;
  return err?.name ?? "error";
}

// ── Withdraw ─────────────────────────────────────────────────────────────────

interface ConnRow {
  id: string;
  provider: string;
  access_type: string;
  provider_user_id: string | null;
  provider_connection_id: string | null;
  status: string;
  upstream_revoked_at: string | null;
  data_deleted_at: string | null;
}

export interface DisconnectResult {
  ok: boolean;
  error?: string;
  /** The aggregator confirmed the revoke (now or on an earlier attempt). */
  upstreamRevoked: boolean;
  /** Set when the vendor call failed this time — the local half still ran. */
  upstreamError?: string;
  /** The whole aggregator consumer was deleted (this was the tenant's last live connection). */
  consumerDeleted: boolean;
  accounts: number;
  linesDeleted: number;
}

const CONN_COLS = `id, provider, access_type, provider_user_id, provider_connection_id, status,
                   upstream_revoked_at, data_deleted_at`;

/** Other connections that still have upstream access (anything not withdrawn). */
async function liveOtherConnections(env: Env, userId: string, exceptId: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM bank_connections WHERE user_id = ? AND id <> ? AND status <> 'revoked'`,
  ).bind(userId, exceptId).first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * The upstream half: delete the connection at the aggregator, and the whole consumer when no other
 * live connection remains (which also stops the per-user billing). Never throws — the outcome is
 * recorded on the row and in the CDR log, and returned.
 */
async function revokeUpstream(
  env: Env,
  userId: string,
  conn: ConnRow,
  upstream: BankUpstream,
  nowIso: string,
): Promise<{ revoked: boolean; consumerDeleted: boolean; error?: string }> {
  if (conn.upstream_revoked_at) return { revoked: true, consumerDeleted: false };
  const last = (await liveOtherConnections(env, userId, conn.id)) === 0;
  let consumerDeleted = false;
  try {
    if (conn.provider_user_id && conn.provider_connection_id) {
      await upstream.deleteConnection(conn.provider_user_id, conn.provider_connection_id);
    }
    if (last && conn.provider_user_id) {
      await upstream.deleteUser(conn.provider_user_id);
      consumerDeleted = true;
    }
  } catch (e) {
    const cls = errorClass(e);
    await env.DB.prepare(
      `UPDATE bank_connections SET last_error = ? WHERE id = ? AND user_id = ?`,
    ).bind("The bank-side revoke didn't go through — use Retry, or we'll retry automatically.", conn.id, userId).run();
    await cdrAudit(env, userId, {
      event: "upstream_revoke_failed", connectionId: conn.id, provider: conn.provider, accessType: conn.access_type,
      detail: { error: cls },
    });
    return { revoked: false, consumerDeleted: false, error: (e as Error).message };
  }

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE bank_connections SET upstream_revoked_at = ?, last_error = NULL WHERE id = ? AND user_id = ?`,
    ).bind(nowIso, conn.id, userId),
  ];
  if (consumerDeleted && conn.provider_user_id) {
    // Deleting the consumer revoked every connection under it, including any earlier withdrawal
    // whose own call failed — mark those done too, and forget the id so the next connect mints a
    // fresh consumer instead of addressing a deleted one.
    stmts.push(
      env.DB.prepare(
        `UPDATE bank_connections SET upstream_revoked_at = ?, last_error = NULL
          WHERE user_id = ? AND provider_user_id = ? AND upstream_revoked_at IS NULL`,
      ).bind(nowIso, userId, conn.provider_user_id),
      env.DB.prepare(
        `UPDATE profiles SET bank_provider_user_id = NULL, bank_provider = NULL
          WHERE user_id = ? AND bank_provider_user_id = ?`,
      ).bind(userId, conn.provider_user_id),
    );
  }
  await env.DB.batch(stmts);
  await cdrAudit(env, userId, {
    event: "upstream_revoked", connectionId: conn.id, provider: conn.provider, accessType: conn.access_type,
    detail: { consumer_deleted: consumerDeleted },
  });
  return { revoked: true, consumerDeleted };
}

/**
 * Privacy Safeguard 12: delete the CDR lines collected for `accountId`, plus everything derived from
 * them that carries their content (corrections, traces, AI edit snapshots, claim links/suggestions,
 * attributions, per-line notifications). Receipts matched to a deleted line are un-matched, not
 * deleted — they are the consumer's own evidence, not CDR data — exactly as deleteStatement(purge)
 * does. ONE D1 batch per account, so it is atomic.
 *
 * Returns the number of bank lines deleted.
 */
async function deleteCdrLinesForAccount(env: Env, userId: string, accountId: string, resetSource: boolean): Promise<number> {
  const sub = `SELECT id FROM transactions WHERE user_id = ? AND account_id = ? AND source = 'cdr_feed' AND kind = 'bank_line'`;
  const p = (sql: string) => env.DB.prepare(sql).bind(userId, userId, accountId);
  const stmts: D1PreparedStatement[] = [
    p(`UPDATE transactions SET matched_txn_id = NULL, status = 'extracted'
        WHERE user_id = ? AND kind = 'receipt' AND matched_txn_id IN (${sub})`),
    p(`UPDATE transactions SET refund_for_txn_id = NULL WHERE user_id = ? AND refund_for_txn_id IN (${sub})`),
    p(`DELETE FROM corrections WHERE user_id = ? AND txn_id IN (${sub})`),
    p(`DELETE FROM traces WHERE user_id = ? AND txn_id IN (${sub})`),
    p(`DELETE FROM claim_links WHERE user_id = ? AND txn_id IN (${sub})`),
    p(`DELETE FROM claim_suggestions WHERE user_id = ? AND txn_id IN (${sub})`),
    p(`DELETE FROM notifications WHERE user_id = ? AND txn_id IN (${sub})`),
    p(`DELETE FROM transaction_attributions WHERE user_id = ? AND transaction_id IN (${sub})`),
    p(`DELETE FROM ai_edits WHERE user_id = ? AND entity_id IN (${sub})`),
    p(`UPDATE phi_benefit_usage SET txn_id = NULL WHERE user_id = ? AND txn_id IN (${sub})`),
  ];
  const delIdx = stmts.length;
  stmts.push(
    env.DB.prepare(
      `DELETE FROM transactions WHERE user_id = ? AND account_id = ? AND source = 'cdr_feed' AND kind = 'bank_line'`,
    ).bind(userId, accountId),
  );
  if (resetSource) {
    // Hand the account back to statement uploads ONLY when nothing fed remains on it — so the
    // one-canonical-source rule holds on both sides of the switch.
    stmts.push(
      env.DB.prepare(
        `UPDATE accounts SET source = 'statement'
          WHERE id = ? AND user_id = ? AND source = 'cdr_feed'
            AND NOT EXISTS (SELECT 1 FROM transactions
                             WHERE user_id = ? AND account_id = ? AND source = 'cdr_feed' AND kind = 'bank_line')`,
      ).bind(accountId, userId, userId, accountId),
    );
  }
  const res = await env.DB.batch(stmts);
  return res[delIdx]?.meta?.changes ?? 0;
}

/**
 * Withdraw one bank connection: stop collecting, revoke upstream, delete its CDR data (PS12), and
 * record each step. Idempotent — calling it again retries a failed upstream revoke and never
 * re-runs the delete (which, on the last connection, is tenant-wide and must not later sweep up a
 * NEW connection's lines).
 */
export async function disconnectBankConnection(
  env: Env,
  userId: string,
  connectionId: string,
  upstream: BankUpstream,
  nowIso: string = new Date().toISOString(),
): Promise<DisconnectResult> {
  const conn = await env.DB.prepare(`SELECT ${CONN_COLS} FROM bank_connections WHERE id = ? AND user_id = ?`)
    .bind(connectionId, userId)
    .first<ConnRow>();
  if (!conn) return { ok: false, error: "connection not found", upstreamRevoked: false, consumerDeleted: false, accounts: 0, linesDeleted: 0 };

  // 1. Stop collecting — first, unconditionally.
  if (conn.status !== "revoked") {
    await env.DB.prepare(
      `UPDATE bank_connections SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND user_id = ?`,
    ).bind(nowIso, conn.id, userId).run();
    await cdrAudit(env, userId, { event: "consent_withdrawn", connectionId: conn.id, provider: conn.provider, accessType: conn.access_type });
  }

  // Decided BEFORE the upstream call: "is this the last live connection" must not depend on whether
  // the vendor answered.
  const last = (await liveOtherConnections(env, userId, conn.id)) === 0;

  // 2. Upstream.
  const up = await revokeUpstream(env, userId, conn, upstream, nowIso);

  // 3. PS12 delete — once.
  let accounts = 0;
  let linesDeleted = 0;
  if (!conn.data_deleted_at) {
    const mapped = await env.DB.prepare(
      `SELECT DISTINCT account_id FROM bank_connection_accounts WHERE user_id = ? AND connection_id = ? AND account_id IS NOT NULL`,
    ).bind(userId, conn.id).all<{ account_id: string }>();
    const ids = new Set((mapped.results ?? []).map((r) => r.account_id));
    if (last) {
      // Last live connection ⇒ every CDR line the tenant holds is now redundant, including lines on
      // an account the consumer DESELECTED earlier (deselecting nulls the mapping, so it could not
      // be found through bank_connection_accounts).
      const orphan = await env.DB.prepare(
        `SELECT DISTINCT account_id FROM transactions
          WHERE user_id = ? AND source = 'cdr_feed' AND kind = 'bank_line' AND account_id IS NOT NULL`,
      ).bind(userId).all<{ account_id: string }>();
      for (const r of orphan.results ?? []) ids.add(r.account_id);
    }
    // An account another LIVE connection still feeds keeps source='cdr_feed'; its lines are still
    // deleted (they can't be told apart by origin) and that connection's next sync re-collects its own.
    const stillFed = await env.DB.prepare(
      `SELECT DISTINCT a.account_id FROM bank_connection_accounts a
         JOIN bank_connections c ON c.id = a.connection_id AND c.user_id = a.user_id
        WHERE a.user_id = ? AND a.connection_id <> ? AND c.status <> 'revoked'
          AND a.selected = 1 AND a.account_id IS NOT NULL`,
    ).bind(userId, conn.id).all<{ account_id: string }>();
    const fed = new Set((stillFed.results ?? []).map((r) => r.account_id));

    for (const accountId of ids) {
      linesDeleted += await deleteCdrLinesForAccount(env, userId, accountId, !fed.has(accountId));
      accounts++;
    }
    // A deleted line may have seeded a capital holding (C1) — drop the now-orphaned parcels.
    if (linesDeleted > 0) await clearOrphanedTxnCgt(env, userId);

    // The account list itself (names, last4) is CDR data too. The connection row stays as the
    // consumer-visible record of the withdrawal: institution, dates, scope — no account detail.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM bank_connection_accounts WHERE user_id = ? AND connection_id = ?`).bind(userId, conn.id),
      env.DB.prepare(`UPDATE bank_connections SET data_deleted_at = ? WHERE id = ? AND user_id = ?`).bind(nowIso, conn.id, userId),
    ]);
    await cdrAudit(env, userId, {
      event: "data_deleted", connectionId: conn.id, provider: conn.provider, accessType: conn.access_type,
      accountCount: accounts, rowCount: linesDeleted, detail: { reason: "consent_withdrawn", tenant_wide: last },
    });
  }

  return {
    ok: true,
    upstreamRevoked: up.revoked,
    upstreamError: up.error,
    consumerDeleted: up.consumerDeleted,
    accounts,
    linesDeleted,
  };
}

// ── Weekly lifecycle sweep ───────────────────────────────────────────────────

/** How far ahead of a consent's expiry the reminder goes out. */
export const EXPIRY_REMINDER_DAYS = 30;

export interface LifecycleResult {
  expired: number;
  reminded: number;
  upstreamRetried: number;
}

/**
 * Weekly, per tenant, flag-gated by the caller:
 *  - mark consents past their expiry as 'expired' (bankSync already refuses them; this makes the
 *    dashboard and the CDR record say so),
 *  - send ONE reminder per consent inside the reminder window (ADR-0003 §6.4),
 *  - retry upstream revokes that failed at withdrawal time.
 *
 * Expiry deliberately does NOT auto-delete the collected lines: whether expiry makes lines already
 * in a prepared return "redundant" under PS12 is the legal reading routed to #524. The consumer
 * can withdraw (and delete) from the dashboard at any time.
 */
export async function consentLifecycle(
  env: Env,
  userId: string,
  upstream: BankUpstream,
  now: Date = new Date(),
): Promise<LifecycleResult> {
  const nowIso = now.toISOString();
  const out: LifecycleResult = { expired: 0, reminded: 0, upstreamRetried: 0 };

  const active = await env.DB.prepare(
    `SELECT id, provider, access_type, institution, institution_id, consent_expires_at, expiry_reminded_at
       FROM bank_connections WHERE user_id = ? AND status = 'active' AND consent_expires_at IS NOT NULL`,
  ).bind(userId).all<{
    id: string; provider: string; access_type: string; institution: string | null; institution_id: string | null;
    consent_expires_at: string; expiry_reminded_at: string | null;
  }>();

  for (const c of active.results ?? []) {
    const exp = Date.parse(c.consent_expires_at);
    if (!Number.isFinite(exp)) continue;
    if (exp <= now.getTime()) {
      await env.DB.prepare(`UPDATE bank_connections SET status = 'expired' WHERE id = ? AND user_id = ? AND status = 'active'`)
        .bind(c.id, userId).run();
      await cdrAudit(env, userId, { event: "consent_expired", connectionId: c.id, provider: c.provider, accessType: c.access_type });
      out.expired++;
      continue;
    }
    const daysLeft = Math.ceil((exp - now.getTime()) / 86_400_000);
    if (daysLeft <= EXPIRY_REMINDER_DAYS && !c.expiry_reminded_at) {
      const name = c.institution ?? c.institution_id ?? "your bank";
      const on = new Date(exp).toISOString().slice(0, 10);
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO notifications (id, user_id, body, created_at) VALUES (?, ?, ?, datetime('now'))`).bind(
          crypto.randomUUID(),
          userId,
          `Your bank connection to ${name} expires on ${on}. Reconnect it from Accounts to keep importing, or let it lapse — Quillo stops collecting from it when the consent ends. You can see and withdraw your bank consents in Settings → Bank connections.`,
        ),
        env.DB.prepare(`UPDATE bank_connections SET expiry_reminded_at = ? WHERE id = ? AND user_id = ?`).bind(nowIso, c.id, userId),
      ]);
      await cdrAudit(env, userId, { event: "expiry_reminder", connectionId: c.id, provider: c.provider, accessType: c.access_type, detail: { days_left: daysLeft } });
      out.reminded++;
    }
  }

  const pending = await env.DB.prepare(
    `SELECT ${CONN_COLS} FROM bank_connections WHERE user_id = ? AND status = 'revoked' AND upstream_revoked_at IS NULL`,
  ).bind(userId).all<ConnRow>();
  for (const c of pending.results ?? []) {
    // Re-read: an earlier iteration's consumer delete may already have covered this row.
    const fresh = await env.DB.prepare(`SELECT ${CONN_COLS} FROM bank_connections WHERE id = ? AND user_id = ?`).bind(c.id, userId).first<ConnRow>();
    if (!fresh || fresh.upstream_revoked_at) continue;
    const r = await revokeUpstream(env, userId, fresh, upstream, nowIso);
    if (r.revoked) out.upstreamRetried++;
  }
  return out;
}

/** The consumer's CDR record (newest first) — shown on the consent dashboard. No CDR content. */
export async function cdrHistory(env: Env, userId: string, limit = 100): Promise<Record<string, unknown>[]> {
  const r = await env.DB.prepare(
    `SELECT connection_id, event, account_count, row_count, from_date, to_date, created_at
       FROM cdr_audit_log WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).bind(userId, limit).all<Record<string, unknown>>();
  return r.results ?? [];
}
