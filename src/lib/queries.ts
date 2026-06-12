import type { Env } from "../env";
import { enabledFeatures, featureOn } from "./features";
import { billingPolicy, billableCents } from "./billing";
import { getProfile } from "./db";
import { isAdmin, isPartner } from "./roles";
import { fyBounds, normaliseFyLabel } from "./ledger-totals";
import { resolveJurisdictionForUser, fyStartYearSqlExpr } from "./jurisdiction";
import { annualiseSpendCents, runRateCopy, ADVISORY_DISCLAIMER } from "./advisory";
import { matchEnergyOffer, ctaFromOffer, opportunityTakesEnergyCta, type PartnerDB } from "./partners";

// Read-side queries for the web API. Reads hit D1 directly from the Worker; audited
// writes (corrections, consent) go through the Durable Object RPC instead.

// The single "this row is countable spend" predicate, used everywhere money is summed so
// nothing double-counts across feed / statement / receipt sources:
//  - drop duplicates and transfers/cc-payments (status 'ignored')
//  - count bank lines + ONLY receipts that aren't matched to a line (cash / no statement)
//  - count debits (spend); credits/refunds are stored but excluded.
// A foreign-currency row we couldn't convert to AUD (currency != AUD AND amount_aud_cents IS NULL)
// has no trustworthy AUD value — it's flagged needs_review and must be EXCLUDED from every money sum
// (never summed 1:1 as if it were AUD). Surfaced separately so the excluded money stays visible.
export const FX_CONVERTED = "NOT (COALESCE(currency,'AUD') <> 'AUD' AND amount_aud_cents IS NULL)";

export const COUNTABLE =
  "status NOT IN ('duplicate','ignored') " +
  "AND (kind = 'bank_line' OR (kind = 'receipt' AND matched_txn_id IS NULL)) " +
  "AND COALESCE(direction,'debit') = 'debit' " +
  `AND ${FX_CONVERTED}`;

// The income counterpart of COUNTABLE: same dedup/transfer exclusions, but the CREDIT side
// (money in). Reported separately from the `income` table (document-sourced income); the two
// are de-duplicated in a later phase, so credit income is shown as its own section, not folded
// into the headline income total yet.
export const COUNTABLE_INCOME =
  "status NOT IN ('duplicate','ignored') " +
  "AND (kind = 'bank_line' OR (kind = 'receipt' AND matched_txn_id IS NULL)) " +
  "AND direction = 'credit' " +
  `AND ${FX_CONVERTED}`;

// Rows that warrant the user's attention — defined ONCE so the Dashboard "needs review" counter
// and the Inbox "Needs review" tab can't drift (previously the dashboard counted unknown/low-conf
// rows the inbox tab — filtering only status='needs_review' — never surfaced, so a "882 needs
// review" badge sat next to an empty queue).
export const NEEDS_REVIEW =
  "status NOT IN ('duplicate','ignored','matched_receipt') " +
  "AND (status IN ('needs_review','needs_extraction','blocked_consent') OR bucket = 'unknown' OR confidence < 0.85)";

// "This row can't be assigned to any FY" — a NULL or non-ISO txn_date. Defined here (the shared
// query module) so the dashboard's undated chip, the progress "to date" count and the report's
// `undated` section all read the SAME predicate and can never drift. (progress.ts imports it.)
export const UNDATED_CLAUSE =
  "(txn_date IS NULL OR txn_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')";

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
  reimbursed: number | null;
  created_at: string;
}

// Columns returned for transaction reads (kept in one place so list + detail agree).
const TXN_COLS =
  "id, source, status, merchant, amount_cents, currency, amount_aud_cents, fx_rate, fx_date, " +
  "gst_cents, txn_date, bucket, ato_label, property_id, paid_account, confidence, reasoning, " +
  "duplicate_of, kind, account_id, statement_id, matched_txn_id, direction, raw_description, " +
  "ledger_ref, COALESCE(reimbursed,0) AS reimbursed, created_at";

