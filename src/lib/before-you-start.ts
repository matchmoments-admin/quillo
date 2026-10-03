import type { Env } from "../env";
import auV1RulePack from "../rulepacks/au-v1.json";
import { featureOn } from "./features";

/**
 * Public "Before you start" payload (spec docs/first-timer/spec.md A10, #584).
 *
 * The /start screen is the only SPA surface a signed-out visitor sees, so it cannot read the
 * feature list from an authenticated endpoint. This tiny public endpoint is its flag probe AND the
 * home of the jurisdiction's pack-driven slots. It returns static rule-pack content only — never
 * tenant data, never identity — so it is safe outside the Clerk gate.
 *
 * Flag OFF ⇒ src/index.ts doesn't intercept the path (it falls through to the Clerk gate exactly as
 * today), and the SPA route turns any non-OK answer into the same router 404 an unmatched URL
 * renders today (byte-identical OFF). The handler re-checks the flag as defence in depth.
 */
export interface BeforeYouStartPayload {
  /** Price/fit copy slot, owned by pricing ticket #523. null ⇒ the screen renders nothing for it. */
  price_line: string | null;
}

type PackShape = { before_you_start?: { price_line?: unknown } };

/** Pure: the payload from a rule pack. A missing block or a blank / non-string slot ⇒ null. */
export function beforeYouStartPayload(pack: PackShape | null | undefined): BeforeYouStartPayload {
  const raw = pack?.before_you_start?.price_line;
  const price = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
  return { price_line: price };
}

/** Rule pack the public screen (and #591 /api/education) reads: the KV override (pushed by `npm run rulepack:push`) shadows the bundled default, as everywhere else. */
export async function loadPack(env: Env): Promise<PackShape> {
  try {
    const override = await env.RULES.get("rulepack:au-v1", "json");
    if (override && typeof override === "object") return override as PackShape;
  } catch {
    /* KV unavailable ⇒ fall back to the bundled pack */
  }
  return auV1RulePack as PackShape;
}

/** GET /api/public/before-you-start — 404 when ft_journey is OFF (defence in depth; index.ts already gates). */
export async function handleBeforeYouStart(req: Request, env: Env): Promise<Response> {
  if (!featureOn(env, "ft_journey") || req.method !== "GET") return new Response("not found", { status: 404 });
  const body = beforeYouStartPayload(await loadPack(env));
  return Response.json(body, { headers: { "cache-control": "public, max-age=300" } });
}
