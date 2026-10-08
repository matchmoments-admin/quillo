import type { Env } from "../env";
import { featureOn } from "./features";

// Application-layer envelope encryption for the QuickBooks OAuth tokens stored in D1.
// Cloudflare already encrypts D1 at rest; this adds a SECOND, app-held key (the QBO_TOKEN_KEY
// Worker secret) so the tokens are unreadable even to anything that can read the raw D1 rows.
//
// AES-256-GCM. A fresh 12-byte IV is generated per encryption and PREPENDED to the ciphertext, so
// each sealed value is self-describing (no separate IV column needed). `enc_ver` on the row marks
// the storage format: 0 = legacy plaintext, 1 = sealed by this module.
//
// Activation order (docs/security/secrets-and-encryption.md):
//   1. set the secret   openssl rand -base64 32, then  npx wrangler secret put QBO_TOKEN_KEY
//                       (any high-entropy string — it's hashed to a 256-bit key)
//   2. backfill         POST /api/admin/qbo-token-backfill?dry_run=1, then without dry_run — seals any
//                       legacy enc_ver=0 rows in place (idempotent, counts-only output)
//   3. fail closed      add `qbo_token_fail_closed` to FEATURES — from then on a token write with no key
//                       is REFUSED (TokenKeyMissingError) instead of being stored in plaintext.
// With the flag OFF and no key, writes stay plaintext (enc_ver=0) exactly as before — the flag exists
// only so prod can't break between deploying this and setting the secret. Tokens are NEVER logged.
//
// Plaintext detection is by `enc_ver`, not by guessing at the value: an Intuit refresh token is an
// alphanumeric string that can look like base64. Where the backfill needs to second-guess a row it
// uses the GCM authentication tag (looksSealedWith) — a plaintext never authenticates.

const IV_BYTES = 12;

export function tokenEncryptionEnabled(env: Env): boolean {
  return !!env.QBO_TOKEN_KEY;
}

/** Thrown when a token write is refused because no key is configured and fail-closed is on. */
export class TokenKeyMissingError extends Error {
  readonly code = "token_key_missing";
  constructor() {
    // User-safe copy: this message can reach the browser (e.g. the QBO purchases route returns e.message).
    // The operator signal is the error class / `code` plus the server-side log, not the text.
    super(TOKEN_STORAGE_BLOCKED_MESSAGE);
    this.name = "TokenKeyMissingError";
  }
}

/** True when token writes must be sealed or refused (flag `qbo_token_fail_closed`). */
export function tokenFailClosed(env: Env): boolean {
  return featureOn(env, "qbo_token_fail_closed");
}

/** True when a token write right now would be refused — check BEFORE starting an OAuth exchange. */
export function tokenStorageBlocked(env: Env): boolean {
  return !tokenEncryptionEnabled(env) && tokenFailClosed(env);
}

/** User-facing copy for a refused connect (never names the secret). */
export const TOKEN_STORAGE_BLOCKED_MESSAGE =
  "QuickBooks can't be connected right now: secure token storage isn't configured. Please try again later.";

/** A token pair as it should be written to qbo_connections. */
export interface StoredTokenPair {
  access: string | null;
  refresh: string;
  encVer: 0 | 1;
}

/**
 * The ONE write path for QBO tokens (connect + refresh). Seals both tokens with QBO_TOKEN_KEY
 * (enc_ver=1). With no key: refuses when fail-closed is on (TokenKeyMissingError), otherwise falls
 * back to legacy plaintext (enc_ver=0). Both tokens always share one enc_ver.
 */
export async function sealTokenPair(env: Env, access: string | null, refresh: string): Promise<StoredTokenPair> {
  if (tokenEncryptionEnabled(env)) {
    return {
      access: access == null ? null : await sealToken(env, access),
      refresh: await sealToken(env, refresh),
      encVer: 1,
    };
  }
  if (tokenFailClosed(env)) throw new TokenKeyMissingError();
  return { access, refresh, encVer: 0 };
}

/** enc_ver 0 / null ⇒ the row is stored in plaintext. */
export function isPlaintextEncVer(encVer: number | null | undefined): boolean {
  return (encVer ?? 0) === 0;
}

/**
 * True when `value` authenticates as a sealToken() output under the CURRENT key. AES-GCM's 128-bit
 * tag makes a false positive on a plaintext token cryptographically negligible, so this is a safe
 * "already sealed?" check for the backfill. Never throws.
 */
export async function looksSealedWith(env: Env, value: string): Promise<boolean> {
  if (!tokenEncryptionEnabled(env)) return false;
  try {
    await openToken(env, value);
    return true;
  } catch {
    return false;
  }
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
  if (isPlaintextEncVer(encVer)) return value;
  // enc_ver=1 means this value was sealed with QBO_TOKEN_KEY. If the key is now missing (unset or a
  // new env without it), fail with a clear, actionable error rather than an opaque GCM exception
  // from hashing `undefined`. Callers (connection/revoke) surface this so the fix is obvious:
  // restore the key, or reconnect to re-issue tokens.
  if (!tokenEncryptionEnabled(env))
    throw new Error("QBO_TOKEN_KEY is not set but a stored QuickBooks token is encrypted (enc_ver=1) — restore the secret or reconnect QuickBooks.");
  return openToken(env, value);
}
