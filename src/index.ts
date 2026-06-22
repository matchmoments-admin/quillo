import type { Env, TaxAgentRpc } from "./env";
import { verifyIngest } from "./ingest/auth";
import { parseEmail } from "./lib/email";
import { userIdFromLocalpart } from "./lib/db";
import { requireClerk } from "./auth/clerk";
import { handleApi } from "./api";
import { DeleteBlockedError } from "./lib/situation-write";
import { handleCallback } from "./lib/qbo-oauth";
import { marketingResponse } from "./marketing/landing";
import { legalResponse } from "./marketing/legal";
import { handleWaitlist } from "./marketing/waitlist";
import { spentTodayGlobalCents } from "./lib/usage";
import { featureOn } from "./lib/features";

// The DO class must be exported from the Worker's main module for the binding.
export { TaxAgent } from "./agent";

// Content-Security-Policy for the SPA shell. Shipped REPORT-ONLY first: an enforcing
// `connect-src` mistake would lock every user out of Clerk auth, and the local runtime is
// deploy-only (macOS 12.6 can't run workerd) so we can't validate the allowlist before prod.
// Report-Only never blocks — it only POSTs violations to /csp-report — so it is safe to ship and
// gives us server-side visibility of any unexpected outbound call (the supply-chain concern behind
// adopting @assistant-ui/react). Flip to enforcing (`Content-Security-Policy`) in a fast-follow once
// prod reports confirm zero false positives. Allowlist = self + Google Fonts + Clerk; assistant-ui
// under useLocalRuntime needs nothing beyond 'self' (its optional cloud SDK is never constructed).
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "script-src 'self' 'unsafe-inline' https://*.clerk.accounts.dev https://*.clerk.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.clerk.com https://img.clerk.com",
  "connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com",
  "worker-src 'self' blob:",
  "frame-src 'self' https://*.clerk.com https://challenges.cloudflare.com",
  "form-action 'self'",
  "report-uri /csp-report",
].join("; ");

// Attach the Report-Only CSP (+ a couple of cheap always-safe headers) to the SPA's HTML shell only.
// Hashed JS/CSS/font assets don't need it and we must not disturb their caching headers.
function withSecurityHeaders(res: Response): Response {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("text/html")) return res;
  const h = new Headers(res.headers);
  h.set("Content-Security-Policy-Report-Only", CSP_DIRECTIVES);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/**
 * Run a one-time, KV-guarded backfill at most `maxAttempts` times, claiming the attempt BEFORE the
 * work. The old pattern set the "done" flag AFTER the AI work, so a mid-run failure (e.g. an
 * Anthropic 429 that lands AFTER some paid batches were already submitted) left the flag unset and
 * the 10-minute cron re-ran — and re-paid for — the whole backfill every tick, forever (C2). Claiming up
 * front bounds the blast radius to `maxAttempts` paid tries even if every one crashes; on success
 * we flip to "done" so it never runs again. The work itself stays idempotent (recategorise only
 * re-queues null/unknown lines; with C6 it skips statements already in an in-flight batch).
 * KV states: "done" | "attempt:N".
 */
