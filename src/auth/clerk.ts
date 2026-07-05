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
 * Access model: OPEN self-service signup. Any Clerk-verified user may use /api/* and gets their
 * OWN isolated tenant (keyed by their sub); the founder sub maps to the legacy pilot tenant "me"
 * for data continuity. Spend is bounded by the per-tenant + global daily/monthly cost caps
 * (MAX_DAILY_COST_CENTS etc.) and the `billing` free-credit/top-up gate, not by who you are.
 *
 * Kill-switch: CLERK_ALLOWED_USERS is an OPTIONAL allow-list. Empty/unset ⇒ open (the default).
 * Set it to a comma-separated list of subs to RE-LOCK /api/* to those users only (e.g. to pause
 * signups or run a closed beta again) — instant via config, no code change.
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

// The founder's Clerk sub maps to the legacy pilot tenant "me". Hard default (overridable via
// CLERK_FOUNDER_SUB) so an empty/missing var can never collapse other testers onto "me".
const FOUNDER_SUB_DEFAULT = "user_3EX9q24hvBuYNz3Hk6Pg6O5FfBq";

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

  // Optional allow-list (kill-switch). Empty/unset ⇒ OPEN access: any Clerk-verified user is let
  // through to their own tenant. A NON-empty list re-locks /api/* to exactly those subs (closed
  // beta / paused signups). The founder→"me" mapping below is independent of this gate.
  const allowed = (env.CLERK_ALLOWED_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(sub)) {
    // Log the verified sub so a would-be tester's id can be captured while the list is active.
    console.log(`clerk: verified but not allowlisted — sub=${sub} email=${email}`);
    return { ok: false, status: 403 };
  }

  // Per-tenant identity, fail-CLOSED for isolation: ONLY the founder's sub maps to the pilot tenant
  // "me" (data continuity); every other allow-listed user always gets their OWN tenant keyed by their
  // Clerk sub — they can never collide on "me". The founder sub defaults to the known literal so a
  // missing/empty CLERK_FOUNDER_SUB can't silently merge two humans into "me".
  const founderSub = env.CLERK_FOUNDER_SUB?.trim() || FOUNDER_SUB_DEFAULT;
  const userId = sub === founderSub ? "me" : sub;
  return { ok: true, user: { email, userId } };
}
