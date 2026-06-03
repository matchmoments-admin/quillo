import type { Env, TaxAgentRpc } from "./env";
import type { AuthedUser } from "./auth/access";
import { getProfile, getSituation } from "./lib/db";
import {
  listTransactions,
  getTransaction,
  receiptKeyFor,
  listNotifications,
  dashboard,
  listAccounts,
  usageSummary,
  listStatements,
  reconcilePairs,
  listIncome,
  listDocuments,
  listAssets,
  listDepreciation,
  listChecklist,
  listClaims,
} from "./lib/queries";
import {
  addPerson,
  updatePerson,
  addProperty,
  updateProperty,
  addEntity,
  addRule,
  addAccount,
  updateAccount,
  deleteRow,
  listKeys,
  mintKey,
  revokeKey,
} from "./lib/situation-write";
import { buildConnectUrl, qboStatus } from "./lib/qbo-oauth";
import { QuickBooksAdapter } from "./ledger/qbo";
import { LedgerReauthError } from "./ledger";
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
      kind: url.searchParams.get("kind") ?? undefined,
      limit: Number(url.searchParams.get("limit")) || undefined,
      offset: Number(url.searchParams.get("offset")) || undefined,
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
    // One or more `file` parts (multi-screenshot = one receipt). workers-types under-types
    // FormData, so cast the entries through Blob and drop any stray text fields.
    const blobs = (form.getAll("file") as unknown as Array<Blob | string>).filter(
      (f): f is Blob => typeof f !== "string",
    );
    if (blobs.length === 0) return json({ error: "no file" }, 400);
    const bucketEntry = form.get("bucket");
    const bucketHint = typeof bucketEntry === "string" ? bucketEntry : null;

    const images: { bytes: ArrayBuffer; mime: string }[] = [];
    for (const b of blobs) {
      const bytes = await b.arrayBuffer();
      if (bytes.byteLength > 0) images.push({ bytes, mime: b.type || "image/jpeg" });
    }
    if (images.length === 0) return json({ error: "empty file" }, 400);

    const first = images[0]!;
    const txnId =
      images.length === 1
        ? await stub.ingest(uid, "web", first.bytes, first.mime, bucketHint)
        : await stub.ingestImages(uid, "web", images, bucketHint);
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
  if (resource === "situation" && !id && m === "GET") {
    const profile = await getProfile(env, uid);
    if (!profile) return json({ error: "no profile" }, 404);
    const s = await getSituation(env, uid, profile);
    return json(s);
  }

  // POST /api/situation/draft  { message } — onboarding conversational front door. Returns a
  // structured DRAFT (entities/properties/rules) for the wizard to confirm; writes nothing.
  if (resource === "situation" && id === "draft" && m === "POST") {
    const { message } = (await req.json()) as { message?: string };
    if (!message || !message.trim()) return json({ error: "empty message" }, 400);
    try {
      return json(await stub.draftSituation(uid, message));
    } catch (e) {
      if ((e as Error).message === "consent_required") return json({ error: "consent_required" }, 403);
      throw e;
    }
  }

  // GET /api/dashboard — aggregates. Opportunistically apply any finished async batch jobs
  // (cheap no-op when there are none) so results land without waiting for the cron.
  if (resource === "dashboard" && m === "GET") {
    await stub.pollBatchJobs(uid);
    return json(await dashboard(env, uid));
  }

  // GET /api/usage — measured inference cost (today / month / by feature).
  if (resource === "usage" && m === "GET") {
    return json(await usageSummary(env, uid));
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
  // Persons (taxpayers). The list is returned by GET /api/situation (getSituation).
  if (resource === "persons") {
    if (m === "POST" && !id) return json({ id: await addPerson(env, uid, await req.json()) });
    if (m === "PUT" && id) {
      await updatePerson(env, uid, id, await req.json());
      return json({ ok: true });
    }
    if (m === "DELETE" && id) {
      await deleteRow(env, uid, "persons", id);
      return json({ ok: true });
    }
  }
  if (resource === "properties") {
    if (m === "POST") return json({ id: await addProperty(env, uid, await req.json()) });
    // GET /api/properties/:id/cgt — indicative CGT on a disposed property.
    if (m === "GET" && id && sub === "cgt") {
      try {
        return json(await stub.computeCgt(uid, id));
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
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
  // ── Accounts (bank/card/investment) ───────────────────────────────────────
  if (resource === "accounts") {
    if (m === "GET" && !id) return json({ accounts: await listAccounts(env, uid) });
    if (m === "POST" && !id) return json({ id: await addAccount(env, uid, await req.json()) });
    if (m === "PUT" && id) {
      await updateAccount(env, uid, id, await req.json());
      return json({ ok: true });
    }
    if (m === "POST" && id && sub === "source") {
      const { source } = (await req.json()) as { source: string };
      await stub.setAccountSource(uid, id, source);
      return json({ ok: true });
    }
    if (m === "DELETE" && id) {
      await deleteRow(env, uid, "accounts", id);
      return json({ ok: true });
    }
  }

  // ── Statement import (CSV) ─────────────────────────────────────────────────
  if (resource === "statements") {
    // POST /api/statements (multipart: file + account_id) → parse + preview (no commit yet)
    if (m === "POST" && !id) {
      const form = await req.formData();
      const entry = form.get("file");
      const accEntry = form.get("account_id");
      if (entry == null || typeof entry === "string") return json({ error: "no file" }, 400);
      if (typeof accEntry !== "string") return json({ error: "no account_id" }, 400);
      const file = entry as unknown as Blob;
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength === 0) return json({ error: "empty file" }, 400);
      const filename = (entry as unknown as { name?: string }).name ?? "statement.csv";
      const format = filename.toLowerCase().endsWith(".pdf") ? "pdf" : "csv";
      try {
        return json(await stub.parseStatement(uid, accEntry, filename, bytes, format));
      } catch (e) {
        const msg = (e as Error).message;
        if (msg === "consent_required") return json({ error: "consent_required" }, 403);
        return json({ error: msg }, 422); // unreadable statement / extraction failure — show the reason
      }
    }
    // POST /api/statements/:id/confirm [{ columnMap?, force? }] → commit + dedup + categorise
    if (m === "POST" && id && sub === "confirm") {
      const body = (await req.json().catch(() => ({}))) as { columnMap?: unknown; force?: boolean };
      try {
        return json(await stub.confirmImport(uid, id, body.columnMap, body.force));
      } catch (e) {
        return json({ error: (e as Error).message }, 409); // e.g. reconciliation gate
      }
    }
  }

  // ── Income (first-class) ──────────────────────────────────────────────────
  if (resource === "income") {
    if (m === "GET" && !id) {
      return json({
        income: await listIncome(env, uid, {
          fy: url.searchParams.get("fy") ?? undefined,
          personId: url.searchParams.get("person_id") ?? undefined,
          propertyId: url.searchParams.get("property_id") ?? undefined,
        }),
      });
    }
    if (m === "POST" && !id) return json({ id: await stub.recordIncome(uid, await req.json()) });
    if (m === "DELETE" && id) {
      await deleteRow(env, uid, "income", id);
      return json({ ok: true });
    }
  }

  // ── Assets & depreciation ─────────────────────────────────────────────────
  if (resource === "assets") {
    if (m === "GET" && !id) return json({ assets: await listAssets(env, uid, url.searchParams.get("fy") ?? undefined) });
    if (m === "POST" && !id) return json({ id: await stub.createAsset(uid, await req.json()) });
    if (m === "GET" && id && sub === "schedule") return json({ schedule: await listDepreciation(env, uid, id) });
    if (m === "POST" && id && sub === "compute") {
      const fy = Number(url.searchParams.get("fy")) || undefined;
      return json(await stub.computeDepreciation(uid, id, fy));
    }
    if (m === "POST" && id && sub === "dispose") {
      const { disposed_date, disposal_value_cents } = (await req.json()) as { disposed_date: string; disposal_value_cents: number };
      return json(await stub.disposeAsset(uid, id, disposed_date, disposal_value_cents));
    }
    if (m === "DELETE" && id) {
      await deleteRow(env, uid, "assets", id);
      return json({ ok: true });
    }
  }
  // POST /api/depreciation/rollforward?fy= — batch roll every active asset into a new FY.
  if (resource === "depreciation" && id === "rollforward" && m === "POST") {
    const fy = Number(url.searchParams.get("fy")) || new Date().getFullYear();
    return json(await stub.rollForward(uid, fy));
  }

  // ── FY checklist ──────────────────────────────────────────────────────────
  if (resource === "checklist") {
    if (m === "GET" && !id) return json({ checklist: await listChecklist(env, uid, url.searchParams.get("fy") ?? undefined) });
    if (m === "POST" && id === "generate") return json(await stub.generateChecklist(uid, url.searchParams.get("fy") ?? undefined));
    if (m === "PATCH" && id) {
      const { status } = (await req.json()) as { status: string };
      await stub.setChecklistStatus(uid, id, status);
      return json({ ok: true });
    }
  }

  // ── Claim suggestions (claimability brain) ────────────────────────────────
  if (resource === "claims") {
    if (m === "GET" && !id) return json({ claims: await listClaims(env, uid) });
    if (m === "PATCH" && id) {
      const { status } = (await req.json()) as { status: string };
      await stub.setClaimStatus(uid, id, status);
      return json({ ok: true });
    }
  }

  // ── Documents shelf (Smart-Inbox sink + registry) ─────────────────────────
  if (resource === "documents") {
    if (m === "GET" && !id) {
      return json({
        documents: await listDocuments(env, uid, {
          type: url.searchParams.get("type") ?? undefined,
          fy: url.searchParams.get("fy") ?? undefined,
          propertyId: url.searchParams.get("property_id") ?? undefined,
        }),
      });
    }
    // POST /api/documents/upload (multipart: file) → classify + route via the Smart Inbox.
    if (m === "POST" && id === "upload") {
      const form = await req.formData();
      const entry = form.get("file");
      if (entry == null || typeof entry === "string") return json({ error: "no file" }, 400);
      const file = entry as unknown as Blob;
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength === 0) return json({ error: "empty file" }, 400);
      const out = await stub.classifyAndRoute(uid, "web", bytes, file.type || "application/octet-stream");
      return json(out);
    }
    // GET /api/documents/:id/download — stream the R2 object (scoped to the tenant).
    if (m === "GET" && id && sub === "download") {
      const row = await env.DB.prepare(`SELECT r2_key FROM documents WHERE id = ? AND user_id = ?`)
        .bind(id, uid)
        .first<{ r2_key: string | null }>();
      if (!row?.r2_key) return json({ error: "not found" }, 404);
      const obj = await env.RECEIPTS.get(row.r2_key);
      if (!obj) return json({ error: "not found" }, 404);
      return new Response(obj.body, {
        headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "cache-control": "private, max-age=60" },
      });
    }
  }

  // GET /api/reconcile — unmatched receipts vs unmatched bank lines (for the Reconcile page).
  if (resource === "reconcile" && m === "GET") {
    return json(await reconcilePairs(env, uid));
  }

  // GET /api/statements?account_id= — statement import status per account.
  if (resource === "statements" && m === "GET" && !id) {
    return json({ statements: await listStatements(env, uid, url.searchParams.get("account_id") ?? undefined) });
  }

  // ── Manual receipt ↔ bank-line matching ───────────────────────────────────
  if (resource === "match" && m === "POST") {
    if (id === "link") {
      const { receiptId, lineId } = (await req.json()) as { receiptId: string; lineId: string };
      await stub.linkReceipt(uid, receiptId, lineId);
      return json({ ok: true });
    }
    if (id === "unlink") {
      const { receiptId } = (await req.json()) as { receiptId: string };
      await stub.unlinkReceipt(uid, receiptId);
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
    // POST /api/qbo/sync-accounts — register QBO bank/card accounts as source='qbo_feed'
    // (activates the feed-vs-statement dedup guard).
    if (id === "sync-accounts" && m === "POST") return json(await stub.syncQboAccounts(uid));
    // POST /api/qbo/push/:txnId — user-triggered push of a NON-FEED company expense.
    if (id === "push" && sub && m === "POST") return json(await stub.pushToQuickBooks(uid, sub));
    // Returns the Intuit authorize URL as JSON (NOT a redirect): the SPA fetches this with
    // its Bearer token, then navigates the browser to Intuit. A plain <a href> here would be
    // a top-level navigation with no Authorization header → requireClerk 401. The OAuth
    // callback is handled as a PUBLIC route in index.ts (Intuit can't send our Bearer token).
    if (id === "connect" && m === "GET") {
      if (!env.QBO_CLIENT_ID) return json({ error: "QuickBooks is not configured (QBO_CLIENT_ID missing)." }, 400);
      const connectUrl = await buildConnectUrl(env, uid, url.origin);
      // Log the exact authorize URL we hand the browser so `wrangler tail` can confirm the
      // redirect_uri we send Intuit (diagnostic for the production connect issue).
      console.log(`qbo connect: redirect_uri=${url.origin}/api/qbo/callback authorize=${connectUrl}`);
      return json({ url: connectUrl });
    }
    if (id === "reconcile" && m === "GET") {
      // Only receipts are candidate QBO purchases — statement bank_lines come from the
      // bank feed QBO already has, so excluding them keeps the two pipes from overlapping.
      const company = await listTransactions(env, uid, { bucket: "company", kind: "receipt", limit: 50 });
      let purchases: unknown[] = [];
      let connected = false;
      let needsReconnect = false;
      let err: string | null = null;
      try {
        purchases = await new QuickBooksAdapter(env).listRecentPurchases(uid);
        connected = true;
      } catch (e) {
        // A dead refresh token surfaces as LedgerReauthError → tell the UI to prompt reconnect.
        if (e instanceof LedgerReauthError) {
          needsReconnect = true;
          err = "QuickBooks needs reconnecting — your authorisation expired.";
        } else {
          err = (e as Error).message;
        }
      }
      return json({ connected, needsReconnect, company, purchases, error: err });
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

  // ── Filing readiness (capstone) ───────────────────────────────────────────
  if (resource === "filing-readiness" && m === "GET") {
    const fy = Number(url.searchParams.get("fy")) || currentFyStartYear();
    return json(await stub.assessFilingReadiness(uid, fy));
  }

  return json({ error: "not found" }, 404);
}
