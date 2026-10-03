// Bank-data minimisation (first-timer spec A5 ticket a, #581; owner rulings #534 + spec residual Q1).
//
// Hold the least bank data that still gives the user everything their return needs:
//   * every CREDIT — kept;
//   * every debit that is relevant / worth a look / unsorted / confirmed deductible / LINKED to anything — kept;
//   * an IRRELEVANT debit (private payg spend stamped likely_not / confirmed_not, or an ignored own-account
//     transfer / card repayment) linked to nothing — kept until its FY is lodged AND it has been held 60 days
//     (whichever is later), then DELETED and folded into a per-account / per-statement / per-FY rollup, with its
//     fingerprint kept as a tombstone so a statement re-upload or a feed re-sync can never revive it.
//
// "Lodged" is NOT re-derived here. The single rule lives in fy-signoff.ts (lodged_at set, or a NOA close) and
// the retention reading of it — including the owner's backstop (self-lodger due date + 60 days when the user
// never marks the year) — in lodging-year.ts, with timing from the tenant's RESOLVED rule pack. This module only
// composes it with the per-line 60-day hold.
//
// Shrunk rows never reach the POSITION: COUNTABLE drops status 'ignored', and position_excludes_nondeductible drops
// likely_not / confirmed_not payg — so minimiseTenant refuses to run unless that flag is ON. The position and every
// accountant tie-back are unchanged (golden pft10). By design, a LODGED FY's descriptive "not claimed" detail
// (report by_bucket payg n/total, the accountant schedule's explicitly-not-claimed lines, progress counts) loses
// the shrunk lines — that detail is exactly the data being minimised.
//
// Flag `bank_minimisation` (kill-switch, lands OFF): OFF ⇒ every export here is a no-op that touches neither
// 0081 table. The weekly cron, the user notice and the PS12 disconnect extension are #594.

import type { Env } from "../env";
import { featureOn } from "./features";
import { resolveRulePack } from "./report";
import { fyLabel } from "./ledger-totals";
import { fyBoundsFor, fyStartYearForDate, resolveJurisdictionForUser, type JurisdictionDescriptor } from "./jurisdiction";
import { isFyLodgedForRetention, lodgementTiming, type FySignoffState } from "./lodging-year";
import { isLiabilityAccount } from "./statements";

/** Days an irrelevant debit is held after it lands before it may shrink (the "~60 days" of #534). */
export const MIN_HOLD_DAYS = 60;

/** Rows selected per round (spec: batches of 500); each round is written in D1-sized sub-chunks. */
const SELECT_BATCH = 500;
/** Ids per IN-list. D1 caps bound parameters at 100 per statement; the widest statement below binds ids + 9. */
const ID_CHUNK = 80;

/**
 * The ONE predicate for "this transaction row may be shrunk" (alias `t` = transactions), the window aside.
 * Every clause is a reason to KEEP when it fails. Exported so a unit test can assert it never matches a credit,
 * a linked line, a relevant / worth-a-look / unsorted line, a loan account or a non-payg bucket.
 *
 * "Linked" is read broadly — a matched receipt, a refund credit pointing at it, a claim link, an attribution,
 * a claim suggestion, a capital holding, a PHI benefit, an asset, a property, a document or receipt image, a
 * payer, any positive claimable amount. Loan accounts are excluded outright: their interest lines feed
 * loan_interest_summaries (statement_parsed), which recomputeStatementLoanInterest would drop as stale.
 */
