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
import {
  addProperty,
  updateProperty,
  addEntity,
  addRule,
  deleteRow,
  listKeys,
  mintKey,
  revokeKey,
} from "./lib/situation-write";
import { buildConnectUrl, handleCallback, qboStatus } from "./lib/qbo-oauth";
import { QuickBooksAdapter } from "./ledger/qbo";
import { buildReport, reportToCsv, currentFyStartYear } from "./lib/report";

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

  // DELETE /api/transactions/:id — hard-delete (e.g. a duplicate), audited via the DO.
  if (resource === "transactions" && id && m === "DELETE") {
    await stub.deleteTransaction(uid, id);
    return json({ ok: true });
  }

  // POST /api/upload — snap-and-upload a receipt from the browser / phone camera.
  // Multipart form-data: `file` (image/PDF) [+ optional `bucket` hint]. Access has already
  // authenticated the user (scoped to uid), so no HMAC signing is needed here — that's
  // only for the unauthenticated device endpoint /ingest. ingest() awaits extraction, so
  // the response returns once the receipt is categorised.
  if (resource === "upload" && m === "POST") {
    const form = await req.formData();
    const entry = form.get("file");
    // FormData entries are File | string at runtime; a missing/text entry means no upload.
    // (workers-types under-types get() as string|null, so cast the file case through Blob.)
    if (entry == null || typeof entry === "string") return json({ error: "no file" }, 400);
    const file = entry as unknown as Blob;
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength === 0) return json({ error: "empty file" }, 400);
    const mime = file.type || "image/jpeg";
    const bucketEntry = form.get("bucket");
    const bucketHint = typeof bucketEntry === "string" ? bucketEntry : null;
    const txnId = await stub.ingest(uid, "web", bytes, mime, bucketHint);
    return json({ ok: true, txnId });
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

  // ── Situation writes (Settings + web onboarding) ──────────────────────────
  if (resource === "properties") {
    if (m === "POST") return json({ id: await addProperty(env, uid, await req.json()) });
    if (m === "PUT" && id) {
      await updateProperty(env, uid, id, await req.json());
      return json({ ok: true });
    }
    if (m === "DELETE" && id) {
      await deleteRow(env, uid, "properties", id);
      return json({ ok: true });
    }
  }
  if (resource === "entities") {
    if (m === "POST") return json({ id: await addEntity(env, uid, await req.json()) });
    if (m === "DELETE" && id) {
      await deleteRow(env, uid, "entities", id);
      return json({ ok: true });
    }
  }
  if (resource === "rules") {
    if (m === "POST") return json({ id: await addRule(env, uid, await req.json()) });
    if (m === "DELETE" && id) {
      await deleteRow(env, uid, "user_rules", id);
      return json({ ok: true });
    }
  }
  if (resource === "keys") {
    if (m === "GET") return json({ keys: await listKeys(env, uid) });
    if (m === "POST" && !id) {
      const b = (await req.json().catch(() => ({}))) as { label?: string };
      return json(await mintKey(env, uid, b.label ?? "web"));
    }
    if (m === "POST" && id && sub === "revoke") {
      await revokeKey(env, uid, id);
      return json({ ok: true });
    }
  }

  // ── QuickBooks (Phase 4) ──────────────────────────────────────────────────
  if (resource === "qbo") {
    if (id === "status" && m === "GET") return json(await qboStatus(env, uid));
    if (id === "connect" && m === "GET") {
      if (!env.QBO_CLIENT_ID) return json({ error: "QBO_CLIENT_ID not set" }, 400);
      return Response.redirect(await buildConnectUrl(env, uid, url.origin), 302);
    }
    if (id === "callback" && m === "GET") {
      const r = await handleCallback(env, url, url.origin);
      return Response.redirect(`${url.origin}/quickbooks?connected=${r.ok ? "1" : "0"}`, 302);
    }
    if (id === "reconcile" && m === "GET") {
      const company = await listTransactions(env, uid, { bucket: "company", limit: 50 });
      let purchases: unknown[] = [];
      let connected = false;
      let err: string | null = null;
      try {
        purchases = await new QuickBooksAdapter(env).listRecentPurchases(uid);
        connected = true;
      } catch (e) {
        err = (e as Error).message;
      }
      return json({ connected, company, purchases, error: err });
    }
  }

  // ── Year-end report (Phase 5) ─────────────────────────────────────────────
  if (resource === "report" && m === "GET") {
    const fy = Number(url.searchParams.get("fy")) || currentFyStartYear();
    const rep = await buildReport(env, uid, fy);
    if (url.searchParams.get("format") === "csv") {
      return new Response(reportToCsv(rep), {
        headers: {
          "content-type": "text/csv",
          "content-disposition": `attachment; filename=tax-agent-${rep.fy}.csv`,
        },
      });
    }
    return json(rep);
  }

  return json({ error: "not found" }, 404);
}
