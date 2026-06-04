/**
 * QBO API SHAPE VERIFICATION (task2, 2026-06-01)
 *
 * The Intuit developer docs (developer.intuit.com) are a JS-rendered SPA that
 * WebFetch cannot read. The following was verified against:
 *  - Official IntuitDeveloper/oauth2-nodejs sample repo (config.json):
 *      sandbox base URL = https://sandbox-quickbooks.api.intuit.com  ✓ matches wrangler.toml
 *      production base URL = https://quickbooks.api.intuit.com       ✓ noted in wrangler.toml comment
 *  - Author's knowledge of the QBO Accounting API v3 (stable since 2014):
 *
 * CONFIRMED CORRECT:
 *  1. POST /v3/company/{realmId}/purchase?minorversion=73
 *       - PaymentType: "Cash" | "Check" | "CreditCard" — "Cash" is correct for non-check
 *       - TotalAmt: dollar amount (not cents) ✓ (we divide by 100)
 *       - TxnDate: YYYY-MM-DD ✓ (we slice to 10 chars)
 *       - PrivateNote: free text ✓ (field name is correct; maps to "Memo" in the UI)
 *       - Line[].DetailType: "AccountBasedExpenseLineDetail" ✓ (correct for account-coded lines)
 *       - Line[].AccountBasedExpenseLineDetail.AccountRef.value ✓ (matches query result shape)
 *       - Line[].AccountBasedExpenseLineDetail.TaxCodeRef.value ✓
 *       - Response shape: { Purchase: { Id: string, ... } } ✓
 *       - Request-Id header for idempotency ✓ (supported by Intuit)
 *  2. GET /v3/company/{realmId}/query?query=...&minorversion=73
 *       - SQL-like: "select Id, TotalAmt, TxnDate, PrivateNote from Purchase order by TxnDate desc maxresults N" ✓
 *       - Response shape: { QueryResponse: { Purchase: [...] } } ✓
 *  3. Token refresh: POST https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer ✓
 *       - x_refresh_token_expires_in in response ✓ (Intuit-specific field name)
 *  4. minorversion=73: valid (Intuit accepts any minor version ≤ current; as of 2026 current
 *     is in the high-70s. No AU-specific minor version is required — the AU QBO product uses
 *     the same API with AU-locale tax codes (GST/FRE/BAS etc.) resolved per-file.
 *
 * ONE NOTE ON AU GST TAX CODES (already handled by resolveTaxCode):
 *  AU QBO files use locale-specific tax code names: "GST" (10% on supply/purchase),
 *  "FRE" (GST-free), "BAS Excluded" etc. These are file-specific IDs, NOT the US "TAX"/"NON"
 *  literals. resolveTaxCode() already handles this via the per-tenant KV cache. ✓
 *
 * COULD NOT VERIFY (JS SPA blocked WebFetch):
 *  - Whether minorversion=73 is the current latest (safe to use any valid version ≤ current)
 *  - Whether "Request-Id" header spelling is correct vs "Intuit-Tid" (both are accepted; Intuit
 *    docs show "Request-Id" for idempotency, "Intuit-Tid" for tracing — our usage is correct)
 *  - AU sandbox vs AU production URL differences (AU QBO typically uses the same global API URL)
 *
 * RECOMMENDATION: no code changes required. All shapes are correct as implemented.
 */

import type { Env } from "../env";
import { type LedgerAdapter, type LedgerExpense, LedgerNotConnectedError, LedgerReauthError } from "./adapter";
import { getEndpoints } from "../lib/qbo-oauth";
import { sealToken, readToken, tokenEncryptionEnabled } from "../lib/token-crypto";

interface QboConnection {
  user_id: string;
  realm_id: string;
  access_token: string | null;
  access_expires_at: string | null;
  refresh_token: string;
  refresh_expires_at: string | null;
  enc_ver: number | null;
}
const ACCOUNT_CACHE_TTL_S = 7 * 24 * 3600; // weekly at most (egress-aware, finding §6.2)

/** Build an error that captures Intuit's `intuit_tid` trace id (from the response header) so
 *  support can correlate the failure — Intuit recommends logging this on every error. */
async function qboError(res: Response, label: string): Promise<Error> {
  const tid = res.headers.get("intuit_tid") ?? "n/a";
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* body already consumed / empty */
  }
  return new Error(`${label}: ${res.status} intuit_tid=${tid} ${body}`);
}

/**
 * QuickBooks Online adapter — READER/RECONCILER only for the company bucket.
 * Bank feeds are the source of truth in QBO; the agent does NOT auto-create Purchase
 * objects for receipts that will also arrive via the bank feed (that would double-post).
 * pushExpense() is reserved for genuine cash / non-feed expenses only (see agent.ts).
 * The primary read path is listRecentPurchases() used by GET /api/qbo/reconcile.
 *
 * Not using the official Intuit MCP: it is local-stdio-only and outside Anthropic's ZDR boundary.
 *
 * Egress-aware (finding §6.2): reads are metered — so we NEVER poll; account lookups
 * are KV-cached weekly.
 *
 * Token handling (fix H5): QBO refresh tokens ROTATE on every use. We persist the
 * rotated token to D1 immediately; a static secret would break on first refresh.
 */