export const SHRINKABLE_WHERE = `(
  t.kind = 'bank_line'
  AND t.direction = 'debit'
  AND t.source IN ('statement', 'cdr_feed')
  AND t.account_id IS NOT NULL
  AND t.line_fingerprint IS NOT NULL
  AND t.txn_date IS NOT NULL
  AND t.amount_aud_cents IS NOT NULL
  AND (
    (t.bucket = 'payg' AND t.deductibility IN ('likely_not', 'confirmed_not') AND t.status NOT IN ('needs_review', 'needs_extraction', 'duplicate'))
    OR (t.status = 'ignored' AND (t.bucket IS NULL OR t.bucket = 'payg')
        AND (t.deductibility IS NULL OR t.deductibility IN ('undetermined', 'likely_not', 'confirmed_not')))
  )
  AND (t.relevance IS NULL OR t.relevance = 'irrelevant')
  AND COALESCE(t.reimbursed, 0) = 0
  AND COALESCE(t.deductible_amount_cents, 0) = 0
  AND COALESCE(t.gst_cents, 0) = 0
  AND t.asset_id IS NULL
  AND t.property_id IS NULL
  AND t.matched_txn_id IS NULL
  AND t.matched_income_id IS NULL
  AND t.refund_for_txn_id IS NULL
  AND t.duplicate_of IS NULL
  AND t.receipt_key IS NULL
  AND t.document_id IS NULL
  AND t.payer_person_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id AND a.user_id = t.user_id AND a.type = 'loan')
  AND NOT EXISTS (SELECT 1 FROM transactions o WHERE o.user_id = t.user_id AND (o.matched_txn_id = t.id OR o.refund_for_txn_id = t.id OR o.duplicate_of = t.id))
  AND NOT EXISTS (SELECT 1 FROM claim_links cl WHERE cl.user_id = t.user_id AND cl.txn_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM transaction_attributions ta WHERE ta.user_id = t.user_id AND ta.transaction_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM claim_suggestions cs WHERE cs.user_id = t.user_id AND cs.txn_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM cgt_assets ca WHERE ca.user_id = t.user_id AND ca.txn_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM phi_benefit_usage pb WHERE pb.user_id = t.user_id AND pb.txn_id = t.id)
)`;

export interface MinimiseAccountFy {
  account_id: string;
  fy: string;
  n: number;
  total_cents: number;
}

export interface MinimiseResult {
  shrunk: number;
  total_cents: number;
  /** One entry per (account, FY) that shrank — the audit grain (counts and totals only, no line content). */
  by_account_fy: MinimiseAccountFy[];
  /** FY labels considered lodged for retention on this run (whether or not anything shrank). */
  lodged_fys: string[];
}

export type MinimiseAudit = (event: string, detail: string) => Promise<void>;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** SQLite datetime('now') shape ('YYYY-MM-DD HH:MM:SS') for `now − days`, so `datetime(created_at) <= ?` compares. */
function holdCutoff(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}

type Row = { id: string; account_id: string; statement_id: string | null; amount_aud_cents: number; txn_date: string };

/**
 * Shrink every eligible irrelevant debit for one tenant. For each FY that is lodged for retention on `now`
 * (fy-signoff's rule or the lodging-year backstop), select shrinkable rows held ≥ MIN_HOLD_DAYS in rounds of
 * 500, and per ≤80-id chunk run ONE D1 batch (atomic): upsert the rollups, insert the tombstones, delete the
 * corrections / ai_edits / traces that carry those lines' merchant text, delete the rows. Every statement in the
 * batch re-applies the full predicate, so a line the user linked between the SELECT and the batch is simply kept
 * by all of them (counts can't drift from what was deleted). One `bank_lines_minimised` audit row per
 * (account, FY) via `audit` (the DO's hash chain). Returns null when the flag is OFF (nothing read or written).
 */
