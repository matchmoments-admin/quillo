// Bind an OAuth / hosted-consent `state` to the browser that started the connect (security sweep #694,
// finding S-04 / #712).
//
// THE GAP. The QuickBooks and bank-feed callbacks are public routes: the provider sends the browser back as a
// top-level navigation with no Authorization header, so the callback recovers the tenant from the `state`
// handle alone. That proves the state is one WE issued, but not that the browser presenting it is the one
// that asked for it. Tenant A could start a connect, send the provider's authorize link to V, and if V
// approved, V's QuickBooks tokens (or bank consent) would be stored under A's tenant (account-linking CSRF).
//
// THE FIX. When the connect starts, the Worker mints a random nonce, stores only its SHA-256 with the state,
// and sets the nonce in a short-lived `__Host-` cookie:
//   __Host- prefix      the browser only accepts it when Secure, Path=/ and with NO Domain, so a sibling
//                       subdomain (or an http:// page) can't plant or overwrite the binding (cookie tossing)
//   HttpOnly            the SPA's scripts can't read it
//   Secure              never sent over plain HTTP (localhost counts as secure in browsers, so wrangler dev works)
//   SameSite=Lax        sent on the provider's top-level GET redirect back to us; never on a cross-site subrequest
//   Path=/              required by __Host-. It is therefore sent with every same-site request to the app,
//                       but only the callback (`callback` below) ever reads it, and it carries no identity
//   Max-Age=<state TTL> gone when the state is
// The callback requires the cookie's hash to equal the stored hash. V's browser never received A's cookie, so
// the forwarded link is refused. The app otherwise uses Bearer tokens, so these are its only cookies, and
// they carry no identity: a nonce is useless without the state it was minted with.
//
// The state stays single-use (consumed on first read, match or not) and short-lived, as before.

export interface BindingCookie {
  name: string;
  /** Cookie Path: always "/" (the __Host- prefix requires it). */
  path: "/";
  /** The one route that reads the cookie (documentation; not a cookie attribute). */
  callback: string;
}

export const QBO_BINDING: BindingCookie = { name: "__Host-quillo_qbo_bind", path: "/", callback: "/api/qbo/callback" };
export const BANK_BINDING: BindingCookie = { name: "__Host-quillo_bank_bind", path: "/", callback: "/api/bank/callback" };

/** What the callback says when the binding is missing or wrong (shown on the page the user lands on). */
export const BINDING_MISMATCH = "this connection was started in a different browser, or has expired. Start it again from Quillo in this browser";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashNonce(nonce: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A fresh 256-bit nonce (for the cookie) and its hash (for KV, next to the state). */
export async function mintBinding(): Promise<{ nonce: string; hash: string }> {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { nonce, hash: await hashNonce(nonce) };
}

const NONCE_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;

/** Constant-time check that `nonce` hashes to `expectedHash`. Anything missing or malformed is a mismatch. */
export async function bindingMatches(nonce: string | null | undefined, expectedHash: string | null | undefined): Promise<boolean> {
  if (!nonce || !expectedHash || !NONCE_SHAPE.test(nonce) || !/^[0-9a-f]{64}$/.test(expectedHash)) return false;
  const got = await hashNonce(nonce);
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= got.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  return diff === 0;
}

export function bindingSetCookie(c: BindingCookie, nonce: string, maxAgeSeconds: number): string {
  const ttl = Math.min(3600, Math.max(60, Math.floor(maxAgeSeconds) || 600));
  return `${c.name}=${nonce}; Path=${c.path}; Max-Age=${ttl}; HttpOnly; Secure; SameSite=Lax`;
}

export function bindingClearCookie(c: BindingCookie): string {
  return `${c.name}=; Path=${c.path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** Read one cookie value from the request (first match; no decoding, the nonce is base64url). */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/**
 * The value stored under the state key: the tenant plus the binding hash. Legacy values (a bare user id,
 * minted before this change) have no binding and are refused, which only affects a connect that was in
 * flight across the deploy (the user starts it again).
 */
export function encodeBoundState(userId: string, bindHash: string): string {
  return JSON.stringify({ u: userId, b: bindHash });
}

export function decodeBoundState(raw: string | null): { userId: string; bindHash: string } | null {
  if (!raw || raw[0] !== "{") return null;
  try {
    const v = JSON.parse(raw) as { u?: unknown; b?: unknown };
    if (typeof v.u === "string" && v.u && typeof v.b === "string" && v.b) return { userId: v.u, bindHash: v.b };
  } catch {
    /* fall through */
  }
  return null;
}

/** A 302 to `location` that also clears the binding cookie (Response.redirect's headers are immutable). */
export function redirectClearingBinding(location: string, c: BindingCookie): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Set-Cookie": bindingClearCookie(c) } });
}