async function runOnceGuarded(
  env: Env,
  flag: string,
  maxAttempts: number,
  fn: () => Promise<void>,
): Promise<void> {
  const cur = await env.RULES.get(flag);
  if (cur === "done") return;
  const attempts = cur?.startsWith("attempt:") ? Number(cur.slice("attempt:".length)) || 0 : 0;
  if (attempts >= maxAttempts) return; // gave up after repeated failures — don't keep paying to retry
  // Interim "attempt:N" state carries a TTL so a permanently-wedged tenant (every attempt crashes)
  // self-heals after the window rather than counting failed attempts forever; the terminal "done"
  // flag is PERMANENT (no TTL) so a completed one-time backfill never silently re-runs and re-spends.
  await env.RULES.put(flag, `attempt:${attempts + 1}`, { expirationTtl: 60 * 60 * 24 * 7 }); // claim BEFORE the work
  await fn();
  await env.RULES.put(flag, "done"); // success → never re-run (permanent)
}

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

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }

    // CSP violation sink (public — browsers POST reports with no auth header, so this must sit
    // before the /api Clerk gate). We only log: a violation here means either a misconfigured
    // allowlist (tighten the policy) or an unexpected outbound call from a bundled dep (investigate).
    // Bounded body read so a spammed report can't be a memory amplifier.
    if (url.pathname === "/csp-report" && req.method === "POST") {
      try {
        const raw = (await req.text()).slice(0, 4096);
        console.warn(`csp-report: ${raw}`);
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
      // Keep the apex tiny — anything else belongs to the app.
      return Response.redirect("https://app.quillo.au" + url.pathname + url.search, 302);
    }

    // (a) Web upload + (c) iOS Shortcut + (d) Android app all POST signed bytes here.
    // Tenant identity is DERIVED from the verifying key — never a client header (B1).
    if (url.pathname === "/ingest" && req.method === "POST") {
      const body = await req.arrayBuffer(); // read ONCE (fixes §3 clone/re-read bug)
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
      const body = await req.arrayBuffer();
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

    // Record explicit APP-8 cross-border consent (fix H7).
    if (url.pathname === "/consent" && req.method === "POST") {
      const body = await req.arrayBuffer();
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
      const r = await handleCallback(env, url, url.origin);
      // Surface the failure reason to the UI (and logs) so a failed callback isn't a silent
      // connected=0. Note: the "redirect_uri invalid" error happens on Intuit's authorize
      // page BEFORE this callback ever runs, so it won't appear here — that's an Intuit-side
      // registration/propagation issue, not something our server sees.
      if (!r.ok) console.warn(`qbo callback failed: ${r.error}`);
      const reason = r.ok ? "" : `&reason=${encodeURIComponent(r.error ?? "unknown")}`;
      return Response.redirect(`${url.origin}/quickbooks?connected=${r.ok ? "1" : "0"}${reason}`, 302);
    }

    // Web UI API — authenticated via Clerk, gated to the founder's user until launch.
    if (url.pathname.startsWith("/api/")) {
      const auth = await requireClerk(req, env);
      if (!auth.ok) {
        const msg = auth.status === 403 ? "not yet available" : "unauthorized";
        return new Response(msg, { status: auth.status });
      }
      // Error boundary: a throw inside any /api handler must become a readable JSON 500,
      // never a raw Cloudflare 1101 ("Worker threw exception") HTML page that the UI then
      // shows verbatim. Log with method+path so Workers Logs pinpoint the failing route.
      try {
        return await handleApi(req, env, auth.user, stubFor(env, auth.user.userId));
      } catch (e) {
        // A blocked delete (dependent financial records still reference the row) is a
        // 409, not a 500 — return the blockers so the UI can offer "archive instead".
        if (e instanceof DeleteBlockedError) {
          return Response.json({ error: e.message, blockers: e.blockers, parentTable: e.parentTable, archivable: e.archivable }, { status: 409 });
        }
        const err = e as Error;
        console.error(`api error: ${req.method} ${url.pathname}: ${err?.stack ?? err?.message ?? err}`);
        return Response.json({ error: err?.message ?? "internal error" }, { status: 500 });
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
    if (env.ASSETS) return withSecurityHeaders(await env.ASSETS.fetch(req));
    return new Response("not found", { status: 404 });
  },

  // (b) EMAIL ingest — Cloudflare Email Routing delivers here. Tenant is derived
  // server-side from the verified recipient mailbox, not from any client input.
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    const parsed = await parseEmail(message);
    const userId = await userIdFromLocalpart(env, parsed.localpart);
    if (!userId) {
      console.warn(`email to unknown mailbox: ${parsed.localpart}`);
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
      await stub.classifyAndRoute(userId, "email", att.bytes, att.mime);
    }
  },

  // Cron — two schedules (see wrangler.toml):
  //  - frequent (*/10): poll + apply finished async categorisation batches.
  //  - weekly (Mon 08:00): proactive suggestions for every tenant.
  async scheduled(evt: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
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
      await runPooled(batch, CONCURRENCY, async (u) => {
        // Isolate per-tenant failures — one tenant's bad asset/data must not abort the sweep for all.
        try {
          const stub = stubFor(env, u.user_id);
          await stub.runProactiveScan(u.user_id);
          // Keep each tenant's depreciation_schedule materialised through the current FY (carry-forward).
          await stub.rollForward(u.user_id, fyStart);
          // Retention: flag (never delete) records past the tenant's window.
          await stub.flagOldData(u.user_id);
          // Savings & Opportunities: deterministic recurring-bill detection + factual opportunities
          // (no LLM → no AI-spend interaction). Flag-gated so OFF ⇒ no read/write path, byte-identical.
          if (featureOn(env, "advisory_layer")) await stub.detectAdvisory(u.user_id);
          // PHI Extras Tracker: deterministic (no-LLM) setup nudge + reset reminder. Writes only to
          // opportunities + notifications. Flag-gated ⇒ OFF means no read/write path, byte-identical.
          if (featureOn(env, "phi_extras_tracker")) await stub.detectBenefitsReset(u.user_id);
        } catch (e) {
          console.error(`weekly cron failed for ${u.user_id}: ${(e as Error).message}`);
        }
      });
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
    // Frequent: only users with a pending batch job (cheap query, no per-tenant fan-out). Draining
    // in-flight batches is safe even when over budget — the cost was already incurred at submission;
    // polling/applying just accounts for it and unblocks the user (so it runs unconditionally).
    const pending = await env.DB.prepare(`SELECT DISTINCT user_id FROM batch_jobs WHERE status = 'submitted'`).all<{ user_id: string }>();
    for (const u of pending.results) await stubFor(env, u.user_id).pollBatchJobs(u.user_id);

    // One-time backfill (NON-spendy — no model call, so it runs BEFORE the AI-cost gate below):
    // repair auto-created needs_review assets the v1 linker mis-handled — unwind personal transfers
    // wrongly depreciated, and reclass low-cost (≤$300) items from a multi-year schedule to an
    // immediate write-off. Guarded per tenant (claim-before-work, bounded) so it runs once. Iterate
    // REAL tenants from `profiles` (founder's data lives under "me", not a Clerk id).
    const assetFixTenants = await env.DB.prepare(`SELECT user_id FROM profiles`).all<{ user_id: string }>();
    for (const t of assetFixTenants.results ?? []) {
      try {
        await runOnceGuarded(env, `backfill:reclass-lowcost-assets-v1:${t.user_id}`, 3, () =>
          stubFor(env, t.user_id).reclassMisbucketedAssets(t.user_id).then(() => undefined),
        );
      } catch (e) {
        console.error(`asset reclass backfill failed for ${t.user_id}: ${(e as Error).message}`);
      }
    }

    // Cost-safety gate for the SPENDY backfills below (C1): recategorise/repairStatements submit NEW
    // batch jobs (Anthropic bills at submission). If the platform's daily ceiling is already hit,
    // skip them this tick — they're one-time backfills with no deadline, so deferring to a day with
    // headroom costs nothing but stops the cron spending past the global cap. (withinBudget inside
    // categoriseStatement is the per-submit backstop; this avoids even starting the work.)
    const globalCeiling = Number(env.MAX_DAILY_COST_CENTS_GLOBAL ?? 0);
    if (globalCeiling > 0 && (await spentTodayGlobalCents(env)) >= globalCeiling) {
      console.warn("skipping one-time backfills this tick — global daily AI ceiling already reached");
      return;
    }

    // One-time backfill: re-categorise data imported before the income/asset buckets existed, so
    // stranded credits get income buckets and capital purchases link to assets. Guarded per tenant
    // (claim-before-work, bounded attempts) so a transient failure can't loop it forever (C2).
    //
    // Iterate REAL tenants from `profiles` (like the weekly scan), NOT CLERK_ALLOWED_USERS: the
    // allow-list holds Clerk subject ids (e.g. user_3EX9…), but the founder's data lives under the
    // mapped tenant id "me" (see src/auth/clerk.ts). The earlier v1 backfill keyed off the Clerk id,
    // so its UPDATE matched 0 rows and silently no-op'd — hence the v2 flag key here.
    const tenants = await env.DB.prepare(`SELECT user_id FROM profiles`).all<{ user_id: string }>();
    for (const t of tenants.results ?? []) {
      try {
        await runOnceGuarded(env, `backfill:income-assets-v2:${t.user_id}`, 3, () =>
          stubFor(env, t.user_id).recategorise(t.user_id).then(() => undefined),
        );
      } catch (e) {
        console.error(`backfill recategorise failed for ${t.user_id}: ${(e as Error).message}`);
      }
    }

    // One-time statement repair: recover lines dropped by the old credit-card de-dup bug (re-import
    // from the stored R2 sidecar with the fixed fingerprint) and correct stale imported_count /
    // reconciled flags. Idempotent; claim-before-work guarded so it runs at most a few times.
    for (const t of tenants.results ?? []) {
      try {
        await runOnceGuarded(env, `repair:statements-v1:${t.user_id}`, 3, () =>
          stubFor(env, t.user_id).repairStatements(t.user_id).then(() => undefined),
        );
      } catch (e) {
        console.error(`statement repair failed for ${t.user_id}: ${(e as Error).message}`);
      }
    }
  },
} satisfies ExportedHandler<Env>;
