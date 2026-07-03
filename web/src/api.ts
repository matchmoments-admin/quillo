import type { Txn, TxnDetail, Situation, SituationDraft, Notification, DashboardData, KeyRow, QboStatus, Reconcile, Report, Account, StatementParse, UsageData, StatementInfo, IncomeRow, DocRow, AssetRow, ScheduleRow, ChecklistItem, ClaimSuggestion, FilingReadiness, ReviewSummary, Progress, AdminTenant, AdminOverview, AdminSpend, AiEdit, ClaimReview, OccupationRulesDraft, OccupationRuleCandidate, NoaCarryover, MovementSweep, BatchResult, ClarifyQuestion, ClarifyAnswer, ClaimMatch, AccountantSummary, SuggestedDeduction, WorkUse, CarUse, CarUseRates, ScanResult, CapitalLoss, OpeningDepreciation, AttributionState, AttributionInput, AttributionRow, IncomeActivity, PropertyOwner, EntityRole, CgtAssetRow, CgtEventRow, EssGrantRow, VehicleLogbookRow, TrustDistributionRow, SmsfMemberRow, SuperContributionRow, BasPeriodRow, PaygInstalmentRow, AskAnswer, SavingsData, PhiOverview, PhiInsurerOption, PhiProvidersResult, PhiScanResult, BillingOverview, PartnerPortal, AmmaComponents, PartnershipDistributionRow } from "./types";

// Clerk session token getter, wired from <TokenBridge> inside ClerkProvider (main.tsx).
// Clerk tokens are short-lived, so we fetch a fresh one per request (getToken caches/refreshes).
let tokenGetter: (() => Promise<string | null>) | null = null;
export function setTokenGetter(fn: () => Promise<string | null>): void {
  tokenGetter = fn;
}

async function authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  const token = tokenGetter ? await tokenGetter() : null;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// A delete blocked because dependent records still reference the row (HTTP 409). Carries the
// blockers + whether the parent can be archived instead, so the UI can offer "Archive".
export type DeleteBlocker = { table: string; label: string; count: number };
export class ApiError extends Error {
  status: number;
  blockers?: DeleteBlocker[];
  archivable?: boolean;
  parentTable?: string;
  constructor(message: string, status: number, extra?: { blockers?: DeleteBlocker[]; archivable?: boolean; parentTable?: string }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.blockers = extra?.blockers;
    this.archivable = extra?.archivable;
    this.parentTable = extra?.parentTable;
  }
}
export const isDeleteBlocked = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 409 && Array.isArray(e.blockers);

// Turn a non-2xx response into a clean Error. The Worker returns `{ error: "<message>" }` JSON, so
// surface just that message (shown verbatim in toasts) instead of a raw `429 {"error":"…"}` blob.
// Falls back to the raw body / status text when the response isn't the expected shape. NOTE: callers
// that match on a code (e.g. TabGuide checks `.includes("consent_required")`) still work — the parsed
// message is exactly that string.
async function errFrom(res: Response): Promise<Error> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { error?: unknown; blockers?: DeleteBlocker[]; archivable?: boolean; parentTable?: string };
    // Blocked delete (409): build a human summary of what still references the row.
    if (res.status === 409 && Array.isArray(body?.blockers)) {
      const summary = body.blockers.map((b) => `${b.count} ${b.label}`).join(", ");
      return new ApiError(`Can't delete — still used by ${summary}.`, 409, { blockers: body.blockers, archivable: body.archivable, parentTable: body.parentTable });
    }
    if (typeof body?.error === "string" && body.error) return new ApiError(body.error, res.status);
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return new ApiError(text || `${res.status} ${res.statusText}`, res.status);
}

// Trigger a browser download for a fetched Blob (used by Bearer-authed downloads that can't be a
// plain <a href> — the href wouldn't carry the Authorization header).
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// Same-origin: the SPA is served by the Worker, so /api/* needs no base URL.
// In dev, Vite proxies /api to the local Worker (see vite.config.ts).
async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include", headers: await authHeaders() });
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) throw await errFrom(res);
  return res.json() as Promise<T>;
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers: await authHeaders(body ? { "content-type": "application/json" } : undefined),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) throw await errFrom(res);
  return res.json() as Promise<T>;
}
const post = <T>(path: string, body?: unknown) => send<T>("POST", path, body);

