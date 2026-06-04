import type { Txn, TxnDetail, Situation, SituationDraft, Notification, DashboardData, KeyRow, QboStatus, Reconcile, Report, Account, StatementParse, UsageData, StatementInfo, IncomeRow, DocRow, AssetRow, ScheduleRow, ChecklistItem, ClaimSuggestion, FilingReadiness } from "./types";

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

// Same-origin: the SPA is served by the Worker, so /api/* needs no base URL.
// In dev, Vite proxies /api to the local Worker (see vite.config.ts).
async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include", headers: await authHeaders() });
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
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
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
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
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  },
  situation: () => get<Situation>("/api/situation"),
  draftSituation: (message: string) => post<SituationDraft>("/api/situation/draft", { message }),
  receiptUrl: (id: string) => `/api/receipt/${id}`,
  correct: (txnId: string, field: string, value: string) => post<{ ok: boolean }>("/api/correct", { txnId, field, value }),
  deleteTxn: (id: string) => send<{ ok: boolean }>("DELETE", `/api/transactions/${id}`),

  // Phase 2
  dashboard: () => get<DashboardData>("/api/dashboard"),
  usage: () => get<UsageData>("/api/usage"),
  notifications: () => get<{ notifications: Notification[] }>("/api/notifications").then((r) => r.notifications),
  markRead: (id: string) => post<{ ok: boolean }>(`/api/notifications/${id}/read`),

  // Phase 3
  addProperty: (b: unknown) => post<{ id: string }>("/api/properties", b),
  updateProperty: (id: string, b: unknown) => send<{ ok: boolean }>("PUT", `/api/properties/${id}`, b),
  deleteProperty: (id: string) => send<{ ok: boolean }>("DELETE", `/api/properties/${id}`),
  addEntity: (b: unknown) => post<{ id: string }>("/api/entities", b),
  deleteEntity: (id: string) => send<{ ok: boolean }>("DELETE", `/api/entities/${id}`),
  addRule: (b: unknown) => post<{ id: string }>("/api/rules", b),
  deleteRule: (id: string) => send<{ ok: boolean }>("DELETE", `/api/rules/${id}`),
  keys: () => get<{ keys: KeyRow[] }>("/api/keys").then((r) => r.keys),
  mintKey: (label: string) => post<{ keyId: string; secret: string }>("/api/keys", { label }),
  revokeKey: (id: string) => post<{ ok: boolean }>(`/api/keys/${id}/revoke`),
  consent: (text: string) => post<{ ok: boolean }>("/api/consent", { text, method: "web" }),

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
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  },
  confirmImport: (statementId: string, force?: boolean, columnMap?: unknown) =>
    post<{ imported: number; skipped: number }>(`/api/statements/${statementId}/confirm`, { columnMap, force }),
  confirmImportBulk: (opts?: { statementIds?: string[]; force?: boolean }) =>
    post<{ statements: number; imported: number; skipped: number; errors: { statementId: string; error: string }[] }>(
      "/api/statements/confirm-batch",
      opts ?? {},
    ),

  // Phase 4
  qboStatus: () => get<QboStatus>("/api/qbo/status"),
  qboPush: (txnId: string) => post<{ ok: boolean; ledgerRef?: string; error?: string }>(`/api/qbo/push/${txnId}`),
  reconcile: () => get<Reconcile>("/api/qbo/reconcile"),
  // Fetches the Intuit authorize URL (Bearer-authed); the caller then navigates the browser
  // to it. A plain <a href> to /api/qbo/connect would 401 (no Authorization header on a
  // top-level navigation).
  qboConnect: () => get<{ url: string }>("/api/qbo/connect"),

  // Phase 5
  report: (fy?: number) => get<Report>(`/api/report${fy ? `?fy=${fy}` : ""}`),
  reportCsvUrl: (fy?: number) => `/api/report?format=csv${fy ? `&fy=${fy}` : ""}`,
  filingReadiness: (fy?: number) => get<FilingReadiness>(`/api/filing-readiness${fy ? `?fy=${fy}` : ""}`),

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
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  },
  // Fetches the stored document WITH the Clerk Bearer token and hands back a same-origin
  // blob: URL the caller can open in a new tab. A plain <a href> to the download route is a
  // top-level navigation with no Authorization header → 401 "unauthorized" (see src/api.ts
  // download route). The caller is responsible for URL.revokeObjectURL once the tab has loaded.
  documentBlobUrl: async (id: string): Promise<string> => {
    const res = await fetch(`/api/documents/${id}/download`, { credentials: "include", headers: await authHeaders() });
    if (res.status === 401) throw new Error("unauthorized");
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
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
};
