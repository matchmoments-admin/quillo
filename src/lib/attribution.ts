// ── Attribution helpers (Phase B / G2) ────────────────────────────────────────
// Quillo's divergence from Xero/MYOB/QBO: WHO PAID a transaction is not WHO is entitled to
// deduct it. A transaction_attributions row says "of this payment, entity E claims this much,
// against income-activity A". The split is SNAPSHOTTED onto the row (attributed_amount_cents)
// at write time — owner-share × work-use frozen — so the hand-off shows exactly what each
// entity claimed and the report hot path just sums one number. These pure helpers are the single
// source of truth for the snapshot math + the track routing, shared by the writer (API) and the
// aggregator (ledger-totals). No DB, no Env — unit-tested in check-units.ts.

/** Clamp a percentage to [0,100]; null/undefined/NaN → 100 (the "whole thing" default). */
export function clampPct(pct: number | null | undefined): number {
  if (pct == null || Number.isNaN(pct)) return 100;
  return Math.max(0, Math.min(100, pct));
}

/**
 * The snapshot amount an attribution claims: gross × owner-share% × work-use%. This is what the
 * writer freezes into transaction_attributions.attributed_amount_cents. For a co-owned property
 * (TR 93/32) owner_share_pct is the claiming person's legal interest; for a personally-paid company
 * cost it's 100% (the company claims the whole bill, funded by a shareholder loan). work_use_pct
 * apportions a mixed-use item. Rounded to whole cents.
 */
export function splitAttribution(input: {
  amount_cents: number;
  owner_share_pct?: number | null;
  work_use_pct?: number | null;
}): number {
  const owner = clampPct(input.owner_share_pct);
  const work = clampPct(input.work_use_pct);
  return Math.round((input.amount_cents * owner * work) / 10000);
}

export type AttributionTrack = "individual" | "company" | "property" | "excluded";

/**
 * Which part of the position an attribution feeds — the routing counterpart to deductionGroupForRow.
 * SINGLE source of truth so the reader and any future writer/preview agree:
 *   - private_non_deductible provision → excluded (claims nothing)
 *   - rental-property activity → the per-property negative-gearing position
 *   - company claiming entity → the company track (NOT the individual headline)
 *   - everything else (the individual taxpayer) → the headline deductions
 * Ordering matters: a private provision wins over any track; a rental activity wins over the
 * entity type (a company can't hold a rental_property activity in this model).
 */
export function classifyAttribution(input: {
  entity_type?: string | null;
  activity_type?: string | null;
  deduction_provision?: string | null;
}): AttributionTrack {
  if (input.deduction_provision === "private_non_deductible") return "excluded";
  if (input.activity_type === "rental_property") return "property";
  if (input.entity_type === "company") return "company";
  return "individual";
}
