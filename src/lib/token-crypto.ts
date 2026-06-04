import type { Env } from "../env";

// Application-layer envelope encryption for the QuickBooks OAuth tokens stored in D1.
// Cloudflare already encrypts D1 at rest; this adds a SECOND, app-held key (the QBO_TOKEN_KEY
// Worker secret) so the tokens are unreadable even to anything that can read the raw D1 rows.
//
// AES-256-GCM. A fresh 12-byte IV is generated per encryption and PREPENDED to the ciphertext, so
// each sealed value is self-describing (no separate IV column needed). `enc_ver` on the row marks
// the storage format: 0 = legacy plaintext, 1 = sealed by this module.
//
// Activation is graceful: with no QBO_TOKEN_KEY set, writes stay plaintext (enc_ver=0) so QBO keeps
// working; once the secret is configured, new writes seal (enc_ver=1) and the dual-read below
// transparently handles both. Set it with:  npx wrangler secret put QBO_TOKEN_KEY  (any high-entropy
// string — it's hashed to a 256-bit key, so length doesn't matter). Tokens are NEVER logged.

const IV_BYTES = 12;

export function tokenEncryptionEnabled(env: Env): boolean {
  return !!env.QBO_TOKEN_KEY;
}

async function aesKey(env: Env): Promise<CryptoKey> {
  // Derive a stable 256-bit key from the secret (any length) via SHA-256. The secret never leaves
  // the Worker; the derived key is non-extractable.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.QBO_TOKEN_KEY));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Encrypt a token → base64(iv ++ ciphertext+tag). Requires QBO_TOKEN_KEY to be set. */
export async function sealToken(env: Env, plaintext: string): Promise<string> {
  const key = await aesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return toB64(packed);
}

/** Decrypt a base64(iv ++ ciphertext) value produced by sealToken. */
export async function openToken(env: Env, sealed: string): Promise<string> {
  const key = await aesKey(env);
  const packed = fromB64(sealed);
  const iv = packed.slice(0, IV_BYTES);
  const ct = packed.slice(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/**
 * Read a stored token back to plaintext, honouring its enc_ver: 0 (or null) = legacy plaintext
 * passthrough; 1 = AES-GCM sealed → decrypt. Null value → null (e.g. a cleared access token).
 */
export async function readToken(env: Env, value: string | null, encVer: number | null): Promise<string | null> {
  if (value == null) return null;
  if ((encVer ?? 0) === 0) return value;
  // enc_ver=1 means this value was sealed with QBO_TOKEN_KEY. If the key is now missing (unset or a
  // new env without it), fail with a clear, actionable error rather than an opaque GCM exception
  // from hashing `undefined`. Callers (connection/revoke) surface this so the fix is obvious:
  // restore the key, or reconnect to re-issue tokens.
  if (!tokenEncryptionEnabled(env))
    throw new Error("QBO_TOKEN_KEY is not set but a stored QuickBooks token is encrypted (enc_ver=1) — restore the secret or reconnect QuickBooks.");
  return openToken(env, value);
}
