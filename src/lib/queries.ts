import type { Env } from "../env";

// Read-side queries for the web API. Reads hit D1 directly from the Worker; audited
// writes (corrections, consent) go through the Durable Object RPC instead.

// The single "this row is countable spend" predicate, used everywhere money is summed so
// nothing double-counts across feed / statement / receipt sources:
//  - drop duplicates and transfers/cc-payments (status 'ignored')
//  - count bank lines + ONLY receipts that aren't matched to a line (cash / no statement)
//  - count debits (spend); credits/refunds are stored but excluded.
export const COUNTABLE =
  "status NOT IN ('duplicate','ignored') " +
  "AND (kind = 'bank_line' OR (kind = 'receipt' AND matched_txn_id IS NULL)) " +
  "AND COALESCE(direction,'debit') = 'debit'";

export interface TxnRow {
  id: string;
  source: string;
  status: string;
  merchant: string | null;
  amount_cents: number | null;
  currency: string | null;
  amount_aud_cents: number | null;
  fx_rate: number | null;
  fx_date: string | null;
  gst_cents: number | null;
  txn_date: string | null;
  bucket: string | null;
  ato_label: string | null;
  property_id: string | null;
  paid_account: string | null;
  confidence: number | null;
  reasoning: string | null;
  duplicate_of: string | null;
  kind: string;
  account_id: string | null;
  statement_id: string | null;
  matched_txn_id: string | null;
  direction: string | null;
  raw_description: string | null;
  ledger_ref: string | null;
  created_at: string;
}

// Columns returned for transaction reads (kept in one place so list + detail agree).
const TXN_COLS =
  "id, source, status, merchant, amount_cents, currency, amount_aud_cents, fx_rate, fx_date, " +
  "gst_cents, txn_date, bucket, ato_label, property_id, paid_account, confidence, reasoning, " +
  "duplicate_of, kind, account_id, statement_id, matched_txn_id, direction, raw_description, " +
  "ledger_ref, created_at";

export async function listTransactions(
  env: Env,
  userId: string,
  opts: { status?: string; bucket?: string; limit?: number } = {},
): Promise<TxnRow[]> {
  const where: string[] = ["user_id = ?"];
  const binds: unknown[] = [userId];
  if (opts.status) {
    where.push("status = ?");
    binds.push(opts.status);
  }
  if (opts.bucket) {
    where.push("bucket = ?");
    binds.push(opts.bucket);
  }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  // Low-confidence + needs-review first, then newest.
  const res = await env.DB.prepare(
    `SELECT ${TXN_COLS}
       FROM transactions WHERE ${where.join(" AND ")}
      ORDER BY (confidence IS NULL) DESC, confidence ASC, created_at DESC
      LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<TxnRow>();
  return res.results ?? [];
}

export async function getTransaction(env: Env, userId: string, id: string) {
  const txn = await env.DB.prepare(
    `SELECT ${TXN_COLS}, receipt_key
       FROM transactions WHERE id = ? AND user_id = ?`,
  )
    .bind(id, userId)
    .first<TxnRow & { receipt_key: string | null }>();
  if (!txn) return null;
  const corr = await env.DB.prepare(
    `SELECT field, old_value, new_value, created_at FROM corrections
      WHERE txn_id = ? AND user_id = ? ORDER BY created_at DESC`,
  )
    .bind(id, userId)
    .all();
  return { ...txn, corrections: corr.results ?? [] };
}

/** Look up the R2 key for a transaction, scoped to the user (prevents cross-tenant reads). */
export async function receiptKeyFor(env: Env, userId: string, txnId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT receipt_key FROM transactions WHERE id = ? AND user_id = ?`,
  )
    .bind(txnId, userId)
    .first<{ receipt_key: string | null }>();
  return row?.receipt_key ?? null;
}

export async function listAccounts(env: Env, userId: string) {
  const res = await env.DB.prepare(
    `SELECT a.id, a.institution, a.name, a.last4, a.type, a.source, a.qbo_account_id, a.created_at,
            (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id AND t.kind='bank_line') AS line_count
       FROM accounts a WHERE a.user_id = ? AND a.active = 1 ORDER BY a.created_at`,
  )
    .bind(userId)
    .all();
  return res.results ?? [];
}

export async function usageSummary(env: Env, userId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const totals = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN substr(created_at,1,10) = ? THEN cost_cents END),0) AS today_cents,
       COALESCE(SUM(CASE WHEN substr(created_at,1,7)  = ? THEN cost_cents END),0) AS month_cents,
       COUNT(*) AS calls
     FROM llm_usage WHERE user_id = ?`,
  )
    .bind(today, month, userId)
    .first<{ today_cents: number; month_cents: number; calls: number }>();
  const byFeature = await env.DB.prepare(
    `SELECT feature, COUNT(*) AS calls, COALESCE(SUM(cost_cents),0) AS cost_cents
       FROM llm_usage WHERE user_id = ? AND substr(created_at,1,7) = ?
      GROUP BY feature ORDER BY cost_cents DESC`,
  )
    .bind(userId, month)
    .all();
  return {
    today_cents: totals?.today_cents ?? 0,
    month_cents: totals?.month_cents ?? 0,
    calls: totals?.calls ?? 0,
    by_feature: byFeature.results ?? [],
  };
}

export async function listNotifications(env: Env, userId: string) {
  const res = await env.DB.prepare(
    `SELECT id, body, txn_id, read_at, created_at FROM notifications
      WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(userId)
    .all();
  return res.results ?? [];
}

export async function dashboard(env: Env, userId: string) {
  // Totals use the AUD value (falling back to the original when it's already AUD / pre-migration),
  // so mixed-currency receipts never sum incorrectly. Duplicates are excluded.
  const byBucket = await env.DB.prepare(
    `SELECT bucket, COUNT(*) AS n, COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total_cents
       FROM transactions WHERE user_id = ? AND bucket IS NOT NULL AND ${COUNTABLE}
      GROUP BY bucket ORDER BY total_cents DESC`,
  )
    .bind(userId)
    .all();
  const byProperty = await env.DB.prepare(
    `SELECT t.property_id, p.label, COUNT(*) AS n,
            COALESCE(SUM(COALESCE(t.amount_aud_cents, t.amount_cents)),0) AS total_cents
       FROM transactions t LEFT JOIN properties p ON p.id = t.property_id
      WHERE t.user_id = ? AND t.property_id IS NOT NULL AND ${COUNTABLE.replace(/\b(status|kind|matched_txn_id|direction)\b/g, "t.$1")}
      GROUP BY t.property_id`,
  )
    .bind(userId)
    .all();
  const needsReview = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM transactions
      WHERE user_id = ? AND status NOT IN ('duplicate','ignored','matched_receipt')
        AND (status IN ('needs_review','needs_extraction','blocked_consent') OR bucket = 'unknown' OR confidence < 0.85)`,
  )
    .bind(userId)
    .first<{ n: number }>();
  return {
    by_bucket: byBucket.results ?? [],
    by_property: byProperty.results ?? [],
    needs_review: needsReview?.n ?? 0,
  };
}
