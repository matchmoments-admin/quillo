import type { Env } from "../env";
import { sha256hex } from "./base64";

/**
 * Provider-neutral pieces of the bank feed (ADR-0003): the normalised shapes every aggregator
 * adapter returns, the money/identifier normalisers, the page re-checks, the error base class and
 * the Privacy Safeguard 8 decision.
 *
 * Nothing here talks to a network. The aggregator adapters (src/lib/basiq.ts, src/lib/fiskil.ts)
 * import from this module; this module imports neither, so there is no import cycle to trip over
 * when a class here is extended at module-evaluation time.
 */

/** The aggregators Quillo can be a CDR Representative through. Stored on bank_connections.provider. */
export type BankProviderId = "basiq" | "fiskil";
export const BANK_PROVIDER_IDS: readonly BankProviderId[] = ["basiq", "fiskil"];

export function isBankProviderId(v: unknown): v is BankProviderId {
  return typeof v === "string" && (BANK_PROVIDER_IDS as readonly string[]).includes(v);
}

/** How a connection's data reached us. The legal obligations differ — see requiresAuResidency. */
export type AccessType = "cdr" | "web";

export type ProviderEnvironment = "sandbox" | "production";

/**
 * Each provider's environment var, read FAIL-CLOSED toward the sandbox carve-out's narrowness:
 * only the literal 'production' (any case) means production. Unset/typo ⇒ sandbox, which is what
 * the connector is limited to until the CDR arrangement and the AU-residency guard are both real.
 */
function envFlag(v: string | undefined): ProviderEnvironment {
  return (v ?? "sandbox").toLowerCase() === "production" ? "production" : "sandbox";
}

export function providerEnvironment(env: Env, provider: BankProviderId): ProviderEnvironment {
  return provider === "fiskil" ? envFlag(env.FISKIL_ENV) : envFlag(env.BASIQ_ENV);
}

/**
 * Fiskil's sandbox data holder ("Banking Sandbox Data Holder"). Verified 2026-10-06 against the live
 * sandbox: GET /v1/institutions lists it as the ONLY institution with is_accessible=true.
 */
export const FISKIL_SANDBOX_INSTITUTION_ID = "88888";

/**
 * Does this connection's data force AU-resident inference (CDR Privacy Safeguard 8)?
 *
 * TRUE only when BOTH hold:
 *   - access_type === 'cdr'. Web-connector data is ordinary personal information: the existing
 *     APP-8 cross-border consent gate governs it and PS8 does not attach. CDR data is governed by
 *     the Privacy Safeguards for its whole life inside Quillo — it does not become "ordinary" data
 *     after categorisation — and a consumer cannot consent past PS8.
 *   - the data is REAL. Sandbox connections return synthetic data from a test institution. There is
 *     no consumer, so there is no consumer's CDR data to disclose and no safeguard to breach. Gating
 *     on this is what makes the feed testable before Bedrock is activated.
 *
 * The carve-out is deliberately narrow, and narrower for Fiskil than for Basiq:
 *   - Basiq: keyed off BASIQ_ENV ('production' ⇒ real). Basiq separates sandbox/prod by application.
 *   - Fiskil: sandbox and production share ONE base URL — the credentials decide, and nothing in the
 *     token says which (verified: the JWT carries org_id/key_id/scope only). So FISKIL_ENV alone could
 *     be wrong in the dangerous direction (production keys, var left on 'sandbox'). The carve-out
 *     therefore ALSO requires the connection to be at Fiskil's sandbox data holder — a real bank's
 *     data is treated as real whatever the env var says. An unknown institution ⇒ real.
 *   - An unknown provider ⇒ real (fail closed).
 *
 * Callers use the result to decide whether to stamp profiles.cdr_tainted before the first write.
 */
export function requiresAuResidency(
  env: Env,
  accessType: AccessType,
  provider: string = "basiq",
  institutionId?: string | null,
): boolean {
  if (accessType !== "cdr") return false;
  if (provider === "basiq") return providerEnvironment(env, "basiq") === "production";
  if (provider === "fiskil") {
    return providerEnvironment(env, "fiskil") === "production" || institutionId !== FISKIL_SANDBOX_INSTITUTION_ID;
  }
  return true;
}

