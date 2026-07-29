// Capital-holding cost base — pure, deterministic helpers. NO I/O.
// Golden-tested in scripts/check-units.ts. GENERAL-INFO only — cost-base composition is fact-specific and
// the claimability brain always defers the judgement calls to a registered tax agent.
//
// WHY THIS EXISTS. migration 0037 documented cgt_assets.cost_base_cents as "purchase + incidental costs
// (brokerage, stamp duty)" — but nothing ever captured the incidental costs. There was no brokerage field on
// the holding form, no extraction from a contract note, and no breakdown anywhere. So the promise in the
// schema comment was never kept, and a share purchase's cost base was understated by exactly the brokerage
// the taxpayer paid (which is real money: ~$3–$10 a trade, on both the buy AND the sell side).
//
// SHAPE DECISION (recorded in docs/capital-cgt-findings.md rather than left to the diff). The ATO defines
// FIVE cost-base elements (s 110-25): (1) money/property given to acquire, (2) incidental costs of acquiring
// or disposing, (3) costs of ownership (non-deductible holding costs, and NOT available for shares/units
// acquired after 20 Aug 1991 — never auto-included here), (4) capital enhancement expenditure, (5) costs to
// establish/preserve title. Sharesight and Xero both model these as a BREAKDOWN over one total, not as five
// columns — and so do we, for three reasons:
//
//   1. THE TIE-BACK INVARIANT. The accountant schedule asserts that its per-disposal gains sum to
//      report.gross_capital_gains_cents. That needs ONE canonical figure that reconciles to
//      cgt_events.cost_base_used_cents. A breakdown is presentation; the total is the contract.
//   2. NO MIGRATION PER ELEMENT. A JSON breakdown survives the UK Section 104 pooling and Canadian ACB
//      averaging models (§5 of the brief) without a schema change per jurisdiction.
//   3. IT MIRRORS AN ESTABLISHED PATTERN IN THIS CODEBASE. income.detail_json already carries the AMMA
//      `components` blob under one gross figure (src/lib/managed-fund.ts). Same shape, same parse-or-null
//      degradation, same golden style.
//
// So: cost_base_cents stays the ONLY figure any engine reads, and the elements live in
// cgt_assets.detail_json under a `cost_base_elements` key.

/**
 * The cost-base elements we CAPTURE. Deliberately a subset of the statutory five: these are the ones a
 * retail share/ETF/crypto investor actually has evidence for on a contract note. Element 3 (ownership costs)
 * is excluded on purpose — it is generally NOT available for shares or units acquired after 20 August 1991,
 * so offering a field would invite an over-stated cost base. Element 4/5 are folded into `other_cents` with
 * a note rather than given false precision.
 */
export interface CostBaseElements {
  /** Element 1 — what you paid for the asset itself (the consideration), excluding costs. */
  purchase_cents: number;
  /** Element 2 — brokerage on ACQUISITION. The gap migration 0037 promised and never filled. */
  brokerage_cents: number;
  /** Element 2 — other incidental costs of acquiring (transfer/stamp duty, adviser or valuation fees). */
  incidental_cents: number;
  /** Elements 4/5 — capital enhancement, or costs to establish/preserve title. Rare for listed shares. */
  other_cents: number;
  /** Free-text provenance for the evidence pack (e.g. "CommSec contract note 1234"). Never parsed. */
  note?: string | null;
}

export const EMPTY_COST_BASE_ELEMENTS: CostBaseElements = {
  purchase_cents: 0, brokerage_cents: 0, incidental_cents: 0, other_cents: 0, note: null,
};

/**
 * The canonical cost base for a set of elements. This is what gets stored in cgt_assets.cost_base_cents and
 * what must reconcile to cgt_events.cost_base_used_cents at disposal — see the tie-back note above.
 *
 * Brokerage on DISPOSAL is deliberately NOT here: selling costs reduce the capital PROCEEDS, they don't
 * increase the cost base. Conflating the two would double-count them. That belongs with the disposal.
 */
export function costBaseFromElements(e: CostBaseElements): number {
  return (e.purchase_cents ?? 0) + (e.brokerage_cents ?? 0) + (e.incidental_cents ?? 0) + (e.other_cents ?? 0);
}

export interface CostBaseValidation {
  ok: boolean;
  reason?: "negative" | "all_zero";
}

/**
 * Validate an elements payload. Every element must be NON-NEGATIVE — a negative "cost" is not a cost-base
 * reduction (those come from Div 43 capital works and the AMIT cost-base amount, which are applied by their
 * own engines against the total, never smuggled in as a negative element). All-zero is rejected: a holding
 * with no cost base at all is chased by readiness, not silently stored as an itemised zero.
 */
export function validateCostBaseElements(e: CostBaseElements): CostBaseValidation {
  const values = [e.purchase_cents, e.brokerage_cents, e.incidental_cents, e.other_cents];
  if (values.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)) return { ok: false, reason: "negative" };
  if (costBaseFromElements(e) === 0) return { ok: false, reason: "all_zero" };
  return { ok: true };
}

/**
 * Read the elements back out of a cgt_assets.detail_json blob. Mirrors parseAmmaComponents exactly: a legacy
 * or absent blob (every holding written before this flag) returns null, so the caller falls back to the
 * single cost_base_cents figure and nothing is itemised. Never throws on malformed JSON.
 */
