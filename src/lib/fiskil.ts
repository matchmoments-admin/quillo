import type { Env } from "../env";
import {
  ProviderError, screenRows, last4Of, providerEnvironment,
  type ProviderAccount, type ProviderConsent, type ProviderConnection, type TransactionPageResult, type RawFeedRow,
} from "./bank-feed-core";
import type { BankFeedProvider, ConsentStart, ConsentUrlOptions } from "./bank-provider";

/**
 * Fiskil (CDR principal, ADRBNK000246) API client — the second implementation of the BankFeedProvider
 * seam (src/lib/bank-provider.ts). Selected by BANK_FEED_PROVIDER=fiskil; see
 * docs/bank-feed-provider-options.md for the Basiq → Fiskil mapping and what was verified live.
 *
 * Transport only, like basiq.ts: it writes nothing, reads no tenant state, makes no tax judgement,
 * and never logs a raw payload. Three boundary rules specific to Fiskil:
 *
 *  1. ACCOUNT NUMBERS STOP HERE. /banking/accounts returns the UNMASKED `account_number` and `bsb`.
 *     The raw account type below does not even declare them: only `masked_number` is read, and only
 *     its last four digits leave this module (ADR-0003 S11).
 *  2. THE CURSOR IS A TOKEN, NOT A URL. `links.next` is a full URL; only its `page[after]` value is
 *     kept, and every page is rebuilt from our own base URL + filters. A persisted cursor therefore
 *     cannot point the app-wide bearer at another host or another end user (the SSRF/cross-tenant
 *     surface Basiq's safeNextUrl has to police does not exist here).
 *  3. VENDOR CATEGORIES ARE A HINT AT MOST. Each transaction carries Fiskil's enrichment
 *     (`category.primary_category/secondary_category`). It is passed through as `providerClass` for
 *     diagnostics and is NOT persisted — ADR-0003: a vendor category may seed but must never override
 *     Quillo's ATO-rule categorisation.
 *
 * Errors: every failure becomes a FiskilError carrying Fiskil's `id` (its support "error_id") as the
 * correlation id, so it reaches bank_sync_runs.correlation_id and the CDR record. Retries with backoff
 * happen ONLY when Fiskil marks the error `temporary`/`timeout`, on 5xx/429 and on network errors (a
 * data-holder outage) — never on a 4xx validation error, and never on the non-idempotent end-user create.
 */

const API_BASE = "https://api.fiskil.com/v1";
/**
 * Pinned API version (header X-Fiskil-Version). "/v1/" in the path is a namespace, not the version;
 * without the header the Console default applies, so a Console change could silently reshape every
 * response. v3 is what this sandbox account defaults to (verified 2026-10-06: responses carry
 * `x-fiskil-version: v3`); v3 banking endpoints are identical to v2.
 */
export const FISKIL_API_VERSION = "v3";
/** Fiskil's page[size] cap. */
export const FISKIL_PAGE_SIZE = 1000;
/** Tokens live 15 minutes with no refresh token; refresh this long before expiry. */
const TOKEN_SAFETY_MARGIN_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 3;
/** Pages a single list call (consents / accounts) may walk — a runaway guard, not a real limit. */
const MAX_LIST_PAGES = 20;
/** Fiskil's consent flow can involve an OTP + the bank's own login, so allow longer than Basiq's 10 min. */
const STATE_TTL_SECONDS = 30 * 60;

export interface FiskilDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function fiskilConfigured(env: Env): boolean {
  return Boolean(env.FISKIL_CLIENT_ID && env.FISKIL_CLIENT_SECRET);
}

