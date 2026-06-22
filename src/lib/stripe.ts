import type { Env } from "../env";

// Minimal Stripe integration via fetch (no SDK): a Checkout Session for an AI-credit top-up, and
// webhook signature verification. Entirely inert until STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET exist,
// so this ships dark and is "activated" purely by setting the two secrets (see the activation runbook).

const STRIPE_API = "https://api.stripe.com/v1";

export interface StripeEvent {
  type: string;
  data?: { object?: Record<string, unknown> };
}

/** Create a Stripe Checkout Session for a top-up of `amountCents` (AUD). Returns the hosted URL, or
 *  null when Stripe isn't configured. The credited amount (e4 units) + user ride in metadata so the
 *  webhook can apply them. */
export async function createTopupCheckout(env: Env, userId: string, amountCents: number): Promise<string | null> {
  if (!env.STRIPE_SECRET_KEY) return null;
  const cents = Math.max(100, Math.round(amountCents || 0)); // Stripe minimum ~$1
  const creditE4 = cents * 10_000; // wallet is in 1e-4-cent units
  const success = env.BILLING_SUCCESS_URL || "https://app.quillo.au/billing?topup=ok";
  const cancel = env.BILLING_CANCEL_URL || "https://app.quillo.au/billing?topup=cancel";
  const body = new URLSearchParams({
    mode: "payment",
    "line_items[0][price_data][currency]": "aud",
    "line_items[0][price_data][product_data][name]": "Quillo AI credits",
    "line_items[0][price_data][unit_amount]": String(cents),
    "line_items[0][quantity]": "1",
    success_url: success,
    cancel_url: cancel,
    "metadata[user_id]": userId,
    "metadata[credit_e4]": String(creditE4),
  });
  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`stripe checkout failed (${res.status})`);
  const j = (await res.json()) as { url?: string };
  return j.url ?? null;
}

/** Verify a Stripe webhook signature (HMAC-SHA256 over `${t}.${payload}`, the `v1=` scheme) and return
 *  the parsed event — or null if not configured, malformed, or the signature doesn't match. */
export async function verifyStripeWebhook(env: Env, payload: string, sigHeader: string | null): Promise<StripeEvent | null> {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !sigHeader) return null;
  const parts: Record<string, string> = {};
  for (const kv of sigHeader.split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== v1.length) return null;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  if (diff !== 0) return null;
  // Reject events older than 5 minutes (replay guard).
  const ts = Number(t);
  if (Number.isFinite(ts) && Math.abs(Date.now() / 1000 - ts) > 300) return null;
  try { return JSON.parse(payload) as StripeEvent; } catch { return null; }
}