export function parseCostBaseElements(detailJson: string | null | undefined): CostBaseElements | null {
  if (!detailJson) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(detailJson); } catch { return null; }
  const blob = (parsed as { cost_base_elements?: unknown } | null)?.cost_base_elements;
  if (!blob || typeof blob !== "object") return null;
  const n = (k: keyof CostBaseElements): number => {
    const v = (blob as Record<string, unknown>)[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const note = (blob as Record<string, unknown>).note;
  return {
    purchase_cents: n("purchase_cents"),
    brokerage_cents: n("brokerage_cents"),
    incidental_cents: n("incidental_cents"),
    other_cents: n("other_cents"),
    note: typeof note === "string" && note.trim() ? note.trim() : null,
  };
}

/** Merge elements into an existing detail_json blob without disturbing anything else already in it. */
export function withCostBaseElements(detailJson: string | null | undefined, e: CostBaseElements): string {
  let base: Record<string, unknown> = {};
  if (detailJson) {
    try { base = (JSON.parse(detailJson) as Record<string, unknown>) ?? {}; } catch { base = {}; }
  }
  return JSON.stringify({ ...base, cost_base_elements: e });
}

// ── Holdings position (C3, capital_position) ───────────────────────────────────────────────────
// `cgt_assets.units` is the ACQUIRED parcel size and is deliberately never rewritten — the acquisition
// record stays immutable and the remaining quantity is DERIVED. `cgt_assets.status` is written as the
// literal 'held' at insert (migration 0037) and updated by nothing; it is DEAD and this module supersedes
// it. (Dropping the column is a destructive migration needing its own sign-off, so it stays present.)
//
// Everything here is arithmetic over what the USER entered — never a parcel selection. That distinction is
// load-bearing: parcel choice changes the gain and is the taxpayer's decision (see the anti-goals), so a
// remaining cost base may only ever be "the parcel's cost base minus the cost base they said they used",
// never a figure we picked by choosing parcels on their behalf.

export interface HoldingDisposal {
  units_disposed?: number | null;
  cost_base_used_cents?: number | null;
}

export interface HoldingPosition {
  /** What the parcel row records as acquired. null ⇒ never captured (every pre-C0 holding). */
  units_acquired: number | null;
  units_disposed: number;
  /** null when the acquired quantity is unknown — we never imply a balance we can't compute. */
  units_remaining: number | null;
  cost_base_cents: number;
  cost_base_used_cents: number;
  /** 0-floored: a full disposal legitimately leaves nothing. */
  cost_base_remaining_cents: number;
  status: "held" | "part_disposed" | "disposed";
  /** > 0 ⇒ they disposed of MORE than they hold. A REVIEW finding, never a block — Quillo surfaces, the agent decides. */
  over_disposed_units: number;
  /** > 0 ⇒ the cost base claimed across disposals exceeds the parcel's. Understates the gain, so it is surfaced too. */
  over_used_cost_base_cents: number;
}

/**
 * Derive a holding's running position from its immutable parcel row and its disposal events. Pure.
 *
 * Scope note for callers: run this over USER-MANAGED holdings only (`property_id IS NULL AND income_id IS
 * NULL`). A property- or AMMA-sourced parcel is materialised complete from its source with `units` NULL and
 * `status='disposed'` already set, so deriving "part sold" for it would be noise, not information.
 */
export function holdingPosition(
  asset: { units?: number | null; cost_base_cents?: number | null },
  disposals: ReadonlyArray<HoldingDisposal>,
): HoldingPosition {
  const unitsAcquired = typeof asset.units === "number" && Number.isFinite(asset.units) ? asset.units : null;
  const costBase = asset.cost_base_cents ?? 0;
  const unitsDisposed = disposals.reduce((t, d) => t + (d.units_disposed ?? 0), 0);
  const costUsed = disposals.reduce((t, d) => t + (d.cost_base_used_cents ?? 0), 0);

  const unitsRemaining = unitsAcquired == null ? null : unitsAcquired - unitsDisposed;
  const overDisposed = unitsAcquired == null ? 0 : Math.max(0, unitsDisposed - unitsAcquired);

  // Status, in order of what we can honestly assert:
  //  - no disposals at all ⇒ still held;
  //  - disposals but an unknown acquired quantity ⇒ "part sold" (something went, we can't say it all did);
  //  - nothing left ⇒ sold.
  let status: HoldingPosition["status"];
  if (!disposals.length) status = "held";
  else if (unitsRemaining == null) status = "part_disposed";
  else if (unitsRemaining <= 0) status = "disposed";
  else status = "part_disposed";

  return {
    units_acquired: unitsAcquired,
    units_disposed: unitsDisposed,
    units_remaining: unitsRemaining,
    cost_base_cents: costBase,
    cost_base_used_cents: costUsed,
    cost_base_remaining_cents: Math.max(0, costBase - costUsed),
    status,
    over_disposed_units: overDisposed,
    over_used_cost_base_cents: Math.max(0, costUsed - costBase),
  };
}

/**
 * The itemised rows for the accountant schedule: label + amount, zero elements dropped. Presentation only —
 * the caller keeps the section subtotal on the canonical total, so the tie-back is unaffected by itemising.
 */
export function costBaseBreakdownRows(e: CostBaseElements): { label: string; cents: number }[] {
  return [
    { label: "Purchase price", cents: e.purchase_cents },
    { label: "Brokerage (acquisition)", cents: e.brokerage_cents },
    { label: "Incidental costs (transfer duty, fees)", cents: e.incidental_cents },
    { label: "Other capital costs (enhancement, title)", cents: e.other_cents },
  ].filter((r) => (r.cents ?? 0) !== 0);
}
