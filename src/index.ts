import { routeAgentRequest } from "agents";
import type { Env, TaxAgentRpc } from "./env";
import { verifyIngest } from "./ingest/auth";
import { parseEmail } from "./lib/email";
import { userIdFromLocalpart } from "./lib/db";
import { requireClerk } from "./auth/clerk";
import { handleApi } from "./api";
import { handleCallback } from "./lib/qbo-oauth";
import { marketingResponse } from "./marketing/landing";
import { legalResponse } from "./marketing/legal";
import { handleWaitlist } from "./marketing/waitlist";

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

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true });
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
        const err = e as Error;
        console.error(`api error: ${req.method} ${url.pathname}: ${err?.stack ?? err?.message ?? err}`);
        return Response.json({ error: err?.message ?? "internal error" }, { status: 500 });
      }
    }

    // Agents SDK routes (/agents/*) + websocket upgrades.
    const agentRes = await routeAgentRequest(req, env, { cors: true });
    if (agentRes) return agentRes;

    // Static assets / SPA. Now that "/" is in run_worker_first, the Worker runs for
    // the app host's "/" too, so it must hand back to the assets binding (which honours
    // the single-page-application fallback to index.html).
    if (env.ASSETS) return env.ASSETS.fetch(req);
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
      const users = await env.DB.prepare(`SELECT user_id FROM profiles`).all<{ user_id: string }>();
      for (const u of users.results) {
        // Isolate per-tenant failures — one tenant's bad asset/data must not abort the sweep for all.
        try {
          const stub = stubFor(env, u.user_id);
          await stub.runProactiveScan(u.user_id);
          // Keep each tenant's depreciation_schedule materialised through the current FY (carry-forward).
          await stub.rollForward(u.user_id, fyStart);
        } catch (e) {
          console.error(`weekly cron failed for ${u.user_id}: ${(e as Error).message}`);
        }
      }
      return;
    }
    // Frequent: only users with a pending batch job (cheap query, no per-tenant fan-out).
    const pending = await env.DB.prepare(`SELECT DISTINCT user_id FROM batch_jobs WHERE status = 'submitted'`).all<{ user_id: string }>();
    for (const u of pending.results) await stubFor(env, u.user_id).pollBatchJobs(u.user_id);
  },
} satisfies ExportedHandler<Env>;