/**
 * Is this a NON-PRODUCTION deployment (local `wrangler dev`, a preview)? The one marker is DEV_AUTH_BYPASS=1:
 * it is what makes a non-production deployment usable at all, and production must never set it (wrangler.toml
 * forbids it; auth fails closed without it). Read strictly — only the literal "1".
 */
export function isNonProductionDeployment(env: Env): boolean {
  return env.DEV_AUTH_BYPASS === "1";
}

/**
 * CDR data never reaches non-production (CDR Rules Schedule 2, control 3(b); docs/security/data-handling.md §6).
 * TRUE ⇒ the caller must refuse to collect or store this connection's data here. It is exactly "a
 * non-production deployment AND data that would be real" — i.e. requiresAuResidency's carve-out is the ONLY way
 * through: Fiskil's sandbox data holder (88888) with FISKIL_ENV not 'production', or Basiq with BASIQ_ENV not
 * 'production'. A real bank, an unknown institution, an unknown provider or production credentials are blocked
 * in non-production; production is never blocked by this (its guard is AU residency, PS8).
 */
export function cdrBlockedInThisDeployment(
  env: Env,
  accessType: AccessType,
  provider: string = "basiq",
  institutionId?: string | null,
): boolean {
  return isNonProductionDeployment(env) && requiresAuResidency(env, accessType, provider, institutionId);
}

/** Non-production must never hold production aggregator credentials in use: a new connect is refused. */
export function productionCredentialsBlockedHere(env: Env, provider: BankProviderId): boolean {
  return isNonProductionDeployment(env) && providerEnvironment(env, provider) === "production";
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * An aggregator API failure. `correlationId` is the provider's own support handle for this occurrence
 * (Basiq correlationId, Fiskil error `id`) — an identifier, never the consumer's data — and is what
 * lands on bank_sync_runs.correlation_id and in the CDR record.
 */
export class ProviderError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly correlationId: string | undefined;
  /** The provider said retrying may succeed (Fiskil `temporary`/`timeout`, or a 5xx / network error). */
  readonly temporary: boolean;
  constructor(status: number, code: string | undefined, message: string, correlationId?: string, temporary = false) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
    this.temporary = temporary;
  }
}

// ── Normalised shapes ────────────────────────────────────────────────────────

export interface FeedTransaction {
  /** Provider transaction id, already namespaced by the adapter where needed (see feedFingerprint). */
  id: string;
  accountId: string;
  /** ISO date (YYYY-MM-DD) the transaction posted. Posted-only, so never null. */
  postDate: string;
  description: string;
  /** Unsigned cents. Direction carries the sign, matching the statement path's storage. */
  amountCents: number;
  direction: "debit" | "credit";
  currency: string;
  /**
   * Provider class/category. Kept for diagnostics ONLY and never persisted — ADR-0003: a vendor
   * category may at most seed, and must NEVER override, Quillo's own ATO-rule categorisation.
   */
  providerClass: string | null;
}

/** One page of POSTED, in-window transactions for one account, plus the cursor to the next page. */
export interface TransactionPageResult {
  transactions: FeedTransaction[];
  /** Rows the provider returned that we discarded, and why. Recorded on the sync run. */
  skippedPending: number;
  skippedOutOfWindow: number;
  /** Opaque resume cursor (Basiq: a links.next URL; Fiskil: a page[after] token), or null when exhausted. */
  next: string | null;
}

export interface ProviderAccount {
  id: string;
  name: string | null;
  /** LAST FOUR DIGITS ONLY — a full account number never leaves an adapter. */
  last4: string | null;
  type: string | null;
  currency: string | null;
  connectionId: string | null;
  institutionId: string | null;
}

