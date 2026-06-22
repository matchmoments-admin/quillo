import type { Env, TaxAgentRpc } from "./env";
import type { AuthedUser } from "./auth/access";
import { entityActionSpec } from "./extract";
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
  platformSpend,
  listSuggestedDeductions,
  savingsOverview,
  phiExtrasOverview,
  referralFunnelAdmin,
} from "./lib/queries";
import { phisProductList } from "./lib/phis-seed";
import { createTopupCheckout } from "./lib/stripe";
import { isAdmin, isPartner, normaliseRoles } from "./lib/roles";
import { REFERRAL_STATUSES, canAdvanceReferral, sanitizeRevenueCents, partnerPortalData } from "./lib/partners";
import { RULE_CREDIT_BUCKETS } from "./lib/rules";
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
  addIncomeActivity,
  updateIncomeActivityPsiStatus,
  addCapitalLoss,
  listCapitalLosses,
  addDepreciationOpening,
  listDepreciationOpenings,
  signOffFy,
  clearSignOffFy,
  getFySignoff,
  ensureTenant,
  deleteRow,
  archiveRow,
  listKeys,
  mintKey,
  revokeKey,
  clearIncomeCgt,
} from "./lib/situation-write";
import { setAttributions, getAttributions, clearAttributions } from "./lib/attribution-write";
import { buildConnectUrl, qboStatus } from "./lib/qbo-oauth";
import { QuickBooksAdapter } from "./ledger/qbo";
import { LedgerReauthError } from "./ledger";
import { buildReport, reportToCsv, currentFyStartYear } from "./lib/report";
import { resolveJurisdictionForUser } from "./lib/jurisdiction";
import { buildAccountantSchedule, scheduleToCsv } from "./lib/accountant-schedule";
import { getProgress } from "./lib/progress";
import { featureOn } from "./lib/features";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/**
 * Manual entity create/update routing (Phase 4). When ai_edit_feed is ON, route the write through the
 * audited DO path (aiWriteEntity → ai_edits + audit_log → undoable); OFF ⇒ the existing direct-to-D1
 * write, byte-identical. Deletes are deliberately NOT routed (they stay direct so DeleteBlockedError
 * keeps its 409 blockers/archivable shape, which wouldn't survive the RPC boundary). `direct` returns
 * the new id on create.
 */
async function routedEntityWrite(
  env: Env,
  stub: TaxAgentRpc,
  uid: string,
  kind: "person" | "property" | "entity" | "rule" | "account" | "property_owner" | "entity_role" | "income_activity" | "loan_property",
  op: "create" | "update",
  id: string | null,
  data: Record<string, unknown>,
  direct: () => Promise<string | void>,
): Promise<Response> {
  if (featureOn(env, "ai_edit_feed")) {
    const r = await stub.aiWriteEntity(uid, { kind, op, id: id ?? undefined, data, source: "manual" });
    return op === "create" ? json({ id: r.id }) : json({ ok: true });
  }
  const res = await direct();
  return op === "create" ? json({ id: res as string }) : json({ ok: true });
}

/**
 * Manual entity delete routing (Phase 4 convergence, #225). When ai_edit_feed is ON, route the delete
 * through the audited DO path (aiDeleteEntity → ai_edits snapshot + audit_log → undoable). A blocked
 * delete comes back as a structured `{ blocked }` result (DeleteBlockedError can't cross the RPC boundary
 * as a throw) which we turn into the SAME 409 the direct path's DeleteBlockedError produces in index.ts.
 * OFF ⇒ the existing direct deleteRow, which throws DeleteBlockedError → caught in index.ts → identical 409.
 */