export async function listTransactions(
  env: Env,
  userId: string,
  opts: { status?: string; bucket?: string; property_id?: string; kind?: string; review?: boolean; fy?: number; countable?: boolean; limit?: number; offset?: number } = {},
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
  if (opts.property_id) {
    where.push("property_id = ?");
    binds.push(opts.property_id);
  }
  if (opts.kind) {
    where.push("kind = ?");
    binds.push(opts.kind);
  }
  // FY scope — used by the Dashboard drill-through so the line list matches the FY-scoped figure the
  // user clicked. Date-bound (NOT the COUNTABLE predicate) so undated rows fall out, exactly like the
  // dashboard totals, which surface undated separately.
  if (opts.fy != null) {
    const { start, end } = fyBounds(opts.fy, await resolveJurisdictionForUser(env, userId));
    where.push("txn_date >= ? AND txn_date <= ?");
    binds.push(start, end);
  }
  // Drop duplicates / excluded movements so a drill-through count reconciles with the dashboard total
  // (which is COUNTABLE/COUNTABLE_INCOME). Direction isn't constrained here so it works for both spend
  // (debit) and income (credit) buckets.
  if (opts.countable) where.push("status NOT IN ('duplicate','ignored')");
  // "Needs review" queue: the SAME predicate the dashboard counts, so the badge and the list agree.
  if (opts.review) where.push(`(${NEEDS_REVIEW})`);
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

// ── Ask Quillo C3: the FY transaction digest (flag ask_actions) ───────────────
// A bounded slice of the tenant's countable FY spend, ordered by FIXABILITY — the rows the model can
// usefully propose actions on come first (undetermined → needs_apportionment → likely_not), with
// needs_review and bigger amounts ahead within each band. The model only ever sees these rows via
// short aliases (renderTxnDigest), so a proposal can only reference what was actually shown.
export interface AskDigestRow {
  id: string;
  txn_date: string | null;
  merchant: string | null;
  amount_aud_cents: number;
  bucket: string | null;
  ato_label: string | null;
  deductibility: string | null;
  property_id: string | null;
}

export async function fetchAskDigestRows(
  env: Env,
  userId: string,
  fyStartYear: number,
  cap = 200,
): Promise<{ rows: AskDigestRow[]; total: number }> {
  const { start, end } = fyBounds(fyStartYear, await resolveJurisdictionForUser(env, userId));
  const where = `user_id = ? AND txn_date >= ? AND txn_date <= ? AND bucket IS NOT NULL AND ${COUNTABLE}`;
  const res = await env.DB.prepare(
    `SELECT id, txn_date, merchant, COALESCE(amount_aud_cents, amount_cents) AS amount_aud_cents,
            bucket, ato_label, deductibility, property_id
       FROM transactions WHERE ${where}
      ORDER BY CASE COALESCE(deductibility,'undetermined')
                 WHEN 'undetermined' THEN 0
                 WHEN 'needs_apportionment' THEN 1
                 WHEN 'likely_not' THEN 2
                 ELSE 3 END,
               CASE WHEN status = 'needs_review' THEN 0 ELSE 1 END,
               ABS(COALESCE(amount_aud_cents, amount_cents)) DESC
      LIMIT ?`,
  )
    .bind(userId, start, end, cap)
    .all<AskDigestRow>();
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${where}`)
    .bind(userId, start, end)
    .first<{ n: number }>();
  return { rows: res.results ?? [], total: count?.n ?? 0 };
}

/** Statements for an account (or all), with their reconcile/import status — for the Accounts page. */
export async function listStatements(env: Env, userId: string, accountId?: string) {
  const where = accountId ? "s.user_id = ? AND s.account_id = ?" : "s.user_id = ?";
  const binds = accountId ? [userId, accountId] : [userId];
  // total_lines / categorised_count drive the live "X / N categorised" progress while an async
  // batch fills in: a bank line is "done" once it's 'extracted' (categorised) or 'ignored'
  // (transfer); 'needs_review' lines are still pending. One cheap aggregate join — no new columns.
  const res = await env.DB.prepare(
    `SELECT s.id, s.account_id, s.filename, s.format, s.status, s.row_count, s.imported_count,
            s.reconciled, s.recon_diff_cents, s.created_at,
            COUNT(t.id) AS total_lines,
            COALESCE(SUM(CASE WHEN t.status IN ('extracted', 'ignored') THEN 1 ELSE 0 END), 0) AS categorised_count
       FROM statements s
       LEFT JOIN transactions t
         ON t.statement_id = s.id AND t.user_id = s.user_id AND t.kind = 'bank_line'
      WHERE ${where}
      GROUP BY s.id
      ORDER BY s.created_at DESC LIMIT 50`,
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
            a.interest_rate_pct, a.balance_cents,
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
    // cost_e4 is the exact integer cost (1e-4 cent units); SUM integers, divide to cents once.
    `SELECT
       COALESCE(SUM(CASE WHEN substr(created_at,1,10) = ? THEN cost_e4 END),0)/10000.0 AS today_cents,
       COALESCE(SUM(CASE WHEN substr(created_at,1,7)  = ? THEN cost_e4 END),0)/10000.0 AS month_cents,
       COUNT(*) AS calls
     FROM llm_usage WHERE user_id = ?`,
  )
    .bind(today, month, userId)
    .first<{ today_cents: number; month_cents: number; calls: number }>();
  const byFeature = await env.DB.prepare(
    `SELECT feature, COUNT(*) AS calls, COALESCE(SUM(cost_e4),0)/10000.0 AS cost_cents
       FROM llm_usage WHERE user_id = ? AND substr(created_at,1,7) = ?
      GROUP BY feature ORDER BY cost_cents DESC`,
  )
    .bind(userId, month)
    .all();
  // Per Australian financial year (1 Jul–30 Jun): a row's FY-start year is its calendar year, minus
  // one if the month is Jan–Jun. Grouped here for the tax-time billing rollup (uses the existing
  // (user_id, created_at) index). billable = measured cost marked up by the env pricing policy —
  // display only today (see lib/billing.ts). NOTE: the boundary is computed on the UTC created_at, so
  // usage in the ~10h window after AEST midnight on 1 Jul lands in the prior FY; acceptable for a
  // display rollup, but apply a proper AU-local offset before this drives a real charge.
  const policy = billingPolicy(env);
  const fyStartExpr = fyStartYearSqlExpr(await resolveJurisdictionForUser(env, userId), "created_at");
  const byFyRows = await env.DB.prepare(
    `SELECT ${fyStartExpr} AS fy_start,
            COUNT(*) AS calls, COALESCE(SUM(cost_e4),0)/10000.0 AS cost_cents
       FROM llm_usage WHERE user_id = ?
      GROUP BY fy_start ORDER BY fy_start DESC`,
  )
    .bind(userId)
    .all<{ fy_start: number; calls: number; cost_cents: number }>();
  const by_fy = (byFyRows.results ?? []).map((r) => ({
    fy: `${r.fy_start}-${String((r.fy_start + 1) % 100).padStart(2, "0")}`, // e.g. "2025-26"
    calls: r.calls,
    cost_cents: r.cost_cents,
    billable_cents: billableCents(r.cost_cents, policy.markupPct, policy.appFeeCents),
  }));
  return {
    today_cents: totals?.today_cents ?? 0,
    month_cents: totals?.month_cents ?? 0,
    calls: totals?.calls ?? 0,
    by_feature: byFeature.results ?? [],
    by_fy,
    markup_pct: policy.markupPct,
    app_fee_cents: policy.appFeeCents,
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
  // fy_checklist.fy is the canonical LABEL ('2025-26'); normalise whatever the caller passed (a label,
  // a start year, or '2025') so a non-label query param can't silently match nothing.
  const nf = normaliseFyLabel(fy);
  const where = nf ? "user_id = ? AND fy = ?" : "user_id = ?";
  const binds = nf ? [userId, nf] : [userId];
  const res = await env.DB.prepare(
    `SELECT id, fy, item_key, title, rationale, status, trigger_bucket, due_hint, created_at
       FROM fy_checklist WHERE ${where} ORDER BY (status='open') DESC, created_at LIMIT 200`,
  )
    .bind(...binds)
    .all();
  return res.results ?? [];
}

/** Transactions positively SUGGESTED as deductible (Stage D) — confirm-required, FY-scoped. */
export async function listSuggestedDeductions(env: Env, userId: string, startYear: number) {
  const { start, end } = fyBounds(startYear, await resolveJurisdictionForUser(env, userId));
  const res = await env.DB.prepare(
    `SELECT id, merchant, ato_label, amount_cents, amount_aud_cents, txn_date
       FROM transactions
      WHERE user_id = ? AND deductibility = 'suggested_deductible' AND ${COUNTABLE}
        AND txn_date >= ? AND txn_date <= ?
      ORDER BY COALESCE(amount_aud_cents, amount_cents) DESC LIMIT 200`,
  )
    .bind(userId, start, end)
    .all<{ id: string; merchant: string | null; ato_label: string | null; amount_cents: number | null; amount_aud_cents: number | null; txn_date: string | null }>();
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

export async function dashboard(env: Env, userId: string, startYear: number) {
  // Every figure is scoped to the active financial year (Jul–Jun): tax is reported per FY, so the
  // "tracked tax position" is a single-year view that follows the header FY switcher. The date
  // bounds are appended to each query (NOT baked into the COUNTABLE predicate) so the by_property
  // column-aliasing replace below stays isolated. Undated rows (no FY) are reported separately so
  // FY-scoping never silently hides them.
  const { start, end } = fyBounds(startYear, await resolveJurisdictionForUser(env, userId));
  // The MONEY figures (tracked total, by-property, income) are scoped to the active FY — bounds are
  // appended per-query (NOT into the COUNTABLE predicate) so the by_property column-aliasing replace
  // below stays isolated. `needs_review` is deliberately ALL-TIME: it's the review-queue backlog and
  // must match the Inbox (which isn't FY-scoped) and the all-time NextAction spine. Undated rows
  // (no FY) are reported separately so FY-scoping the totals never silently hides them. The reads are
  // independent → run them concurrently (D1 pipelines them) instead of six serial round-trips.
  const [byBucket, byProperty, incomeByBucket, needsReview, undated, profile] = await Promise.all([
    // Totals use the AUD value (falling back to the original when it's already AUD / pre-migration),
    // so mixed-currency receipts never sum incorrectly. Duplicates are excluded.
    env.DB.prepare(
      `SELECT bucket, COUNT(*) AS n, COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total_cents
         FROM transactions WHERE user_id = ? AND bucket IS NOT NULL AND ${COUNTABLE}
          AND txn_date >= ? AND txn_date <= ?
        GROUP BY bucket ORDER BY total_cents DESC`,
    )
      .bind(userId, start, end)
      .all(),
    env.DB.prepare(
      `SELECT t.property_id, p.label, COUNT(*) AS n,
              COALESCE(SUM(COALESCE(t.amount_aud_cents, t.amount_cents)),0) AS total_cents
         FROM transactions t LEFT JOIN properties p ON p.id = t.property_id
        WHERE t.user_id = ? AND t.property_id IS NOT NULL AND ${COUNTABLE.replace(/\b(status|kind|matched_txn_id|direction|currency|amount_aud_cents)\b/g, "t.$1")}
          AND t.txn_date >= ? AND t.txn_date <= ?
        GROUP BY t.property_id`,
    )
      .bind(userId, start, end)
      .all(),
    // Income from bank credits, grouped by income bucket (separate from the document-sourced
    // `income` table — see COUNTABLE_INCOME). 'refund' is excluded: it nets against spend.
    // NOTE: dedupe (matched_income_id) is intentionally NOT applied here — the dashboard shows this
    // credit glance WITHOUT the income table beside it, so hiding matched credits would make income
    // look like it vanished. De-dup is applied in the formal Report, where both sections coexist.
    env.DB.prepare(
      `SELECT bucket, COUNT(*) AS n, COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total_cents
         FROM transactions WHERE user_id = ? AND bucket IN ('income_business','income_property','income_personal') AND ${COUNTABLE_INCOME}
          AND txn_date >= ? AND txn_date <= ?
        GROUP BY bucket ORDER BY total_cents DESC`,
    )
      .bind(userId, start, end)
      .all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND ${NEEDS_REVIEW}`)
      .bind(userId)
      .first<{ n: number }>(),
    // Undated countable spend (belongs to no FY) — surfaced as an actionable chip so the FY totals
    // above can be trusted as complete-for-the-year. Same predicate as the report's `undated` section.
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total_cents
         FROM transactions WHERE user_id = ? AND ${COUNTABLE} AND ${UNDATED_CLAUSE}`,
    )
      .bind(userId)
      .first<{ n: number; total_cents: number }>(),
    getProfile(env, userId),
  ]);
  return {
    fy: startYear, // the FY these figures are scoped to (start year; label derived client-side)
    by_bucket: byBucket.results ?? [],
    income_by_bucket: incomeByBucket.results ?? [],
    by_property: byProperty.results ?? [],
    needs_review: needsReview?.n ?? 0,
    undated: { n: undated?.n ?? 0, total_cents: undated?.total_cents ?? 0 },
    features: enabledFeatures(env), // SPA gates nav/UI on the enabled flags (loaded once on mount)
    is_admin: isAdmin(profile), // gates the Admin page/nav (founder only)
    is_partner: isPartner(profile), // gates the Partner portal page/nav (partner staff only)
  };
}

// ── Savings & Opportunities advisory reads (flag: advisory_layer) ──────────────
// All FACTUAL: annualised run-rate is plain arithmetic on spend the user already gave us; recurring
// bills + opportunities are written by the deterministic detector. No projections/benchmarks/partners.

/** FY-scoped annualised spend run-rate + top spenders (factual "at this rate, ~$X/year"). */
export async function spendRunRate(env: Env, userId: string, startYear: number) {
  const { start, end } = fyBounds(startYear, await resolveJurisdictionForUser(env, userId));
  // asOf = today clamped into the FY window (a past FY annualises to its actual total; the current FY
  // extrapolates by elapsed days). String compare is safe for ISO dates.
  const today = new Date().toISOString().slice(0, 10);
  const asOf = today < start ? start : today > end ? end : today;
  const [head, top] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total_cents
         FROM transactions WHERE user_id = ? AND ${COUNTABLE} AND txn_date >= ? AND txn_date <= ?`,
    )
      .bind(userId, start, end)
      .first<{ n: number; total_cents: number }>(),
    // Top spenders grouped by stable biller_key when present, else the cleaned merchant/description.
    env.DB.prepare(
      `SELECT COALESCE(NULLIF(biller_key,''), lower(COALESCE(merchant, raw_description, ''))) AS k,
              COALESCE(MAX(merchant), MAX(raw_description)) AS label,
              COUNT(*) AS n,
              COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total_cents
         FROM transactions
        WHERE user_id = ? AND ${COUNTABLE} AND txn_date >= ? AND txn_date <= ?
          AND COALESCE(NULLIF(biller_key,''), merchant, raw_description) IS NOT NULL
        GROUP BY k HAVING k <> '' ORDER BY total_cents DESC LIMIT 8`,
    )
      .bind(userId, start, end)
      .all<{ k: string; label: string | null; n: number; total_cents: number }>(),
  ]);
  const spent = head?.total_cents ?? 0;
  const annualised = annualiseSpendCents(spent, start, end, asOf);
  return {
    fy: startYear,
    spent_cents: spent,
    items: head?.n ?? 0,
    annualised_cents: annualised,
    as_of: asOf,
    body: runRateCopy(spent, annualised, head?.n ?? 0),
    top_spenders: (top.results ?? []).map((r) => ({
      label: r.label ?? r.k,
      n: r.n,
      spent_cents: r.total_cents,
      annualised_cents: annualiseSpendCents(r.total_cents, start, end, asOf),
    })),
  };
}

