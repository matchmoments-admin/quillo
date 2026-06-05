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
  CLERK_FOUNDER_SUB?: string;           // the founder's Clerk sub → mapped to the pilot tenant "me"; others get their own tenant

  // Vars (wrangler.toml [vars])
  JURISDICTION: string;
  MAX_DAILY_COST_CENTS?: string;        // per-user daily AI spend budget in cents (0/unset = unlimited)
  MAX_DAILY_COST_CENTS_GLOBAL?: string; // platform-wide daily AI spend ceiling across ALL tenants (0/unset = unlimited)
  DEFAULT_INFERENCE_PROVIDER: string;   // 'anthropic' | 'bedrock'
  DEFAULT_INFERENCE_REGION: string;     // e.g. 'ap-southeast-2'
  QBO_BASE_URL: string;                 // sandbox or production
  FEATURES?: string;                    // comma-separated enabled feature flags (see lib/features.ts)
  CATEGORISE_MODE?: string;             // 'auto' | 'live' | 'batch' — default categorisation path (per-tenant override: profiles.categorise_mode)
  COST_MARKUP_PCT?: string;             // markup % over measured AI cost for the billable figure, e.g. '30' = +30% (display only today)
  APP_FEE_CENTS?: string;               // flat application fee in cents added on top of marked-up AI cost (display only today)

  // Secrets
  ANTHROPIC_API_KEY: string;
  QBO_CLIENT_ID: string;
  QBO_CLIENT_SECRET: string;
  // Optional: when set, QuickBooks OAuth tokens are AES-GCM envelope-encrypted at rest in D1
  // (see lib/token-crypto.ts). Absent = tokens stay plaintext (graceful, backward-compatible).
  QBO_TOKEN_KEY?: string;
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
  classifyAndRoute(userId: string, source: string, bytes: ArrayBuffer, mime: string): Promise<{ docId: string; doc_type: string; routed: boolean }>;
  recordIncome(userId: string, inc: { income_type: string; gross_cents: number; person_id?: string | null; entity_id?: string | null; property_id?: string | null; ato_label?: string | null; fy?: string | null; net_cents?: number | null; withholding_cents?: number | null; franking_credit_cents?: number | null; foreign_tax_paid_cents?: number | null; currency?: string | null; source_doc_id?: string | null; txn_date?: string | null; detail_json?: string | null; needs_review?: number }): Promise<string>;
  incomeMatches(userId: string): Promise<{ suggestions: { txn_id: string; merchant: string | null; txn_amount_cents: number; txn_date: string | null; bucket: string | null; income_id: string; income_type: string; income_gross_cents: number; income_net_cents: number | null; income_date: string | null }[]; matched: { txn_id: string; merchant: string | null; txn_amount_cents: number; txn_date: string | null; income_id: string; income_type: string; income_gross_cents: number }[] }>;
  linkIncome(userId: string, txnId: string, incomeId: string): Promise<void>;
  unlinkIncome(userId: string, txnId: string): Promise<void>;
  reviewSummary(userId: string, fy?: string): Promise<{ fy: string; rows: { bucket: string; ato_label: string | null; deductibility: string; n: number; total_cents: number; resolved_cents: number }[] }>;
  setDeductibility(userId: string, txnIds: string[], state: string, deductibleAmountCents?: number | null): Promise<{ updated: number }>;
  resolveByLabel(userId: string, opts: { fy?: string; bucket: string; atoLabel?: string | null; state: string; businessUsePct?: number | null }): Promise<{ updated: number }>;
  createAsset(userId: string, a: { label: string; asset_class: string; cost_cents: number; acquired_date: string; property_id?: string | null; entity_id?: string | null; effective_life_years?: number | null; method?: string | null; div43_rate?: number | null; dv_rate_pct?: number | null; is_second_hand?: boolean; business_use_pct?: number | null; source_doc_id?: string | null; needs_review?: number }): Promise<string>;
  computeDepreciation(userId: string, assetId: string, toStartYear?: number): Promise<{ rows: number }>;
  rollForward(userId: string, toStartYear: number): Promise<{ assets: number }>;
  disposeAsset(userId: string, assetId: string, disposedDate: string, disposalValueCents: number): Promise<{ balancing_adjustment_cents: number }>;
  importDepreciationSchedule(userId: string, docId: string, bytes: ArrayBuffer, mime: string): Promise<{ created: number }>;
  generateChecklist(userId: string, fy?: string): Promise<{ items: number }>;
  assessFilingReadiness(userId: string, startYear: number): Promise<import("./lib/readiness").FilingReadiness>;
  setChecklistStatus(userId: string, id: string, status: string): Promise<void>;
  setClaimStatus(userId: string, id: string, status: string): Promise<void>;
  computeCgt(userId: string, propertyId: string): Promise<import("./lib/cgt").CgtResult & { property_id: string }>;
  applyCorrection(userId: string, txnId: string, field: string, value: string): Promise<void>;
  deleteTransaction(userId: string, txnId: string): Promise<void>;
  pushToQuickBooks(userId: string, txnId: string): Promise<{ ok: boolean; ledgerRef?: string; error?: string }>;
  parseStatement(userId: string, accountId: string, filename: string, bytes: ArrayBuffer, format: string): Promise<{ statementId: string; columnMap: unknown; preview: unknown[]; rowCount: number; duplicate: boolean; reconciliation?: unknown }>;
  confirmImport(userId: string, statementId: string, columnMapOverride?: unknown, force?: boolean, quiet?: boolean): Promise<{ imported: number; skipped: number }>;
  confirmImportBulk(userId: string, opts?: { statementIds?: string[]; force?: boolean }): Promise<{ statements: number; imported: number; skipped: number; errors: { statementId: string; error: string }[] }>;
  deleteStatement(userId: string, statementId: string, purge?: boolean): Promise<{ deleted: boolean; linesRemoved: number }>;
  repairStatements(userId: string): Promise<{ statements: number; recovered: number; flagsFixed: number }>;
  setAccountSource(userId: string, accountId: string, source: string): Promise<void>;
  syncQboAccounts(userId: string): Promise<{ synced: number }>;
  disconnectQuickBooks(userId: string): Promise<{ ok: boolean; revoked: boolean }>;
  withdrawConsent(userId: string): Promise<{ ok: boolean }>;
  purgeTenant(userId: string): Promise<{ tables: number; rowsDeleted: number; r2Objects: number; kvKeys: number; qboRevoked: boolean }>;
  exportTenant(userId: string): Promise<Record<string, unknown>>;
  flagOldData(userId: string): Promise<{ flagged: boolean }>;
  setUiState(userId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  categoriseStatement(userId: string, statementId: string): Promise<{ categorised: number }>;
  pollBatchJobs(userId: string): Promise<{ applied: number }>;
  recategorise(userId: string): Promise<{ requeued: number; statements: number }>;
  linkReceipt(userId: string, receiptId: string, lineId: string): Promise<void>;
  unlinkReceipt(userId: string, receiptId: string): Promise<void>;
  runProactiveScan(userId: string): Promise<void>;
  recordConsent(userId: string, text: string, method: string): Promise<void>;
  draftSituation(userId: string, message: string): Promise<import("./extract").SituationDraft>;
  guideMe(userId: string, tab: string): Promise<{ headline: string; steps: string[] }>;
}
