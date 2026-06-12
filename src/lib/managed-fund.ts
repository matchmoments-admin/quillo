// Managed-fund (ETF / AMIT) AMMA distribution components — pure, deterministic helpers. NO I/O.
// Golden-tested in scripts/check-units.ts. GENERAL-INFO only.
//
// A managed-fund distribution (income_type='managed_fund_distribution') is NOT a single ordinary-income
// number: an AMMA (AMIT Member Annual) / Standard Distribution Statement breaks it into components that are
// taxed DIFFERENTLY. The component taxonomy here mirrors the ATO SDS / AMMA standard (the authoritative
// reference for this structure — the same set SMSF-admin tools like Simple Fund 360 / BGL capture):
//   - ordinary ASSESSABLE income: franked + unfranked dividends, interest, other Australian income
//     (absorbs NCMI / CBM / other AU income for a resident's assessable total), and foreign income;
//   - attached CREDITS: franking credits (gross-up + offset) and foreign tax paid (FITO);
//   - CAPITAL GAINS: a discounted-method gain (eligible for the 50% CGT discount) and an other-method gain;
//   - the AMIT COST BASE NET AMOUNT: NOT assessable now — it adjusts the cost base of the units for the
//     eventual CGT on disposal (signed: + = a cost-base decrease / "tax-deferred", − = a cost-base increase).
//
// Routing (done by the caller at write time): ordinary components sum into income.gross_cents; franking /
// foreign tax go in their dedicated income columns; the capital-gain buckets are MATERIALISED into the CGT
// engine (cgt_events) so they get the discount + loss-offset instead of being taxed as ordinary income; the
// AMIT cost-base amount stays out of the position entirely (a defer nudge only).
//
// v1 scope: AUD only (components are not FX-converted) and personal only (cgtTotals isn't entity-scoped).

import type { CgtEventInput } from "./cgt";

export interface AmmaComponents {
  // Ordinary assessable income.
  franked_cents: number;
  unfranked_cents: number;
  interest_cents: number;
  other_income_cents: number;       // other Australian income (incl. NCMI / CBM for a resident's assessable total)
  foreign_income_cents: number;
  // Attached credits (already AUD by construction, like the existing income columns).
  franking_credit_cents: number;
  foreign_tax_paid_cents: number;
  // Capital gains. capital_gain_discounted_cents is the GROSS gain (pre-discount) — the engine applies the
  // 50% CGT discount. capital_gain_other_cents is the non-discountable "other method" gain.
  capital_gain_discounted_cents: number;
  capital_gain_other_cents: number;
  // AMIT cost base net amount (signed) — NOT assessable; adjusts the units' cost base for a future disposal.
  amit_cost_base_net_amount_cents: number;
}

/** The fields that, summed, are ordinary assessable income (what lands in income.gross_cents). */
export function ordinaryAssessableCents(c: AmmaComponents): number {
  return c.franked_cents + c.unfranked_cents + c.interest_cents + c.other_income_cents + c.foreign_income_cents;
}

/** Total distribution = ordinary + capital gains + the (signed) AMIT cost-base amount. Display convenience. */
export function totalDistributionCents(c: AmmaComponents): number {
  return ordinaryAssessableCents(c) + c.capital_gain_discounted_cents + c.capital_gain_other_cents + c.amit_cost_base_net_amount_cents;
}

export interface ComponentValidation {
  ok: boolean;
  reason?: "negative" | "all_zero";
}

/**
 * Validate a components payload. Income / capital-gain / credit buckets must be non-negative (AMMA statements
 * don't distribute capital LOSSES to members; a loss is never routed here). The AMIT cost-base amount may be
 * negative (a cost-base increase). All-zero is rejected (nothing to record). Currency (AUD-only) is enforced
 * by the caller, which has the income row's currency.
 */
export function validateComponents(c: AmmaComponents): ComponentValidation {
  const nonNeg = [
    c.franked_cents, c.unfranked_cents, c.interest_cents, c.other_income_cents, c.foreign_income_cents,
    c.franking_credit_cents, c.foreign_tax_paid_cents, c.capital_gain_discounted_cents, c.capital_gain_other_cents,
  ];
  if (nonNeg.some((n) => n < 0)) return { ok: false, reason: "negative" };
  const anyNonZero = nonNeg.some((n) => n > 0) || c.amit_cost_base_net_amount_cents !== 0;
  if (!anyNonZero) return { ok: false, reason: "all_zero" };
  return { ok: true };
}

/**
 * The CGT events to materialise for a distribution's capital-gain components — one per NON-ZERO bucket, with
 * cost_base_used_cents = 0 (the gain itself is the distributed amount) and an EXPLICIT discount_eligible
 * (managed-fund units have no single acquisition date, so the date-derive path can't be relied on).
 */
export function ammaToCgtEvents(c: AmmaComponents): Pick<CgtEventInput, "proceeds_cents" | "cost_base_used_cents" | "discount_eligible">[] {
  const events: Pick<CgtEventInput, "proceeds_cents" | "cost_base_used_cents" | "discount_eligible">[] = [];
  if (c.capital_gain_discounted_cents > 0) events.push({ proceeds_cents: c.capital_gain_discounted_cents, cost_base_used_cents: 0, discount_eligible: true });
  if (c.capital_gain_other_cents > 0) events.push({ proceeds_cents: c.capital_gain_other_cents, cost_base_used_cents: 0, discount_eligible: false });
  return events;
}

/** Parse a components blob (e.g. income.detail_json) into AmmaComponents, defaulting missing fields to 0.
 *  Returns null if the blob is absent or carries no `components` object (a legacy single-gross row). */
export function parseAmmaComponents(detailJson: string | null | undefined): AmmaComponents | null {
  if (!detailJson) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(detailJson); } catch { return null; }
  const raw = (parsed as { components?: Record<string, unknown> } | null)?.components ?? null;
  if (!raw || typeof raw !== "object") return null;
  const n = (k: string): number => {
    const v = (raw as Record<string, unknown>)[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  return {
    franked_cents: n("franked_cents"),
    unfranked_cents: n("unfranked_cents"),
    interest_cents: n("interest_cents"),
    other_income_cents: n("other_income_cents"),
    foreign_income_cents: n("foreign_income_cents"),
    franking_credit_cents: n("franking_credit_cents"),
    foreign_tax_paid_cents: n("foreign_tax_paid_cents"),
    capital_gain_discounted_cents: n("capital_gain_discounted_cents"),
    capital_gain_other_cents: n("capital_gain_other_cents"),
    amit_cost_base_net_amount_cents: n("amit_cost_base_net_amount_cents"),
  };
}