export async function minimiseTenant(
  env: Env,
  userId: string,
  now: Date = new Date(),
  opts: { audit?: MinimiseAudit; descriptor?: JurisdictionDescriptor } = {},
): Promise<MinimiseResult | null> {
  if (!featureOn(env, "bank_minimisation")) return null;
  // Safety interlock: without position_excludes_nondeductible a likely_not / confirmed_not payg row still counts in
  // the position, so shrinking it would move money. Never minimise in that configuration.
  if (!featureOn(env, "position_excludes_nondeductible")) return null;
  const descriptor = opts.descriptor ?? (await resolveJurisdictionForUser(env, userId));
  const timing = lodgementTiming(await resolveRulePack(env, userId, descriptor));
  const today = isoDay(now);
  const cutoff = holdCutoff(now, MIN_HOLD_DAYS);

  // Candidate FYs = the FYs of the dates that actually carry shrinkable rows (bounded by the data, and correct
  // for a tax period that doesn't start on the 1st — UK 6 April — which a month-level scan would get wrong).
  const dates = await env.DB.prepare(
    `SELECT DISTINCT t.txn_date AS d FROM transactions t
      WHERE t.user_id = ? AND datetime(t.created_at) <= datetime(?) AND ${SHRINKABLE_WHERE}`,
  ).bind(userId, cutoff).all<{ d: string }>();
  const fys = [...new Set((dates.results ?? []).map((r) => fyStartYearForDate(descriptor, r.d)).filter((y) => Number.isFinite(y)))].sort((a, b) => a - b);

  const signoffs = new Map<number, FySignoffState>();
  if (fys.length) {
    const rows = await env.DB.prepare(`SELECT fy, lodged_at, status, signed_off_at FROM fy_signoff WHERE user_id = ?`)
      .bind(userId)
      .all<FySignoffState & { fy: number }>();
    for (const r of rows.results ?? []) signoffs.set(Number(r.fy), r);
  }

  const result: MinimiseResult = { shrunk: 0, total_cents: 0, by_account_fy: [], lodged_fys: [] };
  for (const fy of fys) {
    if (!isFyLodgedForRetention(fy, signoffs.get(fy) ?? null, today, descriptor, timing)) continue;
    const label = fyLabel(fy);
    result.lodged_fys.push(label);
    const { start, end } = fyBoundsFor(descriptor, fy);
    const perAccount = new Map<string, MinimiseAccountFy>();

    // Rows are deleted as we go, so the same SELECT walks the remainder; a round that deletes nothing (every
    // candidate got linked under us) stops the loop rather than spinning.
    for (;;) {
      const sel = await env.DB.prepare(
        `SELECT t.id, t.account_id, t.statement_id, t.amount_aud_cents, t.txn_date FROM transactions t
          WHERE t.user_id = ? AND t.txn_date BETWEEN ? AND ? AND datetime(t.created_at) <= datetime(?) AND ${SHRINKABLE_WHERE}
          ORDER BY t.id LIMIT ${SELECT_BATCH}`,
      ).bind(userId, start, end, cutoff).all<Row>();
      const rows = sel.results ?? [];
      if (!rows.length) break;
      let deletedThisRound = 0;
      for (let i = 0; i < rows.length; i += ID_CHUNK) {
        deletedThisRound += await shrinkChunk(env, userId, rows.slice(i, i + ID_CHUNK), { start, end, cutoff, label }, perAccount);
      }
      if (deletedThisRound === 0 || rows.length < SELECT_BATCH) break;
    }

    for (const a of perAccount.values()) {
      if (a.n <= 0) continue;
      result.by_account_fy.push(a);
      result.shrunk += a.n;
      result.total_cents += a.total_cents;
      if (opts.audit) await opts.audit("bank_lines_minimised", JSON.stringify({ account_id: a.account_id, fy: a.fy, n: a.n, total_cents: a.total_cents }));
    }
  }
  return result;
}