async function routedEntityDelete(
  env: Env,
  stub: TaxAgentRpc,
  uid: string,
  kind: "person" | "property" | "entity" | "rule" | "account" | "property_owner" | "entity_role" | "income_activity" | "loan_property",
  id: string,
  direct: () => Promise<void>,
): Promise<Response> {
  if (featureOn(env, "ai_edit_feed")) {
    const r = await stub.aiDeleteEntity(uid, { kind, id, source: "manual" });
    if ("blocked" in r) return Response.json({ error: r.message, blockers: r.blockers, parentTable: r.parentTable, archivable: r.archivable }, { status: 409 });
    return json({ ok: true });
  }
  await direct();
  return json({ ok: true });
}

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
  // Resolve the tenant's jurisdiction once so the default-FY (when the SPA omits ?fy) is computed under
  // the tenant's tax period. Flag OFF / AU ⇒ Jul–Jun ⇒ byte-identical. The SPA normally sends ?fy.
  const jur = await resolveJurisdictionForUser(env, uid);
  const defaultFy = () => currentFyStartYear(new Date(), jur);

  // ── Apply-to-siblings (flag apply_to_siblings) — "edit one line → update its look-alikes" ──
  // GET  /api/transactions/:id/siblings          → { n, total_cents, group_key } preview
  // POST /api/transactions/:id/apply-to-siblings  { edit, learn_rule } → fan the edit out + learn a rule
  // Declared BEFORE the generic GET /transactions/:id handler so the :id detail route doesn't swallow it.
  if (resource === "transactions" && id && sub === "siblings" && m === "GET") {
    if (!featureOn(env, "apply_to_siblings")) return json({ error: "not available" }, 404);
    try {
      return json(await stub.previewSiblings(uid, id));
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }
  if (resource === "transactions" && id && sub === "apply-to-siblings" && m === "POST") {
    if (!featureOn(env, "apply_to_siblings")) return json({ error: "not available" }, 404);
    const body = (await req.json().catch(() => ({}))) as { edit?: { bucket?: string; ato_label?: string; property_id?: string }; learn_rule?: boolean };
    if (!body.edit || typeof body.edit !== "object") return json({ error: "edit required" }, 400);
    try {
      return json(await stub.applyToSiblings(uid, id, body.edit, { learnRule: !!body.learn_rule }));
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }
  // #130: one-click — record a money-in (credit) line as income for its tagged property, linked so it
  // counts once. Flag-gated (record_credit_income); the per-txn equivalent of the Clarify income answer.
  if (resource === "transactions" && id && sub === "record-income" && m === "POST") {
    if (!featureOn(env, "record_credit_income")) return json({ error: "not available" }, 404);
    try {
      return json(await stub.recordTxnAsIncome(uid, id));
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }

  // GET /api/transactions  ·  GET /api/transactions/:id
  if (resource === "transactions" && m === "GET") {
    if (id) {
      const txn = await getTransaction(env, uid, id);
      return txn ? json(txn) : json({ error: "not found" }, 404);
    }
    const rows = await listTransactions(env, uid, {
      status: url.searchParams.get("status") ?? undefined,
      bucket: url.searchParams.get("bucket") ?? undefined,
      property_id: url.searchParams.get("property_id") ?? undefined,
      kind: url.searchParams.get("kind") ?? undefined,
      review: url.searchParams.get("review") === "1" || undefined,
      fy: Number(url.searchParams.get("fy")) || undefined,
      countable: url.searchParams.get("countable") === "1" || undefined,
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

  // POST /api/ask { question, fy? } — grounded single-turn tax-Q&A from the user's own ledger.
  if (resource === "ask" && m === "POST") {
    if (!featureOn(env, "ask_quillo")) return json({ error: "not available" }, 404);
    const { question, fy } = (await req.json().catch(() => ({}))) as { question?: string; fy?: number };
    if (!question || !question.trim()) return json({ error: "missing question" }, 400);
    try {
      return json(await stub.askQuestion(uid, question, Math.trunc(Number(fy)) || defaultFy()));
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "consent_required") return json({ error: "consent_required" }, 403);
      if (msg === "ai_budget_reached") return json({ error: "AI is paused for today (daily limit reached) — try again after the reset." }, 429);
      throw e;
    }
  }

  // Ask Quillo C2 (#173): multi-turn chat. GET /api/chat/:session → history; POST /api/chat → a turn.
  if (resource === "chat") {
    if (!featureOn(env, "ask_quillo")) return json({ error: "not available" }, 404);
    if (m === "GET" && id) return json(await stub.chatHistory(uid, id));
    if (m === "POST" && !id) {
      const { session_id, message, fy, page } = (await req.json().catch(() => ({}))) as { session_id?: string; message?: string; fy?: number; page?: string };
      if (!message || !message.trim()) return json({ error: "missing message" }, 400);
      try {
        return json(await stub.chatTurn(uid, session_id ?? null, message, Math.trunc(Number(fy)) || defaultFy(), typeof page === "string" ? page : undefined));
      } catch (e) {
        const msg = (e as Error).message;
        if (msg === "consent_required") return json({ error: "consent_required" }, 403);
        if (msg === "ai_budget_reached") return json({ error: "AI is paused for today (daily limit reached) — try again after the reset." }, 429);
        if (msg === "chat_rate_limited") return json({ error: "You're sending messages too quickly — give it a moment and try again." }, 429);
        if (msg === "chat_message_too_long") return json({ error: "That message is too long — please shorten it and try again." }, 400);
        throw e;
      }
    }
  }

  // AI changes feed + undo (Phase 4, flag ai_edit_feed) and the Phase-3 apply path (flag ask_actions_v2).
  // GET → recent entity edits; POST /undo → revert one action/batch; POST /apply → execute a
  // user-CONFIRMED entity-write proposal. All writes/undos go through the DO (serialised + hash-chained).
  if (resource === "ai-edits") {
    // /apply is the write surface — gated by ask_actions_v2 (which needs ai_edit_feed for the undo
    // backstop, so both must be on). Re-validates kind + re-allowlists fields server-side before writing.
    if (m === "POST" && id === "apply") {
      if (!featureOn(env, "ask_actions_v2") || !featureOn(env, "ai_edit_feed")) return json({ error: "not available" }, 404);
      const body = (await req.json().catch(() => ({}))) as { kind?: string; entity_id?: string; fields?: Record<string, unknown>; action_id?: string; session_id?: string };
      const spec = body.kind ? entityActionSpec(body.kind) : undefined;
      if (!spec) return json({ error: "unknown action kind" }, 400);
      if (spec.op === "update" && !body.entity_id) return json({ error: "entity_id required for an edit" }, 400);
      const data: Record<string, unknown> = {};
      for (const f of spec.fields) {
        const v = body.fields?.[f];
        if (v !== undefined && v !== null && v !== "") data[f] = v;
      }
      if (!Object.keys(data).length) return json({ error: "no fields to write" }, 400);
      try {
        const r = await stub.aiWriteEntity(uid, { kind: spec.entity, op: spec.op, id: body.entity_id, data, source: "ai_confirmed", sessionId: body.session_id, actionId: body.action_id });
        return json({ ok: true, id: r.id, action_id: r.action_id });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    if (!featureOn(env, "ai_edit_feed")) return json({ error: "not available" }, 404);
    if (m === "GET" && !id) return json(await stub.listAiEdits(uid));
    if (m === "POST" && id === "undo") {
      const { action_id, batch_id } = (await req.json().catch(() => ({}))) as { action_id?: string; batch_id?: string };
      if (batch_id) return json(await stub.undoAiEditBatch(uid, batch_id));
      if (action_id) return json(await stub.undoAiEdit(uid, action_id));
      return json({ error: "action_id or batch_id required" }, 400);
    }
  }

  // GET /api/dashboard — aggregates. Opportunistically apply any finished async batch jobs
  // (cheap no-op when there are none) so results land without waiting for the cron.
  if (resource === "dashboard" && m === "GET") {
    await stub.pollBatchJobs(uid);
    // FY-scoped (Jul–Jun); the SPA always sends ?fy=<start year> from the active-FY switcher.
    // Absent/garbage → default to the current FY so a bare /api/dashboard still works.
    const fy = Number(url.searchParams.get("fy")) || defaultFy();
    return json(await dashboard(env, uid, fy));
  }

  // GET /api/usage — measured inference cost (today / month / by feature).
  if (resource === "usage" && m === "GET") {
    return json(await usageSummary(env, uid));
  }

  // ── Savings & Opportunities (flag advisory_layer) — FACTUAL-info advisory surface ──
  // GET  /api/savings              → run-rate + recurring bills + opportunities (FY-scoped run-rate)
  // POST /api/savings/scan         → run the deterministic detector on demand (no LLM)
  // POST /api/opportunities/:id/dismiss   → terminal-dismiss an opportunity (user action)
  // POST /api/recurring-bills/:id/dismiss → terminal-dismiss a detected recurring bill
  if (resource === "savings" && !id && m === "GET") {
    if (!featureOn(env, "advisory_layer")) return json({ error: "not available" }, 404);
    const fy = Number(url.searchParams.get("fy")) || defaultFy();
    return json(await savingsOverview(env, uid, fy));
  }
  if (resource === "savings" && id === "scan" && m === "POST") {
    if (!featureOn(env, "advisory_layer")) return json({ error: "not available" }, 404);
    return json(await stub.detectAdvisory(uid));
  }
  if (resource === "opportunities" && id && sub === "dismiss" && m === "POST") {
    if (!featureOn(env, "advisory_layer")) return json({ error: "not available" }, 404);
    return json(await stub.dismissOpportunity(uid, id));
  }
  if (resource === "recurring-bills" && id && sub === "dismiss" && m === "POST") {
    if (!featureOn(env, "advisory_layer")) return json({ error: "not available" }, 404);
    return json(await stub.dismissRecurringBill(uid, id));
  }
  if (resource === "recurring-bills" && id && sub === "confirm" && m === "POST") {
    if (!featureOn(env, "advisory_layer")) return json({ error: "not available" }, 404);
    return json(await stub.confirmRecurringBill(uid, id));
  }

  // ── Usage-based billing wallet (flag billing) ──
  // GET  /api/billing        → balance + markup + recent grants/top-ups (grants the free allowance on first view)
  // POST /api/billing/topup  → a Stripe Checkout URL for a credit top-up (503 until Stripe is configured)
  if (resource === "billing") {
    if (!featureOn(env, "billing")) return json({ error: "not available" }, 404);
    if (!id && m === "GET") {
      await stub.grantSignupCredits(uid); // idempotent — the one-off free allowance, lazily on first view
      return json(await stub.getBillingOverview(uid));
    }
    if (id === "topup" && m === "POST") {
      const b = (await req.json().catch(() => ({}))) as { amount_cents?: unknown };
      const cents = Math.round(Number(b.amount_cents) || 0);
      if (cents < 100) return json({ error: "Minimum top-up is $1" }, 400);
      try {
        const checkoutUrl = await createTopupCheckout(env, uid, cents);
        if (!checkoutUrl) return json({ error: "Billing isn't configured yet" }, 503);
        return json({ url: checkoutUrl });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    return json({ error: "not found" }, 404);
  }

  // ── Private Health Extras Tracker (flag phi_extras_tracker) — FACTUAL engagement surface ──
  // GET  /api/phi                 → policies + per-category limits/used/remaining + reset countdown
  // POST /api/phi/consent         → record the separate health-data consent (unlocks writes)
  // POST /api/phi/consent/withdraw→ withdraw it
  // POST /api/phi/hospital {holds}→ set the private-hospital-cover flag (MLS pivot)
  // POST /api/phi/policy          → create/update a policy   · DELETE /api/phi/policy/:id
  // POST /api/phi/limit           → create/update a limit     · DELETE /api/phi/limit/:id
  // POST /api/phi/usage           → record a benefit used
  // POST /api/phi/scan            → run the deterministic reset/setup detector on demand
  if (resource === "phi") {
    if (!featureOn(env, "phi_extras_tracker")) return json({ error: "not available" }, 404);
    if (!id && m === "GET") {
      return json(await phiExtrasOverview(env, uid));
    }
    if (id === "products" && m === "GET") {
      return json({ insurers: phisProductList() });
    }
    if (id === "apply-product" && m === "POST") {
      const b = (await req.json().catch(() => ({}))) as { product_id?: unknown };
      if (typeof b.product_id !== "string") return json({ error: "product_id required" }, 400);
      try { return json(await stub.applyPhiProduct(uid, b.product_id)); } catch (e) { return json({ error: (e as Error).message }, 400); }
    }
    if (id === "confirm" && m === "POST") {
      const b = (await req.json().catch(() => ({}))) as { policy_id?: unknown };
      if (typeof b.policy_id !== "string") return json({ error: "policy_id required" }, 400);
      try { return json(await stub.confirmPhiPolicyLimits(uid, b.policy_id)); } catch (e) { return json({ error: (e as Error).message }, 400); }
    }
    if (id === "consent" && !sub && m === "POST") {
      const b = (await req.json().catch(() => ({}))) as { text?: unknown; method?: unknown };
      return json(await stub.recordHealthExtrasConsent(uid, typeof b.text === "string" ? b.text : "", typeof b.method === "string" ? b.method : "web"));
    }
    if (id === "consent" && sub === "withdraw" && m === "POST") {
      return json(await stub.withdrawHealthExtrasConsent(uid));
    }
    if (id === "hospital" && m === "POST") {
      const b = (await req.json().catch(() => ({}))) as { holds?: unknown };
      return json(await stub.setPrivateHealth(uid, !!b.holds));
    }
    if (id === "policy" && !sub && m === "POST") {
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      try { return json(await stub.savePhiPolicy(uid, b)); } catch (e) { return json({ error: (e as Error).message }, 400); }
    }
    if (id === "policy" && sub && m === "DELETE") {
      try { return json(await stub.deletePhiPolicy(uid, sub)); } catch (e) { return json({ error: (e as Error).message }, 400); }
    }
    if (id === "limit" && !sub && m === "POST") {
      const b = (await req.json().catch(() => ({}))) as { policy_id?: unknown; category?: unknown; annual_limit_cents?: unknown; period?: unknown };
      if (typeof b.policy_id !== "string" || typeof b.category !== "string") return json({ error: "policy_id and category required" }, 400);
      try { return json(await stub.savePhiLimit(uid, { policy_id: b.policy_id, category: b.category, annual_limit_cents: Number(b.annual_limit_cents) || 0, period: typeof b.period === "string" ? b.period : null })); } catch (e) { return json({ error: (e as Error).message }, 400); }
    }
    if (id === "limit" && sub && m === "DELETE") {
      try { return json(await stub.deletePhiLimit(uid, sub)); } catch (e) { return json({ error: (e as Error).message }, 400); }
    }
    if (id === "usage" && !sub && m === "POST") {
      const b = (await req.json().catch(() => ({}))) as { policy_id?: unknown; category?: unknown; amount_used_cents?: unknown; txn_id?: unknown; used_on?: unknown };
      if (typeof b.policy_id !== "string" || typeof b.category !== "string") return json({ error: "policy_id and category required" }, 400);
      try { return json(await stub.recordPhiUsage(uid, { policy_id: b.policy_id, category: b.category, amount_used_cents: Number(b.amount_used_cents) || 0, txn_id: typeof b.txn_id === "string" ? b.txn_id : null, used_on: typeof b.used_on === "string" ? b.used_on : null })); } catch (e) { return json({ error: (e as Error).message }, 400); }
    }
    if (id === "usage" && sub && m === "DELETE") {
      try { return json(await stub.deletePhiUsage(uid, sub)); } catch (e) { return json({ error: (e as Error).message }, 400); }
    }
    if (id === "scan" && m === "POST") {
      return json(await stub.detectBenefitsReset(uid));
    }
    return json({ error: "not found" }, 404);
  }

  // POST /api/referrals { opportunity_id } — user-initiated Tier-1 energy referral (flag
  // advisory_partners_energy). Returns the tokened outbound URL the SPA opens. Idempotent + audited in
  // the DO. NO PII leaves Quillo — the user completes everything on the partner's site.
  if (resource === "referrals" && !id && m === "POST") {
    if (!featureOn(env, "advisory_partners_energy")) return json({ error: "not available" }, 404);
    const { opportunity_id, offer_id } = (await req.json().catch(() => ({}))) as { opportunity_id?: unknown; offer_id?: unknown };
    if (typeof opportunity_id !== "string") return json({ error: "opportunity_id required" }, 400);
    try {
      return json(await stub.createReferral(uid, opportunity_id, typeof offer_id === "string" ? offer_id : undefined));
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }

  // ── Partner portal (role 'partner') — a partner staff member's OWN org only ───────────────────────
  // GET /api/partner/overview → org + funnel + anonymised leads + offers, scoped to the caller's
  // partner_id (resolved server-side from partner_members; never a request value). The consumer's
  // identity/ledger never crosses into this surface. Role-gated, exactly like /admin is founder-gated.
  if (resource === "partner") {
    if (!isPartner(await getProfile(env, uid))) return json({ error: "forbidden" }, 403);
    if (m === "GET" && id === "overview") return json(await partnerPortalData(env, uid));
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
    const { txnIds, edits, learn_rule } = (await req.json().catch(() => ({}))) as { txnIds?: unknown; edits?: unknown; learn_rule?: boolean };
    if (!Array.isArray(txnIds) || txnIds.some((x) => typeof x !== "string")) return json({ error: "txnIds must be an array of strings" }, 400);
    if (!Array.isArray(edits) || edits.some((e) => typeof (e as { field?: unknown })?.field !== "string" || typeof (e as { value?: unknown })?.value !== "string"))
      return json({ error: "edits must be an array of {field, value}" }, 400);
    // Income/refund are credits — re-bucketing them here would double-count income. They must route
    // through an income answer (Clarify), which records once. Mirrors the apply-to-siblings guard.
    const creditBucket = (edits as { field: string; value: string }[]).find((e) => e.field === "bucket" && RULE_CREDIT_BUCKETS.has(e.value));
    if (creditBucket) return json({ error: `use an income answer for ${creditBucket.value}, not a re-categorise` }, 400);
    try {
      return json(await stub.applyCorrectionBatch(uid, txnIds as string[], edits as { field: string; value: string }[], { learnRule: !!learn_rule }));
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

  // POST /api/gst-registered { registered } — tenant-default GST registration (sole-trader fallback).
  if (resource === "gst-registered" && m === "POST") {
    const { registered } = (await req.json().catch(() => ({}))) as { registered?: boolean };
    return json(await stub.setGstRegistered(uid, !!registered));
  }

  // ── Situation writes (Settings + web onboarding) ──────────────────────────
  // Persons (taxpayers). The list is returned by GET /api/situation (getSituation).
  if (resource === "persons") {
    if (m === "POST" && !id) { const body = (await req.json()) as Record<string, unknown>; return routedEntityWrite(env, stub, uid, "person", "create", null, body, () => addPerson(env, uid, body as { display_name: string })); }
    if (m === "PUT" && id) {
      const body = (await req.json()) as { role?: string } & Record<string, unknown>;
      // Don't let an edit reassign the 'self' role (would orphan the anchor or create two selves).
      if (body.role !== undefined) {
        const cur = await env.DB.prepare(`SELECT role FROM persons WHERE id = ? AND user_id = ?`).bind(id, uid).first<{ role: string }>();
        if ((cur?.role === "self") !== (body.role === "self")) return json({ error: "the primary taxpayer role can't be reassigned" }, 409);
      }
      return routedEntityWrite(env, stub, uid, "person", "update", id, body, () => updatePerson(env, uid, id, body));
    }
    if (m === "DELETE" && id) {
      // The 'self' person anchors entities/properties/income (person_id FK) — never delete it,
      // even via a direct API call (the UI already hides the button).
      const p = await env.DB.prepare(`SELECT role FROM persons WHERE id = ? AND user_id = ?`).bind(id, uid).first<{ role: string }>();
      if (p?.role === "self") return json({ error: "the primary taxpayer can't be deleted" }, 409);
      return routedEntityDelete(env, stub, uid, "person", id, () => deleteRow(env, uid, "persons", id));
    }
  }
  if (resource === "properties") {
    if (m === "POST") { const body = (await req.json()) as Record<string, unknown>; return routedEntityWrite(env, stub, uid, "property", "create", null, body, () => addProperty(env, uid, body as { label: string })); }
    // GET /api/properties/:id/cgt — indicative CGT on a disposed property.
    if (m === "GET" && id && sub === "cgt") {
      try {
        return json(await stub.computeCgt(uid, id));
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    if (m === "PUT" && id) { const body = (await req.json()) as Record<string, unknown>; return routedEntityWrite(env, stub, uid, "property", "update", id, body, () => updateProperty(env, uid, id, body)); }
    if (m === "DELETE" && id) return routedEntityDelete(env, stub, uid, "property", id, () => deleteRow(env, uid, "properties", id));
  }
  if (resource === "entities") {
    if (m === "POST") { const body = (await req.json()) as Record<string, unknown>; return routedEntityWrite(env, stub, uid, "entity", "create", null, body, () => addEntity(env, uid, body as { kind: string })); }
    if (m === "PUT" && id) { const body = (await req.json()) as Record<string, unknown>; return routedEntityWrite(env, stub, uid, "entity", "update", id, body, () => updateEntity(env, uid, id, body)); }
    // Non-destructive archive (hide from pickers, keep history) — the safe alternative
    // surfaced when a delete is blocked because records still reference this entity.
    if (m === "POST" && id && sub === "archive") {
      const ok = await archiveRow(env, uid, "entities", id);
      return ok ? json({ ok: true, archived: true }) : json({ error: "not found" }, 404);
    }
    if (m === "DELETE" && id) return routedEntityDelete(env, stub, uid, "entity", id, () => deleteRow(env, uid, "entities", id));
  }
  // ── Co-ownership + income-activity spine (Phase B / G2) ──────────────────────
  if (resource === "property-owners") {
    if (m === "GET" && !id) return json({ property_owners: await listPropertyOwners(env, uid) });
    if (m === "POST" && !id) { const body = (await req.json()) as Record<string, unknown>; return routedEntityWrite(env, stub, uid, "property_owner", "create", null, body, () => addPropertyOwner(env, uid, body as { property_id: string; person_id: string })); }
    if (m === "DELETE" && id) return routedEntityDelete(env, stub, uid, "property_owner", id, () => deleteRow(env, uid, "property_owners", id));
  }
  if (resource === "entity-roles") {
    if (m === "GET" && !id) return json({ entity_roles: await listEntityRoles(env, uid) });
    if (m === "POST" && !id) { const body = (await req.json()) as Record<string, unknown>; return routedEntityWrite(env, stub, uid, "entity_role", "create", null, body, () => addEntityRole(env, uid, body as { person_id: string; entity_id: string; role: string })); }
    if (m === "DELETE" && id) return routedEntityDelete(env, stub, uid, "entity_role", id, () => deleteRow(env, uid, "entity_roles", id));
  }
  if (resource === "income-activities") {
    if (m === "GET" && !id) return json({ income_activities: await listIncomeActivities(env, uid) });
    if (m === "POST" && !id) { const body = (await req.json()) as Record<string, unknown>; return routedEntityWrite(env, stub, uid, "income_activity", "create", null, body, () => addIncomeActivity(env, uid, body)); }
    // PSI-status toggle stays on the direct path — it's a narrow status write, not a generic field edit.
    if (m === "PUT" && id) { await updateIncomeActivityPsiStatus(env, uid, id, (await req.json() as { psi_status?: unknown }).psi_status); return json({ ok: true }); }
    if (m === "DELETE" && id) return routedEntityDelete(env, stub, uid, "income_activity", id, () => deleteRow(env, uid, "income_activities", id));
  }
  if (resource === "rules") {
    if (m === "POST") { const body = (await req.json()) as Record<string, unknown>; return routedEntityWrite(env, stub, uid, "rule", "create", null, body, () => addRule(env, uid, body as { pattern: string; bucket: string; ato_label: string })); }
    if (m === "PUT" && id) {
      try {
        const body = (await req.json()) as Record<string, unknown>;
        return await routedEntityWrite(env, stub, uid, "rule", "update", id, body, () => updateRule(env, uid, id, body));
      } catch (e) {
        return json({ error: (e as Error).message }, 400); // unknown bucket
      }
    }
    if (m === "DELETE" && id) return routedEntityDelete(env, stub, uid, "rule", id, () => deleteRow(env, uid, "user_rules", id));
  }
  // ── Accounts (bank/card/investment) ───────────────────────────────────────
  if (resource === "accounts") {
    if (m === "GET" && !id) return json({ accounts: await listAccounts(env, uid) });
    if (m === "POST" && !id) { const body = (await req.json()) as Record<string, unknown>; return routedEntityWrite(env, stub, uid, "account", "create", null, body, () => addAccount(env, uid, body as { name: string })); }
    if (m === "PUT" && id && !sub) { const body = (await req.json()) as Record<string, unknown>; return routedEntityWrite(env, stub, uid, "account", "update", id, body, () => updateAccount(env, uid, id, body)); }
    if (m === "POST" && id && sub === "source") {
      const { source } = (await req.json()) as { source: string };
      await stub.setAccountSource(uid, id, source);
      return json({ ok: true });
    }
    // Non-destructive archive (hide from pickers, keep imported lines counted).
    if (m === "POST" && id && sub === "archive") {
      const ok = await archiveRow(env, uid, "accounts", id);
      return ok ? json({ ok: true, archived: true }) : json({ error: "not found" }, 404);
    }
    if (m === "DELETE" && id) return routedEntityDelete(env, stub, uid, "account", id, () => deleteRow(env, uid, "accounts", id));
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
    const fy = Number(url.searchParams.get("fy")) || defaultFy();
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
        const body = (await req.json()) as Record<string, unknown>;
        return await routedEntityWrite(env, stub, uid, "loan_property", "create", null, body, () => addLoanProperty(env, uid, body as { loan_account_id: string; property_id: string }));
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    if (m === "PUT" && id) { const body = (await req.json()) as Record<string, unknown>; return routedEntityWrite(env, stub, uid, "loan_property", "update", id, body, () => updateLoanProperty(env, uid, id, body)); }
    if (m === "DELETE" && id) return routedEntityDelete(env, stub, uid, "loan_property", id, () => deleteRow(env, uid, "loans_properties", id));
  }

  // ── Loan interest evidence (flag loan_interest_v2) — actual FY interest per loan ──────
  // GET  /api/loans/interest?fy=               → recorded summaries (capture-only; not in the position yet)
  // POST /api/loans/:accountId/interest        { fy, interest_cents, source?, document_id? } → upsert
  if (resource === "loans") {
    if (!featureOn(env, "loan_interest_v2")) return json({ error: "not available" }, 404);
    if (m === "GET" && id === "interest") {
      const fyParam = url.searchParams.get("fy");
      return json({ summaries: await stub.listLoanInterest(uid, fyParam ? Number(fyParam) : undefined) });
    }
    if (m === "GET" && id === "review") {
      const fy = Number(url.searchParams.get("fy")) || defaultFy();
      return json({ loans: await stub.listLoanInterestReview(uid, fy) });
    }
    if (m === "POST" && id && id !== "interest" && sub === "interest") {
      const b = (await req.json().catch(() => ({}))) as { fy?: unknown; interest_cents?: unknown; source?: unknown; document_id?: unknown };
      if (typeof b.fy !== "number" || typeof b.interest_cents !== "number") return json({ error: "fy and interest_cents are required" }, 400);
      try {
        return json(await stub.setLoanInterest(uid, id, b.fy, b.interest_cents, typeof b.source === "string" ? b.source : undefined, typeof b.document_id === "string" ? b.document_id : undefined));
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
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
      // Slice B: drop any AMMA capital-gain rows materialised from this distribution, or its gain would
      // orphan into the position with no income row left to remove it (silent over-count).
      await clearIncomeCgt(env, uid, id);
      await deleteRow(env, uid, "income", id);
      return json({ ok: true });
    }
  }

  // ── CGT (#138): holdings (cgt_assets) + disposal events (cgt_events) ───────
  if (resource === "cgt-assets") {
    if (m === "GET" && !id) {
      // Only user-entered holdings — auto-materialised assets (property disposal = Slice F, managed-fund AMMA
      // capital gains = Slice B) are managed from their source row, not the capital register, so deleting one
      // here can't desync it from its source.
      const assets = (await env.DB.prepare(`SELECT id, asset_kind, code, label, units, acquired_date, cost_base_cents, status FROM cgt_assets WHERE user_id = ? AND property_id IS NULL AND income_id IS NULL ORDER BY acquired_date DESC, created_at DESC`).bind(uid).all()).results ?? [];
      return json({ cgt_assets: assets });
    }
    if (m === "POST" && !id) return json({ id: await stub.recordCgtAsset(uid, await req.json()) });
    if (m === "DELETE" && id) { await deleteRow(env, uid, "cgt_assets", id); return json({ ok: true }); }
  }
  if (resource === "cgt-events") {
    if (m === "GET" && !id) {
      const fy = url.searchParams.get("fy");
      const events = (await env.DB.prepare(`SELECT id, cgt_asset_id, fy, event_type, event_date, proceeds_cents, cost_base_used_cents, units_disposed, discount_eligible FROM cgt_events WHERE user_id = ?${fy ? " AND fy = ?" : ""} ORDER BY event_date DESC`).bind(...(fy ? [uid, fy] : [uid])).all()).results ?? [];
      return json({ cgt_events: events });
    }
    if (m === "POST" && !id) return json({ id: await stub.recordCgtEvent(uid, await req.json()) });
    if (m === "DELETE" && id) { await deleteRow(env, uid, "cgt_events", id); return json({ ok: true }); }
  }

  // ── ESS grants (#141) ─────────────────────────────────────────────────────
  if (resource === "ess-grants") {
    if (m === "GET" && !id) return json({ ess_grants: (await env.DB.prepare(`SELECT id, employer_entity_id, scheme_type, grant_date, taxing_point_date, discount_cents, market_value_cents, ownership_gt_10pct FROM ess_grants WHERE user_id = ? ORDER BY COALESCE(taxing_point_date, grant_date) DESC`).bind(uid).all()).results ?? [] });
    if (m === "POST" && !id) return json({ id: await stub.recordEssGrant(uid, await req.json()) });
    if (m === "DELETE" && id) { await deleteRow(env, uid, "ess_grants", id); return json({ ok: true }); }
  }

  // ── Vehicle logbooks (#142) ───────────────────────────────────────────────
  if (resource === "vehicle-logbooks") {
    if (m === "GET" && !id) return json({ vehicle_logbooks: (await env.DB.prepare(`SELECT id, asset_id, fy, business_km, total_km, running_costs_cents, business_use_pct FROM vehicle_logbooks WHERE user_id = ? ORDER BY fy DESC`).bind(uid).all()).results ?? [] });
    if (m === "POST" && !id) return json({ id: await stub.recordVehicleLogbook(uid, await req.json()) });
    if (m === "DELETE" && id) { await deleteRow(env, uid, "vehicle_logbooks", id); return json({ ok: true }); }
  }

  // ── Trust distributions (#139) ────────────────────────────────────────────
  if (resource === "trust-distributions") {
    if (m === "GET" && !id) return json({ trust_distributions: (await env.DB.prepare(`SELECT id, trust_entity_id, fy, beneficiary_person_id, share_pct, amount_cents, character, franking_credit_cents FROM trust_distributions WHERE user_id = ? AND COALESCE(source_kind,'trust') = 'trust' ORDER BY fy DESC`).bind(uid).all()).results ?? [] });
    if (m === "POST" && !id) return json({ id: await stub.recordTrustDistribution(uid, await req.json()) });
    if (m === "DELETE" && id) { await deleteRow(env, uid, "trust_distributions", id); return json({ ok: true }); }
  }
  // Slice E: partnership distributions share the trust_distributions table (source_kind='partnership').
  if (resource === "partnership-distributions") {
    if (m === "GET" && !id) return json({ partnership_distributions: (await env.DB.prepare(`SELECT id, trust_entity_id AS partnership_entity_id, fy, beneficiary_person_id, share_pct, amount_cents, character, franking_credit_cents FROM trust_distributions WHERE user_id = ? AND source_kind = 'partnership' ORDER BY fy DESC`).bind(uid).all()).results ?? [] });
    if (m === "POST" && !id) return json({ id: await stub.recordPartnershipDistribution(uid, await req.json()) });
    if (m === "DELETE" && id) { await deleteRow(env, uid, "trust_distributions", id); return json({ ok: true }); }
  }

  // ── SMSF members + super contributions (#140) ─────────────────────────────
  if (resource === "smsf-members") {
    if (m === "GET" && !id) return json({ smsf_members: (await env.DB.prepare(`SELECT id, smsf_entity_id, person_id, phase, pension_balance_cents, accumulation_balance_cents, transfer_balance_cents FROM smsf_members WHERE user_id = ? ORDER BY created_at DESC`).bind(uid).all()).results ?? [] });
    if (m === "POST" && !id) return json({ id: await stub.recordSmsfMember(uid, await req.json()) });
    if (m === "DELETE" && id) { await deleteRow(env, uid, "smsf_members", id); return json({ ok: true }); }
  }
  if (resource === "super-contributions") {
    if (m === "GET" && !id) return json({ super_contributions: (await env.DB.prepare(`SELECT id, person_id, fy, type, amount_cents FROM super_contributions WHERE user_id = ? ORDER BY fy DESC`).bind(uid).all()).results ?? [] });
    if (m === "POST" && !id) return json({ id: await stub.recordSuperContribution(uid, await req.json()) });
    if (m === "DELETE" && id) { await deleteRow(env, uid, "super_contributions", id); return json({ ok: true }); }
  }
  // ── BAS periods + PAYG instalments (#174) — gst_bas gated ──────────────────
  if (resource === "bas-periods") {
    if (!featureOn(env, "gst_bas")) return json({ error: "not available" }, 404);
    if (m === "GET" && !id) return json({ bas_periods: (await env.DB.prepare(`SELECT id, entity_id, period_start, period_end, output_gst_cents, input_gst_cents, payg_withholding_cents, payg_instalment_cents, status FROM bas_periods WHERE user_id = ? ORDER BY period_start DESC`).bind(uid).all()).results ?? [] });
    if (m === "POST" && !id) { try { return json({ id: await stub.recordBasPeriod(uid, await req.json()) }); } catch (e) { return json({ error: (e as Error).message }, 400); } }
    if (m === "DELETE" && id) { await deleteRow(env, uid, "bas_periods", id); return json({ ok: true }); }
  }
  if (resource === "payg-instalments") {
    if (!featureOn(env, "gst_bas")) return json({ error: "not available" }, 404);
    if (m === "GET" && !id) return json({ payg_instalments: (await env.DB.prepare(`SELECT id, entity_id, fy, quarter, instalment_cents, basis FROM payg_instalments WHERE user_id = ? ORDER BY fy DESC, quarter`).bind(uid).all()).results ?? [] });
    if (m === "POST" && !id) return json({ id: await stub.recordPaygInstalment(uid, await req.json()) });
    if (m === "DELETE" && id) { await deleteRow(env, uid, "payg_instalments", id); return json({ ok: true }); }
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
    const fy = Number(url.searchParams.get("fy")) || defaultFy();
    if (m === "GET") {
      const row = await env.DB.prepare(`SELECT wfh_hours, car_work_km, wfh_days_per_week, wfh_weeks, has_dedicated_home_office, wfh_has_record, wfh_weekdays, wfh_leave_ranges, wfh_generate_diary FROM work_use_inputs WHERE user_id = ? AND fy = ?`)
        .bind(uid, fy)
        .first<{ wfh_hours: number | null; car_work_km: number | null; wfh_days_per_week: number | null; wfh_weeks: number | null; has_dedicated_home_office: number | null; wfh_has_record: number | null; wfh_weekdays: string | null; wfh_leave_ranges: string | null; wfh_generate_diary: number | null }>();
      // Diary columns are stored as JSON text; parse them back to arrays for the SPA (tolerant of nulls).
      const parseJson = <T>(s: string | null, fallback: T): T => { try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; } };
      const work_use = row
        ? { ...row, wfh_weekdays: parseJson<number[]>(row.wfh_weekdays, []), wfh_leave_ranges: parseJson<{ start: string; end: string; label?: string }[]>(row.wfh_leave_ranges, []) }
        : { wfh_hours: null, car_work_km: null, wfh_days_per_week: null, wfh_weeks: null, has_dedicated_home_office: 0, wfh_has_record: 0, wfh_weekdays: [], wfh_leave_ranges: [], wfh_generate_diary: 0 };
      return json({ work_use });
    }
    if (m === "POST") {
      const body = (await req.json().catch(() => ({}))) as { wfh_hours?: number | null; car_work_km?: number | null; wfh_days_per_week?: number | null; wfh_weeks?: number | null; has_dedicated_home_office?: boolean; wfh_has_record?: boolean; wfh_weekdays?: number[] | null; wfh_leave_ranges?: { start: string; end: string; label?: string }[] | null; wfh_generate_diary?: boolean };
      const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Math.max(0, Number(v)));
      return json(await stub.setWorkUseInputs(uid, { fy, wfh_hours: num(body.wfh_hours), car_work_km: num(body.car_work_km), wfh_days_per_week: num(body.wfh_days_per_week), wfh_weeks: num(body.wfh_weeks), has_dedicated_home_office: !!body.has_dedicated_home_office, wfh_has_record: !!body.wfh_has_record, wfh_weekdays: Array.isArray(body.wfh_weekdays) ? body.wfh_weekdays : [], wfh_leave_ranges: Array.isArray(body.wfh_leave_ranges) ? body.wfh_leave_ranges : [], wfh_generate_diary: !!body.wfh_generate_diary }));
    }
  }

  // ── Car cents-per-km input (#245) — separate from work-use (WFH) ──────────
  if (resource === "car-use") {
    const fy = Number(url.searchParams.get("fy")) || defaultFy();
    if (m === "GET") {
      const row = await env.DB.prepare(`SELECT work_km FROM car_inputs WHERE user_id = ? AND fy = ?`)
        .bind(uid, fy)
        .first<{ work_km: number | null }>();
      return json({ car_use: row ?? { work_km: null } });
    }
    if (m === "POST") {
      const body = (await req.json().catch(() => ({}))) as { work_km?: number | null };
      const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Math.max(0, Number(v)));
      return json(await stub.setCarInputs(uid, { fy, work_km: num(body.work_km) }));
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
  // #256: pre-handoff double-check scan — deterministic, read-only. Flag-gated (404 when off ⇒ byte-identical).
  if (resource === "scan" && m === "GET") {
    if (!featureOn(env, "txn_scan")) return json({ error: "not_found" }, 404);
    const fy = Number(url.searchParams.get("fy")) || defaultFy();
    return json(await stub.scanTransactions(uid, fy));
  }

  if (resource === "report" && m === "GET") {
    const fy = Number(url.searchParams.get("fy")) || defaultFy();
    const rep = await buildReport(env, uid, fy);
    if (url.searchParams.get("format") === "csv") {
      // #179/#181: the itemised accountant schedule replaces the thin summary CSV when the flag is
      // on. Flag off ⇒ the identical legacy code path (byte-identical output by construction).
      if (featureOn(env, "accountant_schedule")) {
        const sched = await buildAccountantSchedule(env, uid, fy, { report: rep });
        return new Response(scheduleToCsv(sched), {
          headers: {
            "content-type": "text/csv",
            "content-disposition": `attachment; filename=quillo-accountant-schedule-${rep.fy}.csv`,
          },
        });
      }
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
    const fy = Number(url.searchParams.get("fy")) || defaultFy();
    return json(await stub.assessFilingReadiness(uid, fy));
  }

  // ── Find My Claims (flag claim_review) — 404 when off ─────────────────────
  // GET  /api/claim-review?fy=         → read-only situational sweep (3 groups + uncovered occupations)
  // POST /api/claim-review/draft       → AI gap-fill candidate rules for an uncovered occupation
  // POST /api/claim-review/rules       → persist user-confirmed candidate rules (defer_to_agent forced)
  if (resource === "claim-review") {
    if (!featureOn(env, "claim_review")) return json({ error: "not available" }, 404);
    if (m === "GET" && !id) {
      const fy = Number(url.searchParams.get("fy")) || defaultFy();
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
    // POST /api/movements/loan-split-group { txn_ids:[], property_id, interest_pct }
    //   → apply the SAME property + interest % to every loan line in a group (one row per loan).
    if (m === "POST" && id === "loan-split-group") {
      if (!featureOn(env, "loan_split")) return json({ error: "loan split is not enabled" }, 404);
      const b = (await req.json().catch(() => ({}))) as { txn_ids?: unknown; property_id?: unknown; interest_pct?: unknown };
      if (!Array.isArray(b.txn_ids) || b.txn_ids.some((x) => typeof x !== "string")) return json({ error: "txn_ids must be an array of strings" }, 400);
      if (typeof b.property_id !== "string" || typeof b.interest_pct !== "number") return json({ error: "property_id and interest_pct are required" }, 400);
      try {
        return json(await stub.applyLoanSplitGroup(uid, b.txn_ids as string[], { property_id: b.property_id, interest_pct: b.interest_pct }));
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
      const fy = Number(url.searchParams.get("fy")) || defaultFy();
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
      const fy = Number(url.searchParams.get("fy")) || defaultFy();
      try {
        return json(await stub.runAccountantPass(uid, fy));
      } catch (e) {
        return json({ error: (e as Error).message }, 409);
      }
    }
    if (m === "GET" && id === "suggestions") {
      const fy = Number(url.searchParams.get("fy")) || defaultFy();
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
    // GET /api/admin/spend — cross-tenant AI-spend + abuse view (per-tenant today/7d, who hit the daily
    // cap, who's a large share of the global ceiling). Read-only; reads existing llm_usage/daily_cost.
    if (m === "GET" && id === "spend") return json(await platformSpend(env));
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
    // GET /api/admin/referrals — cross-tenant referral funnel + recent leads (god-mode read, like the
    // other admin aggregates). The partner PORTAL (deferred) is the scoped view; this is the founder's.
    if (m === "GET" && id === "referrals") return json(await referralFunnelAdmin(env));
    // POST /api/admin/referrals/:token/advance { status, revenue_cents } — SIMULATE the partner postback
    // for testing (the real HMAC webhook is the outward integration step, deferred). Forward-only.
    if (m === "POST" && id === "referrals" && sub && parts[3] === "advance") {
      const { status, revenue_cents } = (await req.json().catch(() => ({}))) as { status?: unknown; revenue_cents?: unknown };
      if (typeof status !== "string" || !(REFERRAL_STATUSES as readonly string[]).includes(status)) return json({ error: "valid status required" }, 400);
      const cur = await env.DB.prepare(`SELECT status FROM referrals WHERE referral_token = ?`).bind(sub).first<{ status: string }>();
      if (!cur) return json({ error: "referral not found" }, 404);
      if (!canAdvanceReferral(cur.status, status)) return json({ error: `can't move ${cur.status} → ${status}` }, 409);
      // Revenue is only earned at convert/pay; a clawback REVERSES it (→0); other transitions leave it.
      const nextRev =
        status === "converted" || status === "paid" ? sanitizeRevenueCents(revenue_cents)
        : status === "clawed_back" ? 0
        : null; // null ⇒ keep the current value
      await env.DB.prepare(
        nextRev === null
          ? `UPDATE referrals SET status = ?, updated_at = datetime('now') WHERE referral_token = ?`
          : `UPDATE referrals SET status = ?, revenue_cents = ?, updated_at = datetime('now') WHERE referral_token = ?`,
      )
        .bind(...(nextRev === null ? [status, sub] : [status, nextRev, sub]))
        .run();
      return json({ ok: true, status });
    }
  }

  return json({ error: "not found" }, 404);
}
