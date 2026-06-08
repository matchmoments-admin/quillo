import type { Env } from "../env";
import { splitAttribution } from "./attribution";

// ── Attribution writer (Phase B / G2) ─────────────────────────────────────────
// Writes transaction_attributions (who-claims-what) + the payer fields on a transaction. The split
// is SNAPSHOTTED here (attributed_amount_cents) via the same splitAttribution helper the reader trusts,
// so the position never has to recompute. A replace-set per transaction keeps it idempotent.

export interface AttributionInput {
  entity_id: string;
  income_activity_id?: string | null;
  attributed_pct?: number | null;          // XOR amount; the owner/work split. default 100%
  attributed_amount_cents?: number | null; // explicit override of the snapshot
  work_use_pct?: number | null;
  deduction_provision?: string | null;
}

export interface PreparedAttribution {
  entity_id: string;
  income_activity_id: string | null;
  attributed_pct: number | null;
  attributed_amount_cents: number;
  work_use_pct: number | null;
  deduction_provision: string | null;
  creates_shareholder_loan: number; // 1 when an individual funds a company cost (person_funds_company)
}

/**
 * Pure: turn the UI's attribution items into the rows to persist, snapshotting each amount and
 * flagging the shareholder-loan case. Validates that the split doesn't over-claim the transaction.
 * `isCompany` decides whether a target entity is a company (→ the person funds it → a shareholder
 * loan, never a Div 7A deemed dividend, because the direction is person→company). Returns an error
 * string instead of throwing so the API can answer 400 cleanly.
 */
export function prepareAttributions(
  txnAmountCents: number,
  items: AttributionInput[],
  ctx: { isCompany: (entityId: string) => boolean },
): { rows: PreparedAttribution[]; error?: string } {
  if (!items.length) return { rows: [] };
  let pctSum = 0;
  const rows: PreparedAttribution[] = [];
  for (const it of items) {
    if (!it.entity_id) return { rows: [], error: "each attribution needs an entity_id" };
    // pct XOR amount: an explicit amount WINS and the pct is cleared (so a stray pct alongside an
    // amount can't be double-counted into pctSum — review #4).
    const hasExplicitAmount = it.attributed_amount_cents != null;
    if (it.attributed_pct != null && !hasExplicitAmount) {
      if (it.attributed_pct < 0 || it.attributed_pct > 100) return { rows: [], error: `attributed_pct ${it.attributed_pct} is outside 0–100` };
      pctSum += it.attributed_pct;
    }
    const amount = hasExplicitAmount ? (it.attributed_amount_cents as number) : splitAttribution({ amount_cents: txnAmountCents, owner_share_pct: it.attributed_pct, work_use_pct: it.work_use_pct });
    // Attributions are positive claims on a spend; a negative amount is never valid and would otherwise
    // slip past a sign-naive sum guard (review #1).
    if (amount < 0) return { rows: [], error: "an attributed amount can't be negative" };
    rows.push({
      entity_id: it.entity_id,
      income_activity_id: it.income_activity_id ?? null,
      attributed_pct: hasExplicitAmount ? null : (it.attributed_pct ?? null),
      attributed_amount_cents: amount,
      work_use_pct: it.work_use_pct ?? null,
      deduction_provision: it.deduction_provision ?? null,
      // An individual paying a company's cost funds the company → a loan FROM the person TO the
      // company (person_funds_company). That direction is NEVER the Div 7A risk (company→person is).
      creates_shareholder_loan: ctx.isCompany(it.entity_id) ? 1 : 0,
    });
  }
  if (pctSum > 100.0001) return { rows: [], error: `attributed percentages sum to ${pctSum}%, over 100%` };
  // amounts are all non-negative now, so a plain sum vs the transaction magnitude is a sound guard.
  const amtSum = rows.reduce((s, r) => s + r.attributed_amount_cents, 0);
  if (amtSum > Math.abs(txnAmountCents) + rows.length) return { rows: [], error: `attributed amounts (${amtSum}) exceed the transaction (${Math.abs(txnAmountCents)})` };
  return { rows };
}

/** Read a transaction's attributions + payer fields (for the UI panel). */
export async function getAttributions(env: Env, userId: string, txnId: string) {
  const payer = await env.DB.prepare(`SELECT payer_person_id, paid_via_account_id FROM transactions WHERE id = ? AND user_id = ?`)
    .bind(txnId, userId)
    .first<{ payer_person_id: string | null; paid_via_account_id: string | null }>();
  const rows = await env.DB.prepare(
    `SELECT id, entity_id, income_activity_id, attributed_pct, attributed_amount_cents, work_use_pct,
            deduction_provision, creates_shareholder_loan, shareholder_loan_id
       FROM transaction_attributions WHERE user_id = ? AND transaction_id = ? ORDER BY created_at`,
  )
    .bind(userId, txnId)
    .all();
  return { payer_person_id: payer?.payer_person_id ?? null, paid_via_account_id: payer?.paid_via_account_id ?? null, attributions: rows.results ?? [] };
}

/**
 * Replace-set a transaction's attributions + payer. Validates and snapshots via prepareAttributions,
 * then in one batch: stamp the payer fields, delete the old rows, insert the new. Returns the prepared
 * rows or a 400-style error. Idempotent (a second identical call yields the same state).
 */