/** Detected recurring bills + subscriptions (newest activity first), confirmed/early only. */
export async function listRecurringBills(env: Env, userId: string) {
  const res = await env.DB.prepare(
    `SELECT id, biller_key, label, category, cadence, typical_amount_cents, amount_variance_cents,
            annual_amount_cents, is_subscription, is_essential, occurrences, first_seen_date,
            last_seen_date, next_expected_date, status, COALESCE(pinned,0) AS pinned
       FROM recurring_bills
      WHERE user_id = ? AND status NOT IN ('dismissed','ended')
      ORDER BY pinned DESC, annual_amount_cents DESC, typical_amount_cents DESC LIMIT 100`,
  )
    .bind(userId)
    .all();
  return res.results ?? [];
}

/** Year-over-year total countable spend (this FY vs prior FY) — factual delta, no commentary. */
export async function spendYoy(env: Env, userId: string, startYear: number) {
  const jur = await resolveJurisdictionForUser(env, userId);
  const cur = fyBounds(startYear, jur);
  const prev = fyBounds(startYear - 1, jur);
  const sumFy = (b: { start: string; end: string }) =>
    env.DB.prepare(
      `SELECT COALESCE(SUM(COALESCE(amount_aud_cents, amount_cents)),0) AS total_cents
         FROM transactions WHERE user_id = ? AND ${COUNTABLE} AND txn_date >= ? AND txn_date <= ?`,
    )
      .bind(userId, b.start, b.end)
      .first<{ total_cents: number }>();
  const [thisFy, priorFy] = await Promise.all([sumFy(cur), sumFy(prev)]);
  const this_cents = thisFy?.total_cents ?? 0;
  const prior_cents = priorFy?.total_cents ?? 0;
  const delta_cents = this_cents - prior_cents;
  const delta_pct = prior_cents > 0 ? Math.round((delta_cents / prior_cents) * 1000) / 10 : null;
  return { fy: startYear, this_cents, prior_cents, delta_cents, delta_pct };
}

