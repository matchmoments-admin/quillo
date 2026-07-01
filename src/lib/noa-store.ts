// Feature B1 (noa_capture, #71/#304): storage + confirm-before-write for NOA-derived carry-overs.
// Direct env.DB writes, consistent with the sibling carry-in routes (capital-losses / opening-depreciation
// in api.ts). The DO extracts the NOA and calls captureNoaDraft; the Worker's /api/noa route lists,
// confirms (writes the carry-ins) and undoes. Nothing here predicts a refund — GENERAL-INFO only.

import type { Env } from "../env";
import { addCapitalLoss, addDepreciationOpening } from "./situation-write";
import { planNoaCarryovers, type NoaFacts } from "./noa";

export interface CarryoverRow {
  id: string;
  source_fy: number;
  target_fy: number;
  noa_document_id: string | null;
  status: string; // 'draft' | 'confirmed'
  taxable_income_cents: number | null;
  tax_assessed_cents: number | null;
  net_capital_losses_cf_cents: number;
  prior_year_tax_losses_cf_cents: number;
  opening_depreciation_cents: number;
  hecs_balance_cents: number | null;
  mls_debt_cents: number | null;
  franking_refund_cents: number | null;
  capital_loss_carryin_id: string | null;
  depreciation_opening_id: string | null;
  confidence: number | null;
  confirmed_at: string | null;
}

const SELECT_COLS =
  `id, source_fy, target_fy, noa_document_id, status, taxable_income_cents, tax_assessed_cents,
   net_capital_losses_cf_cents, prior_year_tax_losses_cf_cents, opening_depreciation_cents,
   hecs_balance_cents, mls_debt_cents, franking_refund_cents, capital_loss_carryin_id,
   depreciation_opening_id, confidence, confirmed_at`;

const fyLabel = (start: number) => `${start}-${String((start + 1) % 100).padStart(2, "0")}`;

// Insert a DRAFT carry-over from an extracted NOA, replacing any prior UNCONFIRMED draft for the same
// source FY (re-uploading supersedes rather than piling up). Confirmed rows are left intact.
export async function captureNoaDraft(env: Env, userId: string, noaDocumentId: string, facts: NoaFacts): Promise<string> {
  const source_fy = facts.assessed_fy;
  const target_fy = source_fy + 1;
  await env.DB.prepare(`DELETE FROM fy_carryovers WHERE user_id = ? AND source_fy = ? AND status = 'draft'`).bind(userId, source_fy).run();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO fy_carryovers (id, user_id, source_fy, target_fy, noa_document_id, status,
       taxable_income_cents, tax_assessed_cents, net_capital_losses_cf_cents, prior_year_tax_losses_cf_cents,
       opening_depreciation_cents, hecs_balance_cents, mls_debt_cents, franking_refund_cents, confidence)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id, userId, source_fy, target_fy, noaDocumentId,
      Math.max(0, Math.round(facts.taxable_income_cents)), Math.max(0, Math.round(facts.tax_assessed_cents)),
      Math.max(0, Math.round(facts.net_capital_losses_cf_cents)), Math.max(0, Math.round(facts.prior_year_tax_losses_cf_cents)),
      Math.max(0, Math.round(facts.opening_depreciation_cents)),
      facts.hecs_balance_cents, facts.mls_debt_cents, facts.franking_refund_cents, facts.confidence,
    )
    .run();
  return id;
}

export async function listNoaCarryovers(env: Env, userId: string, sourceFy?: number): Promise<CarryoverRow[]> {
  const q =
    sourceFy != null
      ? env.DB.prepare(`SELECT ${SELECT_COLS} FROM fy_carryovers WHERE user_id = ? AND source_fy = ? ORDER BY created_at DESC`).bind(userId, sourceFy)
      : env.DB.prepare(`SELECT ${SELECT_COLS} FROM fy_carryovers WHERE user_id = ? ORDER BY source_fy DESC, created_at DESC`).bind(userId);
  const res = await q.all<CarryoverRow>();
  return res.results ?? [];
}

