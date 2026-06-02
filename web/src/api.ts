import type { Txn, TxnDetail, Situation, Notification, DashboardData, KeyRow, QboStatus, Reconcile, Report, Account, StatementParse, UsageData, StatementInfo } from "./types";

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
  transactions: (opts: { status?: string; kind?: string; offset?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.status) q.set("status", opts.status);
    if (opts.kind) q.set("kind", opts.kind);
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

  // Phase 4
  qboStatus: () => get<QboStatus>("/api/qbo/status"),
  qboPush: (txnId: string) => post<{ ok: boolean; ledgerRef?: string; error?: string }>(`/api/qbo/push/${txnId}`),
  reconcile: () => get<Reconcile>("/api/qbo/reconcile"),
  qboConnectUrl: "/api/qbo/connect",

  // Phase 5
  report: (fy?: number) => get<Report>(`/api/report${fy ? `?fy=${fy}` : ""}`),
  reportCsvUrl: (fy?: number) => `/api/report?format=csv${fy ? `&fy=${fy}` : ""}`,
};
