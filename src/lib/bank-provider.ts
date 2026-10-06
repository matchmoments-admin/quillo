import type { Env } from "../env";
import {
  isBankProviderId, BANK_PROVIDER_IDS,
  type BankProviderId, type ProviderEnvironment, type ProviderAccount, type ProviderConsent,
  type ProviderConnection, type TransactionPageResult,
} from "./bank-feed-core";
import { basiqProvider } from "./basiq";
import { fiskilProvider } from "./fiskil";

/**
 * The aggregator seam (ADR-0003; docs/bank-feed-provider-options.md §3).
 *
 * Quillo is a CDR Representative of ONE principal at a time, but a tenant's existing connections keep
 * the provider that created them (bank_connections.provider, profiles.bank_provider), so every
 * operation on an existing row resolves the provider FROM THE ROW, and only a new connect uses the
 * configured default (`BANK_FEED_PROVIDER`, default 'basiq' — nothing changes until it is set).
 *
 * Everything above this interface (the DO's upsert/audit/account-selection, the bounded sync in
 * bank-sync.ts, the withdraw/PS12/lifecycle logic in bank-consent.ts, the purge) is provider-neutral.
 */

/** Consent-UI actions. `connect` adds an institution; the rest are Basiq's management flows. */
export type ConsentAction = "connect" | "manage" | "extend" | "update" | "reauthorise";

export interface ConsentUrlOptions {
  /** Our single-use state handle. It MUST come back to /api/bank/callback (query param). */
  state: string;
  /** Absolute /api/bank/callback URL. Basiq ignores it (its redirect is set in the dashboard). */
  callbackUrl?: string;
  action?: ConsentAction;
}

export interface ConsentStart {
  /** Where the browser goes. Hosted by the aggregator — never Quillo, so no credential reaches us. */
  url: string;
  /** Provider support handle for this consent attempt (Fiskil auth session id), recorded even if abandoned. */
  sessionId?: string;
}

export interface BankFeedProvider {
  readonly id: BankProviderId;
  /** False when credentials are absent — the whole surface ships dark, like Stripe. */
  configured(): boolean;
  environment(): ProviderEnvironment;
  /** How long the connect state handle must live for this provider's hosted flow (seconds). */
  readonly stateTtlSeconds: number;
  /** Create the aggregator-side consumer. Only an identifying email is sent. */
  createUser(identity: { email: string; name?: string }): Promise<string>;
  consentUrl(providerUserId: string, opts: ConsentUrlOptions): Promise<ConsentStart>;
  listConsents(providerUserId: string): Promise<ProviderConsent[]>;
  listAccounts(providerUserId: string): Promise<ProviderAccount[]>;
  /** Callback → one row per institution connection, each with its governing consent and accounts. */
  listConnections(providerUserId: string): Promise<ProviderConnection[]>;
  /** One page of POSTED, in-window transactions for ONE account (the FeedTransport contract). */
  fetchTransactionPage(
    providerUserId: string,
    q: { accountId: string; from: string; to: string; next: string | null },
  ): Promise<TransactionPageResult>;
  /** Revoke one connection / CDR arrangement. Already-gone is success. */
  revokeConnection(providerUserId: string, connectionId: string): Promise<void>;
  /** Delete the aggregator consumer (and everything under it). Already-gone is success. */
  deleteUser(providerUserId: string): Promise<void>;
}

/**
 * The provider a NEW connect uses. Unset ⇒ 'basiq' (behaviour-identical to before the seam). An
 * unrecognised value THROWS rather than silently falling back: a typo must not route consumers to a
 * provider the operator did not choose.
 */
export function activeBankProviderId(env: Env): BankProviderId {
  const v = (env.BANK_FEED_PROVIDER ?? "basiq").trim().toLowerCase() || "basiq";
  if (!isBankProviderId(v)) throw new Error(`bank feeds misconfigured: unknown BANK_FEED_PROVIDER '${v}'`);
  return v;
}

/**
 * Resolve a provider. `id` comes from a stored row (bank_connections.provider / profiles.bank_provider);
 * NULL on a legacy row means Basiq, the only provider that existed when it was written. Omitted ⇒ the
 * configured default. An unknown stored value throws — it is never re-routed to another aggregator.
 */
export function bankProvider(env: Env, id?: string | null): BankFeedProvider {
  const resolved = id === undefined ? activeBankProviderId(env) : (id ?? "basiq");
  if (resolved === "basiq") return basiqProvider(env);
  if (resolved === "fiskil") return fiskilProvider(env);
  throw new Error(`unknown bank-feed provider '${resolved}'`);
}

/** Is ANY aggregator configured? The kill-switch check for continuing work on existing rows. */
export function anyBankProviderConfigured(env: Env): boolean {
  return BANK_PROVIDER_IDS.some((id) => bankProvider(env, id).configured());
}
