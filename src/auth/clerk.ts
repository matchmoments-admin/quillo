import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../env";
import type { AuthedUser } from "./access";

/**
 * Authenticate a web request via Clerk, then enforce a single-user allowlist.
 *
 * Mirrors the Cloudflare Access seam (src/auth/access.ts) but verifies a Clerk session
 * JWT: the SPA sends `Authorization: Bearer <token>` (a short-lived Clerk session token);
 * we verify it against the Clerk instance's JWKS and check the issuer + authorized party.
 *
 * Lockdown until launch: only Clerk user ids in CLERK_ALLOWED_USERS may use /api/*. Any
 * other (verified-but-not-allowed) user is rejected, so they cannot spend API credits.
 * The allowed founder maps to the existing pilot tenant "me" (preserves their data); real
 * per-user tenants come later.
 *
 * Local dev: when CLERK_ISSUER is unset there is no auth in front, so we fall back to the
 * pilot tenant "me" (unchanged dev ergonomics).
 */

// Cache the JWKS per issuer across requests (module scope survives within an isolate).
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksFor = "";

const ALLOWED_AZP = new Set([
  "https://app.quillo.au",
  "http://localhost:5173", // vite dev
  "http://localhost:8787", // wrangler dev
]);

export type ClerkAuthResult =
  | { ok: true; user: AuthedUser }
  | { ok: false; status: 401 | 403 };

export async function requireClerk(req: Request, env: Env): Promise<ClerkAuthResult> {
  if (!env.CLERK_ISSUER) {
    return { ok: true, user: { email: "dev@local", userId: "me" } }; // local dev, no auth in front
  }

  const auth = req.headers.get("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return { ok: false, status: 401 };

  const issuer = env.CLERK_ISSUER.replace(/\/$/, "");
  const jwksUrl = `${issuer}/.well-known/jwks.json`;
  if (!jwks || jwksFor !== jwksUrl) {
    jwks = createRemoteJWKSet(new URL(jwksUrl));
    jwksFor = jwksUrl;
  }

  let sub: string;
  let email = "";
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer });
    // azp (authorized party) must be one of our known origins (when present).
    const azp = typeof payload.azp === "string" ? payload.azp : null;
    if (azp && !ALLOWED_AZP.has(azp)) return { ok: false, status: 401 };
    if (typeof payload.sub !== "string") return { ok: false, status: 401 };
    sub = payload.sub;
    if (typeof payload.email === "string") email = payload.email;
  } catch {
    return { ok: false, status: 401 };
  }

  // Single-user lockdown: only allowlisted Clerk users may use the API.
  const allowed = new Set(
    (env.CLERK_ALLOWED_USERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (!allowed.has(sub)) {
    // Log the verified sub so the founder's id can be captured on first sign-in.
    console.log(`clerk: verified but not allowlisted — sub=${sub} email=${email}`);
    return { ok: false, status: 403 };
  }

  // Allowed founder → existing pilot tenant "me" (data carries over). Multi-tenant later.
  return { ok: true, user: { email, userId: "me" } };
}
