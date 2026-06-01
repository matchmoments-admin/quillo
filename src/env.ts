export interface Env {
  // Durable Object namespace — one TaxAgent instance per tenant (idFromName(user_id)).
  TaxAgent: DurableObjectNamespace;

  // Stores
  DB: D1Database;
  RECEIPTS: R2Bucket;
  RULES: KVNamespace;

  // Static assets (the web SPA served from this same Worker).
  ASSETS?: Fetcher;

  // Cloudflare Access (legacy web UI auth — superseded by Clerk, kept for the seam).
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;

  // Clerk auth. CLERK_ISSUER = Clerk Frontend API URL (JWKS lives under it). When unset we
  // are in local dev and the API falls back to the pilot tenant. CLERK_ALLOWED_USERS is a
  // comma-separated allowlist of Clerk user ids that may use /api/* (single-user lockdown
  // until launch; empty = deny everyone).
  CLERK_ISSUER?: string;
  CLERK_ALLOWED_USERS?: string;

  // Vars (wrangler.toml [vars])
  JURISDICTION: string;
  MAX_EXTRACTIONS_PER_DAY?: string;     // per-user daily cap on model extractions (0/unset = unlimited)
  DEFAULT_INFERENCE_PROVIDER: string;   // 'anthropic' | 'bedrock'
  DEFAULT_INFERENCE_REGION: string;     // e.g. 'ap-southeast-2'
  QBO_BASE_URL: string;                 // sandbox or production

  // Secrets
  ANTHROPIC_API_KEY: string;
  QBO_CLIENT_ID: string;
  QBO_CLIENT_SECRET: string;
  // Only present when a tenant uses inference_provider=bedrock:
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
}

/**
 * RPC surface of the TaxAgent Durable Object, used to type the stub at call sites
 * without an `as any` cast (review finding: avoid unnecessary `as any`).
 */
export interface TaxAgentRpc {
  ingest(userId: string, source: string, bytes: ArrayBuffer, mime: string, bucketHint?: string | null): Promise<string>;
  ingestImages(userId: string, source: string, images: { bytes: ArrayBuffer; mime: string }[], bucketHint?: string | null): Promise<string>;
  ingestText(userId: string, source: string, text: string): Promise<string>;
  ingestCategoriseText(userId: string, source: string, text: string, bucketHint?: string | null): Promise<string>;
  applyCorrection(userId: string, txnId: string, field: string, value: string): Promise<void>;
  deleteTransaction(userId: string, txnId: string): Promise<void>;
  pushToQuickBooks(userId: string, txnId: string): Promise<{ ok: boolean; ledgerRef?: string; error?: string }>;
  runProactiveScan(userId: string): Promise<void>;
  recordConsent(userId: string, text: string, method: string): Promise<void>;
}
