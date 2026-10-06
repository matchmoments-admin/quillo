import type { Env } from "../env";
import {
  ProviderError, screenRows, toCents, last4Of, feedFingerprint, requiresAuResidency, providerEnvironment,
  type AccessType, type FeedTransaction, type TransactionPageResult, type ProviderAccount, type ProviderConsent,
  type ProviderConnection,
} from "./bank-feed-core";
import type { BankFeedProvider, ConsentAction } from "./bank-provider";

// The provider-neutral helpers live in bank-feed-core.ts; re-exported so existing importers keep working.
export { toCents, last4Of, feedFingerprint, requiresAuResidency };
export type { AccessType, TransactionPageResult, ConsentAction };
/** The shape is provider-neutral now (FeedTransaction); the old name is kept for existing callers. */
export type BasiqTransaction = FeedTransaction;

/**
 * Basiq (Open Banking / CDR aggregator) API client — ADR-0003. One implementation of the
 * BankFeedProvider seam (src/lib/bank-provider.ts); see basiqProvider at the bottom.
 *
 * Transport only: this module talks to Basiq and normalises what comes back. It writes nothing,
 * reads no tenant state, and makes no tax judgement. The ledger write lives in the DO so it shares
 * the statement path's categorise → Inbox/Sort pipeline.
 *
 * Two rules run through everything here:
 *   1. Quillo never sees a banking credential. Consent and authentication happen on Basiq's hosted
 *      flow and the data holder's own site. We hold a short-lived API token scoped to OUR app, never
 *      anything that could re-authenticate to a bank.
 *   2. Raw provider payloads are never logged. Transaction descriptions routinely carry BSB/account
 *      fragments, BPAY CRNs and PANs (ADR-0003 S8/S11).
 */

// Basiq's API is AU-hosted. That is a useful fact for the residency story but NOT sufficient on its
// own for PS8 — see requiresAuResidency, which is about where *we* send the data next.
const API_BASE = "https://au-api.basiq.io";
const CONSENT_BASE = "https://consent.basiq.io/home";
const API_VERSION = "3.0";

/** Max page size Basiq accepts on the transactions list. */
export const MAX_PAGE_SIZE = 500;

export type BasiqEnvironment = "sandbox" | "production";

/** BASIQ_ENV, fail-closed: only the literal 'production' (any case) flips it. See requiresAuResidency. */
export function basiqEnvironment(env: Env): BasiqEnvironment {
  return providerEnvironment(env, "basiq");
}

/** False when no API key is configured — the whole surface ships dark, like Stripe. */
export function basiqConfigured(env: Env): boolean {
  return Boolean(env.BASIQ_API_KEY);
}

/** Shape Basiq returns on error: a list envelope of error objects. Never contains our payload. */
interface BasiqErrorBody {
  correlationId?: string;
  data?: { code?: string; title?: string; detail?: string }[];
}

/** A Basiq API failure. A ProviderError, so the provider-neutral sync records it the same way. */
export class BasiqError extends ProviderError {
  constructor(status: number, code: string | undefined, message: string, correlationId?: string) {
    super(status, code, message, correlationId, status >= 500);
    this.name = "BasiqError";
  }
}

async function toBasiqError(res: Response, context: string): Promise<BasiqError> {
  let code: string | undefined;
  let detail = "";
  let correlationId: string | undefined;
  try {
    const body = (await res.json()) as BasiqErrorBody;
    correlationId = body.correlationId;
    const first = body.data?.[0];
    code = first?.code;
    // title/detail are Basiq's own error strings — they describe the API call, not the consumer's
    // data, so they are safe to surface. The response body is never logged wholesale.
    detail = [first?.title, first?.detail].filter(Boolean).join(": ");
  } catch {
    detail = "unreadable error body";
  }
  return new BasiqError(
    res.status,
    code,
    `basiq ${context} failed (${res.status}${code ? ` ${code}` : ""})${detail ? `: ${detail}` : ""}`,
    correlationId,
  );
}

