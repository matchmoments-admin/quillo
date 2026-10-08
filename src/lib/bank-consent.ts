import type { Env } from "../env";
import { bankProvider } from "./bank-provider";
import { clearOrphanedTxnCgt } from "./situation-write";
import { featureOn } from "./features";

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

/**
 * The two aggregator calls a withdrawal needs. Injected so tests run against a fake. `provider` is
 * the row's own bank_connections.provider / profiles.bank_provider — a withdrawal is always sent to
 * the aggregator that holds the consent, never to whichever one new connects currently use.
 */
export interface BankUpstream {
  deleteConnection(providerUserId: string, providerConnectionId: string, provider?: string | null): Promise<void>;
  deleteUser(providerUserId: string, provider?: string | null): Promise<void>;
}

/** Routes each call to the provider named on the row (NULL on a legacy row ⇒ Basiq). */
export function bankUpstream(env: Env): BankUpstream {
  return {
    deleteConnection: (u, c, p) => bankProvider(env, p ?? null).revokeConnection(u, c),
    deleteUser: (u, p) => bankProvider(env, p ?? null).deleteUser(u),
  };
}

// ── CDR audit log ────────────────────────────────────────────────────────────

export type CdrEvent =
  /** A consent flow was STARTED (auth session created) — recorded even if the consumer abandons it. */
  | "consent_requested"
  /** The consumer came back via the cancel/error redirect: no consent was granted. */
  | "consent_abandoned"
  | "consent_granted"
  | "collected"
  | "consent_expired"
  | "expiry_reminder"
  | "consent_withdrawn"
  | "upstream_revoked"
  | "upstream_revoke_failed"
  | "data_deleted"
  | "tenant_purged"
  /** #639: the aggregator end user was deleted after 30 days with no live consent (Fiskil developer checklist). */
  | "end_user_deleted"
  /** #639: that delete failed at the aggregator — an error class only; retried by the next weekly sweep. */
  | "end_user_delete_failed";

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
  await cdrAuditStmt(env, userId, e).run();
}

/** The same insert as a prepared statement, so a caller can put it in the batch of the change it records. */
export function cdrAuditStmt(env: Env, userId: string, e: CdrAuditEntry): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO cdr_audit_log
       (id, user_id, connection_id, provider, access_type, event, account_count, row_count, from_date, to_date, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), userId, e.connectionId ?? null, e.provider ?? null, e.accessType ?? null, e.event,
    e.accountCount ?? null, e.rowCount ?? null, e.fromDate ?? null, e.toDate ?? null,
    e.detail ? JSON.stringify(e.detail) : null,
  );
}

/** A vendor error reduced to something safe to persist: status/code class, never a body. */
function errorClass(e: unknown): string {
  const err = e as { status?: number; code?: string; name?: string };
  if (typeof err?.status === "number") return `http_${err.status}${err.code ? `_${err.code}` : ""}`;
  return err?.name ?? "error";
}

