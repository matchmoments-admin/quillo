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
  listTenantsAdmin,
  platformOverview,
  listSuggestedDeductions,
} from "./lib/queries";
import { isAdmin, normaliseRoles } from "./lib/roles";
import {
  addPerson,
  updatePerson,
  addProperty,
  updateProperty,
  addEntity,
  updateEntity,
  addRule,
  updateRule,
  addAccount,
  updateAccount,
  addLoanProperty,
  updateLoanProperty,
  addPropertyOwner,
  listPropertyOwners,
  addEntityRole,
  listEntityRoles,
  listIncomeActivities,
  addCapitalLoss,
  listCapitalLosses,
  addDepreciationOpening,
  listDepreciationOpenings,
  signOffFy,
  clearSignOffFy,
  getFySignoff,
  ensureTenant,
  deleteRow,
  listKeys,
  mintKey,
  revokeKey,
} from "./lib/situation-write";
import { setAttributions, getAttributions, clearAttributions } from "./lib/attribution-write";
import { buildConnectUrl, qboStatus } from "./lib/qbo-oauth";
import { QuickBooksAdapter } from "./ledger/qbo";
import { LedgerReauthError } from "./ledger";
import { buildReport, reportToCsv, currentFyStartYear } from "./lib/report";
import { getProgress } from "./lib/progress";
import { featureOn } from "./lib/features";

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
  // Bootstrap a fresh tenant (profile + self person + signup email) on first authed touch.
  await ensureTenant(env, uid, user.email);

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
      review: url.searchParams.get("review") === "1" || undefined,
      limit: Number(url.searchParams.get("limit")) || undefined,
      offset: Number(url.searchParams.get("offset")) || undefined,
    });
    return json({ transactions: rows });
  }

  // POST /api/transactions/batch-delete  { ids } — bulk hard-delete (audited per row via the DO).
  if (resource === "transactions" && id === "batch-delete" && m === "POST") {
    const { ids } = (await req.json().catch(() => ({}))) as { ids?: unknown };
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) return json({ error: "ids must be an array of strings" }, 400);
    return json(await stub.deleteTransactionBatch(uid, ids as string[]));
  }

  // ── Attributions (Phase B / G2): who-paid vs who-claims for one transaction ──
  // GET/PUT/DELETE /api/transactions/:id/attributions
  if (resource === "transactions" && id && sub === "attributions") {
    if (m === "GET") return json(await getAttributions(env, uid, id));
    if (m === "PUT") {
      const body = (await req.json().catch(() => ({}))) as Parameters<typeof setAttributions>[3];
      const res = await setAttributions(env, uid, id, body);
      return res.ok ? json({ ok: true, attributions: res.rows }) : json({ error: res.error }, 400);
    }
    if (m === "DELETE") {
      await clearAttributions(env, uid, id);
      return json({ ok: true });
    }
  }

  // PATCH /api/transactions/:id/flags { reimbursed } — set the per-txn reimbursed fact. Employer-
  // reimbursed spend isn't the taxpayer's deductible cost, so the report excludes it (0030). Direct,
  // user-scoped write (a fact flag, not a categorisation correction).
  if (resource === "transactions" && id && sub === "flags" && m === "PATCH") {
    const body = (await req.json().catch(() => ({}))) as { reimbursed?: unknown };
    if (typeof body.reimbursed !== "boolean") return json({ error: "reimbursed must be a boolean" }, 400);
    await env.DB.prepare(`UPDATE transactions SET reimbursed = ? WHERE id = ? AND user_id = ?`).bind(body.reimbursed ? 1 : 0, id, uid).run();
    return json({ ok: true, reimbursed: body.reimbursed });
  }

  // DELETE /api/transactions/:id — hard-delete (e.g. a duplicate), audited via the DO.
  if (resource === "transactions" && id && id !== "batch-delete" && sub !== "attributions" && sub !== "flags" && m === "DELETE") {
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
      const msg = (e as Error).message;
      if (msg === "consent_required") return json({ error: "consent_required" }, 403);
      if (msg === "ai_budget_reached") return json({ error: "AI is paused for today (daily limit reached) — try again after the reset, or fill the form in manually." }, 429);
      throw e;
    }
  }

  // POST /api/guide { tab } — live "Guide me" AI walkthrough (flag guide_me). 404 when off.
  if (resource === "guide" && m === "POST") {
    if (!featureOn(env, "guide_me")) return json({ error: "not available" }, 404);
    const { tab } = (await req.json().catch(() => ({}))) as { tab?: string };
    if (!tab) return json({ error: "missing tab" }, 400);
    try {
      return json(await stub.guideMe(uid, tab));
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "consent_required") return json({ error: "consent_required" }, 403);
      if (msg === "ai_budget_reached") return json({ error: "AI is paused for today (daily limit reached) — try again after the reset." }, 429);
      throw e;
    }
  }

  // GET /api/dashboard — aggregates. Opportunistically apply any finished async batch jobs
  // (cheap no-op when there are none) so results land without waiting for the cron.
  if (resource === "dashboard" && m === "GET") {
    await stub.pollBatchJobs(uid);
    // FY-scoped (Jul–Jun); the SPA always sends ?fy=<start year> from the active-FY switcher.
    // Absent/garbage → default to the current FY so a bare /api/dashboard still works.
    const fy = Number(url.searchParams.get("fy")) || currentFyStartYear();
    return json(await dashboard(env, uid, fy));
  }

  // GET /api/usage — measured inference cost (today / month / by feature).
  if (resource === "usage" && m === "GET") {
    return json(await usageSummary(env, uid));
  }

  // GET /api/progress — derived completion state + the single next action that drives the
  // cross-tab spine and per-tab guides. Read-only (counts only); reuses COUNTABLE / NEEDS_REVIEW.
  if (resource === "progress" && m === "GET") {
    // All-time on purpose: the spine + nav badge are a single cross-year work backlog that must match
    // the (un-FY-scoped) Inbox/Reconcile queues they link to. Only the dashboard's MONEY cards are per-FY.
    return json(await getProgress(env, uid));
  }

  // ── Account data (APP 12 export / APP 13 erasure) ─────────────────────────
  if (resource === "account" && id === "export" && m === "GET") {
    const data = await stub.exportTenant(uid);
    return new Response(JSON.stringify(data, null, 2), {
      headers: { "content-type": "application/json", "content-disposition": "attachment; filename=quillo-export.json" },
    });
  }
  if (resource === "account" && id === "data" && m === "DELETE") {
    return json(await stub.purgeTenant(uid));
  }

  // PATCH /api/ui-state { patch } — merge UI flags (walkthrough seen, etc.) into profiles.ui_state.
  if (resource === "ui-state" && m === "PATCH") {
    const { patch } = (await req.json().catch(() => ({}))) as { patch?: Record<string, unknown> };
    return json(await stub.setUiState(uid, patch ?? {}));
  }

  // POST /api/correct/batch { txnIds, edits } — apply one set of edits to many txns (undoable).
  // POST /api/correct/undo  { batchId }        — revert a batch correction as a unit.
  if (resource === "correct" && id === "batch" && m === "POST") {
    const { txnIds, edits } = (await req.json().catch(() => ({}))) as { txnIds?: unknown; edits?: unknown };
    if (!Array.isArray(txnIds) || txnIds.some((x) => typeof x !== "string")) return json({ error: "txnIds must be an array of strings" }, 400);
    if (!Array.isArray(edits) || edits.some((e) => typeof (e as { field?: unknown })?.field !== "string" || typeof (e as { value?: unknown })?.value !== "string"))
      return json({ error: "edits must be an array of {field, value}" }, 400);
    try {
      return json(await stub.applyCorrectionBatch(uid, txnIds as string[], edits as { field: string; value: string }[]));
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }
  if (resource === "correct" && id === "undo" && m === "POST") {
    const { batchId } = (await req.json().catch(() => ({}))) as { batchId?: unknown };
    if (typeof batchId !== "string" || !batchId) return json({ error: "batchId required" }, 400);
    return json(await stub.undoCorrectionBatch(uid, batchId));
  }

  // POST /api/correct  { txnId, field, value } — audited write via the DO.
  if (resource === "correct" && !id && m === "POST") {
    const { txnId, field, value } = (await req.json()) as { txnId: string; field: string; value: string };
    await stub.applyCorrection(uid, txnId, field, value);
    return json({ ok: true });
  }

  // POST /api/consent  { text, method } — records APP-8 consent via the DO.
  // POST /api/consent/withdraw — clears cross-border consent (re-arms the gate); audited.
  if (resource === "consent" && m === "POST") {
    if (id === "withdraw") return json(await stub.withdrawConsent(uid));
    const { text, method } = (await req.json()) as { text: string; method?: string };
    await stub.recordConsent(uid, text, method ?? "web");
    return json({ ok: true });
  }

  // ── Situation writes (Settings + web onboarding) ──────────────────────────
  // Persons (taxpayers). The list is returned by GET /api/situation (getSituation).
  if (resource === "persons") {
    if (m === "POST" && !id) return json({ id: await addPerson(env, uid, await req.json()) });
    if (m === "PUT" && id) {
      const body = (await req.json()) as { role?: string };
      // Don't let an edit reassign the 'self' role (would orphan the anchor or create two selves).
      if (body.role !== undefined) {
        const cur = await env.DB.prepare(`SELECT role FROM persons WHERE id = ? AND user_id = ?`).bind(id, uid).first<{ role: string }>();
        if ((cur?.role === "self") !== (body.role === "self")) return json({ error: "the primary taxpayer role can't be reassigned" }, 409);
      }
      await updatePerson(env, uid, id, body);
      return json({ ok: true });
    }
    if (m === "DELETE" && id) {
      // The 'self' person anchors entities/properties/income (person_id FK) — never delete it,
      // even via a direct API call (the UI already hides the button).
      const p = await env.DB.prepare(`SELECT role FROM persons WHERE id = ? AND user_id = ?`).bind(id, uid).first<{ role: string }>();
      if (p?.role === "self") return json({ error: "the primary taxpayer can't be deleted" }, 409);
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
    if (m === "PUT" && id) {
      await updateEntity(env, uid, id, await req.json());
      return json({ ok: true });
    }
    if (m === "DELETE" && id) {
      await deleteRow(env, uid, "entities", id);
      return json({ ok: true });
    }
  }
  // ── Co-ownership + income-activity spine (Phase B / G2) ──────────────────────
  if (resource === "property-owners") {
    if (m === "GET" && !id) return json({ property_owners: await listPropertyOwners(env, uid) });
    if (m === "POST" && !id) return json({ id: await addPropertyOwner(env, uid, await req.json()) });
    if (m === "DELETE" && id) {
      await deleteRow(env, uid, "property_owners", id);
      return json({ ok: true });
    }
  }
  if (resource === "entity-roles") {
    if (m === "GET" && !id) return json({ entity_roles: await listEntityRoles(env, uid) });
    if (m === "POST" && !id) return json({ id: await addEntityRole(env, uid, await req.json()) });
    if (m === "DELETE" && id) {
      await deleteRow(env, uid, "entity_roles", id);
      return json({ ok: true });
    }
  }
  if (resource === "income-activities" && m === "GET" && !id) {
    return json({ income_activities: await listIncomeActivities(env, uid) });
  }
  if (resource === "rules") {
    if (m === "POST") return json({ id: await addRule(env, uid, await req.json()) });
    if (m === "PUT" && id) {
      try {
        await updateRule(env, uid, id, await req.json());
        return json({ ok: true });
      } catch (e) {
        return json({ error: (e as Error).message }, 400); // unknown bucket
      }
    }
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
  // ── Prior-year carry-ins (capture-only; surfaced as defer findings, never auto-applied) ──
  if (resource === "capital-losses") {
    if (m === "GET" && !id) return json({ capital_losses: await listCapitalLosses(env, uid) });
    if (m === "POST" && !id) {
      const b = (await req.json().catch(() => ({}))) as { prior_fy?: unknown; loss_cents?: unknown; asset_id?: unknown; notes?: unknown };
      if (typeof b.prior_fy !== "number" || typeof b.loss_cents !== "number") return json({ error: "prior_fy and loss_cents are required" }, 400);
      return json({ id: await addCapitalLoss(env, uid, { prior_fy: b.prior_fy, loss_cents: b.loss_cents, asset_id: typeof b.asset_id === "string" ? b.asset_id : undefined, notes: typeof b.notes === "string" ? b.notes : undefined }) });
    }
    if (m === "DELETE" && id) {
      await deleteRow(env, uid, "capital_loss_carryins", id);
      return json({ ok: true });
    }
  }
  if (resource === "opening-depreciation") {
    if (m === "GET" && !id) return json({ opening_depreciation: await listDepreciationOpenings(env, uid) });
    if (m === "POST" && !id) {
      const b = (await req.json().catch(() => ({}))) as { fy?: unknown; opening_adjustable_value_cents?: unknown; asset_id?: unknown; notes?: unknown };
      if (typeof b.fy !== "number" || typeof b.opening_adjustable_value_cents !== "number") return json({ error: "fy and opening_adjustable_value_cents are required" }, 400);
      return json({ id: await addDepreciationOpening(env, uid, { fy: b.fy, opening_adjustable_value_cents: b.opening_adjustable_value_cents, asset_id: typeof b.asset_id === "string" ? b.asset_id : undefined, notes: typeof b.notes === "string" ? b.notes : undefined }) });
    }
    if (m === "DELETE" && id) {
      await deleteRow(env, uid, "depreciation_opening_balances", id);
      return json({ ok: true });
    }
  }
  // ── Soft per-FY sign-off (attestation only — Quillo never lodges) ─────────────
  if (resource === "signoff") {
    const fy = Number(url.searchParams.get("fy")) || currentFyStartYear();
    if (m === "GET") return json({ signoff: await getFySignoff(env, uid, fy) });
    if (m === "POST") {
      await signOffFy(env, uid, fy);
      return json({ signoff: await getFySignoff(env, uid, fy) });
    }
    if (m === "DELETE") {
      await clearSignOffFy(env, uid, fy);
      return json({ ok: true });
    }
  }
  // ── Loan → property links (Set-up; pre-fills the Phase 5 interest split) ──────
  if (resource === "loans-properties") {
    if (m === "POST" && !id) {
      try {
        return json({ id: await addLoanProperty(env, uid, await req.json()) });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    if (m === "PUT" && id) {
      await updateLoanProperty(env, uid, id, await req.json());
      return json({ ok: true });
    }
    if (m === "DELETE" && id) {
      await deleteRow(env, uid, "loans_properties", id);
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
        if (msg === "ai_budget_reached") return json({ error: "AI is paused for today (daily limit reached) — try again after the reset." }, 429);
        return json({ error: msg }, 422); // unreadable statement / extraction failure — show the reason
      }
    }
    // POST /api/statements/confirm-batch [{ statementIds?, force? }] → bulk-confirm all parsed
    // statements (or a given subset). Flag-gated; 404 when off so behaviour is unchanged.
    if (m === "POST" && id === "confirm-batch") {
      if (!featureOn(env, "bulk_import")) return json({ error: "not found" }, 404);
      const body = (await req.json().catch(() => ({}))) as { statementIds?: string[]; force?: boolean };
      return json(await stub.confirmImportBulk(uid, { statementIds: body.statementIds, force: body.force }));
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
    // DELETE /api/statements/:id[?purge=1] → remove a stuck/failed upload (keeps imported txns), or
    // with purge=1 delete an imported statement's lines too so it can be cleanly re-uploaded.
    if (m === "DELETE" && id) {
      try {
        return json(await stub.deleteStatement(uid, id, url.searchParams.get("purge") === "1"));
      } catch (e) {
        return json({ error: (e as Error).message }, 409);
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
    // Income de-dup (flag income_dedupe): suggest + confirm/undo credit↔income links.
    if (m === "GET" && id === "matches") {
      if (!featureOn(env, "income_dedupe")) return json({ suggestions: [], matched: [] });
      return json(await stub.incomeMatches(uid));
    }
    if (m === "POST" && id === "link") {
      if (!featureOn(env, "income_dedupe")) return json({ error: "not found" }, 404);
      const { txnId, incomeId } = (await req.json().catch(() => ({}))) as { txnId?: string; incomeId?: string };
      if (!txnId || !incomeId) return json({ error: "txnId and incomeId are required" }, 400);
      await stub.linkIncome(uid, txnId, incomeId);
      return json({ ok: true });
    }
    if (m === "POST" && id === "unlink") {
      if (!featureOn(env, "income_dedupe")) return json({ error: "not found" }, 404);
      const { txnId } = (await req.json().catch(() => ({}))) as { txnId?: string };
      if (!txnId) return json({ error: "txnId is required" }, 400);
      await stub.unlinkIncome(uid, txnId);
      return json({ ok: true });
    }
    if (m === "DELETE" && id) {
      // Clear any credit linked to this income row first, or it would stay excluded from income
      // forever with no row left to unlink it (silent under-count).
      await env.DB.prepare(`UPDATE transactions SET matched_income_id = NULL WHERE user_id = ? AND matched_income_id = ?`)
        .bind(uid, id)
        .run();
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

  // ── Work-use inputs (computed WFH fixed-rate + car cents-per-km deductions) ──
  // GET reads D1 directly; POST is an audited write through the DO. fy is the FY start year.
  if (resource === "work-use") {
    const fy = Number(url.searchParams.get("fy")) || currentFyStartYear();
    if (m === "GET") {
      const row = await env.DB.prepare(`SELECT wfh_hours, car_work_km, wfh_days_per_week, wfh_weeks FROM work_use_inputs WHERE user_id = ? AND fy = ?`)
        .bind(uid, fy)
        .first<{ wfh_hours: number | null; car_work_km: number | null; wfh_days_per_week: number | null; wfh_weeks: number | null }>();
      return json({ work_use: row ?? { wfh_hours: null, car_work_km: null, wfh_days_per_week: null, wfh_weeks: null } });
    }
    if (m === "POST") {
      const body = (await req.json().catch(() => ({}))) as { wfh_hours?: number | null; car_work_km?: number | null; wfh_days_per_week?: number | null; wfh_weeks?: number | null };
      const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Math.max(0, Number(v)));
      return json(await stub.setWorkUseInputs(uid, { fy, wfh_hours: num(body.wfh_hours), car_work_km: num(body.car_work_km), wfh_days_per_week: num(body.wfh_days_per_week), wfh_weeks: num(body.wfh_weeks) }));
    }
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
    // POST /api/qbo/disconnect — revoke the token at Intuit + delete the stored connection.
    if (id === "disconnect" && m === "POST") return json(await stub.disconnectQuickBooks(uid));
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

  // ── Year-end deductibility review (flag deductibility_review) ─────────────
  if (resource === "review") {
    if (!featureOn(env, "deductibility_review")) return json({ error: "not found" }, 404);
    // GET /api/review/summary?fy= — countable spend grouped by bucket+label+deductibility.
    if (m === "GET" && id === "summary") {
      return json(await stub.reviewSummary(uid, url.searchParams.get("fy") ?? undefined));
    }
  }
  // POST /api/deductibility — resolve deductibility, by txnIds OR by (bucket, ato_label, fy).
  if (resource === "deductibility" && m === "POST") {
    if (!featureOn(env, "deductibility_review")) return json({ error: "not found" }, 404);
    const b = (await req.json().catch(() => ({}))) as {
      state?: string; deductibleAmountCents?: number | null; txnIds?: string[];
      fy?: string; bucket?: string; atoLabel?: string | null; businessUsePct?: number | null;
    };
    if (!b.state) return json({ error: "state is required" }, 400);
    if (b.txnIds?.length) return json(await stub.setDeductibility(uid, b.txnIds, b.state, b.deductibleAmountCents));
    if (b.bucket) return json(await stub.resolveByLabel(uid, { fy: b.fy, bucket: b.bucket, atoLabel: b.atoLabel, state: b.state, businessUsePct: b.businessUsePct }));
    return json({ error: "provide txnIds or a bucket" }, 400);
  }

  // ── Filing readiness (capstone) ───────────────────────────────────────────
  if (resource === "filing-readiness" && m === "GET") {
    const fy = Number(url.searchParams.get("fy")) || currentFyStartYear();
    return json(await stub.assessFilingReadiness(uid, fy));
  }

  // ── Find My Claims (flag claim_review) — 404 when off ─────────────────────
  // GET  /api/claim-review?fy=         → read-only situational sweep (3 groups + uncovered occupations)
  // POST /api/claim-review/draft       → AI gap-fill candidate rules for an uncovered occupation
  // POST /api/claim-review/rules       → persist user-confirmed candidate rules (defer_to_agent forced)
  if (resource === "claim-review") {
    if (!featureOn(env, "claim_review")) return json({ error: "not available" }, 404);
    if (m === "GET" && !id) {
      const fy = Number(url.searchParams.get("fy")) || currentFyStartYear();
      return json(await stub.reviewClaims(uid, fy));
    }
    if (m === "POST" && id === "draft") {
      const { occupation } = (await req.json().catch(() => ({}))) as { occupation?: string };
      if (!occupation || !occupation.trim()) return json({ error: "missing occupation" }, 400);
      try {
        return json(await stub.draftOccupationRules(uid, occupation));
      } catch (e) {
        const msg = (e as Error).message;
        if (msg === "consent_required") return json({ error: "consent_required" }, 403);
        if (msg === "ai_budget_reached") return json({ error: "AI is paused for today (daily limit reached) — try again after the reset." }, 429);
        throw e;
      }
    }
    if (m === "POST" && id === "rules") {
      const { rules } = (await req.json().catch(() => ({}))) as {
        rules?: { scope_type: string; scope_value: string; merchant_hint?: string | null; ato_label?: string | null; claim_type: string; default_method?: string | null; general_info_note: string }[];
      };
      if (!Array.isArray(rules)) return json({ error: "rules must be an array" }, 400);
      return json(await stub.addClaimabilityRules(uid, rules));
    }
    // Phase 3 — auto-match evidence to a claim, then attach/detach.
    // GET  /api/claim-review/match?claimId=  → scored candidate transactions + already-linked ids
    // POST /api/claim-review/attach { claimId, txnId } · POST /api/claim-review/detach { claimId, txnId }
    if (m === "GET" && id === "match") {
      const claimId = url.searchParams.get("claimId");
      if (!claimId) return json({ error: "claimId required" }, 400);
      try {
        return json(await stub.matchClaim(uid, claimId));
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    if (m === "POST" && (id === "attach" || id === "detach")) {
      const { claimId, txnId } = (await req.json().catch(() => ({}))) as { claimId?: unknown; txnId?: unknown };
      if (typeof claimId !== "string" || typeof txnId !== "string") return json({ error: "claimId and txnId required" }, 400);
      try {
        return json(id === "attach" ? await stub.attachClaim(uid, claimId, txnId) : await stub.detachClaim(uid, claimId, txnId));
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
  }

  // ── Stage A: deterministic non-spend movement clean-up (no LLM, no consent) ─
  // GET  /api/movements/sweep        → read-only pre-checked confirm list + property-loan review list
  // POST /api/movements/apply { ids } → mark confirmed ids 'ignored' (server re-verifies each)
  if (resource === "movements") {
    if (m === "GET" && id === "sweep") return json(await stub.sweepMovements(uid));
    if (m === "POST" && id === "apply") {
      const { ids } = (await req.json().catch(() => ({}))) as { ids?: unknown };
      if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) return json({ error: "ids must be an array of strings" }, 400);
      return json(await stub.applyMovementSweep(uid, ids as string[]));
    }
    // POST /api/movements/loan-split { txn_id, property_id, interest_cents | interest_pct }
    //   → record the deductible interest portion of one loan line (Phase 5, guided split).
    if (m === "POST" && id === "loan-split") {
      // Gate on the flag: with it OFF the position counts GROSS (amtExpr falls back), so a split row
      // (property_rented + confirmed_deductible) would over-claim the principal. Only allow creating
      // splits when the position is set up to honour the apportioned interest.
      if (!featureOn(env, "loan_split")) return json({ error: "loan split is not enabled" }, 404);
      const b = (await req.json().catch(() => ({}))) as { txn_id?: unknown; property_id?: unknown; interest_cents?: unknown; interest_pct?: unknown };
      if (typeof b.txn_id !== "string" || typeof b.property_id !== "string") return json({ error: "txn_id and property_id are required" }, 400);
      try {
        return json(
          await stub.applyLoanSplit(uid, b.txn_id, {
            property_id: b.property_id,
            interest_cents: typeof b.interest_cents === "number" ? b.interest_cents : undefined,
            interest_pct: typeof b.interest_pct === "number" ? b.interest_pct : undefined,
          }),
        );
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
  }

  // ── Stage B: clarify-by-pattern (flag accountant_pass) — 404 when off ──────
  // GET  /api/clarify?fy=            → open questions (biggest-dollar first)
  // POST /api/clarify/scan?fy=       → (re)scan leftovers into grouped questions
  // POST /api/clarify/:id/answer     → { answer } apply to the group + learn a rule
  // POST /api/clarify/:id/dismiss    → terminal dismiss
  if (resource === "clarify") {
    if (!featureOn(env, "accountant_pass")) return json({ error: "not available" }, 404);
    if (m === "GET" && !id) {
      const fyParam = url.searchParams.get("fy");
      return json({ questions: await stub.listClarifyQuestions(uid, fyParam ? Number(fyParam) : undefined) });
    }
    if (m === "POST" && id === "scan") {
      const fy = Number(url.searchParams.get("fy")) || currentFyStartYear();
      return json(await stub.runClarifyScan(uid, fy));
    }
    if (m === "POST" && id && sub === "answer") {
      const { answer } = (await req.json().catch(() => ({}))) as { answer?: { kind?: string; bucket?: string; ato_label?: string; property_id?: string } };
      if (!answer || typeof answer.kind !== "string") return json({ error: "answer.kind required" }, 400);
      try {
        return json(await stub.answerClarify(uid, id, answer as import("./agent").ClarifyAnswer));
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    if (m === "POST" && id && sub === "dismiss") return json(await stub.dismissClarify(uid, id));
  }

  // ── Phase 4: "Do my books" accountant pass (flag accountant_pass) — 404 off ─
  // POST /api/accountant/run?fy=            → run the deterministic pass, return the sign-off counts
  // GET  /api/accountant/suggestions?fy=    → suggested_deductible rows to confirm (Stage D)
  // POST /api/accountant/confirm { txnId }  → confirm one suggestion → confirmed_deductible (it counts)
  if (resource === "accountant") {
    if (!featureOn(env, "accountant_pass")) return json({ error: "not available" }, 404);
    if (m === "POST" && id === "run") {
      const fy = Number(url.searchParams.get("fy")) || currentFyStartYear();
      try {
        return json(await stub.runAccountantPass(uid, fy));
      } catch (e) {
        return json({ error: (e as Error).message }, 409);
      }
    }
    if (m === "GET" && id === "suggestions") {
      const fy = Number(url.searchParams.get("fy")) || currentFyStartYear();
      return json({ suggestions: await listSuggestedDeductions(env, uid, fy) });
    }
    if (m === "POST" && id === "confirm") {
      const { txnId } = (await req.json().catch(() => ({}))) as { txnId?: unknown };
      if (typeof txnId !== "string") return json({ error: "txnId required" }, 400);
      try {
        return json(await stub.confirmSuggestedDeduction(uid, txnId));
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
  }

  // ── Admin (founder only — cross-tenant) ───────────────────────────────────
  // Every admin route requires the caller's profile to hold the 'admin' role; the cross-tenant
  // reads hit D1 directly (the per-tenant DO is the wrong place for platform aggregates).
  if (resource === "admin") {
    if (!isAdmin(await getProfile(env, uid))) return json({ error: "forbidden" }, 403);
    if (m === "GET" && id === "overview") return json(await platformOverview(env));
    if (m === "GET" && id === "tenants") return json({ tenants: await listTenantsAdmin(env) });
    // PUT /api/admin/tenants/:tenantId/roles { roles: [...] } — assign platform roles.
    if (m === "PUT" && id === "tenants" && sub && parts[3] === "roles") {
      const target = sub;
      const { roles } = (await req.json().catch(() => ({}))) as { roles?: unknown };
      const next = normaliseRoles(roles);
      // Lock-out guard: you can't strip your own 'admin' (mirrors the self-person guard).
      if (target === uid && !next.includes("admin")) return json({ error: "you can't remove your own admin role" }, 409);
      const res = await env.DB.prepare(`UPDATE profiles SET roles = ? WHERE user_id = ?`).bind(JSON.stringify(next), target).run();
      if (!res.meta?.changes) return json({ error: "tenant not found" }, 404);
      return json({ ok: true, roles: next });
    }
  }

  return json({ error: "not found" }, 404);
}
