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
  opts: { status?: string; bucket?: string; kind?: string; limit?: number; offset?: number } = {},
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
  if (opts.kind) {
    where.push("kind = ?");
    binds.push(opts.kind);
  }
  // Matched receipts are evidence on a bank line — shown in Reconcile, not the review inbox.
  where.push("status != 'matched_receipt'");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  // Low-confidence + needs-review first, then newest.
  const res = await env.DB.prepare(
    `SELECT ${TXN_COLS}
       FROM transactions WHERE ${where.join(" AND ")}
      ORDER BY (confidence IS NULL) DESC, confidence ASC, created_at DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(...binds, limit, offset)
    .all<TxnRow>();
  return res.results ?? [];
}

/** Statements for an account (or all), with their reconcile/import status — for the Accounts page. */
export async function listStatements(env: Env, userId: string, accountId?: string) {
  const where = accountId ? "user_id = ? AND account_id = ?" : "user_id = ?";
  const binds = accountId ? [userId, accountId] : [userId];
  const res = await env.DB.prepare(
    `SELECT id, account_id, filename, format, status, row_count, imported_count, reconciled, recon_diff_cents, created_at
       FROM statements WHERE ${where} ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(...binds)
    .all();
  return res.results ?? [];
}

/** Unmatched receipts + unmatched bank lines, for the manual Reconcile page. */
export async function reconcilePairs(env: Env, userId: string) {
  const receipts = await env.DB.prepare(
    `SELECT ${TXN_COLS} FROM transactions
      WHERE user_id = ? AND kind = 'receipt' AND status NOT IN ('duplicate') AND matched_txn_id IS NULL
        AND amount_cents IS NOT NULL
      ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(userId)
    .all<TxnRow>();
  const lines = await env.DB.prepare(
    `SELECT ${TXN_COLS} FROM transactions t
      WHERE user_id = ? AND kind = 'bank_line' AND status NOT IN ('duplicate','ignored') AND direction = 'debit'
        AND id NOT IN (SELECT matched_txn_id FROM transactions WHERE user_id = ? AND matched_txn_id IS NOT NULL)
      ORDER BY txn_date DESC LIMIT 200`,
  )
    .bind(userId, userId)
    .all<TxnRow>();
  return { receipts: receipts.results ?? [], lines: lines.results ?? [] };
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

/** Income rows for the Income page, optionally scoped by FY / person / property. */
export async function listIncome(
  env: Env,
  userId: string,
  opts: { fy?: string; personId?: string; propertyId?: string } = {},
) {
  const where: string[] = ["user_id = ?"];
  const binds: unknown[] = [userId];
  if (opts.fy) {
    where.push("fy = ?");
    binds.push(opts.fy);
  }
  if (opts.personId) {
    where.push("person_id = ?");
    binds.push(opts.personId);
  }
  if (opts.propertyId) {
    where.push("property_id = ?");
    binds.push(opts.propertyId);
  }
  const res = await env.DB.prepare(
    `SELECT id, person_id, entity_id, property_id, income_type, ato_label, fy, gross_cents, net_cents,
            withholding_cents, franking_credit_cents, foreign_tax_paid_cents, currency, amount_aud_cents,
            txn_date, source_doc_id, needs_review, created_at
       FROM income WHERE ${where.join(" AND ")} ORDER BY txn_date DESC, created_at DESC LIMIT 500`,
  )
    .bind(...binds)
    .all();
  return res.results ?? [];
}

/**
 * Documents shelf. Unions the canonical `documents` registry with LEGACY receipts (tracked only
 * on transactions.receipt_key, pre-0007) so nothing disappears before the backfill — the
 * forward-only registry decision. doc_type 'receipt' (legacy) is synthesised for those rows.
 */
export async function listDocuments(env: Env, userId: string, opts: { type?: string; fy?: string; propertyId?: string } = {}) {
  const where: string[] = ["user_id = ?"];
  const binds: unknown[] = [userId];
  if (opts.type) {
    where.push("doc_type = ?");
    binds.push(opts.type);
  }
  if (opts.fy) {
    where.push("fy = ?");
    binds.push(opts.fy);
  }
  if (opts.propertyId) {
    where.push("property_id = ?");
    binds.push(opts.propertyId);
  }
  const docs = await env.DB.prepare(
    `SELECT id, doc_type, fy, property_id, entity_id, issuer, doc_date, classification_confidence,
            needs_review, created_at, r2_key
       FROM documents WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
  )
    .bind(...binds)
    .all();
  // Legacy receipts (synthesised fy=NULL, no registry row) are only meaningful in the UNFILTERED
  // view — an FY or property filter would otherwise leak unrelated receipts under the wrong scope.
  const includeLegacy = (!opts.type || opts.type === "receipt") && !opts.fy && !opts.propertyId;
  const legacy = includeLegacy
    ? await env.DB.prepare(
        `SELECT id, 'receipt' AS doc_type, NULL AS fy, property_id, NULL AS entity_id, merchant AS issuer,
                txn_date AS doc_date, confidence AS classification_confidence, 0 AS needs_review,
                created_at, receipt_key AS r2_key
           FROM transactions
          WHERE user_id = ? AND kind = 'receipt' AND receipt_key IS NOT NULL AND document_id IS NULL
          ORDER BY created_at DESC LIMIT 200`,
      )
        .bind(userId)
        .all()
    : { results: [] };
  return [...(docs.results ?? []), ...(legacy.results ?? [])];
}

