import type { Env } from "../env";
import type { AuthedUser } from "../auth/access";
import { featureOn } from "./features";
import { logTag } from "./security-headers";
import { SECURITY_KV, repoLink, type SecuritySourceRecord } from "./security-dashboard";

// ── Access control (#638, A5 of epic #633) ───────────────────────────────────────────────────────
//
// Three server-side controls, each behind its own flag so OFF ⇒ byte-identical:
//   1. admin_mfa_required — every /api/admin/* route additionally requires that the caller's Clerk
//      session shows a VERIFIED SECOND FACTOR (the `fva` claim, see clerk.ts). Checked AFTER isAdmin,
//      so a non-admin never learns the MFA rule exists (they still get 403 / 404 as before).
//   2. api_rate_limit     — general per-IP (pre-auth) and per-user (post-auth) request limits via the
//      Cloudflare Workers Rate Limiting binding (ADR-0003 §10 finding S6).
//   3. the `security:source:mfa` record for the Security & compliance dashboard (#636 contract).
//
// Standard: docs/security/access-control-standard.md. Cutover: docs/security/clerk-production-cutover.md.

export const ADMIN_MFA_MESSAGE =
  "Admin access needs multi-factor authentication. Turn on an authenticator app in your account " +
  "security settings, then sign out and sign back in using your second factor.";

/**
 * Did this Clerk session verify a second factor? Reads the v2 session-token `fva` claim
 * ("factor verification age"): `[firstFactorAgeMinutes, secondFactorAgeMinutes]`, where -1 means the
 * factor was never verified in this session (or the user has no second factor). Anything other than
 * a well-formed array with a non-negative second element is treated as NOT verified (fail closed) —
 * including a v1 token with no `fva` at all.
 */
export function secondFactorAgeMinutes(fva: unknown): number | null {
  if (!Array.isArray(fva) || fva.length < 2) return null;
  const second = fva[1];
  return typeof second === "number" && Number.isFinite(second) && second >= 0 ? second : null;
}

export function secondFactorVerified(fva: unknown): boolean {
  return secondFactorAgeMinutes(fva) !== null;
}

/**
 * How recently the second factor must have been verified for admin routes. Without a ceiling, one MFA
 * at sign-in would carry admin for the whole Clerk session (days) — a stolen session cookie would be as
 * good as MFA. Default 12 h (one working day); ADMIN_MFA_MAX_AGE_MIN overrides (positive integer).
 */
export const ADMIN_MFA_MAX_AGE_MIN_DEFAULT = 720;
export function adminMfaMaxAgeMin(env: Pick<Env, "ADMIN_MFA_MAX_AGE_MIN">): number {
  const n = Number(env.ADMIN_MFA_MAX_AGE_MIN);
  return Number.isInteger(n) && n > 0 ? n : ADMIN_MFA_MAX_AGE_MIN_DEFAULT;
}

export const ADMIN_MFA_STALE_MESSAGE =
  "Your second-factor check is too old for admin access. Sign out and sign back in using your second factor.";

