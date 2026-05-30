import { routeAgentRequest } from "agents";
import type { Env, TaxAgentRpc } from "./env";
import { verifyIngest } from "./ingest/auth";
import { parseEmail } from "./lib/email";
import { userIdFromLocalpart } from "./lib/db";

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

    // (a) Web upload + (c) iOS Shortcut + (d) Android app all POST signed bytes here.
    // Tenant identity is DERIVED from the verifying key — never a client header (B1).
    if (url.pathname === "/ingest" && req.method === "POST") {
      const body = await req.arrayBuffer(); // read ONCE (fixes §3 clone/re-read bug)
      const verified = await verifyIngest(env, req, body, Date.now());
      if (!verified) return new Response("unauthorized", { status: 401 });

      const source = req.headers.get("x-source") ?? "upload";
      const mime = req.headers.get("content-type") ?? "image/jpeg";
      const bucketHint = req.headers.get("x-bucket");
      const txnId = await stubFor(env, verified.userId).ingest(
        verified.userId,
        source,
        body,
        mime,
        bucketHint,
      );
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

    return (await routeAgentRequest(req, env, { cors: true })) ?? new Response("not found", { status: 404 });
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
    for (const att of parsed.attachments) {
      await stub.ingest(userId, "email", att.bytes, att.mime, null);
    }
  },

  // Cron — proactive suggestions for every tenant.
  async scheduled(_evt: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const users = await env.DB.prepare(`SELECT user_id FROM profiles`).all<{ user_id: string }>();
    for (const u of users.results) {
      await stubFor(env, u.user_id).runProactiveScan(u.user_id);
    }
  },
} satisfies ExportedHandler<Env>;