export async function setAttributions(
  env: Env,
  userId: string,
  txnId: string,
  body: { payer_person_id?: string | null; paid_via_account_id?: string | null; attributions?: AttributionInput[] },
): Promise<{ ok: true; rows: PreparedAttribution[] } | { ok: false; error: string }> {
  const txn = await env.DB.prepare(`SELECT COALESCE(amount_aud_cents, amount_cents) AS amount FROM transactions WHERE id = ? AND user_id = ?`)
    .bind(txnId, userId)
    .first<{ amount: number | null }>();
  if (!txn) return { ok: false, error: "transaction not found" };
  const companyIds = new Set(
    ((await env.DB.prepare(`SELECT id FROM entities WHERE user_id = ? AND (kind = 'company' OR entity_type = 'company')`).bind(userId).all<{ id: string }>()).results ?? []).map((r) => r.id),
  );
  const prepared = prepareAttributions(txn.amount ?? 0, body.attributions ?? [], { isCompany: (eid) => companyIds.has(eid) });
  if (prepared.error) return { ok: false, error: prepared.error };
  // Partial update: only touch a payer field when its key is present in the body (so an edit that
  // only adjusts the split doesn't silently null a previously-saved payer — review #2), and only
  // replace the attribution set when `attributions` was provided.
  const stmts = [];
  if ("payer_person_id" in body) stmts.push(env.DB.prepare(`UPDATE transactions SET payer_person_id = ? WHERE id = ? AND user_id = ?`).bind(body.payer_person_id ?? null, txnId, userId));
  if ("paid_via_account_id" in body) stmts.push(env.DB.prepare(`UPDATE transactions SET paid_via_account_id = ? WHERE id = ? AND user_id = ?`).bind(body.paid_via_account_id ?? null, txnId, userId));
  if (body.attributions !== undefined) {
    stmts.push(env.DB.prepare(`DELETE FROM transaction_attributions WHERE user_id = ? AND transaction_id = ?`).bind(userId, txnId));
    for (const r of prepared.rows) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO transaction_attributions (id, user_id, transaction_id, entity_id, income_activity_id,
             attributed_pct, attributed_amount_cents, work_use_pct, deduction_provision, creates_shareholder_loan)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), userId, txnId, r.entity_id, r.income_activity_id, r.attributed_pct, r.attributed_amount_cents, r.work_use_pct, r.deduction_provision, r.creates_shareholder_loan),
      );
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  // Keep the persisted shareholder-loan balances in lockstep with the attributions just written.
  if (body.attributions !== undefined) await syncShareholderLoans(env, userId);
  return { ok: true, rows: prepared.rows };
}

/** Clear all attributions for a transaction (and its payer fields). */
export async function clearAttributions(env: Env, userId: string, txnId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM transaction_attributions WHERE user_id = ? AND transaction_id = ?`).bind(userId, txnId),
    env.DB.prepare(`UPDATE transactions SET payer_person_id = NULL, paid_via_account_id = NULL WHERE id = ? AND user_id = ?`).bind(txnId, userId),
  ]);
  await syncShareholderLoans(env, userId);
}

/**
 * Phase C / G4: recompute the person→company shareholder-loan balances from the attribution rows that
 * flagged creates_shareholder_loan, and persist them (direction = person_funds_company — the benign,
 * non-Div-7A direction). Recompute-from-source so it's idempotent. Leaves any company_loans_person rows
 * (the Div 7A risk direction, entered separately) untouched. The report computes the balance from source
 * too; this table is the persisted record for the hand-off + future Division 7A tracking.
 */
export async function syncShareholderLoans(env: Env, userId: string): Promise<void> {
  const selfPerson = `person_self_${userId}`;
  // SAME filter as companyPositions' loan query (countable, reimbursed-excluded) so the persisted
  // balance and the on-screen report figure agree. Cumulative (all-time) — a loan is a running balance.
  const rows = (await env.DB.prepare(
    `SELECT ta.entity_id AS company, COALESCE(t.payer_person_id, ?) AS person, COALESCE(SUM(ta.attributed_amount_cents),0) AS bal
       FROM transaction_attributions ta
       JOIN transactions t ON t.id = ta.transaction_id AND t.user_id = ta.user_id
      WHERE ta.user_id = ? AND ta.creates_shareholder_loan = 1 AND COALESCE(t.reimbursed,0) = 0
        AND t.status NOT IN ('duplicate','ignored')
        AND (t.kind = 'bank_line' OR (t.kind = 'receipt' AND t.matched_txn_id IS NULL))
        AND COALESCE(t.direction,'debit') = 'debit'
      GROUP BY ta.entity_id, person`,
  ).bind(selfPerson, userId).all<{ company: string; person: string; bal: number }>()).results ?? [];
  const stmts = [env.DB.prepare(`DELETE FROM shareholder_loans WHERE user_id = ? AND direction = 'person_funds_company'`).bind(userId)];
  for (const r of rows) {
    if (r.bal <= 0) continue;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO shareholder_loans (id, user_id, company_entity_id, shareholder_person_id, direction, balance_cents)
         VALUES (?, ?, ?, ?, 'person_funds_company', ?)`,
      ).bind(crypto.randomUUID(), userId, r.company, r.person, r.bal),
    );
  }
  await env.DB.batch(stmts);
}