async function shrinkChunk(
  env: Env,
  userId: string,
  rows: Row[],
  w: { start: string; end: string; cutoff: string; label: string },
  perAccount: Map<string, MinimiseAccountFy>,
): Promise<number> {
  const db = env.DB;
  const ph = (n: number) => Array.from({ length: n }, () => "?").join(",");
  // The re-checked set: ids ∩ predicate ∩ window. Binds: userId, ...ids, start, end, cutoff.
  const pick = (ids: string[], extra = "") =>
    `SELECT t.id FROM transactions t WHERE t.user_id = ? AND t.id IN (${ph(ids.length)})
       AND t.txn_date BETWEEN ? AND ? AND datetime(t.created_at) <= datetime(?) AND ${SHRINKABLE_WHERE}${extra}`;
  const pickBinds = (ids: string[]) => [userId, ...ids, w.start, w.end, w.cutoff];
  const allIds = rows.map((r) => r.id);

  // One rollup per (account, statement) in this chunk. Insert-if-absent FIRST (n = 0), then add — both by an
  // explicit `statement_id IS ?` lookup, because the UNIQUE treats NULL statement_ids (cdr_feed) as distinct.
  const groups = new Map<string, { account_id: string; statement_id: string | null; ids: string[] }>();
  for (const r of rows) {
    const k = `${r.account_id}\u0000${r.statement_id ?? ""}`;
    const g = groups.get(k) ?? { account_id: r.account_id, statement_id: r.statement_id, ids: [] };
    g.ids.push(r.id);
    groups.set(k, g);
  }
  const stmts: D1PreparedStatement[] = [];
  for (const g of groups.values()) {
    stmts.push(
      db.prepare(
        `INSERT INTO bank_line_rollups (id, user_id, account_id, statement_id, fy, direction, n, total_cents)
         SELECT ?, ?, ?, ?, ?, 'debit', 0, 0
          WHERE NOT EXISTS (SELECT 1 FROM bank_line_rollups
                             WHERE user_id = ? AND account_id = ? AND statement_id IS ? AND fy = ? AND direction = 'debit')`,
      ).bind(crypto.randomUUID(), userId, g.account_id, g.statement_id, w.label, userId, g.account_id, g.statement_id, w.label),
    );
    stmts.push(
      db.prepare(
        `UPDATE bank_line_rollups
            SET n = n + s.c,
                total_cents = total_cents + s.tot,
                first_date = CASE WHEN s.lo IS NULL THEN first_date WHEN first_date IS NULL OR s.lo < first_date THEN s.lo ELSE first_date END,
                last_date  = CASE WHEN s.hi IS NULL THEN last_date  WHEN last_date  IS NULL OR s.hi > last_date  THEN s.hi ELSE last_date  END,
                updated_at = datetime('now')
           FROM (SELECT COUNT(*) AS c, COALESCE(SUM(x.amount_aud_cents), 0) AS tot, MIN(x.txn_date) AS lo, MAX(x.txn_date) AS hi
                   FROM transactions x WHERE x.user_id = ? AND x.id IN (${pick(g.ids)})) AS s
          WHERE bank_line_rollups.user_id = ? AND bank_line_rollups.account_id = ? AND bank_line_rollups.statement_id IS ?
            AND bank_line_rollups.fy = ? AND bank_line_rollups.direction = 'debit' AND s.c > 0`,
      ).bind(userId, ...pickBinds(g.ids), userId, g.account_id, g.statement_id, w.label),
    );
  }
  stmts.push(
    db.prepare(
      `INSERT OR IGNORE INTO bank_line_tombstones (user_id, account_id, line_fingerprint, fy, statement_id)
       SELECT x.user_id, x.account_id, x.line_fingerprint, ?, x.statement_id FROM transactions x WHERE x.user_id = ? AND x.id IN (${pick(allIds)})`,
    ).bind(w.label, userId, ...pickBinds(allIds)),
  );
  // The merchant text being minimised also lives in the per-txn correction log, model traces and notifications.
  for (const [table, col] of [["corrections", "txn_id"], ["traces", "txn_id"], ["notifications", "txn_id"]] as const) {
    stmts.push(db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND ${col} IN (${pick(allIds)})`).bind(userId, ...pickBinds(allIds)));
  }
  stmts.push(db.prepare(`DELETE FROM transactions WHERE user_id = ? AND id IN (${pick(allIds)})`).bind(userId, ...pickBinds(allIds)));
  const res = await db.batch(stmts);
  const deleted = Number(res[res.length - 1]?.meta?.changes ?? 0);
  if (deleted === 0) return 0;

  // Attribute the audit totals to the rows that are actually gone (a row linked under us survived the batch).
  const survivors = new Set(
    ((await db.prepare(`SELECT id FROM transactions WHERE user_id = ? AND id IN (${ph(allIds.length)})`).bind(userId, ...allIds).all<{ id: string }>()).results ?? []).map((r) => r.id),
  );
  for (const r of rows) {
    if (survivors.has(r.id)) continue;
    const a = perAccount.get(r.account_id) ?? { account_id: r.account_id, fy: w.label, n: 0, total_cents: 0 };
    a.n += 1;
    a.total_cents += r.amount_aud_cents;
    perAccount.set(r.account_id, a);
  }
  return deleted;
}

/**
 * The fingerprints tombstoned on one account — merged into confirmImport's `seen` set so a re-uploaded (or
 * overlapping) statement skips a shrunk line exactly like a line already on file. Empty when the flag is OFF
 * (the table is never read, so a tenant whose 0081 isn't applied is unaffected).
 */
export async function tombstonedFingerprints(env: Env, userId: string, accountId: string): Promise<string[]> {
  if (!featureOn(env, "bank_minimisation")) return [];
  const r = await env.DB.prepare(`SELECT line_fingerprint FROM bank_line_tombstones WHERE user_id = ? AND account_id = ?`)
    .bind(userId, accountId)
    .all<{ line_fingerprint: string }>();
  return (r.results ?? []).map((x) => x.line_fingerprint);
}

/**
 * "Remove + re-import" (deleteStatement with purge) forgets a statement's minimisation too: its rollups and the
 * tombstones of its lines go with it, so the re-upload re-imports those lines as fresh rows (which re-shrink on a
 * later run) instead of being silently skipped and leaving the new statement short of its row count with the
 * rollup orphaned on the deleted id. No-op when OFF (neither table is touched).
 */
export async function forgetStatementMinimisation(env: Env, userId: string, statementId: string): Promise<void> {
  if (!featureOn(env, "bank_minimisation")) return;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM bank_line_rollups WHERE user_id = ? AND statement_id = ?`).bind(userId, statementId),
    env.DB.prepare(`DELETE FROM bank_line_tombstones WHERE user_id = ? AND statement_id = ?`).bind(userId, statementId),
  ]);
}

