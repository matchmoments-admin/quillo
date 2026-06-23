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
  // ── Usage-based billing (flag `billing`) — all optional; absent ⇒ billing inert / not configured ──
  // (COST_MARKUP_PCT + APP_FEE_CENTS are declared below in the existing pricing-policy block.)
  FREE_CREDIT_GRANT_CENTS?: string;     // one-off free credit allowance granted on signup (default 200 = $2)
  STRIPE_SECRET_KEY?: string;           // SECRET — Stripe API key (sk_...); absent ⇒ top-up returns "not configured"
  STRIPE_WEBHOOK_SECRET?: string;       // SECRET — Stripe webhook signing secret (whsec_...); absent ⇒ webhook 503
  BILLING_SUCCESS_URL?: string;         // where Stripe Checkout returns on success (default app.quillo.au/billing?topup=ok)
  BILLING_CANCEL_URL?: string;          // where Stripe Checkout returns on cancel
  MAX_DAILY_COST_CENTS_GLOBAL?: string; // platform-wide daily AI spend ceiling across ALL tenants (0/unset = unlimited)
  MAX_MONTHLY_COST_CENTS_GLOBAL?: string; // platform-wide MONTHLY AI spend ceiling (firm upper bound; 0/unset = unlimited)
  CHAT_MAX_TURNS_PER_MIN?: string;      // Ask Quillo: per-tenant chat turns per rolling minute (0/unset = unlimited)
  CHAT_MAX_TURNS_PER_DAY?: string;      // Ask Quillo: per-tenant chat turns per day (0/unset = unlimited)
  CHAT_MAX_MESSAGE_CHARS?: string;      // Ask Quillo: max chars per chat message (0/unset = unlimited)
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
  // Optional (flag phi_provider_directory): Google Places API (New) key for the interim Extras
  // provider finder. Server-side only — never reaches the SPA. Absent ⇒ fetchProviders returns []
  // (the UI falls back to "Open in Maps" + the Healthdirect signpost). Set via
  // `wrangler secret put GOOGLE_PLACES_KEY` after enabling Places API (New) in Google Cloud.
  GOOGLE_PLACES_KEY?: string;
  PHI_PROVIDER_MAX_PER_DAY?: string;    // per-tenant daily cap on provider-finder searches (cost guardrail). Unset ⇒ 200; "0" ⇒ unlimited.
  // Legacy: the original Geoapify-backed finder. Geoapify has no allied-health categories, so the
  // finder moved to Google (above). Declared but unused — removable in a later cleanup.
  GEOAPIFY_KEY?: string;
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
  recordTxnAsIncome(userId: string, txnId: string): Promise<{ income_id: string | null }>;
  linkIncome(userId: string, txnId: string, incomeId: string): Promise<void>;
  unlinkIncome(userId: string, txnId: string): Promise<void>;
  reviewSummary(userId: string, fy?: string): Promise<{ fy: string; rows: { bucket: string; ato_label: string | null; deductibility: string; n: number; total_cents: number; resolved_cents: number }[] }>;
  setDeductibility(userId: string, txnIds: string[], state: string, deductibleAmountCents?: number | null): Promise<{ updated: number }>;
  resolveByLabel(userId: string, opts: { fy?: string; bucket: string; atoLabel?: string | null; state: string; businessUsePct?: number | null }): Promise<{ updated: number }>;
  createAsset(userId: string, a: { label: string; asset_class: string; cost_cents: number; acquired_date: string; property_id?: string | null; entity_id?: string | null; effective_life_years?: number | null; method?: string | null; div43_rate?: number | null; dv_rate_pct?: number | null; is_second_hand?: boolean; business_use_pct?: number | null; source_doc_id?: string | null; needs_review?: number; owned_by?: string | null; reimbursed?: number; is_car?: number }): Promise<string>;
  recordEssGrant(userId: string, g: { person_id?: string | null; employer_entity_id?: string | null; scheme_type: string; grant_date?: string | null; taxing_point_date?: string | null; shares_or_options?: string | null; units?: number | null; discount_cents: number; market_value_cents?: number | null; ownership_gt_10pct?: number }): Promise<string>;
  recordVehicleLogbook(userId: string, lb: { person_id?: string | null; asset_id?: string | null; fy?: string | null; start_date?: string | null; end_date?: string | null; business_km?: number | null; total_km?: number | null; running_costs_cents: number; business_use_pct?: number | null }): Promise<string>;
  recordTrustDistribution(userId: string, d: { trust_entity_id: string; fy?: string | null; beneficiary_person_id?: string | null; beneficiary_entity_id?: string | null; share_pct?: number | null; amount_cents: number; character?: string | null; franking_credit_cents?: number }): Promise<string>;
  recordPartnershipDistribution(userId: string, d: { partnership_entity_id: string; fy?: string | null; beneficiary_person_id?: string | null; share_pct?: number | null; amount_cents: number; character?: string | null; franking_credit_cents?: number }): Promise<string>;
  recordSmsfMember(userId: string, m: { smsf_entity_id: string; person_id?: string | null; phase?: string | null; pension_balance_cents?: number; accumulation_balance_cents?: number; transfer_balance_cents?: number }): Promise<string>;
  recordSuperContribution(userId: string, c: { person_id?: string | null; fy?: string | null; type?: string | null; amount_cents: number }): Promise<string>;
  recordBasPeriod(userId: string, b: { entity_id?: string | null; period_start: string; period_end: string; output_gst_cents?: number; input_gst_cents?: number; payg_withholding_cents?: number; payg_instalment_cents?: number; status?: string }): Promise<string>;
  recordPaygInstalment(userId: string, p: { entity_id?: string | null; fy?: string | null; quarter?: number | null; instalment_cents: number; basis?: string | null }): Promise<string>;
  computeDepreciation(userId: string, assetId: string, toStartYear?: number): Promise<{ rows: number }>;
  rollForward(userId: string, toStartYear: number): Promise<{ assets: number }>;
  reclassMisbucketedAssets(userId: string): Promise<{ removed: number; reclassed: number }>;
  disposeAsset(userId: string, assetId: string, disposedDate: string, disposalValueCents: number): Promise<{ balancing_adjustment_cents: number }>;
  importDepreciationSchedule(userId: string, docId: string, bytes: ArrayBuffer, mime: string): Promise<{ created: number }>;
  generateChecklist(userId: string, fy?: string): Promise<{ items: number }>;
  setWorkUseInputs(userId: string, input: { fy: number; wfh_hours: number | null; car_work_km: number | null; wfh_days_per_week?: number | null; wfh_weeks?: number | null; has_dedicated_home_office?: boolean; wfh_has_record?: boolean; wfh_weekdays?: number[] | null; wfh_leave_ranges?: { start: string; end: string; label?: string }[] | null; wfh_generate_diary?: boolean }): Promise<{ ok: true }>;
  setCarInputs(userId: string, input: { fy: number; work_km: number | null }): Promise<{ ok: true }>; // #245
  scanTransactions(userId: string, startYear: number): Promise<import("./lib/scan").ScanResult>; // #256
  assessFilingReadiness(userId: string, startYear: number): Promise<import("./lib/readiness").FilingReadiness>;
  setChecklistStatus(userId: string, id: string, status: string): Promise<void>;
  setClaimStatus(userId: string, id: string, status: string): Promise<void>;
  computeCgt(userId: string, propertyId: string): Promise<import("./lib/cgt").CgtResult & { property_id: string }>;
  recordCgtAsset(userId: string, a: { person_id?: string | null; asset_kind: string; code?: string | null; label?: string | null; units?: number | null; acquired_date?: string | null; cost_base_cents: number; reduced_cost_base_cents?: number | null; main_residence_exempt?: number }): Promise<string>;
  recordCgtEvent(userId: string, e: { cgt_asset_id: string; fy?: string | null; event_type?: string | null; event_date: string; proceeds_cents: number; cost_base_used_cents: number; units_disposed?: number | null; discount_eligible?: boolean | null }): Promise<string>;
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
  setGstRegistered(userId: string, registered: boolean): Promise<{ ok: true; gst_registered: number }>;
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
  detectAdvisory(userId: string): Promise<{ recurring: number; opportunities: number }>;
  dismissOpportunity(userId: string, id: string): Promise<{ ok: boolean }>;
  dismissRecurringBill(userId: string, id: string): Promise<{ ok: boolean }>;
  confirmRecurringBill(userId: string, id: string): Promise<{ ok: boolean }>;
  recordHealthExtrasConsent(userId: string, text: string, method: string): Promise<{ ok: true; consented_at: string }>;
  withdrawHealthExtrasConsent(userId: string): Promise<{ ok: true }>;
  setPrivateHealth(userId: string, holds: boolean): Promise<{ ok: true; private_health: number }>;
  savePhiPolicy(userId: string, p: { id?: string | null; person_id?: string | null; insurer?: string | null; cover_type?: string | null; reset_basis?: string | null; reset_date?: string | null; source?: string | null }): Promise<{ id: string }>;
  deletePhiPolicy(userId: string, id: string): Promise<{ ok: true }>;
  savePhiLimit(userId: string, l: { policy_id: string; category: string; annual_limit_cents: number; period?: string | null; combined_group?: string | null; source?: string | null; verified?: boolean }): Promise<{ id: string }>;
  deletePhiLimit(userId: string, id: string): Promise<{ ok: true }>;
  recordPhiUsage(userId: string, u: { policy_id: string; category: string; amount_used_cents: number; txn_id?: string | null; used_on?: string | null }): Promise<{ id: string }>;
  deletePhiUsage(userId: string, id: string): Promise<{ ok: true }>;
  applyPhiProduct(userId: string, productId: string): Promise<{ policy_id: string; limits: number }>;
  confirmPhiPolicyLimits(userId: string, policyId: string): Promise<{ confirmed: number }>;
  detectBenefitsReset(userId: string): Promise<{ setups: number; resets: number }>;
  grantSignupCredits(userId: string): Promise<{ granted_e4: number }>;
  creditWallet(userId: string, amountE4: number, kind: string, ref: string | null): Promise<{ balance_e4: number }>;
  getBillingOverview(userId: string): Promise<{ configured: boolean; balance_e4: number; markup_pct: number; free_grant_e4: number; ledger: { kind: string; amount_e4: number; ref: string | null; created_at: string }[] }>;
  createReferral(userId: string, opportunityId: string, offerId?: string): Promise<{ token: string; url: string; partner_name: string }>;
  recordConsent(userId: string, text: string, method: string): Promise<void>;
  draftSituation(userId: string, message: string): Promise<import("./extract").SituationDraft>;
  guideMe(userId: string, tab: string): Promise<{ headline: string; steps: string[] }>;
  askQuestion(userId: string, question: string, fy: number): Promise<{ answer: string; caveats: string[]; see_also: string[]; suggested_rule?: { pattern: string; bucket: string; ato_label?: string } }>;
  chatTurn(userId: string, sessionId: string | null, message: string, fy: number, pageRoute?: string): Promise<{ session_id: string; answer: string; caveats: string[]; see_also: string[]; suggested_rule?: { pattern: string; bucket: string; ato_label?: string }; navigate?: { route: string; reason: string } }>;
  chatHistory(userId: string, sessionId: string): Promise<{ messages: { role: string; content: string }[] }>;
  reviewClaims(userId: string, startYear: number): Promise<import("./agent").ClaimReview>;
  sweepMovements(userId: string): Promise<import("./agent").MovementSweep>;
  applyMovementSweep(userId: string, txnIds: string[]): Promise<{ ignored: number; skipped: number }>;
  applyLoanSplit(userId: string, txnId: string, opts: { property_id: string; interest_cents?: number; interest_pct?: number }): Promise<{ ok: true; interest_cents: number }>;
  applyLoanSplitGroup(userId: string, txnIds: string[], opts: { property_id: string; interest_pct: number }): Promise<{ applied: number; skipped: number; interest_cents: number }>;
  applyCorrectionBatch(userId: string, txnIds: string[], edits: { field: string; value: string }[], opts?: { learnRule?: boolean }): Promise<{ batch_id: string; updated: number; failures: { txnId: string; error: string }[]; rules_created?: number }>;
  undoCorrectionBatch(userId: string, batchId: string): Promise<{ reverted: number }>;
  aiWriteEntity(userId: string, spec: { kind: string; op: "create" | "update"; id?: string; data: Record<string, unknown>; source?: "ai_confirmed" | "manual"; sessionId?: string; batchId?: string; actionId?: string }): Promise<{ id: string; action_id: string; deduped?: boolean }>;
  aiDeleteEntity(userId: string, spec: { kind: string; id: string; source?: "ai_confirmed" | "manual"; sessionId?: string; actionId?: string }): Promise<{ ok: true; action_id: string; deduped?: boolean } | { blocked: true; parentTable: string; blockers: { table: string; label: string; count: number }[]; archivable: boolean; message: string }>;
  undoAiEdit(userId: string, actionId: string): Promise<{ reverted: number }>;
  undoAiEditBatch(userId: string, batchId: string): Promise<{ reverted: number }>;
  listAiEdits(userId: string, limit?: number): Promise<{ edits: { action_id: string; entity_type: string; entity_id: string; op: string; source: string; created_at: string; reverted_at: string | null; summary: string }[] }>;
  deleteTransactionBatch(userId: string, txnIds: string[]): Promise<{ deleted: number }>;
  matchClaim(userId: string, claimId: string): Promise<{ claim_id: string; rule_id: string | null; candidates: import("./lib/claim-match").ScoredTxn[]; linked: string[] }>;
  attachClaim(userId: string, claimId: string, txnId: string): Promise<{ ok: boolean; status: string }>;
  detachClaim(userId: string, claimId: string, txnId: string): Promise<{ ok: boolean; status: string }>;
  listClaimLinks(userId: string, claimId: string): Promise<{ txn_id: string; merchant: string | null; amount_cents: number | null; txn_date: string | null }[]>;
  runClarifyScan(userId: string, startYear: number): Promise<{ questions: number; groups: number }>;
  listClarifyQuestions(userId: string, startYear?: number): Promise<import("./agent").ClarifyQuestion[]>;
  answerClarify(userId: string, questionId: string, answer: import("./agent").ClarifyAnswer): Promise<{ applied: number; income_recorded: number }>;
  dismissClarify(userId: string, questionId: string): Promise<{ ok: boolean }>;
  previewSiblings(userId: string, seedTxnId: string): Promise<{ n: number; total_cents: number; group_key: string | null }>;
  applyToSiblings(userId: string, seedTxnId: string, edit: { bucket?: string; ato_label?: string; property_id?: string }, opts?: { learnRule?: boolean }): Promise<{ applied: number; batch_id: string; rule_created: boolean; group_key: string | null }>;
  setLoanInterest(userId: string, loanAccountId: string, fy: number, interestCents: number, source?: string, documentId?: string): Promise<{ ok: true; interest_cents: number; source: string }>;
  listLoanInterest(userId: string, fy?: number): Promise<{ id: string; loan_account_id: string; fy: string; interest_cents: number; source: string; document_id: string | null }[]>;
  listLoanInterestReview(userId: string, fy: number): Promise<{ loan_account_id: string; loan_name: string; properties: { id: string; label: string | null }[]; recorded_cents: number | null; source: string | null; estimate_cents: number | null }[]>;
  runAccountantPass(userId: string, startYear: number): Promise<import("./agent").AccountantSummary>;
  confirmSuggestedDeduction(userId: string, txnId: string): Promise<{ ok: boolean }>;
  draftOccupationRules(userId: string, occupation: string): Promise<import("./extract").OccupationRulesDraft>;
  addClaimabilityRules(userId: string, rules: { scope_type: string; scope_value: string; merchant_hint?: string | null; ato_label?: string | null; claim_type: string; default_method?: string | null; general_info_note: string }[]): Promise<{ inserted: number; ids: string[] }>;
}
