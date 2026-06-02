import type { Env } from "../env";

// QuickBooks OAuth2 connect flow (Phase 4). Tokens land in qbo_connections; the
// QuickBooksAdapter refreshes + rotates them from there. The agent is a reader/
// reconciler — it never writes duplicate purchases.
//
// Endpoints come from Intuit's OpenID discovery document (getEndpoints) rather than being
// hardcoded, so we always use the current authorize/token endpoints (Intuit app-review
// requirement). The well-known values are kept as a fallback if the discovery fetch fails.
const SCOPE = "com.intuit.quickbooks.accounting";

const FALLBACK_ENDPOINTS: OidcEndpoints = {
  authorization_endpoint: "https://appcenter.intuit.com/connect/oauth2",
  token_endpoint: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
};

export interface OidcEndpoints {
  authorization_endpoint: string;
  token_endpoint: string;
}

/** Intuit publishes separate discovery docs for sandbox vs production. */
function discoveryUrl(env: Env): string {
  const sandbox = (env.QBO_BASE_URL ?? "").includes("sandbox");
  return sandbox
    ? "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration"
    : "https://developer.api.intuit.com/.well-known/openid_configuration";
}

/**
 * Resolve the OAuth authorize + token endpoints from Intuit's OpenID discovery document,
 * cached in KV for a day. Falls back to the well-known constants if the fetch fails so a
 * discovery outage never breaks connect/refresh.
 */
export async function getEndpoints(env: Env): Promise<OidcEndpoints> {
  const sandbox = (env.QBO_BASE_URL ?? "").includes("sandbox");
  const cacheKey = `qbo:oidc:${sandbox ? "sandbox" : "prod"}`;
  const cached = (await env.RULES.get(cacheKey, "json")) as OidcEndpoints | null;
  if (cached?.authorization_endpoint && cached?.token_endpoint) return cached;
  try {
    const res = await fetch(discoveryUrl(env), { headers: { Accept: "application/json" } });
    if (res.ok) {
      const doc = (await res.json()) as Partial<OidcEndpoints>;
      if (doc.authorization_endpoint && doc.token_endpoint) {
        const ep: OidcEndpoints = { authorization_endpoint: doc.authorization_endpoint, token_endpoint: doc.token_endpoint };
        await env.RULES.put(cacheKey, JSON.stringify(ep), { expirationTtl: 86400 });
        return ep;
      }
    }
    console.warn(`qbo discovery: unexpected response ${res.status} — using fallback endpoints`);
  } catch (e) {
    console.warn(`qbo discovery fetch failed (${(e as Error).message}) — using fallback endpoints`);
  }
  return FALLBACK_ENDPOINTS;
}

export async function buildConnectUrl(env: Env, userId: string, origin: string): Promise<string> {
  const state = crypto.randomUUID();
  await env.RULES.put(`qbostate:${state}`, userId, { expirationTtl: 600 });
  const { authorization_endpoint } = await getEndpoints(env);
  const u = new URL(authorization_endpoint);
  u.searchParams.set("client_id", env.QBO_CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("redirect_uri", `${origin}/api/qbo/callback`);
  u.searchParams.set("state", state);
  return u.toString();
}

export async function handleCallback(env: Env, url: URL, origin: string): Promise<{ ok: boolean; error?: string }> {
  const code = url.searchParams.get("code");
  const realmId = url.searchParams.get("realmId");
  const state = url.searchParams.get("state");
  if (!code || !realmId || !state) return { ok: false, error: "missing code/realmId/state" };

  // CSRF: the state must be one we issued (KV-stored, 10-min TTL) and maps to the tenant.
  const userId = await env.RULES.get(`qbostate:${state}`);
  if (!userId) return { ok: false, error: "bad or expired state" };

  const { token_endpoint } = await getEndpoints(env);
  const basic = btoa(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`);
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${origin}/api/qbo/callback` }),
  });
  if (!res.ok) {
    // Capture intuit_tid (Intuit's trace id) so support can correlate the failure.
    const tid = res.headers.get("intuit_tid") ?? "n/a";
    console.error(`qbo token exchange failed: ${res.status} intuit_tid=${tid} ${await res.text()}`);
    return { ok: false, error: `token exchange ${res.status}` };
  }
  const tok = (await res.json()) as { access_token: string; expires_in: number; refresh_token: string; x_refresh_token_expires_in: number };

  const accessExp = new Date(Date.now() + tok.expires_in * 1000).toISOString();
  const refreshExp = new Date(Date.now() + tok.x_refresh_token_expires_in * 1000).toISOString();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO qbo_connections (user_id, realm_id, access_token, access_expires_at, refresh_token, refresh_expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(userId, realmId, tok.access_token, accessExp, tok.refresh_token, refreshExp)
    .run();
  await env.RULES.delete(`qbostate:${state}`);
  return { ok: true };
}

export async function qboStatus(
  env: Env,
  userId: string,
): Promise<{ connected: boolean; realm_id: string | null; updated_at: string | null; needs_reconnect: boolean }> {
  const row = await env.DB.prepare(`SELECT realm_id, updated_at, refresh_expires_at FROM qbo_connections WHERE user_id = ?`)
    .bind(userId)
    .first<{ realm_id: string; updated_at: string; refresh_expires_at: string | null }>();
  if (!row) return { connected: false, realm_id: null, updated_at: null, needs_reconnect: false };
  // A stored row whose refresh token has expired (QBO refresh tokens last ~100 days) is dead:
  // report it as not-connected + needs_reconnect so the UI prompts a reconnect rather than
  // silently failing on the next API call.
  const expired = row.refresh_expires_at != null && Date.parse(row.refresh_expires_at) <= Date.now();
  return { connected: !expired, realm_id: row.realm_id, updated_at: row.updated_at, needs_reconnect: expired };
}
