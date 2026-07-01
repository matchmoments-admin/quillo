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

// Enforce the single-active-NOA-capital-loss invariant. A NOA's "net capital losses carried forward" is
// a CUMULATIVE balance (it already rolls up every prior year's unapplied loss), so if each year's NOA
// wrote its own capital_loss_carryins row they would STACK — the CGT read sums all rows with prior_fy <
// reportFY (ledger-totals.ts). Only the LATEST-assessed confirmed NOA is authoritative: rebuild exactly
// one cap-loss row from it and clear every other NOA-sourced one. Idempotent; order-independent.
async function reconcileNoaCapitalLoss(env: Env, userId: string): Promise<void> {
  const confirmed = (await env.DB.prepare(
    `SELECT id, source_fy, net_capital_losses_cf_cents, capital_loss_carryin_id FROM fy_carryovers
       WHERE user_id = ? AND status = 'confirmed' ORDER BY source_fy DESC`,
  ).bind(userId).all<{ id: string; source_fy: number; net_capital_losses_cf_cents: number; capital_loss_carryin_id: string | null }>()).results ?? [];
  // Drop every existing NOA-sourced cap-loss row + its back-reference, then rewrite the single active one.
  for (const c of confirmed) {
    if (c.capital_loss_carryin_id) {
      await env.DB.prepare(`DELETE FROM capital_loss_carryins WHERE id = ? AND user_id = ?`).bind(c.capital_loss_carryin_id, userId).run();
      await env.DB.prepare(`UPDATE fy_carryovers SET capital_loss_carryin_id = NULL WHERE id = ? AND user_id = ?`).bind(c.id, userId).run();
    }
  }
  const active = confirmed.find((c) => c.net_capital_losses_cf_cents > 0); // ORDER BY source_fy DESC ⇒ first is the latest assessed year
  if (active) {
    const capId = await addCapitalLoss(env, userId, { prior_fy: active.source_fy, loss_cents: active.net_capital_losses_cf_cents, notes: `From your ${fyLabel(active.source_fy)} Notice of Assessment (cumulative net capital losses carried forward)` });
    await env.DB.prepare(`UPDATE fy_carryovers SET capital_loss_carryin_id = ? WHERE id = ? AND user_id = ?`).bind(capId, active.id, userId).run();
  }
}