export interface ProviderConsent {
  id: string;
  /** 'active' when live; anything else is not. */
  status: string;
  /** The connection (Basiq) / CDR arrangement (Fiskil) this consent belongs to, when the provider says. */
  connectionId?: string | null;
  institutionId?: string | null;
  institutionName?: string | null;
  created?: string;
  expiryDate?: string;
  /** The consented data clusters. */
  permissions: string[];
}

/** One institution connection as the callback records it: the consent that governs it + its accounts. */
export interface ProviderConnection {
  connectionId: string;
  institutionId: string | null;
  institutionName: string | null;
  consent: ProviderConsent | null;
  accounts: ProviderAccount[];
}

// ── Normalisers ──────────────────────────────────────────────────────────────

/**
 * Decimal money string → unsigned integer cents, without floating point.
 *
 * Aggregators return `amount` as a STRING, negative for outgoing funds ("-24.50"). Going through
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
 * Truncate an account number to its last four digits. Applied at the boundary so a full number
 * never reaches a caller, a log line or the database (ADR-0003 S11).
 */
export function last4Of(accountNo: string | null | undefined): string | null {
  if (!accountNo) return null;
  const digits = accountNo.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * Namespaced dedup key for a fed line. Distinct from the statement fingerprint's input shape.
 *
 * Basiq ids are hashed bare (`feed|<id>`, the shape every existing row has). A second provider's ids
 * are prefixed by its adapter (`fiskil:<fiskil_id>`) before they reach here, so two providers' id
 * spaces can never collide on the per-tenant fingerprint index.
 */
export function feedFingerprint(providerTxnId: string): Promise<string> {
  return sha256hex(`feed|${providerTxnId}`);
}

/** A provider's currency, normalised. "aud" must compare equal to the base currency "AUD". */
export function normaliseCurrency(c: string | null | undefined): string {
  return (c ?? "AUD").trim().toUpperCase();
}

/** A provider row after the adapter has read its own field names, before the shared re-checks. */
export interface RawFeedRow {
  id: string | null | undefined;
  accountId: string | null | undefined;
  status: string | null | undefined;
  /** YYYY-MM-DD, or "" when the provider gave no usable posting date. */
  postDate: string;
  description: string | null | undefined;
  amount: string | number | null | undefined;
  direction: "debit" | "credit";
  currency: string | null | undefined;
  providerClass: string | null | undefined;
}

/**
 * The shared page defences, in order:
 *
 *  1. POSTED ONLY. Pending ids are unstable (Basiq documents that an id refreshes on the
 *     pending → posted transition), so fingerprinting a pending row would double-count it later.
 *  2. THE WINDOW IS RE-ENFORCED LOCALLY. The provider filter is the collection limit, but if it is
 *     wrong or silently ignored an unfiltered pull would drag other financial years into the tax
 *     position. The correctness of a tax figure never rests on a vendor query string.
 *  3. THE ACCOUNT IS RE-CHECKED. A wrong/ignored account filter still cannot land another account's
 *     rows in the ledger.
 */
export function screenRows(
  rows: RawFeedRow[],
  q: { from: string; to: string; accountId: string },
): Omit<TransactionPageResult, "next"> {
  const transactions: FeedTransaction[] = [];
  let skippedPending = 0;
  let skippedOutOfWindow = 0;
  for (const t of rows) {
    if ((t.status ?? "").toLowerCase() !== "posted") {
      skippedPending++;
      continue;
    }
    const postDate = t.postDate;
    if (!postDate || postDate < q.from || postDate > q.to) {
      skippedOutOfWindow++;
      continue;
    }
    if (!t.id || t.accountId !== q.accountId) continue;
    transactions.push({
      id: t.id,
      accountId: t.accountId,
      postDate,
      description: t.description ?? "",
      amountCents: toCents(t.amount),
      direction: t.direction,
      // Normalised at the boundary. A provider returning "aud" would otherwise compare unequal to the
      // base currency, marking every line unconvertible — which excludes the whole account from the
      // position via FX_CONVERTED and silently zeroes the year.
      currency: normaliseCurrency(t.currency),
      providerClass: t.providerClass ?? null,
    });
  }
  return { transactions, skippedPending, skippedOutOfWindow };
}
