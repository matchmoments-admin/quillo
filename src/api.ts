import type { Env, TaxAgentRpc } from "./env";
import type { AuthedUser } from "./auth/access";
import { getProfile, getSituation } from "./lib/db";
import {
  listTransactions,
  getTransaction,
  receiptKeyFor,
  listNotifications,
  dashboard,
} from "./lib/queries";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/**
 * Web API router. Everything here is already authenticated (the caller verified
 * Cloudflare Access) and scoped to `user.userId`. Reads hit D1; audited writes go
 * through the Durable Object `stub`.
 */
export async function handleApi(
  req: Request,
  env: Env,
  user: AuthedUser,
  stub: TaxAgentRpc,
): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const [resource, id, sub] = parts;
  const m = req.method;
  const uid = user.userId;

  // GET /api/transactions  ·  GET /api/transactions/:id
  if (resource === "transactions" && m === "GET") {
    if (id) {
      const txn = await getTransaction(env, uid, id);
      return txn ? json(txn) : json({ error: "not found" }, 404);
    }
    const rows = await listTransactions(env, uid, {
      status: url.searchParams.get("status") ?? undefined,
      bucket: url.searchParams.get("bucket") ?? undefined,
      limit: Number(url.searchParams.get("limit")) || undefined,
    });
    return json({ transactions: rows });
  }

  // GET /api/receipt/:txnId — stream the R2 object for thumbnails / preview.
  if (resource === "receipt" && id && m === "GET") {
    const key = await receiptKeyFor(env, uid, id);
    if (!key) return json({ error: "not found" }, 404);
    const obj = await env.RECEIPTS.get(key);
    if (!obj) return json({ error: "not found" }, 404);
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
        "cache-control": "private, max-age=60",
      },
    });
  }

  // GET /api/notifications  ·  POST /api/notifications/:id/read
  if (resource === "notifications") {
    if (m === "GET") return json({ notifications: await listNotifications(env, uid) });
    if (m === "POST" && id && sub === "read") {
      await env.DB.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ?`)
        .bind(id, uid)
        .run();
      return json({ ok: true });
    }
  }

  // GET /api/situation — profile + properties + entities + rules (for dropdowns/settings).
  if (resource === "situation" && m === "GET") {
    const profile = await getProfile(env, uid);
    if (!profile) return json({ error: "no profile" }, 404);
    const s = await getSituation(env, uid, profile);
    return json(s);
  }

  // GET /api/dashboard — aggregates.
  if (resource === "dashboard" && m === "GET") {
    return json(await dashboard(env, uid));
  }

  // POST /api/correct  { txnId, field, value } — audited write via the DO.
  if (resource === "correct" && m === "POST") {
    const { txnId, field, value } = (await req.json()) as { txnId: string; field: string; value: string };
    await stub.applyCorrection(uid, txnId, field, value);
    return json({ ok: true });
  }

  // POST /api/consent  { text, method } — records APP-8 consent via the DO.
  if (resource === "consent" && m === "POST") {
    const { text, method } = (await req.json()) as { text: string; method?: string };
    await stub.recordConsent(uid, text, method ?? "web");
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}
