// Capital-holding READINESS SIGNALS — the D1 reads behind the six capital findings.
//
// WHY THIS MODULE EXISTS. These queries lived inline in the Durable Object (`filingReadiness` in
// src/agent.ts), which is not reachable from the golden harness. The C3 hardening PR's first cut therefore
// "tested" them by RE-TYPING the SQL inside scripts/check-personas.ts — which asserts the test's own copy
// and stays green when the DO's copy changes. That is trap 10 (an assertion that cannot fail) committed
// inside the fix for trap 11, and the review caught it. So the queries move here: `agent.ts` calls this,
// the goldens call this, and there is one definition to be right or wrong about.
//
// src/lib/capital.ts stays PURE (its header promises no I/O) — this is the DB-touching sibling, which is
// also why the `NOT EXISTS` fragment that briefly lived there is now simply inlined below.
//
// THE COMPLEMENTARITY INVARIANT (read before changing either query). Two findings describe a holding with
// no cost base, and every holding must reach EXACTLY ONE of them:
//
//   - C1 `capital_holding_missing_cost_base` (REVIEW) — "you'd report the whole proceeds as gain IF you
//     sold it". A conditional, holding-level statement. True for anyone's parcel.
//   - C3 `capital_disposal_no_cost_base` (BLOCKER) — "the entire sale proceeds ARE showing as a capital
//     gain". An unconditional claim about THIS YEAR'S INDIVIDUAL POSITION, so it is the one finding that
//     must be entity-scoped: a company/trust/SMSF parcel is excluded from the individual headline by C-E,
//     and claiming their return is distorted by money that is not in it would be false.
//
// Scoping the blocker while unconditionally suppressing the review finding for anything with a disposal is
// what opened a hole: an ENTITY parcel with a disposal and no cost base fell out of both and was surfaced
// nowhere. Hence `noDisposalOrOutOfScope` — a holding leaves the review finding ONLY when the blocker will
// actually pick it up. The two are complements by construction, not by coincidence.
//
// The two `over_*` findings are deliberately NOT entity-scoped. Their copy is holding-level arithmetic
// ("you've sold more units than the parcel records"), true of any parcel the taxpayer keeps records for,
// and the capital register shows its warning badge on entity rows too — scoping them would leave a badge
// on screen with no finding behind it.

import type { Env } from "../env";
import { featureOn } from "./features";
import { cgtPersonalScopeExpr } from "./ledger-totals";
import { holdingPosition } from "./capital";

export interface CapitalReadinessSignals {
  capitalHoldingsNeedingUnitsN: number;
  capitalHoldingsMissingAcquiredN: number;
  capitalHoldingsMissingCostBaseN: number;
  capitalOverDisposedN: number;
  capitalOverUsedCostBaseN: number;
  capitalDisposedNoCostBaseN: number;
}

export const EMPTY_CAPITAL_SIGNALS: CapitalReadinessSignals = {
  capitalHoldingsNeedingUnitsN: 0,
  capitalHoldingsMissingAcquiredN: 0,
  capitalHoldingsMissingCostBaseN: 0,
  capitalOverDisposedN: 0,
  capitalOverUsedCostBaseN: 0,
  capitalDisposedNoCostBaseN: 0,
};

/** USER-MANAGED holdings only. A property- or AMMA-sourced parcel is materialised complete from its source, so chasing it would be noise. */
const USER_MANAGED = "a.property_id IS NULL AND a.income_id IS NULL";

/**
 * Derive every capital readiness signal for a tenant. Not FY-scoped, deliberately: a holding is a standing
 * record, and an incomplete or inconsistent one distorts the gain in whatever year it is eventually sold.
 *
 * Degrades to zeros on a pre-0037/0070 database (the "no such table/column" catch), matching how every
 * other signal block in `filingReadiness` behaves.
 */