export function fiskilEnvironment(env: Env): "sandbox" | "production" {
  return providerEnvironment(env, "fiskil");
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Fiskil's error body. Front-door endpoints (token, end-users, auth/session) return the goa shape
 * {name, id, message, temporary, timeout, fault}; the data endpoints return {id, name, message}.
 * Neither carries the consumer's data.
 */
interface FiskilErrorBody {
  name?: string;
  id?: string;
  message?: string;
  temporary?: boolean;
  timeout?: boolean;
  fault?: boolean;
}

export class FiskilError extends ProviderError {
  readonly timeout: boolean;
  readonly fault: boolean;
  constructor(
    status: number,
    code: string | undefined,
    message: string,
    errorId?: string,
    flags: { temporary?: boolean; timeout?: boolean; fault?: boolean } = {},
  ) {
    super(status, code, message, errorId, Boolean(flags.temporary || flags.timeout));
    this.name = "FiskilError";
    this.timeout = Boolean(flags.timeout);
    this.fault = Boolean(flags.fault);
  }
  /** Fiskil's support handle for this occurrence (the go-live checklist's `error_id`). */
  get errorId(): string | undefined {
    return this.correlationId;
  }
}

async function toFiskilError(res: Response, context: string): Promise<FiskilError> {
  let body: FiskilErrorBody = {};
  try {
    body = (await res.json()) as FiskilErrorBody;
  } catch {
    body = { message: "unreadable error body" };
  }
  const retryable = res.status >= 500 || res.status === 429;
  const label = [res.status, body.name].filter(Boolean).join(" ");
  return new FiskilError(
    res.status,
    body.name,
    `fiskil ${context} failed (${label}${body.id ? `, error_id ${body.id}` : ""})${body.message ? `: ${body.message}` : ""}`,
    body.id,
    { temporary: Boolean(body.temporary) || retryable, timeout: Boolean(body.timeout), fault: Boolean(body.fault) },
  );
}

// ── Tokens ───────────────────────────────────────────────────────────────────
//
// POST /v1/token {client_id, client_secret} → {token, expires_in: 900}. Verified live: a 15-minute JWT
// with no refresh token. Like Basiq's SERVER_ACCESS token it is app-scoped (not per tenant), so caching
// it cannot leak one tenant's access to another; it is held in-isolate only, never in a durable store.
// Keyed by client_id so a credential rotation can never serve the old app's token.

let tokenCache: { clientId: string; token: string; expiresAt: number } | null = null;
let tokenInflight: { clientId: string; p: Promise<string> } | null = null;

/** Test hook: forget the cached token. */
export function _resetFiskilTokenCache(): void {
  tokenCache = null;
  tokenInflight = null;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class FiskilClient {
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  constructor(private readonly env: Env, deps: FiskilDeps = {}) {
    this.f = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
  }

  private async fetchToken(clientId: string): Promise<string> {
    const res = await this.withRetry("token", true, () =>
      this.f(`${API_BASE}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: this.env.FISKIL_CLIENT_SECRET }),
      }),
    );
    const body = (await res.json()) as { token?: string; expires_in?: number };
    if (!body.token) throw new FiskilError(res.status, "no_token", "fiskil token failed: response carried no token");
    tokenCache = {
      clientId,
      token: body.token,
      // expires_in is seconds; fall back to the documented 15 minutes.
      expiresAt: this.now() + (body.expires_in ? body.expires_in * 1000 : 900_000) - TOKEN_SAFETY_MARGIN_MS,
    };
    return body.token;
  }

  async token(force = false): Promise<string> {
    if (!fiskilConfigured(this.env)) throw new Error("fiskil not configured: FISKIL_CLIENT_ID / FISKIL_CLIENT_SECRET unset");
    const clientId = this.env.FISKIL_CLIENT_ID!;
    if (!force && tokenCache && tokenCache.clientId === clientId && tokenCache.expiresAt > this.now()) return tokenCache.token;
    // Coalesce concurrent misses (parallel account pages) onto one token request.
    if (!force && tokenInflight && tokenInflight.clientId === clientId) return tokenInflight.p;
    const p = this.fetchToken(clientId).finally(() => {
      if (tokenInflight?.p === p) tokenInflight = null;
    });
    tokenInflight = { clientId, p };
    return p;
  }

  /**
   * Run one HTTP call with the retry policy. `retry` is false for non-idempotent calls. Returns the
   * response when ok (or 404 when the caller treats 404 as success); otherwise throws a FiskilError.
   */
  private async withRetry(
    context: string,
    retry: boolean,
    call: () => Promise<Response>,
    opts: { notFoundOk?: boolean; onUnauthorized?: () => Promise<void> } = {},
  ): Promise<Response> {
    let reauthed = false;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await call();
      } catch (e) {
        // Network failure: no response at all. Retryable (data-holder/aggregator outage) when allowed.
        const err = new FiskilError(0, "network_error", `fiskil ${context} failed (network): ${(e as Error).message}`, undefined, { temporary: true });
        if (retry && attempt < MAX_ATTEMPTS) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }
      if (res.ok || (opts.notFoundOk && res.status === 404)) return res;
      // A token can be invalidated before its stated expiry (key rotation): re-mint once, then retry.
      if (res.status === 401 && opts.onUnauthorized && !reauthed) {
        reauthed = true;
        await opts.onUnauthorized();
        continue;
      }
      const err = await toFiskilError(res, context);
      if (retry && err.temporary && attempt < MAX_ATTEMPTS) {
        await this.sleep(backoffMs(attempt));
        continue;
      }
      throw err;
    }
  }

  async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    o: { context: string; query?: Record<string, string>; body?: unknown; retry?: boolean; notFoundOk?: boolean },
  ): Promise<Response> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
    let token = await this.token();
    return this.withRetry(
      o.context,
      o.retry ?? method !== "POST",
      async () =>
        this.f(url.toString(), {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "X-Fiskil-Version": FISKIL_API_VERSION,
            ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
        }),
      {
        notFoundOk: o.notFoundOk,
        onUnauthorized: async () => {
          token = await this.token(true);
        },
      },
    );
  }

  async getJson<T>(path: string, context: string, query?: Record<string, string>): Promise<T> {
    const res = await this.request("GET", path, { context, query });
    return (await res.json()) as T;
  }
}

function backoffMs(attempt: number): number {
  return 250 * 4 ** (attempt - 1); // 250ms, 1s
}

/** A pagination token: the `page[after]` value of a `links.next` URL. Never the URL itself. */
export function pageAfterToken(next: string | null | undefined): string | null {
  if (!next) return null;
  let u: URL;
  try {
    u = new URL(next, API_BASE);
  } catch {
    throw new FiskilError(0, "invalid_cursor", "fiskil pagination failed: unreadable links.next");
  }
  const tok = u.searchParams.get("page[after]");
  // A next link with no token would otherwise end pagination early and read as a complete pull.
  if (!tok) throw new FiskilError(0, "invalid_cursor", "fiskil pagination failed: links.next carried no page[after] token");
  return validCursor(tok);
}

/** The persisted cursor is replayed by a later alarm — accept only a plain token shape. */
function validCursor(tok: string): string {
  if (!/^[A-Za-z0-9_\-.:=+/~]{1,512}$/.test(tok)) throw new FiskilError(0, "invalid_cursor", "fiskil pagination failed: malformed cursor");
  return tok;
}

// ── Dates ────────────────────────────────────────────────────────────────────
//
// Fiskil filters `from`/`to` as RFC3339 instants (a bare date is rejected: "invalid from datetime: not
// in RFC3339 format", verified live) against posting_date_time. The ledger keys on a calendar date and
// AU financial years are AU-local, so the window is the Sydney-local day bounds, sent as instants, and
// each row's postDate is its Sydney-local date. Filter and re-check share ONE semantics, so a row at
// 00:30 AEST on 1 July is in the FY on both sides — no spurious out-of-window rows, no silent loss.

const SYDNEY = "Australia/Sydney";
const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: SYDNEY, year: "numeric", month: "2-digit", day: "2-digit" });

/** Sydney's UTC offset ("+10:00" / "+11:00") at an instant. */
function sydneyOffsetAt(ms: number): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: SYDNEY, timeZoneName: "longOffset" })
      .formatToParts(new Date(ms))
      .find((p) => p.type === "timeZoneName")?.value;
    const m = /GMT([+-]\d{2}:\d{2})/.exec(part ?? "");
    if (m) return m[1]!;
  } catch {
    /* fall through */
  }
  return "+10:00";
}

/** RFC3339 instant for a Sydney-local wall-clock time on `date` (YYYY-MM-DD). */
export function sydneyInstant(date: string, time: "00:00:00" | "23:59:59"): string {
  // Guess AEST, then correct to the offset actually in force at that instant (DST).
  const guess = Date.parse(`${date}T${time}+10:00`);
  return `${date}T${time}${Number.isFinite(guess) ? sydneyOffsetAt(guess) : "+10:00"}`;
}

/** A posting timestamp → its Sydney-local calendar date, or "" when unusable. */
export function sydneyDate(ts: string | null | undefined): string {
  if (!ts) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) return ts;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? dateFmt.format(new Date(ms)) : "";
}

// ── Raw shapes (only the fields we read) ─────────────────────────────────────

interface RawConsent {
  arrangement_id?: string;
  active?: boolean;
  institution_id?: string;
  institution_name?: string;
  created_at?: string;
  expires_at?: string;
  permissions?: unknown[];
}

/**
 * DELIBERATELY OMITS `account_number` and `bsb` (unmasked in Fiskil's response). Nothing below may
 * add them: a full account number must never leave this module (ADR-0003 S11).
 */
interface RawAccount {
  account_id?: string;
  fiskil_id?: string;
  arrangement_id?: string;
  institution_id?: string;
  display_name?: string;
  nickname?: string;
  product_name?: string;
  masked_number?: string;
  product_category?: string;
}

interface RawTransaction {
  fiskil_id?: string;
  account_id?: string;
  status?: string;
  posting_date_time?: string;
  description?: string;
  amount?: string;
  currency?: string;
  category?: { primary_category?: string; secondary_category?: string } | null;
  categories?: { primary_category?: string; secondary_category?: string } | null;
}

interface Links {
  next?: string;
}

// ── Provider ─────────────────────────────────────────────────────────────────

/** Is `u` an acceptable callback base? https anywhere, or http only on localhost (wrangler dev). */
function checkedCallback(raw: string | undefined): URL {
  if (!raw) throw new Error("fiskil consent: a callback URL is required (redirect_uri is set per session)");
  const u = new URL(raw);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("fiskil consent: callback URL must be https");
  return u;
}

export function fiskilProvider(env: Env, deps: FiskilDeps = {}): BankFeedProvider {
  const c = new FiskilClient(env, deps);

  async function listAll<T>(path: string, key: string, context: string, query: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    let after: string | null = null;
    for (let i = 0; i < MAX_LIST_PAGES; i++) {
      const q: Record<string, string> = { ...query, "page[size]": String(FISKIL_PAGE_SIZE) };
      if (after) q["page[after]"] = after;
      const body = await c.getJson<Record<string, unknown> & { links?: Links }>(path, context, q);
      out.push(...((body[key] as T[] | undefined) ?? []));
      after = pageAfterToken(body.links?.next);
      if (!after) return out;
    }
    throw new FiskilError(0, "too_many_pages", `fiskil ${context} failed: more than ${MAX_LIST_PAGES} pages`);
  }

  async function listConsents(endUserId: string): Promise<ProviderConsent[]> {
    const raw = await listAll<RawConsent>("/consent", "consents", "listConsents", { end_user_id: endUserId });
    return raw
      .filter((r) => !!r.arrangement_id)
      .map((r) => ({
        id: r.arrangement_id!,
        status: r.active ? "active" : "inactive",
        connectionId: r.arrangement_id!,
        institutionId: r.institution_id ?? null,
        institutionName: r.institution_name ?? null,
        created: r.created_at,
        expiryDate: r.expires_at,
        permissions: (r.permissions ?? []).filter((p): p is string => typeof p === "string" && p.length > 0),
      }));
  }

  async function listAccounts(endUserId: string): Promise<ProviderAccount[]> {
    const raw = await listAll<RawAccount>("/banking/accounts", "accounts", "listAccounts", { end_user_id: endUserId });
    return raw
      .filter((a) => !!a.account_id)
      .map((a) => ({
        // The bank's account id — the same id space as transactions[].account_id, so the per-account
        // re-check in screenRows compares like with like.
        id: a.account_id!,
        name: a.display_name || a.nickname || a.product_name || null,
        last4: last4Of(a.masked_number),
        type: a.product_category ?? null,
        currency: null,
        connectionId: a.arrangement_id ?? null,
        institutionId: a.institution_id ?? null,
      }));
  }

  return {
    id: "fiskil",
    configured: () => fiskilConfigured(env),
    environment: () => fiskilEnvironment(env),
    stateTtlSeconds: STATE_TTL_SECONDS,

    async createUser(identity) {
      // NOT retried: end users have no uniqueness constraint (verified: the same email twice ⇒ two
      // end users), so a retry after an ambiguous failure could mint a duplicate consumer.
      const res = await c.request("POST", "/end-users", { context: "createEndUser", body: { email: identity.email }, retry: false });
      const body = (await res.json()) as { end_user_id?: string };
      if (!body.end_user_id) throw new FiskilError(res.status, "no_id", "fiskil createEndUser: response carried no end_user_id");
      return body.end_user_id;
    },

    async consentUrl(endUserId: string, opts: ConsentUrlOptions): Promise<ConsentStart> {
      const cb = checkedCallback(opts.callbackUrl);
      // Our state rides in the redirect_uri's own query. Fiskil stores redirect_uri server-side
      // (auth_url carries only sess_id), so the query is expected to survive; the callback ALSO
      // accepts sess_id/session_id as a fallback handle (bank-connect.ts), in case it does not.
      const ok = new URL(cb);
      ok.searchParams.set("state", opts.state);
      const cancel = new URL(cb);
      cancel.searchParams.set("state", opts.state);
      cancel.searchParams.set("outcome", "cancel");
      // Retried: an auth session is cheap and an orphaned one simply expires (5 days).
      const res = await c.request("POST", "/auth/session", {
        context: "createAuthSession",
        body: { end_user_id: endUserId, redirect_uri: ok.toString(), cancel_uri: cancel.toString() },
        retry: true,
      });
      const body = (await res.json()) as { auth_url?: string; session_id?: string };
      if (!body.auth_url) throw new FiskilError(res.status, "no_auth_url", "fiskil createAuthSession: response carried no auth_url");
      const auth = new URL(body.auth_url);
      // The browser is sent here — it must be Fiskil's hosted flow, never anywhere else.
      if (auth.protocol !== "https:" || !(auth.hostname === "fiskil.com" || auth.hostname.endsWith(".fiskil.com"))) {
        throw new FiskilError(res.status, "bad_auth_url", "fiskil createAuthSession: auth_url is not on fiskil.com");
      }
      return { url: auth.toString(), sessionId: body.session_id };
    },

    listConsents,
    listAccounts,

    /**
     * One connection per LIVE CDR arrangement, each governed by its own consent (Fiskil consents are
     * per arrangement, unlike Basiq's per-consumer consent). Accounts under an inactive or unknown
     * arrangement are dropped — never recorded, never selectable, never fetched. A consent with no
     * accounts yet (Fiskil fetches data asynchronously after consent) is still recorded, so the grant
     * is visible on the consent dashboard.
     */
    async listConnections(endUserId) {
      const consents = (await listConsents(endUserId)).filter((x) => x.status === "active");
      const accounts = await listAccounts(endUserId);
      return consents.map<ProviderConnection>((consent) => ({
        connectionId: consent.id,
        institutionId: consent.institutionId ?? null,
        institutionName: consent.institutionName ?? null,
        consent,
        accounts: accounts.filter((a) => a.connectionId === consent.id),
      }));
    },

    async fetchTransactionPage(endUserId, q): Promise<TransactionPageResult> {
      const query: Record<string, string> = {
        end_user_id: endUserId,
        // Collection limit (CDR data minimisation): only this selected account.
        account_id: q.accountId,
        from: sydneyInstant(q.from, "00:00:00"),
        to: sydneyInstant(q.to, "23:59:59"),
        // Posted-only at the source too (Fiskil validates the value: PENDING | POSTED).
        status: "POSTED",
        "page[size]": String(FISKIL_PAGE_SIZE),
      };
      if (q.next) query["page[after]"] = validCursor(q.next);
      const body = await c.getJson<{ transactions?: RawTransaction[]; links?: Links }>("/banking/transactions", "getTransactions", query);
      const rows: RawFeedRow[] = (body.transactions ?? []).map((t) => {
        const cat = t.category ?? t.categories ?? null;
        return {
          // Namespaced so Fiskil ids can never collide with Basiq's on the per-tenant fingerprint.
          id: t.fiskil_id ? `fiskil:${t.fiskil_id}` : null,
          accountId: t.account_id,
          status: t.status,
          postDate: sydneyDate(t.posting_date_time),
          description: t.description,
          amount: t.amount,
          // Signed string: negative = money out.
          direction: (t.amount ?? "").trim().startsWith("-") ? "debit" : "credit",
          currency: t.currency,
          providerClass: cat ? [cat.primary_category, cat.secondary_category].filter(Boolean).join("/") || null : null,
        };
      });
      const screened = screenRows(rows, { from: q.from, to: q.to, accountId: q.accountId });
      return { ...screened, next: pageAfterToken(body.links?.next) };
    },

    async revokeConnection(_endUserId, arrangementId) {
      // 204 on success. NOTE (verified): the sandbox also answers 204 for an arrangement id that does
      // not exist, so a 204 is "Fiskil accepted the revoke", not proof one existed.
      await c.request("DELETE", `/consent/${encodeURIComponent(arrangementId)}`, { context: "revokeConsent", notFoundOk: true });
    },

    async deleteUser(endUserId) {
      // 204, then 404 end_user_not_found on a repeat (verified) — 404 is the desired end state.
      await c.request("DELETE", `/end-users/${encodeURIComponent(endUserId)}`, { context: "deleteEndUser", notFoundOk: true });
    },
  };
}