function rowToFacts(row: CarryoverRow): NoaFacts {
  return {
    assessed_fy: row.source_fy,
    taxable_income_cents: row.taxable_income_cents ?? 0,
    tax_assessed_cents: row.tax_assessed_cents ?? 0,
    net_capital_losses_cf_cents: row.net_capital_losses_cf_cents,
    prior_year_tax_losses_cf_cents: row.prior_year_tax_losses_cf_cents,
    opening_depreciation_cents: row.opening_depreciation_cents,
    hecs_balance_cents: row.hecs_balance_cents,
    mls_debt_cents: row.mls_debt_cents,
    franking_refund_cents: row.franking_refund_cents,
    confidence: row.confidence ?? 0,
  };
}

// Turn a draft into carry-in rows (idempotent: a confirmed row is returned unchanged) and CLOSE the year.
// Net capital losses → capital_loss_carryins (flows through cgt.ts); opening depreciation → the (still
// capture-only) depreciation_opening_balances; the FY sign-off is set to 'closed_with_noa'.
export async function confirmNoaCarryover(env: Env, userId: string, id: string): Promise<CarryoverRow> {
  const row = await env.DB.prepare(`SELECT ${SELECT_COLS} FROM fy_carryovers WHERE id = ? AND user_id = ?`).bind(id, userId).first<CarryoverRow>();
  if (!row) throw new Error("carry-over not found");
  if (row.status === "confirmed") return row;

  const plan = planNoaCarryovers(rowToFacts(row));
  const note = `From your ${fyLabel(row.source_fy)} Notice of Assessment`;
  let capId: string | null = null;
  let depId: string | null = null;
  if (plan.capital_loss) {
    capId = await addCapitalLoss(env, userId, { prior_fy: plan.capital_loss.prior_fy, loss_cents: plan.capital_loss.loss_cents, notes: note });
  }
  if (plan.opening_depreciation) {
    depId = await addDepreciationOpening(env, userId, { fy: plan.opening_depreciation.fy, opening_adjustable_value_cents: plan.opening_depreciation.opening_adjustable_value_cents, notes: note });
  }
  await env.DB.prepare(
    `UPDATE fy_carryovers SET status = 'confirmed', confirmed_at = datetime('now'), capital_loss_carryin_id = ?, depreciation_opening_id = ? WHERE id = ? AND user_id = ?`,
  ).bind(capId, depId, id, userId).run();
  // Close the year off the NOA (upsert onto the soft sign-off row).
  await env.DB.prepare(
    `INSERT INTO fy_signoff (user_id, fy, signed_off_at, noa_document_id, status)
       VALUES (?, ?, datetime('now'), ?, 'closed_with_noa')
     ON CONFLICT(user_id, fy) DO UPDATE SET noa_document_id = excluded.noa_document_id, status = 'closed_with_noa', signed_off_at = datetime('now')`,
  ).bind(userId, row.source_fy, row.noa_document_id).run();

  return (await env.DB.prepare(`SELECT ${SELECT_COLS} FROM fy_carryovers WHERE id = ? AND user_id = ?`).bind(id, userId).first<CarryoverRow>())!;
}

// Reverse path: drop the carry-over and any carry-in rows it created; reopen a year it had closed.
export async function deleteNoaCarryover(env: Env, userId: string, id: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT ${SELECT_COLS} FROM fy_carryovers WHERE id = ? AND user_id = ?`).bind(id, userId).first<CarryoverRow>();
  if (!row) return;
  if (row.capital_loss_carryin_id) {
    await env.DB.prepare(`DELETE FROM capital_loss_carryins WHERE id = ? AND user_id = ?`).bind(row.capital_loss_carryin_id, userId).run();
  }
  if (row.depreciation_opening_id) {
    await env.DB.prepare(`DELETE FROM depreciation_opening_balances WHERE id = ? AND user_id = ?`).bind(row.depreciation_opening_id, userId).run();
  }
  if (row.status === "confirmed") {
    // Reopen the year: clear only the NOA-close markers, leaving the soft sign-off timestamp for the user.
    await env.DB.prepare(`UPDATE fy_signoff SET status = NULL, noa_document_id = NULL WHERE user_id = ? AND fy = ? AND status = 'closed_with_noa'`).bind(userId, row.source_fy).run();
  }
  await env.DB.prepare(`DELETE FROM fy_carryovers WHERE id = ? AND user_id = ?`).bind(id, userId).run();
}