/** Open opportunities (factual nudges), biggest figure first. */
export async function listOpportunities(env: Env, userId: string) {
  const res = await env.DB.prepare(
    `SELECT id, opportunity_type, subject_key, fy, recurring_bill_id, category, title, body,
            amount_cents, signpost_label, signpost_url, status, created_at
       FROM opportunities
      WHERE user_id = ? AND status = 'open'
      ORDER BY amount_cents DESC, created_at DESC LIMIT 50`,
  )
    .bind(userId)
    .all();
  return res.results ?? [];
}

/** The combined "Save" surface payload: run-rate + recurring + opportunities + the standing disclaimer. */
export async function savingsOverview(env: Env, userId: string, startYear: number) {
  const [run_rate, recurring_bills, opportunities, yoy] = await Promise.all([
    spendRunRate(env, userId, startYear),
    listRecurringBills(env, userId),
    listOpportunities(env, userId),
    spendYoy(env, userId, startYear),
  ]);
  return {
    run_rate,
    recurring_bills,
    opportunities: await withEnergyCtas(env, opportunities),
    yoy,
    disclaimer: ADVISORY_DISCLAIMER,
  };
}

/**
 * Attach the Tier-1 energy partner CTA to qualifying opportunities — ONLY when advisory_partners_energy
 * is ON and a live partner offer exists. Flag OFF (prod default) ⇒ returns the rows untouched, so the
 * Save surface stays signpost-only and byte-identical. The CTA is purely additive display data; it
 * spawns nothing until the consumer clicks (POST /api/referrals).
 */