export const api = {
  transactions: (opts: { status?: string; bucket?: string; property_id?: string; kind?: string; review?: boolean; fy?: number; countable?: boolean; offset?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.status) q.set("status", opts.status);
    if (opts.bucket) q.set("bucket", opts.bucket);
    if (opts.property_id) q.set("property_id", opts.property_id);
    if (opts.kind) q.set("kind", opts.kind);
    if (opts.review) q.set("review", "1");
    if (opts.fy != null) q.set("fy", String(opts.fy));
    if (opts.countable) q.set("countable", "1");
    if (opts.offset) q.set("offset", String(opts.offset));
    if (opts.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return get<{ transactions: Txn[] }>(`/api/transactions${qs ? `?${qs}` : ""}`).then((r) => r.transactions);
  },
  reconcilePairs: () => get<{ receipts: Txn[]; lines: Txn[] }>("/api/reconcile"),
  statements: (accountId?: string) =>
    get<{ statements: StatementInfo[] }>(`/api/statements${accountId ? `?account_id=${accountId}` : ""}`).then((r) => r.statements),
  matchLink: (receiptId: string, lineId: string) => post<{ ok: boolean }>("/api/match/link", { receiptId, lineId }),
  matchUnlink: (receiptId: string) => post<{ ok: boolean }>("/api/match/unlink", { receiptId }),
  transaction: (id: string) => get<TxnDetail>(`/api/transactions/${id}`),
  upload: async (files: File | File[], bucket?: string): Promise<{ ok: boolean; txnId: string }> => {
    const fd = new FormData();
    for (const f of Array.isArray(files) ? files : [files]) fd.append("file", f);
    if (bucket) fd.append("bucket", bucket);
    // Don't set content-type — the browser adds the multipart boundary. Just add auth.
    const res = await fetch("/api/upload", { method: "POST", credentials: "include", headers: await authHeaders(), body: fd });
    if (res.status === 401) throw new Error("unauthorized");
    if (!res.ok) throw await errFrom(res);
    return res.json();
  },
  situation: () => get<Situation>("/api/situation"),
  draftSituation: (message: string) => post<SituationDraft>("/api/situation/draft", { message }),
  receiptUrl: (id: string) => `/api/receipt/${id}`,
  correct: (txnId: string, field: string, value: string) => post<{ ok: boolean }>("/api/correct", { txnId, field, value }),
  deleteTxn: (id: string) => send<{ ok: boolean }>("DELETE", `/api/transactions/${id}`),
  setTxnReimbursed: (id: string, reimbursed: boolean) => send<{ ok: boolean; reimbursed: boolean }>("PATCH", `/api/transactions/${id}/flags`, { reimbursed }),

  // Phase 2
  dashboard: (fy?: number) => get<DashboardData>(`/api/dashboard${fy ? `?fy=${fy}` : ""}`),
  progress: () => get<Progress>("/api/progress"),
  guideMe: (tab: string) => post<{ headline: string; steps: string[] }>("/api/guide", { tab }),
  ask: (question: string, fy?: number) => post<AskAnswer>("/api/ask", { question, fy }),
  chat: (message: string, session_id?: string, fy?: number, page?: string) => post<AskAnswer & { session_id: string }>("/api/chat", { message, session_id, fy, page }),
  chatHistory: (sessionId: string) => get<{ messages: { role: string; content: string }[] }>(`/api/chat/${sessionId}`).then((r) => r.messages),
  usage: () => get<UsageData>("/api/usage"),
  // Savings & Opportunities (flag advisory_layer) — factual run-rate + recurring bills + opportunities.
  savings: (fy?: number) => get<SavingsData>(`/api/savings${fy ? `?fy=${fy}` : ""}`),
  savingsScan: () => post<{ recurring: number; opportunities: number }>("/api/savings/scan"),
  dismissOpportunity: (id: string) => post<{ ok: boolean }>(`/api/opportunities/${id}/dismiss`),
  dismissRecurringBill: (id: string) => post<{ ok: boolean }>(`/api/recurring-bills/${id}/dismiss`),
  confirmRecurringBill: (id: string) => post<{ ok: boolean }>(`/api/recurring-bills/${id}/confirm`),
  // Tier-1 energy referral (flag advisory_partners_energy) — returns the tokened outbound URL to open.
  createReferral: (opportunityId: string, offerId?: string) => post<{ token: string; url: string; partner_name: string }>("/api/referrals", { opportunity_id: opportunityId, offer_id: offerId }),
  // Private Health Extras Tracker (flag phi_extras_tracker) — FACTUAL engagement surface.
  phi: () => get<PhiOverview>("/api/phi"),
  phiConsent: (text: string) => post<{ ok: true; consented_at: string }>("/api/phi/consent", { text, method: "web" }),
  phiWithdrawConsent: () => post<{ ok: true }>("/api/phi/consent/withdraw"),
  phiSetHospital: (holds: boolean) => post<{ ok: true; private_health: number }>("/api/phi/hospital", { holds }),
  phiSavePolicy: (p: { id?: string; insurer?: string | null; cover_type?: string | null; reset_basis?: string | null; reset_date?: string | null }) => post<{ id: string }>("/api/phi/policy", p),
  phiDeletePolicy: (id: string) => send<{ ok: true }>("DELETE", `/api/phi/policy/${id}`),
  phiSaveLimit: (l: { policy_id: string; category: string; annual_limit_cents: number }) => post<{ id: string }>("/api/phi/limit", l),
  phiDeleteLimit: (id: string) => send<{ ok: true }>("DELETE", `/api/phi/limit/${id}`),
  phiRecordUsage: (u: { policy_id: string; category: string; amount_used_cents: number; used_on?: string | null; txn_id?: string | null; receipt_key?: string | null }) => post<{ id: string }>("/api/phi/usage", u),
  phiDeleteUsage: (id: string) => send<{ ok: true }>("DELETE", `/api/phi/usage/${id}`),
  // Snap a receipt → Claude-vision OCR returns a benefit-used prefill (writes nothing). Multipart; the
  // browser sets the multipart boundary. Errors (over cap / consent / budget) surface for a manual fallback.
  phiScanReceipt: async (file: File): Promise<PhiScanResult> => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/phi/usage/scan", { method: "POST", credentials: "include", headers: await authHeaders(), body: fd });
    if (res.status === 401) throw new Error("unauthorized");
    if (!res.ok) throw await errFrom(res);
    return res.json();
  },
  phiProducts: () => get<{ insurers: PhiInsurerOption[] }>("/api/phi/products").then((r) => r.insurers),
  // Interim provider finder (flag phi_provider_directory) — only an approximate location (device coords,
  // already coarsened, OR a postcode) + the category leave the SPA. No identity.
  phiProviders: (category: string, loc: { postcode?: string; lat?: number; lng?: number }) => {
    const p = new URLSearchParams({ category });
    if (loc.lat != null && loc.lng != null) { p.set("lat", String(loc.lat)); p.set("lng", String(loc.lng)); }
    if (loc.postcode) p.set("postcode", loc.postcode);
    return get<PhiProvidersResult>(`/api/phi/providers?${p.toString()}`);
  },
  phiApplyProduct: (productId: string) => post<{ policy_id: string; limits: number }>("/api/phi/apply-product", { product_id: productId }),
  phiConfirm: (policyId: string) => post<{ confirmed: number }>("/api/phi/confirm", { policy_id: policyId }),
  phiScan: () => post<{ setups: number; resets: number }>("/api/phi/scan"),
  billing: () => get<BillingOverview>("/api/billing"),
  billingTopup: (amountCents: number) => post<{ url: string }>("/api/billing/topup", { amount_cents: amountCents }),
  notifications: () => get<{ notifications: Notification[] }>("/api/notifications").then((r) => r.notifications),
  markRead: (id: string) => post<{ ok: boolean }>(`/api/notifications/${id}/read`),

  // Phase 3
  addProperty: (b: unknown) => post<{ id: string }>("/api/properties", b),
  updateProperty: (id: string, b: unknown) => send<{ ok: boolean }>("PUT", `/api/properties/${id}`, b),
  deleteProperty: (id: string) => send<{ ok: boolean }>("DELETE", `/api/properties/${id}`),
  addEntity: (b: unknown) => post<{ id: string }>("/api/entities", b),
  updateEntity: (id: string, b: unknown) => send<{ ok: boolean }>("PUT", `/api/entities/${id}`, b),
  deleteEntity: (id: string) => send<{ ok: boolean }>("DELETE", `/api/entities/${id}`),
  archiveEntity: (id: string) => send<{ ok: boolean; archived: boolean }>("POST", `/api/entities/${id}/archive`),
  addRule: (b: unknown) => post<{ id: string }>("/api/rules", b),
  updateRule: (id: string, b: unknown) => send<{ ok: boolean }>("PUT", `/api/rules/${id}`, b),
  deleteRule: (id: string) => send<{ ok: boolean }>("DELETE", `/api/rules/${id}`),
  addPerson: (b: unknown) => post<{ id: string }>("/api/persons", b),
  updatePerson: (id: string, b: unknown) => send<{ ok: boolean }>("PUT", `/api/persons/${id}`, b),
  deletePerson: (id: string) => send<{ ok: boolean }>("DELETE", `/api/persons/${id}`),
  keys: () => get<{ keys: KeyRow[] }>("/api/keys").then((r) => r.keys),
  mintKey: (label: string) => post<{ keyId: string; secret: string }>("/api/keys", { label }),
  revokeKey: (id: string) => post<{ ok: boolean }>(`/api/keys/${id}/revoke`),
  consent: (text: string) => post<{ ok: boolean }>("/api/consent", { text, method: "web" }),
  withdrawConsent: () => post<{ ok: boolean }>("/api/consent/withdraw"),
  setGstRegistered: (registered: boolean) => post<{ ok: true; gst_registered: number }>("/api/gst-registered", { registered }),
  // APP 12 export: fetch the tenant's data (Bearer-authed) as a downloadable Blob.
  exportData: async (): Promise<Blob> => {
    const res = await fetch("/api/account/export", { credentials: "include", headers: await authHeaders() });
    if (!res.ok) throw await errFrom(res);
    return res.blob();
  },
  // APP 13 erasure: purge all of the tenant's data across every store.
  purgeData: () => send<{ tables: number; rowsDeleted: number; r2Objects: number; kvKeys: number; qboRevoked: boolean }>("DELETE", "/api/account/data"),
  // Server-side UI state (no localStorage): merge a patch (e.g. {tour_seen:true}).
  setUiState: (patch: Record<string, unknown>) => send<Record<string, unknown>>("PATCH", "/api/ui-state", { patch }),

  // Accounts + statement import
  accounts: () => get<{ accounts: Account[] }>("/api/accounts").then((r) => r.accounts),
  addAccount: (b: Partial<Account>) => post<{ id: string }>("/api/accounts", b),
  updateAccount: (id: string, b: Partial<Account>) => send<{ ok: boolean }>("PUT", `/api/accounts/${id}`, b),
  deleteAccount: (id: string) => send<{ ok: boolean }>("DELETE", `/api/accounts/${id}`),
  archiveAccount: (id: string) => send<{ ok: boolean; archived: boolean }>("POST", `/api/accounts/${id}/archive`),
  setAccountSource: (id: string, source: string) => post<{ ok: boolean }>(`/api/accounts/${id}/source`, { source }),

  // Loan → property links (Set-up; pre-fills the Phase 5 interest split)
  addLoanProperty: (b: { loan_account_id: string; property_id: string; deductible_interest_pct?: number }) =>
    post<{ id: string }>("/api/loans-properties", b),
  // Sort S4/S5 — evidence-first loan interest (flag loan_interest_v2; 404 when off)
  loanInterest: (fy?: number) =>
    get<{ summaries: { id: string; loan_account_id: string; fy: string; interest_cents: number; source: string; document_id: string | null }[] }>(`/api/loans/interest${fy != null ? `?fy=${fy}` : ""}`).then((r) => r.summaries),
  setLoanInterest: (accountId: string, b: { fy: number; interest_cents: number; source?: string; document_id?: string }) =>
    post<{ ok: boolean; interest_cents: number; source: string }>(`/api/loans/${accountId}/interest`, b),
  loanInterestReview: (fy?: number) =>
    get<{ loans: { loan_account_id: string; loan_name: string; properties: { id: string; label: string | null }[]; recorded_cents: number | null; source: string | null; estimate_cents: number | null }[] }>(`/api/loans/review${fy != null ? `?fy=${fy}` : ""}`).then((r) => r.loans),
  updateLoanProperty: (id: string, b: { deductible_interest_pct?: number }) =>
    send<{ ok: boolean }>("PUT", `/api/loans-properties/${id}`, b),
  deleteLoanProperty: (id: string) => send<{ ok: boolean }>("DELETE", `/api/loans-properties/${id}`),
  syncQboAccounts: () => post<{ synced: number }>("/api/qbo/sync-accounts"),
  parseStatement: async (file: File, accountId: string): Promise<StatementParse> => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("account_id", accountId);
    const res = await fetch("/api/statements", { method: "POST", credentials: "include", headers: await authHeaders(), body: fd });
    if (!res.ok) throw await errFrom(res);
    return res.json();
  },
  confirmImport: (statementId: string, force?: boolean, columnMap?: unknown) =>
    post<{ imported: number; skipped: number }>(`/api/statements/${statementId}/confirm`, { columnMap, force }),
  confirmImportBulk: (opts?: { statementIds?: string[]; force?: boolean }) =>
    post<{ statements: number; imported: number; skipped: number; errors: { statementId: string; error: string }[] }>(
      "/api/statements/confirm-batch",
      opts ?? {},
    ),
  deleteStatement: (id: string, purge?: boolean) =>
    send<{ deleted: boolean; linesRemoved: number }>("DELETE", `/api/statements/${id}${purge ? "?purge=1" : ""}`),

  // Phase 4
  qboStatus: () => get<QboStatus>("/api/qbo/status"),
  qboPush: (txnId: string) => post<{ ok: boolean; ledgerRef?: string; error?: string }>(`/api/qbo/push/${txnId}`),
  reconcile: () => get<Reconcile>("/api/qbo/reconcile"),
  // Fetches the Intuit authorize URL (Bearer-authed); the caller then navigates the browser
  // to it. A plain <a href> to /api/qbo/connect would 401 (no Authorization header on a
  // top-level navigation).
  qboConnect: () => get<{ url: string }>("/api/qbo/connect"),
  qboDisconnect: () => post<{ ok: boolean; revoked: boolean }>("/api/qbo/disconnect"),

  // Phase 5
  report: (fy?: number) => get<Report>(`/api/report${fy ? `?fy=${fy}` : ""}`),
  // Accountant schedule CSV. A plain <a href> to this 401s (no Authorization header) AND drops the
  // fy param — so fetch it Bearer-authed as a Blob (like exportData) and let the caller saveBlob() it.
  reportCsv: async (fy?: number): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch(`/api/report?format=csv${fy ? `&fy=${fy}` : ""}`, { credentials: "include", headers: await authHeaders() });
    if (!res.ok) throw await errFrom(res);
    const cd = res.headers.get("content-disposition") ?? "";
    const m = /filename=([^;]+)/.exec(cd);
    const filename = m ? m[1].trim().replace(/^"|"$/g, "") : `quillo-report-${fy ?? "current"}.csv`;
    return { blob: await res.blob(), filename };
  },
  // Accountant schedule as a multi-tab .xlsx workbook (flag accountant_xlsx). Same Bearer-authed
  // blob-download pattern as reportCsv — a plain <a href> would 401 and drop the fy param.
  reportXlsx: async (fy?: number): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch(`/api/report?format=xlsx${fy ? `&fy=${fy}` : ""}`, { credentials: "include", headers: await authHeaders() });
    if (!res.ok) throw await errFrom(res);
    const cd = res.headers.get("content-disposition") ?? "";
    const m = /filename=([^;]+)/.exec(cd);
    const filename = m ? m[1].trim().replace(/^"|"$/g, "") : `quillo-accountant-schedule-${fy ?? "current"}.xlsx`;
    return { blob: await res.blob(), filename };
  },
  filingReadiness: (fy?: number) => get<FilingReadiness>(`/api/filing-readiness${fy ? `?fy=${fy}` : ""}`),
  // Soft per-FY sign-off (attestation only — Quillo never lodges)
  fySignoff: (fy?: number) => get<{ signoff: { signed_off_at: string } | null }>(`/api/signoff${fy ? `?fy=${fy}` : ""}`).then((r) => r.signoff),
  signOff: (fy?: number) => post<{ signoff: { signed_off_at: string } | null }>(`/api/signoff${fy ? `?fy=${fy}` : ""}`).then((r) => r.signoff),
  clearSignOff: (fy?: number) => send<{ ok: boolean }>("DELETE", `/api/signoff${fy ? `?fy=${fy}` : ""}`),

  // Prior-year carry-ins (capture-only; surfaced as defer findings, never auto-applied)
  capitalLosses: () => get<{ capital_losses: CapitalLoss[] }>("/api/capital-losses").then((r) => r.capital_losses),
  addCapitalLoss: (b: { prior_fy: number; loss_cents: number; notes?: string }) => post<{ id: string }>("/api/capital-losses", b),
  deleteCapitalLoss: (id: string) => send<{ ok: boolean }>("DELETE", `/api/capital-losses/${id}`),
  openingDepreciation: () => get<{ opening_depreciation: OpeningDepreciation[] }>("/api/opening-depreciation").then((r) => r.opening_depreciation),
  addOpeningDepreciation: (b: { fy: number; opening_adjustable_value_cents: number; notes?: string }) => post<{ id: string }>("/api/opening-depreciation", b),
  deleteOpeningDepreciation: (id: string) => send<{ ok: boolean }>("DELETE", `/api/opening-depreciation/${id}`),

  // NOA carry-overs (B1 noa_capture): confirm-before-write FY close
  noaCarryovers: (fy?: number) => get<{ carryovers: NoaCarryover[] }>(`/api/noa${fy != null ? `?fy=${fy}` : ""}`).then((r) => r.carryovers),
  confirmNoa: (id: string) => post<{ carryover: NoaCarryover }>(`/api/noa/${id}`, {}),
  deleteNoa: (id: string) => send<{ ok: boolean }>("DELETE", `/api/noa/${id}`),

  // Find My Claims (flag claim_review) — read-only situational sweep, AI gap-fill draft, confirm write.
  claimReview: (fy?: number) => get<ClaimReview>(`/api/claim-review${fy ? `?fy=${fy}` : ""}`),
  // POST may surface consent_required (403) / "AI is paused…" (429) — caller shows a friendly inline message.
  draftOccupationRules: (occupation: string) => post<OccupationRulesDraft>("/api/claim-review/draft", { occupation }),
  // Persist user-confirmed candidate rules. Server forces defer_to_agent=1 on every row.
  addClaimabilityRules: (rules: OccupationRuleCandidate[]) => post<{ inserted: number; ids: string[] }>("/api/claim-review/rules", { rules }),

  // v2 — Income + Documents (Smart Inbox)
  income: (opts: { fy?: string; property_id?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.fy) q.set("fy", opts.fy);
    if (opts.property_id) q.set("property_id", opts.property_id);
    const qs = q.toString();
    return get<{ income: IncomeRow[] }>(`/api/income${qs ? `?${qs}` : ""}`).then((r) => r.income);
  },
  addIncome: (b: Partial<IncomeRow> & { components?: AmmaComponents }) => post<{ id: string }>("/api/income", b),
  deleteIncome: (id: string) => send<{ ok: boolean }>("DELETE", `/api/income/${id}`),
  deleteDocument: (id: string) => send<{ deleted: boolean; income_removed: number; txns_removed: number }>("DELETE", `/api/documents/${id}`),

  // CGT (#138) — holdings + disposal events
  cgtAssets: () => get<{ cgt_assets: CgtAssetRow[] }>("/api/cgt-assets").then((r) => r.cgt_assets),
  addCgtAsset: (b: Partial<CgtAssetRow>) => post<{ id: string }>("/api/cgt-assets", b),
  deleteCgtAsset: (id: string) => send<{ ok: boolean }>("DELETE", `/api/cgt-assets/${id}`),
  cgtEvents: () => get<{ cgt_events: CgtEventRow[] }>("/api/cgt-events").then((r) => r.cgt_events),
  addCgtEvent: (b: Partial<CgtEventRow>) => post<{ id: string }>("/api/cgt-events", b),
  deleteCgtEvent: (id: string) => send<{ ok: boolean }>("DELETE", `/api/cgt-events/${id}`),

  // ESS (#141)
  essGrants: () => get<{ ess_grants: EssGrantRow[] }>("/api/ess-grants").then((r) => r.ess_grants),
  addEssGrant: (b: Partial<EssGrantRow>) => post<{ id: string }>("/api/ess-grants", b),
  deleteEssGrant: (id: string) => send<{ ok: boolean }>("DELETE", `/api/ess-grants/${id}`),
  // Logbook (#142)
  vehicleLogbooks: () => get<{ vehicle_logbooks: VehicleLogbookRow[] }>("/api/vehicle-logbooks").then((r) => r.vehicle_logbooks),
  addVehicleLogbook: (b: Partial<VehicleLogbookRow>) => post<{ id: string }>("/api/vehicle-logbooks", b),
  deleteVehicleLogbook: (id: string) => send<{ ok: boolean }>("DELETE", `/api/vehicle-logbooks/${id}`),
  // Trust distributions (#139)
  trustDistributions: () => get<{ trust_distributions: TrustDistributionRow[] }>("/api/trust-distributions").then((r) => r.trust_distributions),
  addTrustDistribution: (b: Partial<TrustDistributionRow>) => post<{ id: string }>("/api/trust-distributions", b),
  deleteTrustDistribution: (id: string) => send<{ ok: boolean }>("DELETE", `/api/trust-distributions/${id}`),
  // Partnership distributions (Slice E)
  partnershipDistributions: () => get<{ partnership_distributions: PartnershipDistributionRow[] }>("/api/partnership-distributions").then((r) => r.partnership_distributions),
  addPartnershipDistribution: (b: Partial<PartnershipDistributionRow>) => post<{ id: string }>("/api/partnership-distributions", b),
  deletePartnershipDistribution: (id: string) => send<{ ok: boolean }>("DELETE", `/api/partnership-distributions/${id}`),
  smsfMembers: () => get<{ smsf_members: SmsfMemberRow[] }>("/api/smsf-members").then((r) => r.smsf_members),
  addSmsfMember: (b: Partial<SmsfMemberRow>) => post<{ id: string }>("/api/smsf-members", b),
  deleteSmsfMember: (id: string) => send<{ ok: boolean }>("DELETE", `/api/smsf-members/${id}`),
  superContributions: () => get<{ super_contributions: SuperContributionRow[] }>("/api/super-contributions").then((r) => r.super_contributions),
  addSuperContribution: (b: Partial<SuperContributionRow>) => post<{ id: string }>("/api/super-contributions", b),
  deleteSuperContribution: (id: string) => send<{ ok: boolean }>("DELETE", `/api/super-contributions/${id}`),
  basPeriods: () => get<{ bas_periods: BasPeriodRow[] }>("/api/bas-periods").then((r) => r.bas_periods),
  addBasPeriod: (b: Partial<BasPeriodRow>) => post<{ id: string }>("/api/bas-periods", b),
  deleteBasPeriod: (id: string) => send<{ ok: boolean }>("DELETE", `/api/bas-periods/${id}`),
  paygInstalments: () => get<{ payg_instalments: PaygInstalmentRow[] }>("/api/payg-instalments").then((r) => r.payg_instalments),
  addPaygInstalment: (b: Partial<PaygInstalmentRow>) => post<{ id: string }>("/api/payg-instalments", b),
  deletePaygInstalment: (id: string) => send<{ ok: boolean }>("DELETE", `/api/payg-instalments/${id}`),
  incomeMatches: () =>
    get<{
      suggestions: { txn_id: string; merchant: string | null; txn_amount_cents: number; txn_date: string | null; bucket: string | null; income_id: string; income_type: string; income_gross_cents: number; income_net_cents: number | null; income_date: string | null }[];
      matched: { txn_id: string; merchant: string | null; txn_amount_cents: number; txn_date: string | null; income_id: string; income_type: string; income_gross_cents: number }[];
    }>("/api/income/matches"),
  linkIncome: (txnId: string, incomeId: string) => post<{ ok: boolean }>("/api/income/link", { txnId, incomeId }),
  unlinkIncome: (txnId: string) => post<{ ok: boolean }>("/api/income/unlink", { txnId }),
  reviewSummary: (fy?: string) => get<ReviewSummary>(`/api/review/summary${fy ? `?fy=${fy}` : ""}`),
  resolveDeductibility: (b: { state: string; fy?: string; bucket?: string; atoLabel?: string | null; businessUsePct?: number | null; txnIds?: string[]; deductibleAmountCents?: number | null }) =>
    post<{ updated: number }>("/api/deductibility", b),
  documents: (opts: { type?: string; fy?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.type) q.set("type", opts.type);
    if (opts.fy) q.set("fy", opts.fy);
    const qs = q.toString();
    return get<{ documents: DocRow[] }>(`/api/documents${qs ? `?${qs}` : ""}`).then((r) => r.documents);
  },
  uploadDocument: async (file: File): Promise<{ docId: string; doc_type: string; routed: boolean }> => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/documents/upload", { method: "POST", credentials: "include", headers: await authHeaders(), body: fd });
    if (!res.ok) throw await errFrom(res);
    return res.json();
  },
  // Fetches the stored document WITH the Clerk Bearer token and hands back a same-origin
  // blob: URL the caller can open in a new tab. A plain <a href> to the download route is a
  // top-level navigation with no Authorization header → 401 "unauthorized" (see src/api.ts
  // download route). The caller is responsible for URL.revokeObjectURL once the tab has loaded.
  documentBlobUrl: async (id: string): Promise<string> => {
    const res = await fetch(`/api/documents/${id}/download`, { credentials: "include", headers: await authHeaders() });
    if (res.status === 401) throw new Error("unauthorized");
    if (!res.ok) throw await errFrom(res);
    return URL.createObjectURL(await res.blob());
  },

  // v2 — Assets & depreciation
  assets: (fy?: string) => get<{ assets: AssetRow[] }>(`/api/assets${fy ? `?fy=${fy}` : ""}`).then((r) => r.assets),
  addAsset: (b: Partial<AssetRow>) => post<{ id: string }>("/api/assets", b),
  assetSchedule: (id: string) => get<{ schedule: ScheduleRow[] }>(`/api/assets/${id}/schedule`).then((r) => r.schedule),
  computeAsset: (id: string) => post<{ rows: number }>(`/api/assets/${id}/compute`),
  disposeAsset: (id: string, disposed_date: string, disposal_value_cents: number) =>
    post<{ balancing_adjustment_cents: number }>(`/api/assets/${id}/dispose`, { disposed_date, disposal_value_cents }),
  deleteAsset: (id: string) => send<{ ok: boolean }>("DELETE", `/api/assets/${id}`),

  // v2 — FY checklist
  checklist: (fy?: string) => get<{ checklist: ChecklistItem[] }>(`/api/checklist${fy ? `?fy=${fy}` : ""}`).then((r) => r.checklist),
  generateChecklist: (fy?: string) => post<{ items: number }>(`/api/checklist/generate${fy ? `?fy=${fy}` : ""}`),
  setChecklistStatus: (id: string, status: string) => send<{ ok: boolean }>("PATCH", `/api/checklist/${id}`, { status }),

  // Work-use inputs (computed WFH fixed-rate deduction). fy = FY start year.
  workUse: (fy: number) => get<{ work_use: WorkUse }>(`/api/work-use?fy=${fy}`).then((r) => r.work_use),
  setWorkUse: (fy: number, body: WorkUse) => post<{ ok: true }>(`/api/work-use?fy=${fy}`, body),
  // Car cents-per-km input (#245) — separate from WFH (its own car_inputs table). fy = FY start year.
  carUse: (fy: number) => get<{ car_use: CarUse; rates?: CarUseRates | null }>(`/api/car-use?fy=${fy}`),
  // Trading stock (audit wave 4, flag trading_stock). fy = FY label '2025-26'.
  tradingStock: (fy: string) => get<{ trading_stock: { id: string; entity_id: string | null; fy: string; opening_cents: number; closing_cents: number; valuation_basis: string | null }[] }>(`/api/trading-stock?fy=${fy}`).then((r) => r.trading_stock),
  setTradingStock: (b: { entity_id?: string | null; fy?: string; opening_cents?: number; closing_cents?: number; valuation_basis?: string | null }) => post<{ ok: true }>("/api/trading-stock", b),
  setCarUse: (fy: number, body: CarUse) => post<{ ok: true }>(`/api/car-use?fy=${fy}`, body),
  // #256 pre-handoff double-check scan (deterministic, read-only). fy = FY start year.
  scan: (fy: number) => get<ScanResult>(`/api/scan?fy=${fy}`),

  // v2 — Claimability suggestions
  claims: () => get<{ claims: ClaimSuggestion[] }>("/api/claims").then((r) => r.claims),
  setClaimStatus: (id: string, status: string) => send<{ ok: boolean }>("PATCH", `/api/claims/${id}`, { status }),

  // Phase 3 — Find & attach claim evidence
  matchClaim: (claimId: string) => get<ClaimMatch>(`/api/claim-review/match?claimId=${encodeURIComponent(claimId)}`),
  attachClaim: (claimId: string, txnId: string) => post<{ ok: boolean; status: string }>("/api/claim-review/attach", { claimId, txnId }),
  detachClaim: (claimId: string, txnId: string) => post<{ ok: boolean; status: string }>("/api/claim-review/detach", { claimId, txnId }),

  // v2 — CGT on a disposed property (Phase 5)
  cgt: (propertyId: string) =>
    get<{ property_id: string; cost_base_cents: number; gross_gain_cents: number; is_capital_loss: boolean; discount_applied: boolean; discount_cents: number; net_gain_cents: number }>(`/api/properties/${propertyId}/cgt`),

  // Stage A — deterministic non-spend movement clean-up (no LLM, no consent)
  sweepMovements: () => get<MovementSweep>("/api/movements/sweep"),
  applyMovementSweep: (ids: string[]) => post<{ ignored: number; skipped: number }>("/api/movements/apply", { ids }),

  // Phase 2 — batch correction + undo + bulk delete
  correctBatch: (txnIds: string[], edits: { field: string; value: string }[], learn_rule = false) =>
    post<BatchResult>("/api/correct/batch", { txnIds, edits, learn_rule }),
  undoBatch: (batchId: string) => post<{ reverted: number }>("/api/correct/undo", { batchId }),
  deleteTxnBatch: (ids: string[]) => post<{ deleted: number }>("/api/transactions/batch-delete", { ids }),
  // Bulk "Confirm as-is": accept each selected row's current AI category, clearing it from review without
  // changing anything (flag bulk_confirm). Rows with no/'unknown' category are reported in `failures`.
  confirmBatch: (txnIds: string[]) => post<{ batch_id: string; updated: number; failures: { txnId: string; error: string }[] }>("/api/confirm/batch", { txnIds }),
  // Bulk "Not spend": exclude the selection as non-spend (status='ignored') in one undoable batch
  // (flag bulk_ignore). batch_id feeds the shared Undo toast (via undoBatch); already-excluded rows fail.
  ignoreBatch: (txnIds: string[]) => post<{ batch_id: string; updated: number; failures: { txnId: string; error: string }[] }>("/api/ignore/batch", { txnIds }),
  // grouped_review_v2 wave 3c: whole-queue merchant clusters so the review UI can "Select all N matching"
  // even when a merchant spans more than the loaded page. `truncated` ⇒ the queue exceeded the scan cap.
  reviewGroups: () => get<{ groups: { group_key: string; n: number; total_cents: number; ids: string[] }[]; truncated: boolean }>("/api/transactions/review-groups"),

  // Sort S1 — "edit one line → update its look-alikes" (flag apply_to_siblings; 404 when off)
  siblingsPreview: (txnId: string) => get<{ n: number; total_cents: number; group_key: string | null }>(`/api/transactions/${txnId}/siblings`),
  applyToSiblings: (txnId: string, edit: { bucket?: string; ato_label?: string; property_id?: string }, learn_rule = true) =>
    post<{ applied: number; batch_id: string; rule_created: boolean; group_key: string | null }>(`/api/transactions/${txnId}/apply-to-siblings`, { edit, learn_rule }),
  // #130: record a money-in line as income for its tagged property, linked so it counts once.
  recordTxnIncome: (txnId: string) => post<{ income_id: string | null }>(`/api/transactions/${txnId}/record-income`, {}),

  // Phase 4 — "Do my books" accountant pass
  runAccountantPass: (fy?: number) => post<AccountantSummary>(`/api/accountant/run${fy != null ? `?fy=${fy}` : ""}`),
  accountantSuggestions: (fy?: number) => get<{ suggestions: SuggestedDeduction[] }>(`/api/accountant/suggestions${fy != null ? `?fy=${fy}` : ""}`).then((r) => r.suggestions),
  // `denied` ⇒ the current rule pack no longer allows this suggestion (e.g. a raffle/art-union the pack
  // now denies); the server demotes it so the invalidated list drops the row rather than claiming it.
  confirmDeduction: (txnId: string) => post<{ ok: boolean; denied?: boolean }>("/api/accountant/confirm", { txnId }),

  // Stage B — clarify-by-pattern
  clarifyQuestions: (fy?: number) => get<{ questions: ClarifyQuestion[] }>(`/api/clarify${fy != null ? `?fy=${fy}` : ""}`).then((r) => r.questions),
  clarifyScan: (fy?: number) => post<{ questions: number; groups: number }>(`/api/clarify/scan${fy != null ? `?fy=${fy}` : ""}`),
  answerClarify: (id: string, answer: ClarifyAnswer) => post<{ applied: number; income_recorded: number }>(`/api/clarify/${id}/answer`, { answer }),
  dismissClarify: (id: string) => post<{ ok: boolean }>(`/api/clarify/${id}/dismiss`),

  // Phase B / G2 — attributions (who paid vs who claims) + the co-owner / activity spine
  txnAttributions: (txnId: string) => get<AttributionState>(`/api/transactions/${txnId}/attributions`),
  setTxnAttributions: (txnId: string, body: { payer_person_id?: string | null; paid_via_account_id?: string | null; attributions?: AttributionInput[] }) =>
    send<{ ok: boolean; attributions: AttributionRow[] }>("PUT", `/api/transactions/${txnId}/attributions`, body),
  clearTxnAttributions: (txnId: string) => send<{ ok: boolean }>("DELETE", `/api/transactions/${txnId}/attributions`),
  incomeActivities: () => get<{ income_activities: IncomeActivity[] }>("/api/income-activities").then((r) => r.income_activities),
  addIncomeActivity: (b: Partial<IncomeActivity>) => post<{ id: string }>("/api/income-activities", b),
  setIncomeActivityPsiStatus: (id: string, psi_status: string | null) => send<{ ok: boolean }>("PUT", `/api/income-activities/${id}`, { psi_status }),
  deleteIncomeActivity: (id: string) => send<{ ok: boolean }>("DELETE", `/api/income-activities/${id}`),
  propertyOwners: () => get<{ property_owners: PropertyOwner[] }>("/api/property-owners").then((r) => r.property_owners),
  addPropertyOwner: (b: { property_id: string; person_id: string; ownership_pct?: number }) => post<{ id: string }>("/api/property-owners", b),
  deletePropertyOwner: (id: string) => send<{ ok: boolean }>("DELETE", `/api/property-owners/${id}`),
  entityRoles: () => get<{ entity_roles: EntityRole[] }>("/api/entity-roles").then((r) => r.entity_roles),
  addEntityRole: (b: { person_id: string; entity_id: string; role: string; ownership_pct?: number }) => post<{ id: string }>("/api/entity-roles", b),
  deleteEntityRole: (id: string) => send<{ ok: boolean }>("DELETE", `/api/entity-roles/${id}`),

  // Admin (founder only — server enforces the 'admin' role)
  adminOverview: () => get<AdminOverview>("/api/admin/overview"),
  adminTenants: () => get<{ tenants: AdminTenant[] }>("/api/admin/tenants").then((r) => r.tenants),
  adminSpend: () => get<AdminSpend>("/api/admin/spend"),
  setTenantRoles: (userId: string, roles: string[]) => send<{ ok: boolean; roles: string[] }>("PUT", `/api/admin/tenants/${encodeURIComponent(userId)}/roles`, { roles }),
  // Partner portal (role 'partner') — the caller's own org only.
  partnerOverview: () => get<PartnerPortal>("/api/partner/overview"),
  // AI changes feed + undo (flag ai_edit_feed)
  aiEdits: () => get<{ edits: AiEdit[] }>("/api/ai-edits").then((r) => r.edits),
  undoAiEdit: (action_id: string) => post<{ reverted: number }>("/api/ai-edits/undo", { action_id }),
  applyEntityAction: (a: { kind: string; entity_id?: string; fields: Record<string, unknown>; action_id: string; session_id?: string }) =>
    post<{ ok: boolean; id: string; action_id: string }>("/api/ai-edits/apply", a),
};
