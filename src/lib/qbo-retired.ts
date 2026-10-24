import type { Env } from "../env";
import { featureOn } from "./features";

// QuickBooks is retired for now (owner decision 2026-10-24, map #692): connect isn't needed, and every QBO
// surface is hidden. Flag `qbo_retired` ON ⇒ every /api/qbo/* route, including the PUBLIC OAuth callback,
// answers 404 before it calls Intuit, reads the KV state nonce or touches qbo_connections. Stored tokens,
// qbo_feed accounts and ledger_refs are left as they are; account erasure (DELETE /api/account/data) still
// revokes at Intuit. OFF ⇒ the routes run exactly as before.

export const QBO_RETIRED_MESSAGE = "QuickBooks isn't available.";

export function qboRetired(env: Env): boolean {
  return featureOn(env, "qbo_retired");
}

/** The 404 every /api/qbo/* route returns while retired. JSON, so the SPA's api client reads `error`. */
export function qboRetiredResponse(): Response {
  return Response.json({ error: QBO_RETIRED_MESSAGE, code: "qbo_unavailable" }, { status: 404 });
}
