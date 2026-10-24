import type { Env, TaxAgentRpc } from "./env";
import { verifyIngest } from "./ingest/auth";
import { parseEmail } from "./lib/email";
import { refuseRetiredMailbox } from "./lib/mailbox-retired";
import { declaredTooLarge, fileTooLarge, tooLargeMessage, UPLOAD_LIMITS, readBodyCapped, readTextCapped, PUBLIC_BODY_LIMITS } from "./lib/upload-limits";
import { userIdFromLocalpart } from "./lib/db";
import { requireClerk } from "./auth/clerk";
import { handleApi } from "./api";
import { DeleteBlockedError } from "./lib/situation-write";
import { handleCallback } from "./lib/qbo-oauth";
import { qboRetired, qboRetiredResponse } from "./lib/qbo-retired";
import { takeConnectState, stateForSession } from "./lib/bank-connect";
import { readCookie, redirectClearingBinding, QBO_BINDING, BANK_BINDING } from "./lib/oauth-binding";
import { verifyStripeWebhook } from "./lib/stripe";
import { marketingResponse } from "./marketing/landing";
import { legalResponse } from "./marketing/legal";
import { blogResponse } from "./marketing/blog";
import { handleWaitlist } from "./marketing/waitlist";
import { spentTodayGlobalCents } from "./lib/usage";
import { featureOn } from "./lib/features";
import { handleBeforeYouStart } from "./lib/before-you-start";
import { runScheduledSecurityChecks } from "./lib/security-dashboard";
import { emptyTally, publishLifecycleRecord } from "./lib/retention-schedule";
import { withSecurityHeaders, summariseCspReport, logTag, publicErrorMessage, scrubApiErrorResponse } from "./lib/security-headers";
import { ipRateLimit, userRateLimit, publishAccessSource } from "./lib/access-control";
import { BACKUP_CRON, runD1Backup } from "./lib/backups";
import { runBackfillOnce } from "./lib/backfill";
import { staleJobs } from "./lib/categorise-continuation";

// The DO class must be exported from the Worker's main module for the binding.
export { TaxAgent } from "./agent";

// locationHint 'oc' (Oceania) is a LATENCY hint only — NOT a data-residency
// guarantee (review finding B5). Genuine AU residency comes from Bedrock inference.
const LOCATION_HINT: DurableObjectLocationHint = "oc";

function stubFor(env: Env, userId: string): TaxAgentRpc {
  const id = env.TaxAgent.idFromName(userId);
  const stub = env.TaxAgent.get(id, { locationHint: LOCATION_HINT });
  return stub as unknown as TaxAgentRpc;
}

/** Run `fn` over `items` with at most `concurrency` in flight. fn must not throw (callers catch
 *  per-item) — a rejection would abort the worker and starve the rest of the slice. */
async function runPooled<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

