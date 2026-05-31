import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../env";

export interface AuthedUser {
  email: string;
  userId: string;
}

// Cache the JWKS per team domain across requests (module scope survives within an isolate).
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksFor = "";

/**
 * Authenticate a web request via Cloudflare Access.
 *
 * Access sits in front of the Worker and injects `Cf-Access-Jwt-Assertion`. We verify
 * that JWT against the team JWKS + the application AUD (so a forged/absent header is
 * rejected) and derive the user from the verified email — never from a client header.
 *
 * Local dev: when CF_ACCESS_AUD is unset there is no Access in front, so we fall back
 * to the single pilot tenant. Production MUST set CF_ACCESS_AUD + CF_ACCESS_TEAM_DOMAIN.
 *
 * Pilot mapping: any authenticated Access user maps to tenant "me". Multi-tenant
 * email→user_id mapping is deferred (see plan).
 */
export async function requireAccess(req: Request, env: Env): Promise<AuthedUser | null> {
  if (!env.CF_ACCESS_AUD || !env.CF_ACCESS_TEAM_DOMAIN) {
    return { email: "dev@local", userId: "me" }; // local dev, no Access in front
  }

  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;

  const certs = `${env.CF_ACCESS_TEAM_DOMAIN.replace(/\/$/, "")}/cdn-cgi/access/certs`;
  if (!jwks || jwksFor !== certs) {
    jwks = createRemoteJWKSet(new URL(certs));
    jwksFor = certs;
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: env.CF_ACCESS_TEAM_DOMAIN.replace(/\/$/, ""),
      audience: env.CF_ACCESS_AUD,
    });
    const email = typeof payload.email === "string" ? payload.email : "unknown";
    return { email, userId: "me" };
  } catch {
    return null;
  }
}