async function withEnergyCtas(env: Env, opportunities: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  if (!featureOn(env, "advisory_partners_energy")) return opportunities;
  const eligible = opportunities.some((o) => opportunityTakesEnergyCta(o as { opportunity_type?: string; category?: string }));
  if (!eligible) return opportunities;
  const offer = await matchEnergyOffer(env.DB as unknown as PartnerDB);
  if (!offer) return opportunities;
  const cta = ctaFromOffer(offer);
  return opportunities.map((o) =>
    opportunityTakesEnergyCta(o as { opportunity_type?: string; category?: string }) ? { ...o, partner_cta: cta } : o,
  );
}

/** Cross-tenant admin: every tenant with signup + activity + AI-spend summary (newest first). */
export async function listTenantsAdmin(env: Env) {
  const res = await env.DB.prepare(
    `SELECT p.user_id, p.email, p.roles, p.created_at,
            (SELECT COUNT(*) FROM transactions t WHERE t.user_id = p.user_id) AS txn_count,
            (SELECT COALESCE(SUM(cost_e4),0)/10000.0 FROM llm_usage u WHERE u.user_id = p.user_id) AS cost_cents,
            (SELECT MAX(created_at) FROM audit_log a WHERE a.user_id = p.user_id) AS last_activity
       FROM profiles p ORDER BY p.created_at DESC LIMIT 500`,
  ).all();
  return res.results ?? [];
}

