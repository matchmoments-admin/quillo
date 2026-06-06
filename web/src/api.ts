import type { Txn, TxnDetail, Situation, SituationDraft, Notification, DashboardData, KeyRow, QboStatus, Reconcile, Report, Account, StatementParse, UsageData, StatementInfo, IncomeRow, DocRow, AssetRow, ScheduleRow, ChecklistItem, ClaimSuggestion, FilingReadiness, ReviewSummary, Progress, AdminTenant, AdminOverview, ClaimReview, OccupationRulesDraft, OccupationRuleCandidate, MovementSweep, BatchResult } from "./types";

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

// Turn a non-2xx response into a clean Error. The Worker returns `{ error: "<message>" }` JSON, so
// surface just that message (shown verbatim in toasts) instead of a raw `429 {"error":"…"}` blob.
// Falls back to the raw body / status text when the response isn't the expected shape. NOTE: callers
// that match on a code (e.g. TabGuide checks `.includes("consent_required")`) still work — the parsed
// message is exactly that string.
async function errFrom(res: Response): Promise<Error> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body?.error === "string" && body.error) return new Error(body.error);
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return new Error(text || `${res.status} ${res.statusText}`);
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
  transactions: (opts: { status?: string; kind?: string; review?: boolean; offset?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.status) q.set("status", opts.status);
    if (opts.kind) q.set("kind", opts.kind);
    if (opts.review) q.set("review", "1");
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

  // Phase 2
  dashboard: (fy?: number) => get<DashboardData>(`/api/dashboard${fy ? `?fy=${fy}` : ""}`),
  progress: () => get<Progress>("/api/progress"),
  guideMe: (tab: string) => post<{ headline: string; steps: string[] }>("/api/guide", { tab }),
  usage: () => get<UsageData>("/api/usage"),
  notifications: () => get<{ notifications: Notification[] }>("/api/notifications").then((r) => r.notifications),
  markRead: (id: string) => post<{ ok: boolean }>(`/api/notifications/${id}/read`),

  // Phase 3
  addProperty: (b: unknown) => post<{ id: string }>("/api/properties", b),
  updateProperty: (id: string, b: unknown) => send<{ ok: boolean }>("PUT", `/api/properties/${id}`, b),
  deleteProperty: (id: string) => send<{ ok: boolean }>("DELETE", `/api/properties/${id}`),
  addEntity: (b: unknown) => post<{ id: string }>("/api/entities", b),
  updateEntity: (id: string, b: unknown) => send<{ ok: boolean }>("PUT", `/api/entities/${id}`, b),
  deleteEntity: (id: string) => send<{ ok: boolean }>("DELETE", `/api/entities/${id}`),
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
  setAccountSource: (id: string, source: string) => post<{ ok: boolean }>(`/api/accounts/${id}/source`, { source }),
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
  reportCsvUrl: (fy?: number) => `/api/report?format=csv${fy ? `&fy=${fy}` : ""}`,
  filingReadiness: (fy?: number) => get<FilingReadiness>(`/api/filing-readiness${fy ? `?fy=${fy}` : ""}`),

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
  addIncome: (b: Partial<IncomeRow>) => post<{ id: string }>("/api/income", b),
  deleteIncome: (id: string) => send<{ ok: boolean }>("DELETE", `/api/income/${id}`),
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

  // v2 — Claimability suggestions
  claims: () => get<{ claims: ClaimSuggestion[] }>("/api/claims").then((r) => r.claims),
  setClaimStatus: (id: string, status: string) => send<{ ok: boolean }>("PATCH", `/api/claims/${id}`, { status }),

  // v2 — CGT on a disposed property (Phase 5)
  cgt: (propertyId: string) =>
    get<{ property_id: string; cost_base_cents: number; gross_gain_cents: number; is_capital_loss: boolean; discount_applied: boolean; discount_cents: number; net_gain_cents: number }>(`/api/properties/${propertyId}/cgt`),

  // Stage A — deterministic non-spend movement clean-up (no LLM, no consent)
  sweepMovements: () => get<MovementSweep>("/api/movements/sweep"),
  applyMovementSweep: (ids: string[]) => post<{ ignored: number; skipped: number }>("/api/movements/apply", { ids }),

  // Phase 2 — batch correction + undo + bulk delete
  correctBatch: (txnIds: string[], edits: { field: string; value: string }[]) => post<BatchResult>("/api/correct/batch", { txnIds, edits }),
  undoBatch: (batchId: string) => post<{ reverted: number }>("/api/correct/undo", { batchId }),
  deleteTxnBatch: (ids: string[]) => post<{ deleted: number }>("/api/transactions/batch-delete", { ids }),

  // Admin (founder only — server enforces the 'admin' role)
  adminOverview: () => get<AdminOverview>("/api/admin/overview"),
  adminTenants: () => get<{ tenants: AdminTenant[] }>("/api/admin/tenants").then((r) => r.tenants),
  setTenantRoles: (userId: string, roles: string[]) => send<{ ok: boolean; roles: string[] }>("PUT", `/api/admin/tenants/${encodeURIComponent(userId)}/roles`, { roles }),
};
