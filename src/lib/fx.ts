import type { Env } from "../env";

export interface FxResult {
  amount_aud_cents: number | null;
  fx_rate: number | null; // 1 unit of `currency` -> AUD; 1 for AUD, null if unavailable
  fx_date: string | null; // the date the rate actually applies to
}

const norm = (c: string | null | undefined) => (c ?? "AUD").trim().toUpperCase();

/**
 * Convert an original-currency amount to AUD cents using a daily ECB rate (Frankfurter,
 * free + keyless). AUD passes through. Rates are cached in KV — a past day's rate never
 * changes. This is an ESTIMATE to display alongside the receipt; the authoritative AUD is
 * the matched QBO bank-feed line (Quillo is a reconciler). On any failure we return the
 * original cents as a best-effort value with fx_rate=null so the caller can flag it.
 */
export async function toAud(
  env: Env,
  amountCents: number | null,
  currency: string | null,
  date: string | null,
): Promise<FxResult> {
  if (amountCents == null) return { amount_aud_cents: null, fx_rate: null, fx_date: null };
  const cur = norm(currency);
  if (cur === "AUD") return { amount_aud_cents: amountCents, fx_rate: 1, fx_date: null };

  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "latest";
  const cacheKey = `fx:${cur}:AUD:${day}`;
  try {
    const cached = await env.RULES.get(cacheKey);
    if (cached) {
      const c = JSON.parse(cached) as { rate: number; date: string | null };
      return { amount_aud_cents: Math.round(amountCents * c.rate), fx_rate: c.rate, fx_date: c.date };
    }
    const res = await fetch(`https://api.frankfurter.app/${day}?from=${cur}&to=AUD`);
    if (res.ok) {
      const j = (await res.json()) as { date?: string; rates?: Record<string, number> };
      const rate = j.rates?.AUD ?? null;
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
  // Couldn't convert a FOREIGN amount. Never fabricate an AUD value: returning the raw foreign cents
  // here was summed 1:1 into the tax position (a USD/GBP receipt counted as if it were AUD). Leave
  // amount_aud_cents NULL + fx_rate NULL so the caller flags the row for review and the sum paths
  // exclude-and-surface it rather than silently over/under-stating the position.
  return { amount_aud_cents: null, fx_rate: null, fx_date: null };
}
