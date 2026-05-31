import type { Txn, TxnDetail, Situation } from "./types";

// Same-origin: the SPA is served by the Worker, so /api/* needs no base URL.
// In dev, Vite proxies /api to the local Worker (see vite.config.ts).
async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  transactions: (status?: string) =>
    get<{ transactions: Txn[] }>(`/api/transactions${status ? `?status=${status}` : ""}`).then((r) => r.transactions),
  transaction: (id: string) => get<TxnDetail>(`/api/transactions/${id}`),
  situation: () => get<Situation>("/api/situation"),
  receiptUrl: (id: string) => `/api/receipt/${id}`,
  correct: (txnId: string, field: string, value: string) =>
    post<{ ok: boolean }>("/api/correct", { txnId, field, value }),
};