/** The aggregator's support handle for a failure (Fiskil error_id / Basiq correlationId) — an id, safe to keep. */
function errorId(e: unknown): string | null {
  const id = (e as { correlationId?: unknown })?.correlationId;
  return typeof id === "string" && id ? id.slice(0, 128) : null;
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

/**
 * The statuses that no longer hold a live consent. A withdrawn connection never does. An EXPIRED one is a
 * spent consent too, but it only counts as such when `cdr_expiry_delete` is ON: with the flag OFF its lines are
 * still held (expiry only stops collection), so it must keep counting as live — otherwise a withdrawal's
 * last-connection sweep would delete them and the flag-OFF behaviour would change.
 */
function deadStatusesSql(env: Env): string {
  return featureOn(env, "cdr_expiry_delete") ? `('revoked', 'expired')` : `('revoked')`;
}

/** Other connections that still have upstream access (anything not withdrawn — or expired, see above). */
async function liveOtherConnections(env: Env, userId: string, exceptId: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM bank_connections WHERE user_id = ? AND id <> ? AND status NOT IN ${deadStatusesSql(env)}`,
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
      await upstream.deleteConnection(conn.provider_user_id, conn.provider_connection_id, conn.provider);
    }
    if (last && conn.provider_user_id) {
      await upstream.deleteUser(conn.provider_user_id, conn.provider);
      consumerDeleted = true;
    }
  } catch (e) {
    const cls = errorClass(e);
    const eid = errorId(e);
    // Server-side only: the vendor message stays in Workers logs; the row, the CDR record and the
    // client get the error class.
    console.error(`[cdr] upstream revoke failed for connection ${conn.id}: ${(e as Error).message}`);
    await env.DB.prepare(
      `UPDATE bank_connections SET last_error = ? WHERE id = ? AND user_id = ?`,
    ).bind("The bank-side revoke didn't go through — use Retry, or we'll retry automatically.", conn.id, userId).run();
    await cdrAudit(env, userId, {
      event: "upstream_revoke_failed", connectionId: conn.id, provider: conn.provider, accessType: conn.access_type,
      detail: eid ? { error: cls, error_id: eid } : { error: cls },
    });
    return { revoked: false, consumerDeleted: false, error: cls };
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
 * Privacy Safeguard 12: delete the CDR lines collected for `accountId`, plus the per-line derived rows
 * that are keyed to them (corrections, traces, claim links/suggestions, attributions, per-line
 * notifications). Receipts matched to a deleted line are un-matched, not deleted — they are the
 * consumer's own evidence, not CDR data — exactly as deleteStatement(purge) does. ONE D1 batch per
 * account, so it is atomic.
 *
 * KNOWN RESIDUALS (not keyed to a txn id, so not reachable from here — routed to the CDR legal review
 * #524, which decides delete vs keep, because several feed the position): clarify_questions
 * (sample_desc), user_rules auto-learned from a feed merchant, recurring_bills/opportunities,
 * eval_cases, assets auto-linked from a feed line, chat history, and merchant names in audit_log.
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
    p(`UPDATE phi_benefit_usage SET txn_id = NULL WHERE user_id = ? AND txn_id IN (${sub})`),
  ];
  const delIdx = stmts.length;
  stmts.push(
    env.DB.prepare(
      `DELETE FROM transactions WHERE user_id = ? AND account_id = ? AND source = 'cdr_feed' AND kind = 'bank_line'`,
    ).bind(userId, accountId),
    // #594: the bank-minimisation totals and fingerprint tombstones of this account's FEED lines are CDR-derived
    // too (statement_id IS NULL = cdr_feed; a statement's own rollups belong to the statement and stay). With
    // them gone a later re-consent re-collects the period as fresh lines. No-op when nothing was ever shrunk.
    env.DB.prepare(`DELETE FROM bank_line_rollups WHERE user_id = ? AND account_id = ? AND statement_id IS NULL`).bind(userId, accountId),
    env.DB.prepare(`DELETE FROM bank_line_tombstones WHERE user_id = ? AND account_id = ? AND statement_id IS NULL`).bind(userId, accountId),
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
 * The PS12 delete for one withdrawn connection. Runs at most once per connection (data_deleted_at),
 * and is re-run by the weekly sweep if a withdrawal died before stamping it.
 *
 * Which accounts: every account this connection was EVER mapped to — deselecting keeps the mapping
 * (bankSelectAccounts clears only `selected`), so lines collected before a deselect are still found.
 * When this is the tenant's LAST live connection, every CDR line the tenant holds is redundant, so the
 * sweep widens to all cdr_feed lines, and any cdr_feed account left with no lines is handed back to
 * statements (an account claimed and released before its first sync would otherwise stay locked).
 */
async function runPs12Delete(
  env: Env,
  userId: string,
  conn: ConnRow,
  nowIso: string,
  reason: "consent_withdrawn" | "consent_expired" = "consent_withdrawn",
): Promise<{ accounts: number; linesDeleted: number }> {
  const last = (await liveOtherConnections(env, userId, conn.id)) === 0;
  const mapped = await env.DB.prepare(
    `SELECT DISTINCT account_id FROM bank_connection_accounts WHERE user_id = ? AND connection_id = ? AND account_id IS NOT NULL`,
  ).bind(userId, conn.id).all<{ account_id: string }>();
  const ids = new Set((mapped.results ?? []).map((r) => r.account_id));
  if (last) {
    const orphan = await env.DB.prepare(
      `SELECT DISTINCT account_id FROM transactions
        WHERE user_id = ? AND source = 'cdr_feed' AND kind = 'bank_line' AND account_id IS NOT NULL`,
    ).bind(userId).all<{ account_id: string }>();
    for (const r of orphan.results ?? []) ids.add(r.account_id);
  }
  // An account another LIVE connection still feeds keeps source='cdr_feed'. (bankSelectAccounts now
  // refuses mapping one account to two live connections, so this is a belt-and-braces guard.)
  const stillFed = await env.DB.prepare(
    `SELECT DISTINCT a.account_id FROM bank_connection_accounts a
       JOIN bank_connections c ON c.id = a.connection_id AND c.user_id = a.user_id
      WHERE a.user_id = ? AND a.connection_id <> ? AND c.status NOT IN ${deadStatusesSql(env)}
        AND a.selected = 1 AND a.account_id IS NOT NULL`,
  ).bind(userId, conn.id).all<{ account_id: string }>();
  const fed = new Set((stillFed.results ?? []).map((r) => r.account_id));

  let accounts = 0;
  let linesDeleted = 0;
  for (const accountId of ids) {
    linesDeleted += await deleteCdrLinesForAccount(env, userId, accountId, !fed.has(accountId));
    accounts++;
  }
  // A deleted line may have seeded a capital holding (C1) — drop the now-orphaned parcels.
  if (linesDeleted > 0) await clearOrphanedTxnCgt(env, userId);

  const tail: D1PreparedStatement[] = [
    // The account list itself (names, last4) is CDR data too. The connection row stays as the
    // consumer-visible record of the withdrawal: institution, dates, scope — no account detail.
    env.DB.prepare(`DELETE FROM bank_connection_accounts WHERE user_id = ? AND connection_id = ?`).bind(userId, conn.id),
    env.DB.prepare(`UPDATE bank_connections SET data_deleted_at = ? WHERE id = ? AND user_id = ?`).bind(nowIso, conn.id, userId),
  ];
  if (last) {
    tail.push(
      env.DB.prepare(
        `UPDATE accounts SET source = 'statement'
          WHERE user_id = ? AND source = 'cdr_feed'
            AND NOT EXISTS (SELECT 1 FROM transactions t
                             WHERE t.user_id = accounts.user_id AND t.account_id = accounts.id
                               AND t.source = 'cdr_feed' AND t.kind = 'bank_line')`,
      ).bind(userId),
    );
  }
  await env.DB.batch(tail);
  await cdrAudit(env, userId, {
    event: "data_deleted", connectionId: conn.id, provider: conn.provider, accessType: conn.access_type,
    accountCount: accounts, rowCount: linesDeleted, detail: { reason, tenant_wide: last },
  });
  return { accounts, linesDeleted };
}

/**
 * Withdraw one bank connection: stop collecting, revoke upstream, delete its CDR data (PS12), and
 * record each step. Idempotent — calling it again retries a failed upstream revoke and never
 * re-runs a completed delete (which, on the last connection, is tenant-wide and must not later
 * sweep up a NEW connection's lines).
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

  // 1. Stop collecting — first, unconditionally. The status flip and its CDR record share a batch so
  // a crash can't leave a withdrawal with no record. bankSync re-checks status='active' inside every
  // insert, so a sync already in flight cannot land lines after this point.
  if (conn.status !== "revoked") {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE bank_connections SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND user_id = ?`,
      ).bind(nowIso, conn.id, userId),
      cdrAuditStmt(env, userId, { event: "consent_withdrawn", connectionId: conn.id, provider: conn.provider, accessType: conn.access_type }),
      // Close any backfill in flight for this connection: its next checkpoint then matches zero rows
      // and the step stops (bank-sync.ts), instead of fetching pages that can no longer be written.
      env.DB.prepare(
        `UPDATE bank_sync_runs SET status = 'failed', error = 'consent withdrawn', finished_at = datetime('now'), updated_at = datetime('now')
          WHERE user_id = ? AND connection_id = ? AND status = 'running'`,
      ).bind(userId, conn.id),
    ]);
  }

  // 2. Upstream.
  const up = await revokeUpstream(env, userId, conn, upstream, nowIso);

  // 3. PS12 delete — once.
  let accounts = 0;
  let linesDeleted = 0;
  if (!conn.data_deleted_at) ({ accounts, linesDeleted } = await runPs12Delete(env, userId, conn, nowIso));

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
  /** Withdrawals whose PS12 delete had not completed, finished by this sweep. */
  deletesCompleted: number;
  /** #639 (cdr_expiry_delete): expired consents whose PS12 delete ran on this sweep (0 when the flag is OFF). */
  expiredDeleted: number;
  /** Bank lines those expiry deletes removed. */
  expiredLinesDeleted: number;
}