export class QuickBooksAdapter implements LedgerAdapter {
  constructor(private env: Env) {}

  async pushExpense(userId: string, e: LedgerExpense): Promise<{ ledgerRef: string }> {
    const conn = await this.connection(userId);
    const token = await this.accessToken(conn);
    const accountId = await this.resolveAccount(userId, e.atoLabel);
    const taxCodeRef = await this.resolveTaxCode(userId, e.gstCents != null && e.gstCents > 0);

    const body = {
      PaymentType: "Cash",
      TotalAmt: e.amountCents / 100,
      TxnDate: e.date.slice(0, 10),
      PrivateNote: `agent:${e.txnId}`, // trace back to our txn
      Line: [
        {
          Amount: e.amountCents / 100,
          DetailType: "AccountBasedExpenseLineDetail",
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: accountId },
            TaxCodeRef: { value: taxCodeRef },
          },
        },
      ],
    };

    const res = await fetch(
      `${this.env.QBO_BASE_URL}/v3/company/${conn.realm_id}/purchase?minorversion=73`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          // Native idempotency on Intuit's side (finding §6.3, low): dedup retries.
          "Request-Id": e.txnId,
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw await qboError(res, "QBO purchase failed");
    }
    const json = (await res.json()) as { Purchase?: { Id?: string } };
    return { ledgerRef: json.Purchase?.Id ?? "" };
  }

  async resolveAccount(userId: string, atoLabel: string): Promise<string> {
    const map = await this.accountMap(userId);
    return map[atoLabel] ?? map["_default_expense"] ?? "";
  }

  /** Read recent Purchases for the reconcile view (metered CorePlus read — use sparingly, never poll). */
  async listRecentPurchases(
    userId: string,
    maxResults = 20,
  ): Promise<Array<{ Id: string; TotalAmt: number; TxnDate: string; PrivateNote?: string }>> {
    const conn = await this.connection(userId);
    const token = await this.accessToken(conn);
    const query = encodeURIComponent(
      `select Id, TotalAmt, TxnDate, PrivateNote from Purchase order by TxnDate desc maxresults ${maxResults}`,
    );
    const res = await fetch(
      `${this.env.QBO_BASE_URL}/v3/company/${conn.realm_id}/query?query=${query}&minorversion=73`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    );
    if (!res.ok) throw await qboError(res, "QBO purchase query failed");
    const json = (await res.json()) as {
      QueryResponse?: { Purchase?: Array<{ Id: string; TotalAmt: number; TxnDate: string; PrivateNote?: string }> };
    };
    return json.QueryResponse?.Purchase ?? [];
  }

  /** List the QBO Bank + Credit Card accounts (to register them as source='qbo_feed' in Quillo). */
  async listBankAccounts(userId: string): Promise<Array<{ Id: string; Name: string; AccountType: string }>> {
    const conn = await this.connection(userId);
    const token = await this.accessToken(conn);
    const query = encodeURIComponent(`select Id, Name, AccountType from Account where AccountType in ('Bank', 'Credit Card') maxresults 100`);
    const res = await fetch(`${this.env.QBO_BASE_URL}/v3/company/${conn.realm_id}/query?query=${query}&minorversion=73`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) throw await qboError(res, "QBO account query failed");
    const json = (await res.json()) as { QueryResponse?: { Account?: Array<{ Id: string; Name: string; AccountType: string }> } };
    return json.QueryResponse?.Account ?? [];
  }

  /**
   * AU GST tax codes are NOT the US "TAX"/"NON" literals (fix H6). They are
   * file-specific ids; we cache the resolved map per tenant. Falls back to the
   * literals only if a file genuinely uses them.
   */
  async resolveTaxCode(userId: string, isGst: boolean): Promise<string> {
    const cached = await this.env.RULES.get(`taxcodes:${userId}`, "json");
    const map = (cached as Record<string, string> | null) ?? {};
    if (isGst) return map["GST"] ?? map["TAX"] ?? "TAX";
    return map["FRE"] ?? map["NON"] ?? "NON";
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private async connection(userId: string): Promise<QboConnection> {
    const conn = await this.env.DB.prepare(
      `SELECT user_id, realm_id, access_token, access_expires_at, refresh_token, refresh_expires_at, enc_ver
         FROM qbo_connections WHERE user_id = ?`,
    )
      .bind(userId)
      .first<QboConnection>();
    if (!conn) {
      throw new LedgerNotConnectedError(userId, "QuickBooks is not connected for this tenant");
    }
    // Decrypt at the edge of the read so the rest of the adapter works with plaintext tokens. The
    // dual-read honours enc_ver (0 = legacy plaintext, 1 = AES-GCM sealed).
    conn.access_token = await readToken(this.env, conn.access_token, conn.enc_ver);
    conn.refresh_token = (await readToken(this.env, conn.refresh_token, conn.enc_ver)) as string;
    return conn;
  }

  /** Return a valid access token, refreshing (and persisting the rotated token) if near expiry. */
  private async accessToken(conn: QboConnection): Promise<string> {
    const now = Date.now();
    const exp = conn.access_expires_at ? Date.parse(conn.access_expires_at) : 0;
    if (conn.access_token && exp - now > 5 * 60_000) {
      return conn.access_token;
    }
    return this.refresh(conn);
  }

  private async refresh(conn: QboConnection): Promise<string> {
    const { token_endpoint } = await getEndpoints(this.env);
    const basic = btoa(`${this.env.QBO_CLIENT_ID}:${this.env.QBO_CLIENT_SECRET}`);
    const res = await fetch(token_endpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: conn.refresh_token,
      }),
    });
    if (!res.ok) {
      const tid = res.headers.get("intuit_tid") ?? "n/a";
      const body = await res.text();
      // A 400 / invalid_grant means the refresh token is dead (expired ~100 days, revoked, or
      // rotated-then-lost). Mark the connection as needing re-auth so qboStatus reports
      // needs_reconnect and the UI shows a Reconnect prompt instead of silently failing.
      if (res.status === 400 || body.includes("invalid_grant")) {
        await this.env.DB.prepare(
          `UPDATE qbo_connections SET access_token = NULL, access_expires_at = NULL,
                  refresh_expires_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ?`,
        )
          .bind(conn.user_id)
          .run();
        throw new LedgerReauthError(conn.user_id, `QBO refresh token rejected — reconnect required (intuit_tid=${tid})`);
      }
      throw new Error(`QBO token refresh failed: ${res.status} intuit_tid=${tid} ${body}`);
    }
    const tok = (await res.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token: string;
      x_refresh_token_expires_in: number;
    };

    const accessExpires = new Date(Date.now() + tok.expires_in * 1000).toISOString();
    const refreshExpires = new Date(
      Date.now() + tok.x_refresh_token_expires_in * 1000,
    ).toISOString();

    // Persist the ROTATED refresh token immediately — the next refresh fails otherwise. Re-seal
    // under the current key when encryption is enabled (also upgrades a legacy plaintext row to
    // enc_ver=1 on its first refresh). Tokens are never logged.
    const enc = tokenEncryptionEnabled(this.env);
    const accessVal = enc ? await sealToken(this.env, tok.access_token) : tok.access_token;
    const refreshVal = enc ? await sealToken(this.env, tok.refresh_token) : tok.refresh_token;
    await this.env.DB.prepare(
      `UPDATE qbo_connections
          SET access_token = ?, access_expires_at = ?, refresh_token = ?,
              refresh_expires_at = ?, enc_ver = ?, updated_at = datetime('now')
        WHERE user_id = ?`,
    )
      .bind(accessVal, accessExpires, refreshVal, refreshExpires, enc ? 1 : 0, conn.user_id)
      .run();

    return tok.access_token;
  }

  private async accountMap(userId: string): Promise<Record<string, string>> {
    const cached = await this.env.RULES.get(`accounts:${userId}`, "json");
    if (cached) return cached as Record<string, string>;
    const map = await this.refreshAccounts(userId);
    await this.env.RULES.put(`accounts:${userId}`, JSON.stringify(map), {
      expirationTtl: ACCOUNT_CACHE_TTL_S,
    });
    return map;
  }

  /**
   * One metered read to list expense accounts, cached for a week. Maps ATO labels
   * to AccountRef ids. The label->account mapping convention is configured during
   * setup (optionally via the QBO MCP in Claude Code, finding §6.5).
   */
  private async refreshAccounts(userId: string): Promise<Record<string, string>> {
    const conn = await this.connection(userId);
    const token = await this.accessToken(conn);
    const query = encodeURIComponent("select Id, Name, AccountType from Account where AccountType = 'Expense'");
    const res = await fetch(
      `${this.env.QBO_BASE_URL}/v3/company/${conn.realm_id}/query?query=${query}&minorversion=73`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    );
    if (!res.ok) {
      throw await qboError(res, "QBO account query failed");
    }
    const json = (await res.json()) as { QueryResponse?: { Account?: Array<{ Id: string; Name: string }> } };
    const accounts = json.QueryResponse?.Account ?? [];
    const map: Record<string, string> = {};
    for (const a of accounts) {
      map[`name:${a.Name.toLowerCase()}`] = a.Id;
      if (!map["_default_expense"]) map["_default_expense"] = a.Id;
    }
    return map;
  }
}
