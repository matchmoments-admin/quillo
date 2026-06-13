// ── Jurisdiction descriptor — the tax-period seam (UK epic, stop 1) ────────────
// A JurisdictionDescriptor is a property of a TAXABLE UNIT (Xero/MYOB/QBO model: one organisation =
// one country edition = one home jurisdiction + one base currency + one financial-year setting, fixed
// at setup; foreign activity is handled by multi-currency inside that unit, never by mixing two tax
// regimes in one ledger). In Quillo the primary taxable unit is the individual's personal return, so
// the descriptor is resolved from `profiles.jurisdiction` (the home jurisdiction). Entities/assets carry
// their own `jurisdiction` columns already, so a foreign company/property is its own unit — a per-entity
// descriptor override is a later stop, not a rewrite (the resolver takes a code, not a tenant).
//
// THIS STOP consumes only `taxPeriod`. `baseCurrency`/`rulePackId` are populated but inert so the later
// currency / rule-pack stops thread the SAME object instead of inventing parallel plumbing.
//
// AU is byte-identical: the AU descriptor reproduces the legacy hardcoded Jul–Jun bounds exactly, and
// the `jurisdiction_period` flag forces AU when OFF (see resolveJurisdictionForUser).

import type { Env } from "../env";
import { featureOn } from "./features";

/** A tax period that straddles two calendar years, starting on startMonth/startDay (AU 7/1; UK 4/6). */
export interface StraddleTaxPeriod {
  kind: "straddle";
  startMonth: number; // 1-12
  startDay: number; // 1-31
}
/** A tax period aligned to the calendar year (reserved for US/IE etc — NOT used this stop). */
export interface CalendarTaxPeriod {
  kind: "calendar";
}
export type TaxPeriod = StraddleTaxPeriod | CalendarTaxPeriod;

/**
 * The consumption-tax shape of a jurisdiction — structural metadata only, INERT this stop. The *rate*
 * deliberately lives in the rule pack (KV `rulepack:<id>`), NOT here, so we never recreate the
 * period/pack split-brain (the descriptor selects the engine; the pack carries volatile rates).
 *   - 'input-credit' → a VAT/GST with input credits (AU GST, UK VAT, CA GST/HST, IE VAT).
 *   - 'sales-tax'    → a US-style retail sales tax (no input-credit mechanism for individuals).
 *   - 'none'         → no consumption tax (HK; irrelevant to individuals).
 * `gst.ts` is NOT rewired to read this yet — that's the consumption-tax + labels stop.
 */
export interface ConsumptionTax {
  kind: "input-credit" | "none" | "sales-tax";
  label: string; // 'GST' | 'VAT' — the user-facing name of the tax
}

export interface JurisdictionDescriptor {
  code: string; // 'AU' | 'UK'
  taxPeriod: TaxPeriod;
  baseCurrency: string; // 'AUD' | 'GBP' — the tenant's BASE currency. Consumed by the currency-de-anchoring stop
                        // via baseCurrencyOf(); IMMUTABLE per taxable unit (fixed at the first ingest — a
                        // jurisdiction change would need a base-conversion migration, not a live re-read).
  rulePackId: string; // 'au-v1' | 'uk-2025' — RESERVED (mirrors profiles.rule_pack_ver, for later stops)
  consumptionTax: ConsumptionTax; // INERT this stop (structural metadata; rate lives in the rule pack)
}

export const AU_DESCRIPTOR: JurisdictionDescriptor = {
  code: "AU",
  taxPeriod: { kind: "straddle", startMonth: 7, startDay: 1 },
  baseCurrency: "AUD",
  rulePackId: "au-v1",
  consumptionTax: { kind: "input-credit", label: "GST" },
};

export const UK_DESCRIPTOR: JurisdictionDescriptor = {
  code: "UK",
  taxPeriod: { kind: "straddle", startMonth: 4, startDay: 6 }, // 6 April – 5 April
  baseCurrency: "GBP",
  rulePackId: "uk-2025",
  consumptionTax: { kind: "input-credit", label: "VAT" },
};

const BY_CODE: Record<string, JurisdictionDescriptor> = { AU: AU_DESCRIPTOR, UK: UK_DESCRIPTOR };

/** Resolve a descriptor from a jurisdiction code (case-insensitive). Unknown/blank ⇒ AU. */
export function resolveJurisdiction(code: string | null | undefined): JurisdictionDescriptor {
  if (!code) return AU_DESCRIPTOR;
  return BY_CODE[String(code).toUpperCase()] ?? AU_DESCRIPTOR;
}

/**
 * The effective BASE currency for the tenant — the SINGLE chokepoint every base-currency read routes
 * through (no inlined `descriptor.baseCurrency` or `'AUD'` literal anywhere else). The `currency_base`
 * flag is the master gate: OFF ⇒ always 'AUD' (byte-identical, ignores the descriptor) — even for a
 * UK-jurisdiction tenant. ON ⇒ the descriptor's base (AU 'AUD', UK 'GBP'). ON + AU profile ⇒ 'AUD',
 * still byte-identical.
 *
 * Immutability note: a taxable unit's base currency is fixed at its first ingest (Xero/MYOB/QBO model:
 * base currency is set at org setup and never changes live). amount_aud_cents stores base-currency cents
 * under that fixed base; a future jurisdiction change for an existing tenant needs a base-CONVERSION
 * migration of stored rows, never a live re-read through a different base. This helper is the swap point
 * for a per-row base snapshot (US epic) if that's ever needed.
 */