/**
 * Weekly, per tenant, flag-gated by the caller:
 *  - mark consents past their expiry as 'expired' (bankSync already refuses them; this makes the
 *    dashboard and the CDR record say so),
 *  - send ONE reminder per consent inside the reminder window (ADR-0003 §6.4),
 *  - retry upstream revokes that failed at withdrawal time,
 *  - (#639, flag `cdr_expiry_delete`) run the PS12 delete for every EXPIRED consent whose data is still held.
 *
 * Expiry deletion. Once the use consent ends the collected data is redundant (PS12, r7.12–7.13), so with
 * `cdr_expiry_delete` ON an expired consent goes through the SAME delete as a withdrawal (runPs12Delete,
 * reason 'consent_expired'), at expiry — no grace period. It covers consents that expired before the flag was
 * flipped too (status 'expired', data_deleted_at NULL). The connection is NOT revoked upstream (the consent has
 * already lapsed at the data holder); the aggregator end user is removed 30 days later by inactiveEndUserSweep.
 * OFF ⇒ expiry only marks the row and stops collection, exactly as before.
 */
export async function consentLifecycle(
  env: Env,
  userId: string,
  upstream: BankUpstream,
  now: Date = new Date(),
): Promise<LifecycleResult> {
  const nowIso = now.toISOString();
  const out: LifecycleResult = { expired: 0, reminded: 0, upstreamRetried: 0, deletesCompleted: 0, expiredDeleted: 0, expiredLinesDeleted: 0 };

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
      await env.DB.batch([
        env.DB.prepare(`UPDATE bank_connections SET status = 'expired' WHERE id = ? AND user_id = ? AND status = 'active'`).bind(c.id, userId),
        cdrAuditStmt(env, userId, { event: "consent_expired", connectionId: c.id, provider: c.provider, accessType: c.access_type }),
      ]);
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

  // A withdrawal that died between the status flip and the PS12 delete (DO eviction, D1 error) would
  // otherwise hold the data forever — nothing else re-selects it. Finish it here.
  const undeleted = await env.DB.prepare(
    `SELECT ${CONN_COLS} FROM bank_connections WHERE user_id = ? AND status = 'revoked' AND data_deleted_at IS NULL`,
  ).bind(userId).all<ConnRow>();
  for (const c of undeleted.results ?? []) {
    await runPs12Delete(env, userId, c, nowIso);
    out.deletesCompleted++;
  }

  // Expiry ⇒ PS12 delete (#639). Runs after the expire loop above, so a consent that lapsed this week is
  // deleted on the same sweep. Each row at most once (data_deleted_at); a re-consent clears it (bankCallback).
  if (featureOn(env, "cdr_expiry_delete")) {
    const expired = await env.DB.prepare(
      `SELECT ${CONN_COLS} FROM bank_connections WHERE user_id = ? AND status = 'expired' AND data_deleted_at IS NULL`,
    ).bind(userId).all<ConnRow>();
    for (const c of expired.results ?? []) {
      const r = await runPs12Delete(env, userId, c, nowIso, "consent_expired");
      out.expiredDeleted++;
      out.expiredLinesDeleted += r.linesDeleted;
    }
  }
  return out;
}

