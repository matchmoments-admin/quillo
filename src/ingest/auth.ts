import type { Env } from "../env";
import { hexToBytes } from "../lib/base64";

export interface VerifiedIngest {
  userId: string;
  keyId: string;
}

const MAX_SKEW_MS = 60_000;   // ±60s window
const NONCE_TTL_S = 300;      // KV nonce retention (> skew window)

/**
 * Verify a signed /ingest request and DERIVE the tenant from the key.
 *
 * Fixes review blockers:
 *  - B1 (tenant spoofing): user_id comes from the tenant_keys row that the
 *    signature validates against — never from a client `x-user-id` header.
 *  - B3 (replay): the signature covers `${timestamp}.${nonce}.${body}`, the
 *    timestamp must be within ±60s, and each nonce is single-use (KV dedup).
 *
 * Client computes:  HMAC-SHA256(secret, `${x-timestamp}.${x-nonce}.` + rawBody)
 * and sends hex in `x-signature`, plus `x-key-id`, `x-timestamp`, `x-nonce`.
 *
 * The body is read ONCE by the caller and passed in here (fixes the §3 clone/
 * re-read ordering bug).
 */
export async function verifyIngest(
  env: Env,
  req: Request,
  rawBody: ArrayBuffer,
  now: number,
): Promise<VerifiedIngest | null> {
  const keyId = req.headers.get("x-key-id");
  const ts = req.headers.get("x-timestamp");
  const nonce = req.headers.get("x-nonce");
  const sigHex = req.headers.get("x-signature");
  if (!keyId || !ts || !nonce || !sigHex) return null;

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > MAX_SKEW_MS) return null;

  const sig = hexToBytes(sigHex);
  if (!sig) return null;

  const row = await env.DB.prepare(
    `SELECT user_id, secret FROM tenant_keys WHERE key_id = ? AND revoked_at IS NULL`
  )
    .bind(keyId)
    .first<{ user_id: string; secret: string }>();
  if (!row) return null;

  // Anti-replay: nonce must not have been seen for this key.
  const nonceKey = `nonce:${keyId}:${nonce}`;
  if (await env.RULES.get(nonceKey)) return null;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(row.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const prefix = enc.encode(`${ts}.${nonce}.`);
  const body = new Uint8Array(rawBody);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix, 0);
  signed.set(body, prefix.length);

  // subtle.verify is constant-time.
  const ok = await crypto.subtle.verify("HMAC", key, sig, signed);
  if (!ok) return null;

  await env.RULES.put(nonceKey, "1", { expirationTtl: NONCE_TTL_S });
  return { userId: row.user_id, keyId };
}