/**
 * Lines of one statement that were shrunk into rollups — added to the statement's posted line count
 * (confirmImport's imported_count, repairStatements' "actual") so a minimised statement still reads as complete
 * and the repair job never mistakes shrunk lines for dropped ones and re-imports the statement. 0 when OFF.
 */
export async function rolledUpLineCount(env: Env, userId: string, statementId: string): Promise<number> {
  if (!featureOn(env, "bank_minimisation")) return 0;
  const r = await env.DB.prepare(`SELECT COALESCE(SUM(n), 0) AS n FROM bank_line_rollups WHERE user_id = ? AND statement_id = ?`)
    .bind(userId, statementId)
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

export interface StatementLedgerTieOut {
  /** Live bank lines still on file for the statement. */
  lines: number;
  /** Lines folded into rollups. */
  rolled_up: number;
  /** opening + Σ signed live lines + Σ signed rollups (liability accounts flip the sign, like reconcileStatement). */
  expected_cents: number | null;
  closing_cents: number | null;
  diff_cents: number | null;
  ok: boolean | null;
}

/**
 * Re-prove a statement's balance from the LEDGER (live rows + rollups) rather than the parse-time sidecar: after a
 * shrink, opening + every live line + the rollup totals must still land on the closing balance. Uses the same
 * sign convention as statements.ts reconcileStatement (asset: credit +, debit −; liability: flipped). `ok` null
 * when the statement carries no balances. Rollups are included only with the flag ON.
 */
export async function statementLedgerTieOut(env: Env, userId: string, statementId: string): Promise<StatementLedgerTieOut | null> {
  const s = await env.DB.prepare(
    `SELECT s.opening_cents, s.closing_cents, a.type AS account_type
       FROM statements s LEFT JOIN accounts a ON a.id = s.account_id AND a.user_id = s.user_id
      WHERE s.id = ? AND s.user_id = ?`,
  ).bind(statementId, userId).first<{ opening_cents: number | null; closing_cents: number | null; account_type: string | null }>();
  if (!s) return null;
  const live = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_cents ELSE -amount_cents END), 0) AS signed
       FROM transactions WHERE user_id = ? AND statement_id = ? AND kind = 'bank_line'`,
  ).bind(userId, statementId).first<{ n: number; signed: number }>();
  let rolled = 0;
  let rolledSigned = 0;
  if (featureOn(env, "bank_minimisation")) {
    const r = await env.DB.prepare(
      `SELECT COALESCE(SUM(n), 0) AS n,
              COALESCE(SUM(CASE WHEN direction = 'credit' THEN total_cents ELSE -total_cents END), 0) AS signed
         FROM bank_line_rollups WHERE user_id = ? AND statement_id = ?`,
    ).bind(userId, statementId).first<{ n: number; signed: number }>();
    rolled = Number(r?.n ?? 0);
    rolledSigned = Number(r?.signed ?? 0);
  }
  const lines = Number(live?.n ?? 0);
  if (s.opening_cents == null || s.closing_cents == null) {
    return { lines, rolled_up: rolled, expected_cents: null, closing_cents: s.closing_cents, diff_cents: null, ok: null };
  }
  const dir = isLiabilityAccount(s.account_type) ? -1 : 1;
  const expected = s.opening_cents + dir * (Number(live?.signed ?? 0) + rolledSigned);
  const diff = expected - s.closing_cents;
  return { lines, rolled_up: rolled, expected_cents: expected, closing_cents: s.closing_cents, diff_cents: diff, ok: Math.abs(diff) <= 1 };
}