const handler = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }

    // General per-IP rate limit (#638, ADR-0003 S6; flag api_rate_limit — OFF ⇒ null, no binding call).
    // Pre-auth, so it also brakes token-guessing and unauthenticated JWT-verification load. The path
    // list (and its exclusions: /healthz, the Stripe webhook) lives in ipRateLimited().
    const ipLimited = await ipRateLimit(req, env, url.pathname);
    if (ipLimited) return ipLimited;

    // CSP violation sink (public — browsers POST reports with no auth header, so this must sit
    // before the /api Clerk gate). We only log: a violation here means either a misconfigured
    // allowlist (tighten the policy) or an unexpected outbound call from a bundled dep (investigate).
    // Bounded body read (streamed, 8 KB; a bigger report is refused 413 unread) so a spammed report can't
    // be a memory amplifier. Logs ONLY the directive +
    // the blocked ORIGIN (or keyword) — never the raw report, whose document-uri / blocked-uri /
    // script-sample carry full URLs, query strings and page content (#634 log hygiene).
    if (url.pathname === "/csp-report" && req.method === "POST") {
      try {
        const r = await readTextCapped(req, PUBLIC_BODY_LIMITS.cspReport);
        if (!r.ok) return r.response;
        const raw = r.text;
        for (const line of summariseCspReport(raw)) console.warn(`csp-report: ${line}`);
      } catch {
        /* ignore malformed reports */
      }
      return new Response(null, { status: 204 });
    }

    // ── Host branch: public marketing apex vs the gated app host ────────────────
    // The marketing page (quillo.au) lives outside Cloudflare Access; only the app
    // host (app.quillo.au) gets an Access application in front. We read the Host
    // header (not just url.hostname) so `curl -H 'Host: quillo.au'` exercises the
    // apex path under `wrangler dev`, where url.hostname is always localhost.
    const host = (req.headers.get("host") ?? url.hostname).split(":")[0]?.toLowerCase() ?? "";
    if (host === "www.quillo.au") {
      url.protocol = "https:";
      url.hostname = "quillo.au";
      url.port = "";
      return Response.redirect(url.toString(), 301); // canonical apex
    }
    if (host === "quillo.au") {
      if (url.pathname === "/" && req.method === "GET") return marketingResponse();
      if (url.pathname === "/waitlist" && req.method === "POST") return handleWaitlist(req, env);
      // Public legal pages (required by Intuit for production QuickBooks keys, good practice generally).
      if (url.pathname === "/terms" && req.method === "GET") return legalResponse("terms");
      if (url.pathname === "/privacy" && req.method === "GET") return legalResponse("privacy");
      if ((url.pathname === "/blog" || url.pathname.startsWith("/blog/")) && req.method === "GET") return blogResponse(url.pathname);
      // Keep the apex tiny — anything else belongs to the app.
      return Response.redirect("https://app.quillo.au" + url.pathname + url.search, 302);
    }
    // The blog is apex-only; a /blog link that lands on the app host goes to the canonical page.
    if (host === "app.quillo.au" && (url.pathname === "/blog" || url.pathname.startsWith("/blog/"))) {
      return Response.redirect("https://quillo.au" + url.pathname, 301);
    }

    // (a) Web upload + (c) iOS Shortcut + (d) Android app all POST signed bytes here.
    // Tenant identity is DERIVED from the verifying key — never a client header (B1).
    if (url.pathname === "/ingest" && req.method === "POST") {
      // Size ceiling (#713, review F8): a raw image/PDF/text body, so no multipart allowance. A declared
      // Content-Length over it is refused unread; otherwise the body is streamed and cut off at the ceiling.
      if (declaredTooLarge(req, "receipt", false)) return new Response(tooLargeMessage("receipt"), { status: 413 });
      const capped = await readBodyCapped(req, UPLOAD_LIMITS.receipt, () => new Response(tooLargeMessage("receipt"), { status: 413 }));
      if (!capped.ok) return capped.response;
      const body = capped.bytes; // read ONCE (fixes §3 clone/re-read bug)
      const verified = await verifyIngest(env, req, body, Date.now());
      if (!verified) return new Response("unauthorized", { status: 401 });

      const source = req.headers.get("x-source") ?? "upload";
      const mime = req.headers.get("content-type") ?? "image/jpeg";
      const bucketHint = req.headers.get("x-bucket");
      const stub = stubFor(env, verified.userId);

      // Typed / free-text expense (content-type text/*). `x-parse: alert` runs the
      // conservative bank-alert parser (ingestText, no Claude); otherwise the text is
      // categorised like a receipt (ingestCategoriseText → real bucket + ato_label).
      if (mime.startsWith("text/")) {
        const text = new TextDecoder().decode(body);
        const txnId =
          req.headers.get("x-parse") === "alert"
            ? await stub.ingestText(verified.userId, source, text)
            : await stub.ingestCategoriseText(verified.userId, source, text, bucketHint);
        return Response.json({ ok: true, txnId });
      }

      const txnId = await stub.ingest(verified.userId, source, body, mime, bucketHint);
      return Response.json({ ok: true, txnId });
    }

    // Correction endpoint (web UI / chat) — same signed-request auth.
    if (url.pathname === "/correct" && req.method === "POST") {
      const capped = await readBodyCapped(req, PUBLIC_BODY_LIMITS.correct);
      if (!capped.ok) return capped.response;
      const body = capped.bytes;
      const verified = await verifyIngest(env, req, body, Date.now());
      if (!verified) return new Response("unauthorized", { status: 401 });

      const { txnId, field, value } = JSON.parse(new TextDecoder().decode(body)) as {
        txnId: string;
        field: string;
        value: string;
      };
      await stubFor(env, verified.userId).applyCorrection(verified.userId, txnId, field, value);
      return Response.json({ ok: true });
    }

    // Stripe webhook (usage-billing top-ups). Public + UNauthenticated by Clerk — Stripe calls it
    // server-to-server, verified by the webhook signing secret. Credits the user's wallet on a paid
    // checkout. Inert (503) until STRIPE_WEBHOOK_SECRET is set; idempotent on the session id.
    if (url.pathname === "/api/stripe/webhook" && req.method === "POST") {
      const capped = await readTextCapped(req, PUBLIC_BODY_LIMITS.stripeWebhook); // bounded before the signature check
      if (!capped.ok) return capped.response;
      const payload = capped.text;
      const event = await verifyStripeWebhook(env, payload, req.headers.get("stripe-signature"));
      if (!event) return new Response(env.STRIPE_WEBHOOK_SECRET ? "bad signature" : "billing not configured", { status: env.STRIPE_WEBHOOK_SECRET ? 400 : 503 });
      if (event.type === "checkout.session.completed") {
        const s = (event.data?.object ?? {}) as { id?: string; payment_status?: string; metadata?: { user_id?: string; credit_e4?: string } };
        const userId = s.metadata?.user_id;
        const creditE4 = Number(s.metadata?.credit_e4 ?? 0);
        if (s.payment_status === "paid" && userId && creditE4 > 0) {
          await stubFor(env, userId).creditWallet(userId, creditE4, "topup", s.id ?? null);
        }
      }
      return Response.json({ received: true });
    }

    // Record explicit APP-8 cross-border consent (fix H7).
    if (url.pathname === "/consent" && req.method === "POST") {
      const capped = await readBodyCapped(req, PUBLIC_BODY_LIMITS.consent);
      if (!capped.ok) return capped.response;
      const body = capped.bytes;
      const verified = await verifyIngest(env, req, body, Date.now());
      if (!verified) return new Response("unauthorized", { status: 401 });

      const { text, method } = JSON.parse(new TextDecoder().decode(body)) as {
        text: string;
        method: string;
      };
      await stubFor(env, verified.userId).recordConsent(verified.userId, text, method ?? "web");
      return Response.json({ ok: true });
    }

    // QuickBooks OAuth callback — Intuit redirects the BROWSER here (top-level navigation,
    // no Authorization header), so it cannot sit behind the Clerk /api gate. It authenticates
    // via the `state` nonce (KV → userId), set when the SPA initiated connect, not the app
    // session — the standard OAuth CSRF protection. Must be matched BEFORE the /api/ gate.
    if (url.pathname === "/api/qbo/callback" && req.method === "GET") {
      // qbo_retired (map #692): 404 before the state nonce is read or any token is exchanged. OFF ⇒ unchanged.
      if (qboRetired(env)) return qboRetiredResponse();
      const r = await handleCallback(env, url, url.origin, readCookie(req, QBO_BINDING.name));
      // Surface the failure reason to the UI (and logs) so a failed callback isn't a silent
      // connected=0. Note: the "redirect_uri invalid" error happens on Intuit's authorize
      // page BEFORE this callback ever runs, so it won't appear here — that's an Intuit-side
      // registration/propagation issue, not something our server sees.
      if (!r.ok) console.warn(`qbo callback failed: ${r.error}`);
      const reason = r.ok ? "" : `&reason=${encodeURIComponent(r.error ?? "unknown")}`;
      // The binding cookie is single-use like the state: clear it on every outcome (#712).
      return redirectClearingBinding(`${url.origin}/quickbooks?connected=${r.ok ? "1" : "0"}${reason}`, QBO_BINDING);
    }

    // Bank-feed consent callback — PUBLIC by necessity, like the QBO one above: the consumer
    // returns from the aggregator's hosted consent UI as a top-level browser navigation, which
    // carries no Authorization header. It is authenticated instead by a single-use, unguessable,
    // short-lived `state` handle minted at connect time (src/lib/bank-connect.ts). An unknown or
    // replayed state is REFUSED — it never falls back to a default tenant.
    if (url.pathname === "/api/bank/callback" && req.method === "GET") {
      if (!featureOn(env, "bank_feed_cdr")) return new Response("not found", { status: 404 });
      // Resolve (and consume) the state HERE, not inside the DO: it identifies which tenant this
      // callback belongs to, and the DO is per-tenant — so the correct stub can only be chosen
      // once the tenant is known. Doing it inside a guessed stub would let one tenant's DO
      // coordinate another tenant's writes.
      // Our `state` rides in the redirect URL's query. Fallback: a provider that keeps the redirect
      // server-side (Fiskil) may come back with only its auth-session id — mapped to the state at
      // connect time, single-use and short-lived exactly like the state itself.
      const sp = url.searchParams;
      const sessionId = sp.get("sess_id") ?? sp.get("session_id");
      const state = sp.get("state") ?? (await stateForSession(env, sessionId));
      // The state must come back in the browser that started the connect (HttpOnly binding cookie, #712);
      // a forwarded consent link has no cookie and gets the same refusal as an unknown state.
      const userId = await takeConnectState(env, state, readCookie(req, BANK_BINDING.name));
      if (!userId) {
        console.warn("bank callback rejected: invalid_or_expired_state (or not the starting browser)");
        return redirectClearingBinding(`${url.origin}/accounts?connected=0&reason=invalid_or_expired_state`, BANK_BINDING);
      }
      const r = await stubFor(env, userId).bankCallback(userId, sp.get("jobIds"), {
        outcome: sp.get("outcome"),
        error: sp.get("error_type") ?? sp.get("error"),
        errorId: sp.get("error_id"),
        sessionId,
      });
      if (!r.ok) console.warn(`bank callback failed: ${r.error}`);
      const q = r.ok
        ? `connected=1&accounts=${r.accounts}`
        : `connected=0&reason=${encodeURIComponent(r.error ?? "unknown")}`;
      return redirectClearingBinding(`${url.origin}/accounts?${q}`, BANK_BINDING);
    }

    // Public "Before you start" probe (#584, flag ft_journey): static rule-pack content for the
    // signed-out /start screen, so it must sit before the Clerk gate. Flag OFF ⇒ not intercepted at
    // all: the path falls through to the Clerk gate exactly as today (byte-identical OFF).
    if (url.pathname === "/api/public/before-you-start" && featureOn(env, "ft_journey")) {
      return handleBeforeYouStart(req, env);
    }

    // Web UI API — authenticated via Clerk, gated to the founder's user until launch.
    if (url.pathname.startsWith("/api/")) {
      const auth = await requireClerk(req, env);
      if (!auth.ok) {
        const msg = auth.status === 403 ? "not yet available" : "unauthorized";
        return new Response(msg, { status: auth.status });
      }
      // Per-tenant rate limit (#638; flag api_rate_limit), keyed by the server-derived tenant id.
      const userLimited = await userRateLimit(env, auth.user.userId);
      if (userLimited) return userLimited;
      // Error boundary: a throw inside any /api handler must become a readable JSON 500,
      // never a raw Cloudflare 1101 ("Worker threw exception") HTML page that the UI then
      // shows verbatim. Log with method+path so Workers Logs pinpoint the failing route.
      try {
        // Error bodies pass through scrubApiErrorResponse: no SQL / schema / AWS ARNs to the browser (#694).
        return await scrubApiErrorResponse(await handleApi(req, env, auth.user, stubFor(env, auth.user.userId)), `${req.method} ${url.pathname}`);
      } catch (e) {
        // A blocked delete (dependent financial records still reference the row) is a
        // 409, not a 500 — return the blockers so the UI can offer "archive instead".
        if (e instanceof DeleteBlockedError) {
          return Response.json({ error: e.message, blockers: e.blockers, parentTable: e.parentTable, archivable: e.archivable }, { status: 409 });
        }
        const err = e as Error;
        console.error(`api error: ${req.method} ${url.pathname}: ${err?.stack ?? err?.message ?? err}`);
        return Response.json({ error: publicErrorMessage(err?.message) }, { status: 500 }); // full text logged above
      }
    }

    // NOTE: the Agents-SDK transport (`routeAgentRequest`, which maps /agents/:ns/:name/* straight
    // to TaxAgent.idFromName(name)) is deliberately NOT mounted. It carries no auth hook, so it
    // would expose every tenant's Durable Object unauthenticated + cross-origin, bypassing the
    // Clerk gate on /api/* (review CRITICAL). The SPA only ever reaches the DO via server-side
    // stubFor() RPC after requireClerk maps sub→tenant, so the public route is unused. If a direct
    // client transport is ever needed, gate it behind requireClerk, assert :name === the
    // authenticated tenant, drop cors, and add an onBeforeConnect/onBeforeRequest auth hook.

    // Static assets / SPA. Now that "/" is in run_worker_first, the Worker runs for
    // the app host's "/" too, so it must hand back to the assets binding (which honours
    // the single-page-application fallback to index.html).
    if (env.ASSETS) return env.ASSETS.fetch(req); // security headers added by the default-export wrapper
    return new Response("not found", { status: 404 });
  },

  // (b) EMAIL ingest — Cloudflare Email Routing delivers here. Tenant is derived
  // server-side from the verified recipient mailbox, not from any client input.
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    // mailbox_retired (map #692): bounce before anything is parsed, resolved or stored. OFF ⇒ unchanged.
    if (refuseRetiredMailbox(env, message)) return;
    // Size ceiling before the MIME parse buffers it (#713). Bounce rather than drop, so a genuine sender
    // learns the message wasn't filed.
    if (fileTooLarge(message.rawSize, "emailRaw")) {
      message.setReject(tooLargeMessage("emailRaw"));
      return;
    }
    const parsed = await parseEmail(message);
    const userId = await userIdFromLocalpart(env, parsed.localpart);
    if (!userId) {
      console.warn(`email to unknown mailbox: tag=${await logTag(parsed.localpart)}`); // never the address itself
      return; // unknown recipient — drop silently
    }

    const stub = stubFor(env, userId);
    if (parsed.attachments.length === 0) {
      await stub.ingestText(userId, "email", parsed.text);
      return;
    }
    // Emailed attachments are ambiguous (payslip? agent summary? receipt?) — route through the
    // Smart Inbox classifier rather than assuming a receipt.
    for (const att of parsed.attachments) {
      if (fileTooLarge(att.bytes.byteLength, "document")) {
        console.warn(`email attachment skipped: ${att.bytes.byteLength} bytes is over the ${UPLOAD_LIMITS.document} byte limit`);
        continue;
      }
      await stub.classifyAndRoute(userId, "email", att.bytes, att.mime);
    }
  },

  // Cron — two schedules (see wrangler.toml):
  //  - frequent (*/10): poll + apply finished async categorisation batches.
  //  - weekly (Mon 08:00): proactive suggestions for every tenant.
  async scheduled(evt: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Daily D1 export -> BACKUPS (#635). Its own cron so it never shares a tick's budget with the
    // batch drain. Flag OFF ⇒ returns before touching anything. Never throws (records its own failure).
    if (evt.cron === BACKUP_CRON) {
      const r = await runD1Backup(env);
      if (r.status !== "flag_off") console.log(`d1 backup: ${r.status}`);
      return;
    }
    if (evt.cron === "0 8 * * 1") {
      // Current AU FY start year (Jul–Jun) for the depreciation roll-forward.
      const now = new Date();
      const fyStart = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
      // Page the weekly sweep across ticks with a KV cursor so a large tenant set can't blow the 300s
      // wall-clock and silently drop the tail (#79). Each tick processes a bounded, ordered slice
      // (round-robin by user_id) and advances the cursor; bounded concurrency keeps the slice well
      // within budget. NB: rollForward/flagOldData/proactiveScan are maintenance, not time-critical —
      // weekly-paged delivery is fine. When tenant count outgrows one weekly slice, move this onto a
      // Queue consumer (the per-tenant unit of work is already isolated for that).
      const SLICE = 400;
      const CONCURRENCY = 6;
      const cursorKey = "cron:weekly:cursor";
      const cursor = (await env.RULES.get(cursorKey)) ?? "";
      const users = await env.DB.prepare(`SELECT user_id FROM profiles WHERE user_id > ? ORDER BY user_id LIMIT ?`)
        .bind(cursor, SLICE)
        .all<{ user_id: string }>();
      const batch = users.results ?? [];
      // #639: what the data-lifecycle steps did this run — counts only — published for the admin dashboard.
      const tally = emptyTally();
      tally.tenants = batch.length;
      await runPooled(batch, CONCURRENCY, async (u) => {
        // Isolate per-tenant failures — one tenant's bad asset/data must not abort the sweep for all.
        try {
          const stub = stubFor(env, u.user_id);
          await stub.runProactiveScan(u.user_id);
          // Keep each tenant's depreciation_schedule materialised through the current FY (carry-forward).
          await stub.rollForward(u.user_id, fyStart);
          // Retention: flag (never delete) records past the tenant's window (5 years from the lodge date).
          if ((await stub.flagOldData(u.user_id)).flagged) tally.flagged++;
          // Savings & Opportunities: deterministic recurring-bill detection + factual opportunities
          // (no LLM → no AI-spend interaction). Flag-gated so OFF ⇒ no read/write path, byte-identical.
          if (featureOn(env, "advisory_layer")) await stub.detectAdvisory(u.user_id);
          // PHI Extras Tracker: deterministic (no-LLM) setup nudge + reset reminder. Writes only to
          // opportunities + notifications. Flag-gated ⇒ OFF means no read/write path, byte-identical.
          if (featureOn(env, "phi_extras_tracker")) await stub.detectBenefitsReset(u.user_id);
          // Bank-feed consents (#576, ADR-0003 §6.4): mark expired, remind before expiry, retry failed
          // upstream revokes. Flag-gated ⇒ OFF means no read/write path, byte-identical.
          if (featureOn(env, "bank_feed_cdr")) {
            const lc = await stub.bankConsentLifecycle(u.user_id);
            tally.expired_consents_deleted += lc.expiredDeleted ?? 0;
            tally.expiry_lines_deleted += lc.expiredLinesDeleted ?? 0;
          }
        } catch (e) {
          tally.failures++;
          console.error(`weekly cron failed for ${u.user_id}: ${(e as Error).message}`);
        }
        // Data lifecycle (#594 / #639), each step isolated so one failing can't skip the others. Each is
        // flag-gated here AND inside (OFF ⇒ no DO call, no read, no write — byte-identical).
        // Retention schedule: irrelevant debits of a lodged FY (or due date + 60 days) shrink to per-account totals.
        if (featureOn(env, "bank_minimisation")) {
          try {
            tally.shrunk += (await stubFor(env, u.user_id).minimiseBankLines(u.user_id))?.shrunk ?? 0;
          } catch (e) {
            tally.failures++;
            console.error(`bank minimisation failed for ${u.user_id}: ${(e as Error).name}`);
          }
        }
        // Inactive end users: 30 days with no live consent ⇒ delete the aggregator end user.
        if (featureOn(env, "cdr_inactive_user_delete")) {
          try {
            const r = await stubFor(env, u.user_id).bankInactiveEndUser(u.user_id);
            if (r.state === "deleted") tally.end_users_deleted++;
            if (r.state === "failed") tally.failures++;
          } catch (e) {
            tally.failures++;
            console.error(`inactive end-user sweep failed for ${u.user_id}: ${(e as Error).name}`);
          }
        }
      });
      await publishLifecycleRecord(env, tally, new Date(), { partial: batch.length === SLICE || cursor !== "" });
      // A full slice means more tenants remain → resume after the last id next tick. A short slice
      // means we reached the end → clear the cursor so the next run round-robins from the start.
      if (batch.length === SLICE) {
        await env.RULES.put(cursorKey, batch[batch.length - 1]!.user_id);
        console.warn(`weekly cron: swept ${batch.length} tenants from cursor "${cursor}"; more remain — resuming next tick`);
      } else {
        if (cursor !== "") await env.RULES.delete(cursorKey);
        console.log(`weekly cron: swept ${batch.length} tenants (slice complete)`);
      }
      return;
    }
    // Security & compliance checks (#636): flag-gated — OFF ⇒ returns before touching KV or the network.
    // ON ⇒ runs at most once a day (SCHEDULED_INTERVAL_MS), never every tick. Isolated so a failing
    // probe can't stop the batch drain below.
    // waitUntil: the probes (≤8s each) run alongside the batch drain instead of delaying it.
    ctx.waitUntil(
      runScheduledSecurityChecks(env).catch((e) => console.error(`security checks failed: ${(e as Error).name}`)),
    );
    // Access-control source record for the dashboard (#638): KV `security:source:mfa`, rewritten only
    // when a flag/admin-count/Clerk-instance change makes it differ, or daily. Counts + flag states only.
    ctx.waitUntil(
      publishAccessSource(env).catch((e) => console.error(`access source publish failed: ${(e as Error).name}`)),
    );

    // Frequent: only users with a pending batch job (cheap query, no per-tenant fan-out). Draining
    // in-flight batches is safe even when over budget — the cost was already incurred at submission;
    // polling/applying just accounts for it and unblocks the user (so it runs unconditionally).
    const pending = await env.DB.prepare(`SELECT DISTINCT user_id FROM batch_jobs WHERE status = 'submitted'`).all<{ user_id: string }>();
    for (const u of pending.results) await stubFor(env, u.user_id).pollBatchJobs(u.user_id);
    // import_continuation (F2): a live categorisation chain whose alarm went quiet gets its next hop
    // re-delivered (idempotent: a hop is due only if nothing committed it). Cheap: one indexed query.
    if (featureOn(env, "import_continuation")) {
      for (const p of await staleJobs(env.DB, Date.now())) {
        await stubFor(env, p.userId).categoriseContinue(p).catch((e) => console.error(`categorise continuation heal failed: ${(e as Error).name}`));
      }
    }

    // One-time backfills (#724): each runs through runBackfillOnce — a global KV marker
    // (`backfill:<key>:done`) so a finished backfill costs ONE KV read a tick and no D1 scan, KV-cursor
    // paging over `profiles` (at most BACKFILL_PAGE_SIZE tenants a tick), and the original per-tenant
    // claim-before-work guards (same KV flags, so tenants that already ran are never re-run).

    // NON-spendy (no model call, so no AI-cost gate): repair auto-created needs_review assets the v1
    // linker mis-handled — unwind personal transfers wrongly depreciated, and reclass low-cost (<=$300)
    // items from a multi-year schedule to an immediate write-off.
    await runBackfillOnce(env, "reclass-lowcost-assets-v1", (uid) => stubFor(env, uid).reclassMisbucketedAssets(uid).then(() => undefined), {
      tenantFlag: (uid) => `backfill:reclass-lowcost-assets-v1:${uid}`,
      label: "asset reclass",
    });

    // Cost-safety gate for the SPENDY backfills below (C1): recategorise/repairStatements submit NEW
    // batch jobs (Anthropic bills at submission). If the platform's daily ceiling is already hit,
    // skip them this tick — they're one-time backfills with no deadline, so deferring to a day with
    // headroom costs nothing but stops the cron spending past the global cap. (withinBudget inside
    // categoriseStatement is the per-submit backstop; this avoids even starting the work.) Evaluated
    // lazily — only when a spendy backfill isn't done yet — and at most once a tick.
    let budgetOk: Promise<boolean> | undefined;
    const withinGlobalCeiling = () =>
      (budgetOk ??= (async () => {
        const globalCeiling = Number(env.MAX_DAILY_COST_CENTS_GLOBAL ?? 0);
        if (globalCeiling > 0 && (await spentTodayGlobalCents(env)) >= globalCeiling) {
          console.warn("skipping one-time backfills this tick — global daily AI ceiling already reached");
          return false;
        }
        return true;
      })());

    // Re-categorise data imported before the income/asset buckets existed, so stranded credits get
    // income buckets and capital purchases link to assets. Keyed off REAL tenants (`profiles`), NOT
    // CLERK_ALLOWED_USERS: the founder's data lives under the mapped tenant id "me" (src/auth/clerk.ts).
    // The earlier v1 keyed off the Clerk id and silently no-op'd — hence the v2 key.
    await runBackfillOnce(env, "income-assets-v2", (uid) => stubFor(env, uid).recategorise(uid).then(() => undefined), {
      tenantFlag: (uid) => `backfill:income-assets-v2:${uid}`,
      gate: withinGlobalCeiling,
      label: "recategorise",
    });

    // Statement repair: recover lines dropped by the old credit-card de-dup bug (re-import from the
    // stored R2 sidecar with the fixed fingerprint) and correct stale imported_count / reconciled flags.
    await runBackfillOnce(env, "repair-statements-v1", (uid) => stubFor(env, uid).repairStatements(uid).then(() => undefined), {
      tenantFlag: (uid) => `repair:statements-v1:${uid}`,
      gate: withinGlobalCeiling,
      label: "statement repair",
    });
  },
} satisfies ExportedHandler<Env>;

// Every Worker response (API JSON, marketing/legal HTML, redirects, the SPA shell) gets the security
// headers — HSTS, nosniff, Referrer-Policy, X-Frame-Options, Permissions-Policy, and the enforcing CSP
// on HTML (src/lib/security-headers.ts, #634). Asset-only paths get the same set from web/public/_headers.
export default {
  ...handler,
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withSecurityHeaders(await handler.fetch(req, env, ctx));
  },
} satisfies ExportedHandler<Env>;