const jsonRes = (data: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

/**
 * The MFA gate for an ALREADY-VERIFIED admin. Returns a 403 when `admin_mfa_required` is ON and the
 * session shows no second factor; null to let the request through. Flag OFF ⇒ always null (unchanged).
 * Callers must run their isAdmin check FIRST so non-admins keep their existing response.
 */
export function adminMfaBlock(env: Env, user: Pick<AuthedUser, "mfa" | "mfaAgeMin">): Response | null {
  if (!featureOn(env, "admin_mfa_required")) return null;
  if (user.mfa !== true || typeof user.mfaAgeMin !== "number") {
    return jsonRes({ error: ADMIN_MFA_MESSAGE, code: "admin_mfa_required" }, 403);
  }
  if (user.mfaAgeMin > adminMfaMaxAgeMin(env)) {
    return jsonRes({ error: ADMIN_MFA_STALE_MESSAGE, code: "admin_mfa_stale" }, 403);
  }
  return null;
}

// ── General API rate limiting (S6) ─────────────────────────────────────────────────────────────

/**
 * Paths the per-IP limiter covers: every Worker-handled request that can carry work or attempt auth.
 * Excluded: /healthz (uptime monitors), the Stripe webhook POST (server-to-server, signature-verified,
 * Stripe retries on 429 and we must not drop a paid top-up), and static assets (served by ASSETS).
 */
export function ipRateLimited(pathname: string, method: string): boolean {
  if (pathname === "/healthz") return false;
  if (pathname === "/api/stripe/webhook" && method === "POST") return false;
  if (pathname.startsWith("/api/")) return true;
  if (method !== "POST") return false;
  return pathname === "/ingest" || pathname === "/correct" || pathname === "/consent" || pathname === "/csp-report" || pathname === "/waitlist";
}

export const RATE_LIMIT_MESSAGE = "Too many requests — please slow down and try again in a minute.";
const tooMany = () => jsonRes({ error: RATE_LIMIT_MESSAGE, code: "rate_limited" }, 429, { "retry-after": "60" });

async function allowed(binding: RateLimit | undefined, key: string): Promise<boolean> {
  // No binding (an environment provisioned without it) or a binding error ⇒ ALLOW: the limiter is an
  // abuse brake, not an auth control, and failing closed would take the whole API down with it. The
  // AI spend caps + per-op KV limits (chatRateOk, bankRateOk) remain the hard ceilings regardless.
  if (!binding) return true;
  try {
    return (await binding.limit({ key })).success;
  } catch (e) {
    console.error(`rate limiter error: ${(e as Error).name}`);
    return true;
  }
}

/** Pre-auth, per client IP. Returns a 429 or null. Flag OFF ⇒ null without touching the binding. */
export async function ipRateLimit(req: Request, env: Env, pathname: string): Promise<Response | null> {
  if (!featureOn(env, "api_rate_limit")) return null;
  if (!ipRateLimited(pathname, req.method)) return null;
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  if (await allowed(env.API_IP_RATE_LIMITER, `ip:${ip}`)) return null;
  console.warn("rate limit hit (ip)"); // no IP in logs — log hygiene (A1)
  return tooMany();
}

/** Post-auth, per tenant (the server-derived userId — never a client value). Returns a 429 or null. */
export async function userRateLimit(env: Env, userId: string): Promise<Response | null> {
  if (!featureOn(env, "api_rate_limit")) return null;
  if (await allowed(env.API_USER_RATE_LIMITER, `user:${userId}`)) return null;
  console.warn(`rate limit hit (user) tenant_tag=${await logTag(userId)}`); // hashed tag, not the Clerk sub (A1 log hygiene)
  return tooMany();
}

// ── Dashboard source record (#636 contract: KV security:source:mfa) ────────────────────────────

export function clerkInstance(env: Pick<Env, "CLERK_ISSUER">): "production" | "development" | "not configured" {
  const issuer = env.CLERK_ISSUER ?? "";
  if (!issuer) return "not configured";
  return /\.clerk\.accounts\.dev/i.test(issuer) ? "development" : "production";
}

/** Build the access-control source record. Counts + flag states only — no ids, emails or names. */
export function accessSourceRecord(env: Env, adminAccounts: number, at: string): SecuritySourceRecord {
  const instance = clerkInstance(env);
  const mfaOn = featureOn(env, "admin_mfa_required");
  const rlOn = featureOn(env, "api_rate_limit");
  const ok = instance === "production" && mfaOn && rlOn;
  const parts = [
    `Clerk ${instance === "not configured" ? "not configured" : `${instance} instance`}`,
    mfaOn ? "MFA required for admin routes" : "admin MFA not enforced (admin_mfa_required OFF)",
    rlOn ? "API rate limiting on" : "API rate limiting off",
  ];
  return {
    at,
    status: ok ? "ok" : "warn",
    summary: parts.join(" · "),
    metrics: {
      mfa_enforced_for_admin: mfaOn,
      instance,
      admin_accounts: adminAccounts,
      api_rate_limit: rlOn,
    },
    evidence: [
      { label: "src/lib/access-control.ts (MFA gate + rate limits)", href: repoLink("src/lib/access-control.ts") },
      { label: "src/auth/clerk.ts (fva claim verification)", href: repoLink("src/auth/clerk.ts") },
      { label: "docs/security/access-control-standard.md", href: repoLink("docs/security/access-control-standard.md") },
      { label: "docs/security/clerk-production-cutover.md", href: repoLink("docs/security/clerk-production-cutover.md") },
    ],
  };
}

const REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Publish the record to KV `security:source:mfa`, but only when its content changed (a flag flip, a
 * new admin, the Clerk cutover) or it is a day old — the cron calls this every 10 minutes, so the
 * steady state is one KV read + one cheap D1 count per tick and ~1 write a day.
 */
export async function publishAccessSource(env: Env, now = new Date()): Promise<"written" | "unchanged"> {
  let admins = 0;
  try {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM profiles WHERE roles LIKE '%"admin"%'`).first<{ n: number }>();
    admins = Number(r?.n ?? 0);
  } catch { /* leave 0 */ }
  const rec = accessSourceRecord(env, admins, now.toISOString());
  const key = SECURITY_KV.source("mfa");
  const prevRaw = await env.RULES.get(key);
  if (prevRaw) {
    try {
      const prev = JSON.parse(prevRaw) as SecuritySourceRecord;
      const fresh = now.getTime() - Date.parse(prev.at) < REFRESH_MS;
      if (fresh && prev.status === rec.status && JSON.stringify(prev.metrics) === JSON.stringify(rec.metrics)) return "unchanged";
    } catch { /* malformed ⇒ overwrite */ }
  }
  await env.RULES.put(key, JSON.stringify(rec));
  return "written";
}
