import type { Env } from "../env";
import { sha256hex } from "../lib/base64";

// Public, un-gated waitlist capture for the marketing apex (quillo.au). This is the
// landing page's secondary CTA. It never touches tenant data: one row per email in the
// `waitlist` table, no Access, no user_id. Abuse controls are deliberately light —
// a format check, DB-level dedupe, and a best-effort KV rate limit (the RULES KV is the
// same namespace the ingest nonce throttle uses; KV is eventually consistent, so this
// caps casual abuse rather than guaranteeing a hard limit).

const MAX_BODY_BYTES = 1024;
const PER_MIN_LIMIT = 5; // inserts/min/IP
const PER_DAY_LIMIT = 50; // coarse daily cap/IP (slow-flood guard)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const json = (status: number, body: Record<string, unknown>): Response =>
  Response.json(body, { status });

/** Best-effort fixed-window counter in KV. Returns true if the request is over `limit`. */
async function overLimit(env: Env, key: string, limit: number, ttl: number): Promise<boolean> {
  const current = Number((await env.RULES.get(key)) ?? 0);
  if (current >= limit) return true;
  await env.RULES.put(key, String(current + 1), { expirationTtl: ttl });
  return false;
}

export async function handleWaitlist(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  // Cap the body before reading it (cheap header check, then a hard slice on parse).
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return json(413, { ok: false, error: "too_large" });

  let email: string;
  let source: string | null = null;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { ok: false, error: "too_large" });
    const parsed = JSON.parse(raw) as { email?: unknown; source?: unknown };
    email = String(parsed.email ?? "").trim().toLowerCase();
    if (typeof parsed.source === "string") source = parsed.source.slice(0, 40);
  } catch {
    return json(400, { ok: false, error: "bad_request" });
  }

  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return json(400, { ok: false, error: "invalid_email" });
  }

  // Rate limit per hashed IP (raw IP is never stored or logged).
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const ipHash = await sha256hex(ip);
  // A coarse minute bucket keeps the window key stable without Date.now() arithmetic
  // leaking precision — KV TTL does the expiry.
  if (await overLimit(env, `wl:rl:min:${ipHash}`, PER_MIN_LIMIT, 60)) {
    return json(429, { ok: false, error: "rate_limited" });
  }
  if (await overLimit(env, `wl:rl:day:${ipHash}`, PER_DAY_LIMIT, 86_400)) {
    return json(429, { ok: false, error: "rate_limited" });
  }

  // DB-level dedupe via UNIQUE(email). We do NOT reveal whether the email already
  // existed (uniform success response prevents enumeration).
  await env.DB.prepare(
    `INSERT INTO waitlist (id, email, source, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email) DO NOTHING`,
  )
    .bind(
      crypto.randomUUID(),
      email,
      source,
      ipHash,
      (req.headers.get("user-agent") ?? "").slice(0, 256),
    )
    .run();

  return json(200, { ok: true });
}