// Turn a draft into carry-in rows (idempotent) and CLOSE the year. Opening depreciation (year-specific,
// NOT cumulative) → depreciation_opening_balances; the cumulative net capital loss is reconciled to a
// single active row across all confirmed NOAs (see reconcileNoaCapitalLoss); FY sign-off → 'closed_with_noa'.
export async function confirmNoaCarryover(env: Env, userId: string, id: string): Promise<CarryoverRow> {
  const row = await env.DB.prepare(`SELECT ${SELECT_COLS} FROM fy_carryovers WHERE id = ? AND user_id = ?`).bind(id, userId).first<CarryoverRow>();
  if (!row) throw new Error("carry-over not found");
  if (row.status === "confirmed") return row;

  // Claim the draft atomically — only the first confirm flips draft→confirmed and proceeds to write, so a
  // double-tap / retry can't write the carry-ins twice (the loser sees changes=0 and returns the row).
  const claim = await env.DB.prepare(`UPDATE fy_carryovers SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ? AND user_id = ? AND status = 'draft'`).bind(id, userId).run();
  if (!((claim.meta as { changes?: number })?.changes ?? 0)) {
    const cur = await env.DB.prepare(`SELECT ${SELECT_COLS} FROM fy_carryovers WHERE id = ? AND user_id = ?`).bind(id, userId).first<CarryoverRow>();
    if (cur) return cur;
    throw new Error("carry-over not found");
  }

  // A re-upload/correction for the SAME assessed year fully supersedes the prior confirmed record (its
  // year-specific opening-depreciation row too); its cap-loss row is handled by the reconcile below.
  const sameYear = (await env.DB.prepare(
    `SELECT id, depreciation_opening_id FROM fy_carryovers WHERE user_id = ? AND status = 'confirmed' AND source_fy = ? AND id != ?`,
  ).bind(userId, row.source_fy, id).all<{ id: string; depreciation_opening_id: string | null }>()).results ?? [];
  for (const s of sameYear) {
    if (s.depreciation_opening_id) await env.DB.prepare(`DELETE FROM depreciation_opening_balances WHERE id = ? AND user_id = ?`).bind(s.depreciation_opening_id, userId).run();
    await env.DB.prepare(`DELETE FROM fy_carryovers WHERE id = ? AND user_id = ?`).bind(s.id, userId).run();
  }

  // Write THIS year's opening depreciation (year-specific), then reconcile the cumulative cap-loss.
  const plan = planNoaCarryovers(rowToFacts(row));
  let depId: string | null = null;
  if (plan.opening_depreciation) {
    depId = await addDepreciationOpening(env, userId, { fy: plan.opening_depreciation.fy, opening_adjustable_value_cents: plan.opening_depreciation.opening_adjustable_value_cents, notes: `From your ${fyLabel(row.source_fy)} Notice of Assessment` });
  }
  await env.DB.prepare(`UPDATE fy_carryovers SET depreciation_opening_id = ? WHERE id = ? AND user_id = ?`).bind(depId, id, userId).run();
  await reconcileNoaCapitalLoss(env, userId);

  // Close the year off the NOA (upsert onto the soft sign-off row).
  await env.DB.prepare(
    `INSERT INTO fy_signoff (user_id, fy, signed_off_at, noa_document_id, status)
       VALUES (?, ?, datetime('now'), ?, 'closed_with_noa')
     ON CONFLICT(user_id, fy) DO UPDATE SET noa_document_id = excluded.noa_document_id, status = 'closed_with_noa', signed_off_at = datetime('now')`,
  ).bind(userId, row.source_fy, row.noa_document_id).run();

  return (await env.DB.prepare(`SELECT ${SELECT_COLS} FROM fy_carryovers WHERE id = ? AND user_id = ?`).bind(id, userId).first<CarryoverRow>())!;
}

// Reverse path: drop the carry-over + its year-specific opening-depreciation row, re-derive the active
// cap-loss from whatever confirmed NOAs remain, and (for a confirmed row) fully re-open the year.
export async function deleteNoaCarryover(env: Env, userId: string, id: string): Promise<void> {
  const row = await env.DB.prepare(`SELECT ${SELECT_COLS} FROM fy_carryovers WHERE id = ? AND user_id = ?`).bind(id, userId).first<CarryoverRow>();
  if (!row) return;
  if (row.depreciation_opening_id) {
    await env.DB.prepare(`DELETE FROM depreciation_opening_balances WHERE id = ? AND user_id = ?`).bind(row.depreciation_opening_id, userId).run();
  }
  if (row.capital_loss_carryin_id) {
    await env.DB.prepare(`DELETE FROM capital_loss_carryins WHERE id = ? AND user_id = ?`).bind(row.capital_loss_carryin_id, userId).run();
  }
  const wasConfirmed = row.status === "confirmed";
  await env.DB.prepare(`DELETE FROM fy_carryovers WHERE id = ? AND user_id = ?`).bind(id, userId).run();
  if (wasConfirmed) {
    // The cumulative cap-loss may now belong to an earlier confirmed NOA — rebuild it from what remains.
    await reconcileNoaCapitalLoss(env, userId);
    // Fully re-open the year: the NOA-close upsert overwrote any prior soft-signoff timestamp, so removing
    // the row is the honest reopen (a phantom "signed off" would otherwise linger). The user can re-attest.
    await env.DB.prepare(`DELETE FROM fy_signoff WHERE user_id = ? AND fy = ? AND status = 'closed_with_noa'`).bind(userId, row.source_fy).run();
  }
}
