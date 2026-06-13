import type { Env } from "../env";

export interface FxResult {
  // LEGACY NAME, base-currency meaning: the amount in the tenant's BASE currency (AUD for AU, GBP for
  // UK), in cents. The column/field is still called `amount_aud_cents` because the ~17
  // SUM(COALESCE(amount_aud_cents,…)) sites are currency-agnostic, so generalising the *meaning* in
  // place (no rename, no migration) is correct and cheaper than a 40-site rename for no functional gain.
  amount_aud_cents: number | null;
  fx_rate: number | null; // 1 unit of `currency` -> base; 1 when currency IS the base, null if unavailable
  fx_date: string | null; // the date the rate actually applies to
}

const norm = (c: string | null | undefined) => (c ?? "AUD").trim().toUpperCase();

/**
 * Convert an original-currency amount to the tenant's BASE currency (cents) using a daily ECB rate
 * (Frankfurter, free + keyless; supports any ECB cross-pair, so to=GBP / to=AUD both work). An amount
 * already denominated in the base passes through unchanged (rate 1, no fetch). Rates are cached in KV —
 * a past day's rate never changes. This is an ESTIMATE to display alongside the receipt; the
 * authoritative base amount is the matched bank-feed line (Quillo is a reconciler). On any failure we
 * return NULL base cents with fx_rate=null so the caller flags the row (excluded-and-surfaced, never
 * summed un-converted into the position).
 */
export async function toBaseCurrency(
  env: Env,
  amountCents: number | null,
  currency: string | null,
  base: string,
  date: string | null,
): Promise<FxResult> {
  if (amountCents == null) return { amount_aud_cents: null, fx_rate: null, fx_date: null };
  const cur = norm(currency);
  const baseCur = norm(base);
  // Base-currency passthrough (AUD→AUD for AU, GBP→GBP for UK): no rate, no fetch — byte-identical to
  // the legacy `cur === "AUD"` shortcut when base is 'AUD'.
  if (cur === baseCur) return { amount_aud_cents: amountCents, fx_rate: 1, fx_date: null };

  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "latest";
  const cacheKey = `fx:${cur}:${baseCur}:${day}`;
  try {
    const cached = await env.RULES.get(cacheKey);
    if (cached) {
      const c = JSON.parse(cached) as { rate: number; date: string | null };
      return { amount_aud_cents: Math.round(amountCents * c.rate), fx_rate: c.rate, fx_date: c.date };
    }
    const res = await fetch(`https://api.frankfurter.app/${day}?from=${cur}&to=${baseCur}`);
    if (res.ok) {
      const j = (await res.json()) as { date?: string; rates?: Record<string, number> };
      const rate = j.rates?.[baseCur] ?? null;
      if (rate != null) {
        const usedDate = j.date ?? (day === "latest" ? null : day);
        await env.RULES.put(cacheKey, JSON.stringify({ rate, date: usedDate }), {
          expirationTtl: 60 * 60 * 24 * 30,
        });
        return { amount_aud_cents: Math.round(amountCents * rate), fx_rate: rate, fx_date: usedDate };
      }
    }
  } catch {
    // network/parse failure — fall through to best-effort
  }
  // Couldn't convert a FOREIGN amount. Never fabricate a base value: returning the raw foreign cents
  // here was summed 1:1 into the tax position (a USD/GBP receipt counted as if it were base). Leave
  // amount_aud_cents NULL + fx_rate NULL so the caller flags the row for review and the sum paths
  // exclude-and-surface it rather than silently over/under-stating the position.
  return { amount_aud_cents: null, fx_rate: null, fx_date: null };
}

// (The legacy `toAud` wrapper was removed in stop 2 — the two live ingest call sites now pass the
// tenant's resolved base to toBaseCurrency directly; toBaseCurrency(env, c, cur, 'AUD', date) is the
// exact former behaviour for any future AUD-specific need.)
