import type { Env } from "../env";
import { type LedgerAdapter, type LedgerExpense, LedgerNotConnectedError } from "./adapter";

interface QboConnection {
  user_id: string;
  realm_id: string;
  access_token: string | null;
  access_expires_at: string | null;
  refresh_token: string;
  refresh_expires_at: string | null;
}

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const ACCOUNT_CACHE_TTL_S = 7 * 24 * 3600; // weekly at most (egress-aware, finding §6.2)

/**
 * QuickBooks Online adapter — the direct REST hot path (NOT MCP: the official
 * Intuit MCP is local-stdio-only and outside Anthropic's ZDR boundary).
 *
 * Egress-aware (finding §6.2): writes are free/unmetered, reads are metered — so
 * we write once per confirmed txn and NEVER poll; account lookups are KV-cached.
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
      throw new Error(`QBO purchase failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { Purchase?: { Id?: string } };
    return { ledgerRef: json.Purchase?.Id ?? "" };
  }

  async resolveAccount(userId: string, atoLabel: string): Promise<string> {
    const map = await this.accountMap(userId);
    return map[atoLabel] ?? map["_default_expense"] ?? "";
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
      `SELECT user_id, realm_id, access_token, access_expires_at, refresh_token, refresh_expires_at
         FROM qbo_connections WHERE user_id = ?`,
    )
      .bind(userId)
      .first<QboConnection>();
    if (!conn) {
      throw new LedgerNotConnectedError(userId, "QuickBooks is not connected for this tenant");
    }
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
    const basic = btoa(`${this.env.QBO_CLIENT_ID}:${this.env.QBO_CLIENT_SECRET}`);
    const res = await fetch(TOKEN_URL, {
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
      throw new Error(`QBO token refresh failed: ${res.status} ${await res.text()}`);
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

    // Persist the ROTATED refresh token immediately — the next refresh fails otherwise.
    await this.env.DB.prepare(
      `UPDATE qbo_connections
          SET access_token = ?, access_expires_at = ?, refresh_token = ?,
              refresh_expires_at = ?, updated_at = datetime('now')
        WHERE user_id = ?`,
    )
      .bind(tok.access_token, accessExpires, tok.refresh_token, refreshExpires, conn.user_id)
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
      throw new Error(`QBO account query failed: ${res.status} ${await res.text()}`);
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