// ── Inactive end users (#639, Fiskil developer checklist) ────────────────────

/** Days with no live consent before the aggregator end user is deleted. */
export const INACTIVE_END_USER_DAYS = 30;

export type InactiveEndUserState =
  /** No aggregator end user on file (never connected, or already deleted). */
  | { state: "none" }
  /** A consent is still live (active / pending / error) — the end user is in use. */
  | { state: "active" }
  /** No live consent, but not yet 30 days: queued. `due_at` is when it becomes eligible. */
  | { state: "queued"; inactive_since: string; due_at: string }
  | { state: "deleted"; inactive_since: string }
  | { state: "failed"; error: string };

/** SQLite 'YYYY-MM-DD HH:MM:SS' or ISO → epoch ms (UTC); NaN when unparseable. */
function ts(v: string | null | undefined): number {
  if (!v) return NaN;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v) ? `${v.replace(" ", "T")}Z` : v;
  return Date.parse(iso);
}

/**
 * The moment the tenant's CDR relationship last showed any activity: the newest CDR record (consent requested /
 * granted / abandoned / collected / withdrawn / expired / deleted…), a connection's creation, revocation or a
 * past expiry. Failed end-user deletes and pre-expiry reminders are NOT activity (otherwise a failing delete
 * would push its own retry back forever). NaN when nothing is on record.
 */
