export interface Env {
  // Durable Object namespace — one TaxAgent instance per tenant (idFromName(user_id)).
  TaxAgent: DurableObjectNamespace;

  // Stores
  DB: D1Database;
  RECEIPTS: R2Bucket;
  RULES: KVNamespace;

  // Static assets (the web SPA served from this same Worker).
  ASSETS?: Fetcher;

  // Cloudflare Access (web UI auth). When CF_ACCESS_AUD is unset we're in local dev
  // and the API falls back to the pilot tenant without verifying a JWT.
  CF_ACCESS_TEAM_DOMAIN?: string; // e.g. https://yourteam.cloudflareaccess.com
  CF_ACCESS_AUD?: string; // the Access application AUD tag

  // Vars (wrangler.toml [vars])
  JURISDICTION: string;
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
  ingestText(userId: string, source: string, text: string): Promise<string>;
  applyCorrection(userId: string, txnId: string, field: string, value: string): Promise<void>;
  runProactiveScan(userId: string): Promise<void>;
  recordConsent(userId: string, text: string, method: string): Promise<void>;
}