/** Assets with this-FY decline-in-value joined from the schedule (for the Assets page). */
export async function listAssets(env: Env, userId: string, fy?: string) {
  const res = await env.DB.prepare(
    `SELECT a.id, a.label, a.asset_class, a.cost_cents, a.acquired_date, a.method, a.effective_life_years,
            a.property_id, a.entity_id, a.is_second_hand, a.status, a.needs_review,
            (SELECT deduction_cents FROM depreciation_schedule d WHERE d.asset_id = a.id AND d.fy = COALESCE(?, d.fy) ORDER BY d.fy DESC LIMIT 1) AS this_fy_deduction_cents,
            (SELECT closing_adjustable_value_cents FROM depreciation_schedule d WHERE d.asset_id = a.id ORDER BY d.fy DESC LIMIT 1) AS adjustable_value_cents
       FROM assets a WHERE a.user_id = ? ORDER BY a.created_at DESC LIMIT 500`,
  )
    .bind(fy ?? null, userId)
    .all();
  return res.results ?? [];
}

/** The full multi-FY schedule for one asset (for the asset detail view). */
export async function listDepreciation(env: Env, userId: string, assetId: string) {
  const res = await env.DB.prepare(
    `SELECT fy, opening_adjustable_value_cents, days_held, deduction_cents, closing_adjustable_value_cents, method_applied
       FROM depreciation_schedule WHERE user_id = ? AND asset_id = ? ORDER BY fy`,
  )
    .bind(userId, assetId)
    .all();
  return res.results ?? [];
}

/** FY checklist items (kickoff/wrap-up), newest-open first. */
export async function listChecklist(env: Env, userId: string, fy?: string) {
  const where = fy ? "user_id = ? AND fy = ?" : "user_id = ?";
  const binds = fy ? [userId, fy] : [userId];
  const res = await env.DB.prepare(
    `SELECT id, fy, item_key, title, rationale, status, trigger_bucket, due_hint, created_at
       FROM fy_checklist WHERE ${where} ORDER BY (status='open') DESC, created_at LIMIT 200`,
  )
    .bind(...binds)
    .all();
  return res.results ?? [];
}

/** Claim suggestions (GENERAL-INFO), newest open first — for the Inbox/Dashboard nudge. */
export async function listClaims(env: Env, userId: string) {
  const res = await env.DB.prepare(
    `SELECT id, txn_id, asset_id, rule_id, suggestion, claim_type, estimated_deduction_cents, status, created_at
       FROM claim_suggestions WHERE user_id = ? ORDER BY (status='suggested') DESC, created_at DESC LIMIT 100`,
  )
    .bind(userId)
    .all();
  return res.results ?? [];
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