async function lastCdrActivity(env: Env, userId: string, nowMs: number): Promise<number> {
  const a = await env.DB.prepare(
    `SELECT MAX(created_at) AS t FROM cdr_audit_log
      WHERE user_id = ? AND event NOT IN ('end_user_delete_failed', 'expiry_reminder')`,
  ).bind(userId).first<{ t: string | null }>();
  const c = await env.DB.prepare(
    `SELECT created_at, revoked_at, consent_expires_at FROM bank_connections WHERE user_id = ?`,
  ).bind(userId).all<{ created_at: string | null; revoked_at: string | null; consent_expires_at: string | null }>();
  let latest = ts(a?.t);
  const bump = (v: number) => {
    if (Number.isFinite(v) && v <= nowMs && !(v <= latest)) latest = v;
  };
  for (const r of c.results ?? []) {
    bump(ts(r.created_at));
    bump(ts(r.revoked_at));
    bump(ts(r.consent_expires_at)); // only once it is in the past (bump ignores the future)
  }
  return latest;
}

/**
 * Weekly, per tenant, flag `cdr_inactive_user_delete`: delete the aggregator END USER once the tenant has held
 * no live consent for INACTIVE_END_USER_DAYS — every consent withdrawn or expired, or a connect that was started
 * and abandoned. A withdrawal of the last connection already deletes the end user (revokeUpstream); this catches
 * expiry, abandoned connects and a delete that failed. Through the BankProvider seam (`upstream.deleteUser`,
 * routed to the provider on the profile row), then the id is forgotten so a later connect mints a fresh one, and
 * connections under it are marked revoked upstream (deleting the user revoked them). Idempotent: once the id is
 * cleared the tenant reads 'none'. A vendor failure records end_user_delete_failed (error class only) and is
 * retried next week. Never touches cdr_tainted or any local data — that is PS12's job.
 */