// ── Tokens ───────────────────────────────────────────────────────────────────
//
// Basiq access tokens live 60 minutes. The SERVER_ACCESS token is scoped to our application (not to
// a tenant), so caching it cannot leak one tenant's access to another.
//
// It is cached in the isolate rather than KV deliberately: it is a bearer credential for the whole
// application, and an in-memory cache means it is never written to a durable store. The cost is a
// few extra token calls when isolates recycle, which is far below Basiq's own guidance of
// refreshing 2-3 times an hour. CLIENT_ACCESS tokens are bound to one consumer and are never
// cached at all.
let serverTokenCache: { token: string; expiresAt: number; env: BasiqEnvironment } | null = null;

// Refresh with 10 minutes to spare so a token can't expire mid-pagination on a long backfill.
const TOKEN_SAFETY_MARGIN_MS = 10 * 60 * 1000;

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

async function requestToken(env: Env, body: string): Promise<TokenResponse> {
  if (!basiqConfigured(env)) throw new Error("basiq not configured: BASIQ_API_KEY is unset");
  const res = await fetch(`${API_BASE}/token`, {
    method: "POST",
    headers: {
      // The API key is used VERBATIM after "Basic " — it is already encoded by Basiq. Re-encoding
      // it produces a 401 that reads like a bad key.
      Authorization: `Basic ${env.BASIQ_API_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "basiq-version": API_VERSION,
    },
    body,
  });
  if (!res.ok) throw await toBasiqError(res, "token");
  return (await res.json()) as TokenResponse;
}

/** App-scoped token for backend calls (users, accounts, transactions). Cached in-isolate. */
export async function serverToken(env: Env): Promise<string> {
  const environment = basiqEnvironment(env);
  const now = Date.now();
  if (serverTokenCache && serverTokenCache.env === environment && serverTokenCache.expiresAt > now) {
    return serverTokenCache.token;
  }
  const tok = await requestToken(env, "scope=SERVER_ACCESS");
  serverTokenCache = {
    token: tok.access_token,
    // expires_in is seconds; fall back to the documented 60 minutes if absent.
    expiresAt: now + (tok.expires_in ? tok.expires_in * 1000 : 3600_000) - TOKEN_SAFETY_MARGIN_MS,
    env: environment,
  };
  return tok.access_token;
}

/**
 * Consumer-scoped token for the hosted consent UI. NEVER cached and never logged: it authorises
 * access to one consumer's data and is handed to the browser as a URL parameter.
 */
export async function clientToken(env: Env, basiqUserId: string): Promise<string> {
  const tok = await requestToken(env, `scope=CLIENT_ACCESS&userId=${encodeURIComponent(basiqUserId)}`);
  return tok.access_token;
}

/**
 * The hosted consent URL the consumer is sent to. Authentication happens there and on the data
 * holder's own site — never in Quillo, which is why no banking credential can reach us.
 *
 * `state` is echoed back to our redirect URL untouched. It is the ONLY way to identify the tenant
 * on the way back: the redirect is a top-level browser navigation, so it carries no Authorization
 * header (the same constraint that makes the QBO callback a public route). It must therefore be an
 * unguessable, single-use, short-lived handle — never the user id itself.
 */
export function consentUrl(token: string, opts: { action?: ConsentAction; state?: string; institutionId?: string } = {}): string {
  const u = new URL(CONSENT_BASE);
  u.searchParams.set("token", token);
  // Basiq recommends naming the action explicitly rather than relying on the default flow.
  u.searchParams.set("action", opts.action ?? "connect");
  if (opts.state) u.searchParams.set("state", opts.state);
  if (opts.institutionId) u.searchParams.set("institutionId", opts.institutionId);
  return u.toString();
}

// ── Authenticated requests ───────────────────────────────────────────────────

async function apiGet<T>(env: Env, path: string, context: string): Promise<T> {
  const token = await serverToken(env);
  // Absolute URLs are passed through so pagination can follow links.next verbatim.
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw await toBasiqError(res, context);
  return (await res.json()) as T;
}

// ── Users ────────────────────────────────────────────────────────────────────

/**
 * Create the aggregator-side consumer. Basiq requires an email or mobile to identify the consumer
 * in its own consent records; nothing else about the tenant is sent.
 */
export async function createBasiqUser(env: Env, identity: { email?: string; mobile?: string }): Promise<string> {
  if (!identity.email && !identity.mobile) throw new Error("basiq createUser: email or mobile required");
  const token = await serverToken(env);
  const res = await fetch(`${API_BASE}/users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(identity),
  });
  if (!res.ok) throw await toBasiqError(res, "createUser");
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new Error("basiq createUser: response carried no id");
  return body.id;
}

/**
 * Delete the consumer at Basiq. This is the upstream half of the PS12 delete path — purging our own
 * rows does not revoke anything at the aggregator, exactly as deleting qbo_connections would not
 * revoke Intuit's tokens.
 */
export async function deleteBasiqUser(env: Env, basiqUserId: string): Promise<void> {
  const token = await serverToken(env);
  const res = await fetch(`${API_BASE}/users/${encodeURIComponent(basiqUserId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  // 404 means it is already gone — the desired end state, so not an error.
  if (!res.ok && res.status !== 404) throw await toBasiqError(res, "deleteUser");
}

/**
 * Delete ONE institution connection for a consumer at Basiq — the upstream half of withdrawing a
 * single bank while the consumer keeps others. Deleting the connection ends the aggregator's access
 * to that institution's data. When the last connection goes, callers delete the whole consumer
 * instead (deleteBasiqUser), which also ends the per-user billing.
 */
export async function deleteBasiqConnection(env: Env, basiqUserId: string, connectionId: string): Promise<void> {
  const token = await serverToken(env);
  const res = await fetch(
    `${API_BASE}/users/${encodeURIComponent(basiqUserId)}/connections/${encodeURIComponent(connectionId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  // 404 means it is already gone — the desired end state, so not an error.
  if (!res.ok && res.status !== 404) throw await toBasiqError(res, "deleteConnection");
}

// ── Consents ─────────────────────────────────────────────────────────────────

/** status: active | revoked | expired; permissions e.g. account.basic, transaction.detail. */
export type BasiqConsent = ProviderConsent;

interface RawConsent {
  id: string;
  status: string;
  created?: string;
  expiryDate?: string;
  data?: { permissions?: unknown[] };
}

/** Consents held for a consumer. Drives the consent dashboard and the expiry reminder. */
export async function getConsents(env: Env, basiqUserId: string): Promise<BasiqConsent[]> {
  const body = await apiGet<{ data?: RawConsent[] }>(
    env,
    `/users/${encodeURIComponent(basiqUserId)}/consents`,
    "getConsents",
  );
  return (body.data ?? []).map((c) => ({
    id: c.id,
    status: c.status,
    created: c.created,
    expiryDate: c.expiryDate,
    // Permission entries are objects in some responses and bare strings in others; normalise to the
    // scope string so the stored consent_scope is a stable shape.
    permissions: (c.data?.permissions ?? []).map((p) =>
      typeof p === "string" ? p : String((p as { scope?: string })?.scope ?? ""),
    ).filter(Boolean),
  }));
}

// ── Accounts ─────────────────────────────────────────────────────────────────

/** LAST FOUR DIGITS ONLY — a full account number is never returned from this module. */
export type BasiqAccount = ProviderAccount;

interface RawAccount {
  id: string;
  name?: string;
  accountNo?: string;
  class?: { type?: string };
  currency?: string;
  connection?: string;
  institution?: string;
}

export async function getAccounts(env: Env, basiqUserId: string): Promise<BasiqAccount[]> {
  const body = await apiGet<{ data?: RawAccount[] }>(
    env,
    `/users/${encodeURIComponent(basiqUserId)}/accounts`,
    "getAccounts",
  );
  return (body.data ?? []).map((a) => ({
    id: a.id,
    name: a.name ?? null,
    last4: last4Of(a.accountNo),
    type: a.class?.type ?? null,
    currency: a.currency ?? null,
    connectionId: a.connection ?? null,
    institutionId: a.institution ?? null,
  }));
}

// ── Transactions ─────────────────────────────────────────────────────────────

interface RawTransaction {
  id: string;
  status?: string;
  description?: string;
  amount?: string;
  currency?: string;
  direction?: string;
  account?: string;
  postDate?: string;
  class?: string;
}

/**
 * Build the provider-side filter. See fetchTransactionPage on why the window is not trusted alone.
 *
 * `accountId` is NOT an optimisation. Filtering account-side after the rows arrive means the
 * unselected accounts' transactions were still collected — and under the CDR, data minimisation is
 * about collection, so "we fetched them and threw them away" is not compliance. Naming the account
 * in the query is what makes the promise true.
 *
 * ⚠️ UNVERIFIED SYNTAX. Basiq documents `account.id` as filterable but does not publish the operator
 * grammar, and this could not be checked against the sandbox (the local key was stale at the time).
 * Two failure modes, neither dangerous: the provider REJECTS it (sync fails loudly on the first
 * sandbox run — obvious, fix the string) or SILENTLY IGNORES it (we are back to collecting more
 * than we selected, i.e. no worse than before, but the minimisation claim above would be false).
 * Confirm against a live sandbox call before this ships to real consumers.
 */
export function postDateFilter(from: string, to: string, accountId?: string): string {
  const parts = [`transaction.postDate.gteq('${from}')`, `transaction.postDate.lteq('${to}')`];
  if (accountId) parts.push(`account.id.eq('${accountId}')`);
  return parts.join(",");
}

interface TransactionPage {
  data?: RawTransaction[];
  links?: { next?: string };
}

/**
 * Validate a resume cursor before it is fetched WITH THE APP-WIDE SERVER TOKEN attached.
 *
 * Since #511 `links.next` is persisted on `bank_sync_runs.cursor` and replayed by a later alarm, so
 * it is no longer only a value the vendor handed us a moment ago. That token reads every tenant's
 * data, so a cursor is followed only if it is on the Basiq API origin AND under this tenant's own
 * `/users/{id}/transactions` path — never off-host, never another consumer's resource.
 */
export function safeNextUrl(next: string, basiqUserId: string): string {
  let u: URL;
  try {
    u = new URL(next, API_BASE);
  } catch {
    throw new BasiqError(0, "invalid-cursor", "basiq getTransactions failed: unreadable pagination cursor");
  }
  const base = new URL(API_BASE);
  const prefix = `/users/${encodeURIComponent(basiqUserId)}/transactions`;
  if (u.origin !== base.origin || (u.pathname !== prefix && !u.pathname.startsWith(`${prefix}/`))) {
    throw new BasiqError(0, "invalid-cursor", "basiq getTransactions failed: pagination cursor points outside this consumer's transactions");
  }
  return u.toString();
}

/**
 * Fetch ONE page of POSTED transactions for ONE selected account within [from, to] (inclusive,
 * YYYY-MM-DD). Pass `next` (a previous page's cursor) to continue; omit it to start.
 *
 * One page per call is the point (#511). A page-at-a-time transport lets the caller
 * (src/lib/bank-sync.ts) flush each page to D1, checkpoint a resume cursor on the run row, and stop
 * at a budget — continuing in a later invocation.
 *
 * The posted-only / window / account re-checks are the shared screenRows (bank-feed-core.ts): the
 * correctness of a tax figure never rests on a vendor query string, and pending ids are unstable.
 *
 * ONE QUERY PER SELECTED ACCOUNT. Filtering account-side after the rows arrive would mean the
 * unselected accounts' transactions were still collected, and under the CDR data minimisation is
 * about collection — "we fetched them and discarded them" is not compliance.
 */
export async function fetchTransactionPage(
  env: Env,
  basiqUserId: string,
  opts: { from: string; to: string; accountId: string; next?: string | null },
): Promise<TransactionPageResult> {
  const { from, to, accountId } = opts;
  let url: string;
  if (opts.next) {
    url = safeNextUrl(opts.next, basiqUserId);
  } else {
    const params = new URLSearchParams({
      limit: String(MAX_PAGE_SIZE),
      filter: postDateFilter(from, to, accountId),
    });
    url = `/users/${encodeURIComponent(basiqUserId)}/transactions?${params}`;
  }

  const page: TransactionPage = await apiGet<TransactionPage>(env, url, "getTransactions");
  const screened = screenRows(
    (page.data ?? []).map((t) => ({
      id: t.id,
      accountId: t.account,
      status: t.status,
      // postDate is an ISO 8601 datetime; the date part is what the ledger keys on.
      postDate: (t.postDate ?? "").slice(0, 10),
      description: t.description,
      amount: t.amount,
      direction: (t.direction ?? "").toLowerCase() === "credit" ? ("credit" as const) : ("debit" as const),
      currency: t.currency,
      providerClass: t.class ?? null,
    })),
    { from, to, accountId },
  );
  return { ...screened, next: page.links?.next || null };
}

// ── The BankFeedProvider seam ────────────────────────────────────────────────

/**
 * Basiq connections, as the callback records them: one per Basiq connection (institution), grouped
 * from the account list. Behaviour-identical to the pre-seam callback: Basiq's consent is per CONSUMER,
 * so the single active consent (else the first) governs every connection, and a consent-read failure
 * never loses the connections the consumer just authorised.
 */
export async function basiqConnections(env: Env, basiqUserId: string): Promise<ProviderConnection[]> {
  let consents: BasiqConsent[] = [];
  try {
    consents = await getConsents(env, basiqUserId);
  } catch (e) {
    console.warn(`bank callback: consent read failed (${(e as Error).message})`);
  }
  const active = consents.find((c) => c.status === "active") ?? consents[0] ?? null;
  const accounts = await getAccounts(env, basiqUserId);
  const byConnection = new Map<string, ProviderAccount[]>();
  for (const a of accounts) {
    if (!a.connectionId) continue;
    const list = byConnection.get(a.connectionId) ?? [];
    list.push(a);
    byConnection.set(a.connectionId, list);
  }
  return [...byConnection].map(([connectionId, accts]) => ({
    connectionId,
    institutionId: accts[0]?.institutionId ?? null,
    institutionName: null,
    consent: active,
    accounts: accts,
  }));
}

export function basiqProvider(env: Env): BankFeedProvider {
  return {
    id: "basiq",
    configured: () => basiqConfigured(env),
    environment: () => basiqEnvironment(env),
    stateTtlSeconds: 600,
    createUser: (identity) => createBasiqUser(env, { email: identity.email }),
    // Basiq's redirect URL is configured in its dashboard; the state rides on the consent URL.
    consentUrl: async (u, opts) => ({ url: consentUrl(await clientToken(env, u), { action: opts.action, state: opts.state }) }),
    listConsents: (u) => getConsents(env, u),
    listAccounts: (u) => getAccounts(env, u),
    listConnections: (u) => basiqConnections(env, u),
    fetchTransactionPage: (u, q) => fetchTransactionPage(env, u, q),
    revokeConnection: (u, c) => deleteBasiqConnection(env, u, c),
    deleteUser: (u) => deleteBasiqUser(env, u),
  };
}