/**
 * Cross-tenant admin: the referral funnel (counts per status + total revenue) and the most recent leads.
 * God-mode read (founder-only, like platformOverview) — the SCOPED partner view is the deferred portal.
 */
export async function referralFunnelAdmin(env: Env) {
  const [funnelRes, recentRes] = await Promise.all([
    env.DB.prepare(
      `SELECT r.status, COUNT(*) AS n, COALESCE(SUM(r.revenue_cents),0) AS revenue_cents
         FROM referrals r GROUP BY r.status`,
    ).all<{ status: string; n: number; revenue_cents: number }>(),
    env.DB.prepare(
      `SELECT r.referral_token, r.status, r.revenue_cents, r.created_at, r.updated_at, p.name AS partner_name
         FROM referrals r LEFT JOIN partners p ON p.id = r.partner_id
        ORDER BY r.created_at DESC LIMIT 100`,
    ).all(),
  ]);
  const funnel = funnelRes.results ?? [];
  const total = funnel.reduce((n, r) => n + r.n, 0);
  // Earned revenue = PAID only. Converted-but-unpaid is pipeline, not income; clawed_back is reversed —
  // summing across all statuses would double-count both. Per-status revenue stays in `funnel` for detail.
  const revenue_cents = funnel.filter((r) => r.status === "paid").reduce((n, r) => n + r.revenue_cents, 0);
  return { funnel, total, revenue_cents, recent: recentRes.results ?? [] };
}