export function baseCurrencyOf(env: Env, descriptor: JurisdictionDescriptor): string {
  return featureOn(env, "currency_base") ? descriptor.baseCurrency : "AUD";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Calendar bounds (inclusive, 'YYYY-MM-DD') of the FY whose start-year is `startYear`. */
export function fyBoundsFor(descriptor: JurisdictionDescriptor, startYear: number): { start: string; end: string } {
  const p = descriptor.taxPeriod;
  if (p.kind === "calendar") {
    return { start: `${startYear}-01-01`, end: `${startYear}-12-31` };
  }
  const start = `${startYear}-${pad2(p.startMonth)}-${pad2(p.startDay)}`;
  // End = the day before the next period's start (AU 6/30; UK 4/5). Date math via UTC keeps it TZ-safe.
  const nextStart = new Date(Date.UTC(startYear + 1, p.startMonth - 1, p.startDay));
  const endMs = nextStart.getTime() - 24 * 60 * 60 * 1000;
  const end = new Date(endMs);
  const endStr = `${end.getUTCFullYear()}-${pad2(end.getUTCMonth() + 1)}-${pad2(end.getUTCDate())}`;
  return { start, end: endStr };
}

/**
 * The start-year of the FY that contains an ISO date ('YYYY-MM-DD'), under this jurisdiction's period.
 * AU: a Jul-1 date is the new FY, Jun-30 is the prior FY. UK: Apr-6 is new, Apr-5 is prior (the
 * boundary-day test a naive month-only gate gets wrong). NaN if the date is missing/unparseable.
 */
export function fyStartYearForDate(descriptor: JurisdictionDescriptor, dateIso: string | null | undefined): number {
  // Anchored exactly like the legacy report.fyForDate (`^\d{4}-\d{2}-\d{2}$`) so a malformed/datetime
  // string is rejected identically (→ NaN ⇒ callers fall back) — preserves AU byte-identical behaviour.
  if (!dateIso || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) return NaN;
  const y = Number(dateIso.slice(0, 4));
  const mo = Number(dateIso.slice(5, 7));
  const day = Number(dateIso.slice(8, 10));
  const p = descriptor.taxPeriod;
  if (p.kind === "calendar") return y;
  const onOrAfterStart = mo > p.startMonth || (mo === p.startMonth && day >= p.startDay);
  return onOrAfterStart ? y : y - 1;
}

/**
 * A SQL integer expression for the FY start-year of a 'YYYY-MM-DD…' date column, under this period.
 * Replaces the hardcoded `substr(created_at,6,2) >= 7` month gate so analytics group by the right FY.
 * AU reproduces the legacy expression exactly (month-only suffices when the boundary day is the 1st).
 */
export function fyStartYearSqlExpr(descriptor: JurisdictionDescriptor, dateCol: string): string {
  const y = `CAST(substr(${dateCol},1,4) AS INTEGER)`;
  const p = descriptor.taxPeriod;
  if (p.kind === "calendar") return y;
  const mo = `CAST(substr(${dateCol},6,2) AS INTEGER)`;
  const day = `CAST(substr(${dateCol},9,2) AS INTEGER)`;
  // on-or-after the period start in the same calendar year ⇒ that year is the start-year, else year-1.
  const onOrAfter =
    p.startDay <= 1
      ? `${mo} >= ${p.startMonth}`
      : `(${mo} > ${p.startMonth} OR (${mo} = ${p.startMonth} AND ${day} >= ${p.startDay}))`;
  return `${y} - (CASE WHEN ${onOrAfter} THEN 0 ELSE 1 END)`;
}

/** The start-year of the FY that contains `now`, under this jurisdiction's period. */
export function currentFyStartYearFor(descriptor: JurisdictionDescriptor, now = new Date()): number {
  const iso = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
  return fyStartYearForDate(descriptor, iso);
}

/**
 * Resolve the descriptor for a tenant from `profiles.jurisdiction`. The `jurisdiction_period` flag is
 * the master gate: OFF ⇒ always AU (byte-identical, ignores the stored code). Guarded for the test
 * harness (no profile row / no DB) → AU. Mirrors report.ts resolveRulePack.
 */
export async function resolveJurisdictionForUser(env: Env, userId: string): Promise<JurisdictionDescriptor> {
  if (!featureOn(env, "jurisdiction_period")) return AU_DESCRIPTOR;
  try {
    const p = await env.DB.prepare(`SELECT jurisdiction FROM profiles WHERE user_id = ?`).bind(userId).first<{ jurisdiction: string | null }>();
    return resolveJurisdiction(p?.jurisdiction);
  } catch {
    return AU_DESCRIPTOR;
  }
}
