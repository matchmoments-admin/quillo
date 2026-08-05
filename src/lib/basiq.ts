import type { Env } from "../env";
import { sha256hex } from "./base64";

/**
 * Basiq (Open Banking / CDR aggregator) API client — ADR-0003.
 *
 * Transport only: this module talks to Basiq and normalises what comes back. It writes nothing,
 * reads no tenant state, and makes no tax judgement. The ledger write lives in the DO (PR 4) so it
 * shares the statement path's categorise → Inbox/Sort pipeline.
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

/** How a connection's data reached us. The legal obligations differ — see requiresAuResidency. */
export type AccessType = "cdr" | "web";

export type BasiqEnvironment = "sandbox" | "production";

export function basiqEnvironment(env: Env): BasiqEnvironment {
  return (env.BASIQ_ENV ?? "sandbox").toLowerCase() === "production" ? "production" : "sandbox";
}

/** False when no API key is configured — the whole surface ships dark, like Stripe. */
export function basiqConfigured(env: Env): boolean {
  return Boolean(env.BASIQ_API_KEY);
}

/**
 * Does this connection's data force AU-resident inference (CDR Privacy Safeguard 8)?
 *
 * TRUE only when BOTH hold:
 *   - access_type === 'cdr'. Web-connector data is ordinary personal information: the existing
 *     APP-8 cross-border consent gate governs it and PS8 does not attach. CDR data is governed by
 *     the Privacy Safeguards for its whole life inside Quillo — it does not become "ordinary" data
 *     after categorisation — and a consumer cannot consent past PS8.
 *   - the environment is 'production'. Sandbox connections return synthetic data from a test
 *     institution (Hooli). There is no consumer, so there is no consumer's CDR data to disclose and
 *     no safeguard to breach. Gating on this is what makes the feed testable before Bedrock is
 *     activated; without it every sandbox sync would fail closed on a compliance rule protecting
 *     data that does not exist.
 *
 * The second condition is a genuine carve-out, so it is deliberately narrow: it keys off BASIQ_ENV,
 * the same var that already refuses production access until the residency guard and the CDR
 * representative arrangement are both real (wrangler.toml). Flipping that var is the single gate.
 *
 * Callers pass the result to decide whether to call assertAuResidency (src/llm.ts) before inference.
 */
export function requiresAuResidency(env: Env, accessType: AccessType): boolean {
  return accessType === "cdr" && basiqEnvironment(env) === "production";
}

/** Shape Basiq returns on error: a list envelope of error objects. Never contains our payload. */
interface BasiqErrorBody {
  correlationId?: string;
  data?: { code?: string; title?: string; detail?: string }[];
}

