import type { Env } from "../env";

// QuickBooks OAuth2 connect flow (Phase 4). Tokens land in qbo_connections; the
// QuickBooksAdapter refreshes + rotates them from there. The agent is a reader/
// reconciler — it never writes duplicate purchases.
const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPE = "com.intuit.quickbooks.accounting";

export async function buildConnectUrl(env: Env, userId: string, origin: string): Promise<string> {
  const state = crypto.randomUUID();
  await env.RULES.put(`qbostate:${state}`, userId, { expirationTtl: 600 });
  const u = new URL(AUTH_URL);
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

  const userId = await env.RULES.get(`qbostate:${state}`);
  if (!userId) return { ok: false, error: "bad or expired state" };

  const basic = btoa(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${origin}/api/qbo/callback` }),
  });
  if (!res.ok) return { ok: false, error: `token exchange ${res.status}` };
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

export async function qboStatus(env: Env, userId: string): Promise<{ connected: boolean; realm_id: string | null; updated_at: string | null }> {
  const row = await env.DB.prepare(`SELECT realm_id, updated_at FROM qbo_connections WHERE user_id = ?`)
    .bind(userId)
    .first<{ realm_id: string; updated_at: string }>();
  return { connected: !!row, realm_id: row?.realm_id ?? null, updated_at: row?.updated_at ?? null };
}