export async function capitalReadinessSignals(env: Env, userId: string): Promise<CapitalReadinessSignals> {
  const fromTxn = featureOn(env, "capital_from_txn");
  const positionOn = featureOn(env, "capital_position");
  if (!fromTxn && !positionOn) return { ...EMPTY_CAPITAL_SIGNALS };

  const out: CapitalReadinessSignals = { ...EMPTY_CAPITAL_SIGNALS };
  const personal = cgtPersonalScopeExpr(env, "a");
  // "No disposal recorded against this holding, OR the holding is out of the blocker's scope anyway."
  // The second half is what keeps the two findings complementary — see the header.
  const noDisposalOrOutOfScope = positionOn
    ? `(NOT EXISTS (SELECT 1 FROM cgt_events ev WHERE ev.cgt_asset_id = a.id AND ev.user_id = a.user_id) OR NOT (${personal}))`
    : "1";

  if (fromTxn) {
    try {
      const h = await env.DB.prepare(
        `SELECT COALESCE(SUM(CASE WHEN a.txn_id IS NOT NULL AND a.units IS NULL THEN 1 ELSE 0 END), 0) AS needs_units,
                COALESCE(SUM(CASE WHEN a.acquired_date IS NULL OR a.acquired_date = '' THEN 1 ELSE 0 END), 0) AS no_acquired,
                COALESCE(SUM(CASE WHEN COALESCE(a.cost_base_cents, 0) <= 0 AND ${noDisposalOrOutOfScope} THEN 1 ELSE 0 END), 0) AS no_cost_base
           FROM cgt_assets a
          WHERE a.user_id = ? AND ${USER_MANAGED}`,
      ).bind(userId).first<{ needs_units: number; no_acquired: number; no_cost_base: number }>();
      out.capitalHoldingsNeedingUnitsN = h?.needs_units ?? 0;
      out.capitalHoldingsMissingAcquiredN = h?.no_acquired ?? 0;
      out.capitalHoldingsMissingCostBaseN = h?.no_cost_base ?? 0;
    } catch (e) {
      if (!/no such table|no such column/i.test((e as Error).message)) throw e;
    }
  }

  if (positionOn) {
    try {
      // Two flat reads joined in JS, exactly like the register and the accountant schedule — so all four
      // call sites hand holdingPosition() the SAME shape (an array of real disposal rows). The earlier
      // GROUP BY here passed ONE pre-SUMmed pseudo-disposal, which happens to agree today only because
      // holdingPosition reads `disposals.length` as a zero-test; the first per-event field C4/C5 adds
      // would have been silently wrong at this one site.
      const assets = (await env.DB.prepare(
        `SELECT a.id AS id, a.units AS units, a.cost_base_cents AS cost_base_cents, (${personal}) AS is_personal
           FROM cgt_assets a WHERE a.user_id = ? AND ${USER_MANAGED}`,
      ).bind(userId).all<{ id: string; units: number | null; cost_base_cents: number; is_personal: number }>()).results ?? [];
      if (assets.length) {
        const evs = (await env.DB.prepare(
          `SELECT cgt_asset_id, units_disposed, cost_base_used_cents FROM cgt_events WHERE user_id = ?`,
        ).bind(userId).all<{ cgt_asset_id: string; units_disposed: number | null; cost_base_used_cents: number | null }>()).results ?? [];
        const byAsset = new Map<string, { units_disposed: number | null; cost_base_used_cents: number | null }[]>();
        for (const e of evs) {
          const list = byAsset.get(e.cgt_asset_id) ?? [];
          list.push({ units_disposed: e.units_disposed, cost_base_used_cents: e.cost_base_used_cents });
          byAsset.set(e.cgt_asset_id, list);
        }
        for (const a of assets) {
          const disposals = byAsset.get(a.id) ?? [];
          if (!disposals.length) continue; // no disposal ⇒ nothing to be inconsistent with
          const pos = holdingPosition({ units: a.units, cost_base_cents: a.cost_base_cents }, disposals);
          if (pos.over_disposed_units > 0) out.capitalOverDisposedN++;
          if (pos.over_used_cost_base_cents > 0) out.capitalOverUsedCostBaseN++;
          // Entity-scoped, and ONLY this one — it is the finding that asserts the individual's position is
          // distorted. `is_personal` is 1 for every row when capital_entity_scope is OFF.
          if (a.is_personal && (a.cost_base_cents ?? 0) <= 0) out.capitalDisposedNoCostBaseN++;
        }
      }
    } catch (e) {
      if (!/no such table|no such column/i.test((e as Error).message)) throw e;
    }
  }

  return out;
}