/** Cross-tenant admin: platform headline metrics. */
export async function platformOverview(env: Env) {
  const day = new Date().toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const m = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM profiles) AS tenants,
       (SELECT COUNT(*) FROM profiles WHERE created_at >= datetime('now','-7 days')) AS signups_7d,
       (SELECT COUNT(*) FROM profiles WHERE created_at >= datetime('now','-30 days')) AS signups_30d,
       (SELECT COALESCE(SUM(cost_e4),0)/10000.0 FROM llm_usage WHERE substr(created_at,1,10) = ?) AS spend_today_cents,
       (SELECT COALESCE(SUM(cost_e4),0)/10000.0 FROM llm_usage WHERE substr(created_at,1,7) = ?) AS spend_month_cents,
       (SELECT COALESCE(SUM(cost_e4),0)/10000.0 FROM llm_usage) AS spend_all_cents`,
  )
    .bind(day, month)
    .first<{ tenants: number; signups_7d: number; signups_30d: number; spend_today_cents: number; spend_month_cents: number; spend_all_cents: number }>();
  return {
    tenants: m?.tenants ?? 0,
    signups_7d: m?.signups_7d ?? 0,
    signups_30d: m?.signups_30d ?? 0,
    spend_today_cents: m?.spend_today_cents ?? 0,
    spend_month_cents: m?.spend_month_cents ?? 0,
    spend_all_cents: m?.spend_all_cents ?? 0,
    daily_cap_cents: Number(env.MAX_DAILY_COST_CENTS_GLOBAL ?? 0),
  };
}

/**
 * Cross-tenant AI-spend + abuse view for the founder /admin page. One grouped pass over the last 7
 * days of llm_usage gives per-tenant today/7-day spend + the "ask" (chat/Q&A) slice + call counts;
 * we then derive, in JS, who tripped the per-tenant daily cap today and each tenant's share of the
 * global daily ceiling. Read-only, integer cost_e4 ÷ 10000 (no float drift), capped to the top
 * spenders so a large tenant base can't blow the response up. Answers "is a bad actor running up
 * spend?" at a glance — complements the pre-call budget gate, it does not replace it.
 */
export async function platformSpend(env: Env) {
  const day = new Date().toISOString().slice(0, 10);
  const perTenantCap = Number(env.MAX_DAILY_COST_CENTS ?? 0);
  const globalCeiling = Number(env.MAX_DAILY_COST_CENTS_GLOBAL ?? 0);
  const rows = await env.DB.prepare(
    `SELECT user_id,
       COALESCE(SUM(CASE WHEN substr(created_at,1,10) = ? THEN cost_e4 ELSE 0 END),0)/10000.0 AS today_cents,
       COALESCE(SUM(cost_e4),0)/10000.0 AS week_cents,
       COALESCE(SUM(CASE WHEN substr(created_at,1,10) = ? AND feature = 'ask' THEN cost_e4 ELSE 0 END),0)/10000.0 AS ask_today_cents,
       SUM(CASE WHEN substr(created_at,1,10) = ? THEN 1 ELSE 0 END) AS calls_today
       FROM llm_usage
      WHERE created_at >= datetime('now','-7 days')
      GROUP BY user_id
      ORDER BY week_cents DESC
      LIMIT 50`,
  )
    .bind(day, day, day)
    .all<{ user_id: string; today_cents: number; week_cents: number; ask_today_cents: number; calls_today: number }>();
  const spendToday = (await env.DB.prepare(`SELECT cents_e4 FROM daily_cost WHERE scope = 'global' AND day = ?`).bind(day).first<{ cents_e4: number }>())?.cents_e4 ?? 0;
  const tenants = (rows.results ?? []).map((r) => ({
    ...r,
    hit_cap_today: perTenantCap > 0 && r.today_cents >= perTenantCap,
    pct_of_global: globalCeiling > 0 ? Math.round((r.today_cents / globalCeiling) * 100) : 0,
  }));
  return {
    per_tenant_cap_cents: perTenantCap,
    global_ceiling_cents: globalCeiling,
    spend_today_global_cents: spendToday / 10000,
    flagged: tenants.filter((t) => t.hit_cap_today).length,
    tenants,
  };
}