export async function inactiveEndUserSweep(
  env: Env,
  userId: string,
  upstream: BankUpstream,
  now: Date = new Date(),
): Promise<InactiveEndUserState> {
  if (!featureOn(env, "cdr_inactive_user_delete")) return { state: "none" };
  const p = await env.DB.prepare(`SELECT bank_provider_user_id, bank_provider FROM profiles WHERE user_id = ?`)
    .bind(userId)
    .first<{ bank_provider_user_id: string | null; bank_provider: string | null }>();
  const endUser = p?.bank_provider_user_id;
  if (!endUser) return { state: "none" };

  const live = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM bank_connections WHERE user_id = ? AND status NOT IN ('revoked', 'expired')`,
  ).bind(userId).first<{ n: number }>();
  if ((live?.n ?? 0) > 0) return { state: "active" };

  const nowMs = now.getTime();
  const last = await lastCdrActivity(env, userId, nowMs);
  // Nothing on record at all (an end user minted before the CDR log existed): treat as long inactive.
  const since = Number.isFinite(last) ? last : 0;
  const dueMs = since + INACTIVE_END_USER_DAYS * 86_400_000;
  const sinceIso = new Date(since).toISOString();
  if (nowMs < dueMs) return { state: "queued", inactive_since: sinceIso, due_at: new Date(dueMs).toISOString() };

  const provider = p?.bank_provider ?? null;
  try {
    await upstream.deleteUser(endUser, provider);
  } catch (e) {
    const cls = errorClass(e);
    const eid = errorId(e);
    console.error(`[cdr] inactive end-user delete failed for tenant ${userId}: ${cls}`);
    await cdrAudit(env, userId, {
      event: "end_user_delete_failed", provider,
      detail: eid ? { reason: "inactive", error: cls, error_id: eid } : { reason: "inactive", error: cls },
    });
    return { state: "failed", error: cls };
  }
  const nowIso = now.toISOString();
  const inactiveDays = Math.floor((nowMs - since) / 86_400_000);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE profiles SET bank_provider_user_id = NULL, bank_provider = NULL WHERE user_id = ? AND bank_provider_user_id = ?`,
    ).bind(userId, endUser),
    env.DB.prepare(
      `UPDATE bank_connections SET upstream_revoked_at = ?, last_error = NULL
        WHERE user_id = ? AND provider_user_id = ? AND upstream_revoked_at IS NULL`,
    ).bind(nowIso, userId, endUser),
    cdrAuditStmt(env, userId, {
      event: "end_user_deleted", provider,
      detail: { reason: "inactive", inactive_days: Number.isFinite(last) ? inactiveDays : null },
    }),
  ]);
  return { state: "deleted", inactive_since: sinceIso };
}

/**
 * Platform-wide size of the inactive end-user deletion queue (the Security & compliance "Data lifecycle" panel):
 * tenants holding an aggregator end user with no live consent — whether still inside the 30 days or due. Counts
 * only. Read directly (no DO): it is a cross-tenant tally, never a write.
 */
export async function inactiveEndUserQueueSize(env: Env): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM profiles p
      WHERE p.bank_provider_user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM bank_connections c
                         WHERE c.user_id = p.user_id AND c.status NOT IN ('revoked', 'expired'))`,
  ).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/** The consumer's CDR record (newest first) — shown on the consent dashboard. No CDR content. */
export async function cdrHistory(env: Env, userId: string, limit = 100): Promise<Record<string, unknown>[]> {
  const r = await env.DB.prepare(
    `SELECT connection_id, event, account_count, row_count, from_date, to_date, created_at
       FROM cdr_audit_log WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).bind(userId, limit).all<Record<string, unknown>>();
  return r.results ?? [];
}