export class BasiqError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly correlationId: string | undefined;
  constructor(status: number, code: string | undefined, message: string, correlationId?: string) {
    super(message);
    this.name = "BasiqError";
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
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

/** Consent-UI actions. `connect` adds an institution; `manage` is the consumer's own dashboard. */
export type ConsentAction = "connect" | "manage" | "extend" | "update" | "reauthorise";

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

// ── Consents ─────────────────────────────────────────────────────────────────

export interface BasiqConsent {
  id: string;
  status: string; // active | revoked | expired
  created?: string;
  expiryDate?: string;
  /** The consented data clusters, e.g. account.basic, transaction.detail. */
  permissions: string[];
}

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

export interface BasiqAccount {
  id: string;
  name: string | null;
  /** LAST FOUR DIGITS ONLY — a full account number is never returned from this module. */
  last4: string | null;
  type: string | null;
  currency: string | null;
  connectionId: string | null;
  institutionId: string | null;
}

interface RawAccount {
  id: string;
  name?: string;
  accountNo?: string;
  class?: { type?: string };
  currency?: string;
  connection?: string;
  institution?: string;
}

/**
 * Truncate an account number to its last four digits. Applied at the boundary so a full number
 * never reaches a caller, a log line or the database (ADR-0003 S11).
 */
export function last4Of(accountNo: string | null | undefined): string | null {
  if (!accountNo) return null;
  const digits = accountNo.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
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

export interface BasiqTransaction {
  id: string;
  accountId: string;
  /** ISO date (YYYY-MM-DD) the transaction posted. Posted-only, so never null. */
  postDate: string;
  description: string;
  /** Unsigned cents. Direction carries the sign, matching the statement path's storage. */
  amountCents: number;
  direction: "debit" | "credit";
  currency: string;
  /** Provider class/subClass. Kept for diagnostics — NEVER used as a tax category. */
  providerClass: string | null;
}

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
 * Decimal money string → unsigned integer cents, without floating point.
 *
 * Basiq returns `amount` as a STRING, negative for outgoing funds ("-24.50"). Going through
 * parseFloat would put binary-float error into the money path; every other amount in this codebase
 * is integer cents, so the string is parsed digit-wise instead.
 *
 * Returns the ABSOLUTE value — sign is carried by `direction`, matching how the statement importer
 * stores amount_cents unsigned.
 */
export function toCents(amount: string | number | null | undefined): number {
  if (amount == null) return 0;
  const raw = String(amount).trim();
  if (!raw) return 0;
  const m = /^[+-]?(\d*)(?:\.(\d*))?$/.exec(raw.replace(/,/g, ""));
  if (!m) return 0;
  const whole = m[1] || "0";
  // Pad to exactly 2 decimal places, truncating anything finer (no institution reports sub-cents,
  // and rounding here would invent money).
  const frac = (m[2] ?? "").padEnd(2, "0").slice(0, 2);
  return Number(whole) * 100 + Number(frac);
}

/**
 * Build the provider-side filter. See fetchTransactions on why the window is not trusted alone.
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

/** Namespaced dedup key for a fed line. Distinct from the statement fingerprint's input shape. */
export function feedFingerprint(providerTxnId: string): Promise<string> {
  return sha256hex(`feed|${providerTxnId}`);
}

interface TransactionPage {
  data?: RawTransaction[];
  links?: { next?: string };
}

export interface FetchTransactionsResult {
  transactions: BasiqTransaction[];
  /** Rows the provider returned that we discarded, and why. Recorded on the sync run. */
  skippedPending: number;
  skippedOutOfWindow: number;
  pages: number;
}

/**
 * Fetch POSTED transactions for a consumer within [from, to] (inclusive, YYYY-MM-DD).
 *
 * Two deliberate defences:
 *
 *  1. THE WINDOW IS RE-ENFORCED LOCALLY. The provider filter is sent as a bandwidth optimisation,
 *     but Basiq's published spec documents which fields are filterable without pinning the operator
 *     syntax. If that filter is wrong or silently ignored, an unfiltered pull would drag transactions
 *     from other financial years into the tax position. So every row is re-checked against the
 *     window here. The correctness of a tax figure never rests on a vendor query string.
 *  2. POSTED ONLY. Pending ids are unstable — Basiq documents that a transaction's id refreshes on
 *     the pending → posted transition, so fingerprinting a pending row would double-count it later.
 *
 * `maxPages` is a runaway guard: a broken links.next chain must not loop forever inside a Worker.
 */
export async function fetchTransactions(
  env: Env,
  basiqUserId: string,
  opts: { from: string; to: string; accountIds?: string[]; maxPages?: number },
): Promise<FetchTransactionsResult> {
  const { from, to } = opts;
  const maxPages = opts.maxPages ?? 200;
  const accountFilter = opts.accountIds?.length ? new Set(opts.accountIds) : null;

  const transactions: BasiqTransaction[] = [];
  let skippedPending = 0;
  let skippedOutOfWindow = 0;
  let pages = 0;

  // ONE REQUEST PER SELECTED ACCOUNT. Filtering account-side after the rows arrive would mean the
  // unselected accounts' transactions were still collected, and under the CDR data minimisation is
  // about collection — "we fetched them and discarded them" is not compliance. With no selection,
  // a single unfiltered pass (no caller does this today).
  const queries: (string | undefined)[] = accountFilter ? [...accountFilter] : [undefined];

  for (const accountId of queries) {
    const params = new URLSearchParams({
      limit: String(MAX_PAGE_SIZE),
      filter: postDateFilter(from, to, accountId),
    });
    let url: string | undefined = `/users/${encodeURIComponent(basiqUserId)}/transactions?${params}`;

    while (url && pages < maxPages) {
      const page: TransactionPage = await apiGet<TransactionPage>(env, url, "getTransactions");
      pages++;
      for (const t of page.data ?? []) {
        if ((t.status ?? "").toLowerCase() !== "posted") {
          skippedPending++;
          continue;
        }
        // postDate is an ISO 8601 datetime; the date part is what the ledger keys on.
        const postDate = (t.postDate ?? "").slice(0, 10);
        if (!postDate || postDate < from || postDate > to) {
          skippedOutOfWindow++;
          continue;
        }
        // Defence in depth: the provider filter is now the collection limit, but this re-check
        // means a wrong/ignored filter still cannot land another account's rows in the ledger.
        if (accountFilter && !(t.account && accountFilter.has(t.account))) continue;
        if (!t.id || !t.account) continue;
        const direction = (t.direction ?? "").toLowerCase() === "credit" ? "credit" : "debit";
        transactions.push({
          id: t.id,
          accountId: t.account,
          postDate,
          description: t.description ?? "",
          amountCents: toCents(t.amount),
          direction,
          // Normalised at the boundary. A provider returning "aud" would otherwise compare unequal
          // to the base currency, marking every line unconvertible — which excludes the whole
          // account from the position via FX_CONVERTED and silently zeroes the year.
          currency: (t.currency ?? "AUD").trim().toUpperCase(),
          providerClass: t.class ?? null,
        });
      }
      url = page.links?.next;
    }
  }

  return { transactions, skippedPending, skippedOutOfWindow, pages };
}
