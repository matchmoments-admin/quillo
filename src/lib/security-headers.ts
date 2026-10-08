// Security response headers + privacy-safe CSP-report summarising (#634, CDR Schedule 2 hardening).
//
// ONE source of truth for every header the app sends. Two delivery paths read it:
//   1. Worker-generated responses (API JSON, marketing/legal HTML, redirects, and the SPA shell when
//      the Worker hands "/" to ASSETS) go through `withSecurityHeaders` in src/index.ts.
//   2. Asset-served responses that never touch the Worker (every SPA deep link like /accounts —
//      only the paths in wrangler.toml `run_worker_first` hit the Worker — plus hashed JS/CSS/fonts)
//      get the same headers from `web/public/_headers`, which `renderHeadersFile()` generates.
//      scripts/check-units.ts fails if the committed file drifts from this module.
//
// CSP allowlist — audited against what the SPA + marketing pages actually load (build output +
// source, verified by a headless-Chrome cold load under `wrangler dev`):
//   - 'self'                         SPA bundle, /fonts/Geist*.woff2, /api, /csp-report
//   - fonts.googleapis.com / gstatic Anton + Inter (web/index.html, landing, legal)
//   - *.clerk.accounts.dev           Clerk DEV instance Frontend API (clerk-js script, XHR, avatars)
//   - *.clerk.com, img.clerk.com     Clerk-hosted assets / avatars
//   - *.quillo.au                    Clerk PRODUCTION Frontend API (clerk.quillo.au / clerk.app.quillo.au,
//                                    A5 / #638) — first-party, listed now so the prod-instance cutover
//                                    can't be broken by this policy
//   - clerk-telemetry.com            Clerk dev-instance telemetry beacon
//   - challenges.cloudflare.com      Turnstile (Clerk bot protection) — script + iframe
//   - www.google.com                 Maps embed iframe (Extras → PHI providers)
//   - images.unsplash.com            Marketing hero photo (quillo.au only)
//   - data: / blob:                  inline SVG noise texture; receipt/document previews + CSV/XLSX saves
// Stripe Checkout, Intuit, and the Fiskil/Basiq hosted-consent flows are TOP-LEVEL redirects
// (window.location / 302), which CSP does not govern — no entries needed.
//
// 'unsafe-inline' stays on script-src for now: Clerk's documented CSP requires it (absent a nonce),
// and an over-strict enforced policy locks users out of sign-in. The stricter REPORT-ONLY policy
// below drops it (the marketing page's inline script is allowed by hash) so the /csp-report sink
// tells us whether the tightening would break anything before we enforce it.

const CLERK = "https://*.clerk.accounts.dev https://*.clerk.com https://*.quillo.au";

function policy(scriptSrc: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    `img-src 'self' data: blob: https://img.clerk.com ${CLERK} https://images.unsplash.com`,
    `connect-src 'self' ${CLERK} https://clerk-telemetry.com`,
    "worker-src 'self' blob:",
    `frame-src 'self' ${CLERK} https://challenges.cloudflare.com https://www.google.com`,
    "form-action 'self'",
    "report-uri /csp-report",
  ].join("; ");
}

/** ENFORCED policy. */
export const CSP = policy(`'self' 'unsafe-inline' ${CLERK} https://challenges.cloudflare.com`);
/** sha256 of the marketing page's one inline <script> (src/marketing/landing.ts). check-units recomputes
 *  it from the page, so editing that script without updating this fails the suite rather than
 *  silently spamming /csp-report. */
export const LANDING_INLINE_SCRIPT_HASH = "'sha256-8woiXogcaygrxb6TawRP1g4tS7dJcuo1UCzSy8DZtHQ='";
/** Stricter REPORT-ONLY probe: identical except inline script is allowed only by hash (no
 *  'unsafe-inline'). Never blocks — it only reports, telling us whether the enforced policy can drop
 *  'unsafe-inline' later. */
export const CSP_REPORT_ONLY = policy(`'self' ${LANDING_INLINE_SCRIPT_HASH} ${CLERK} https://challenges.cloudflare.com`);

/** No `preload` — submitting the domain to the HSTS preload list is a separate owner decision. */
export const HSTS = "max-age=31536000; includeSubDomains";

/** Sent on EVERY response (HTML, API JSON, redirects, assets). */
// geolocation=(self): Extras → "providers near me" asks for the device location. Camera is NOT needed
// for receipt capture (an <input type=file capture> uses the OS picker, which Permissions-Policy
// doesn't govern).
export const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": HSTS,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(self), payment=(), usb=()",
};

/** Sent on HTML documents only (CSP is meaningless on JSON/JS and only bloats them). */
export const HTML_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CSP,
  "Content-Security-Policy-Report-Only": CSP_REPORT_ONLY,
};

/**
 * Attach the security headers to a Worker response. Headers are SET (not appended), so a response
 * that already carries them (e.g. ASSETS applying web/public/_headers) is not duplicated. A 101
 * WebSocket upgrade is returned untouched (its Response can't be re-wrapped).
 */
export function withSecurityHeaders(res: Response): Response {
  if (res.status === 101 || (res as Response & { webSocket?: unknown }).webSocket) return res;
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(BASE_SECURITY_HEADERS)) h.set(k, v);
  if ((h.get("content-type") ?? "").includes("text/html")) {
    for (const [k, v] of Object.entries(HTML_SECURITY_HEADERS)) h.set(k, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/**
 * Contents of web/public/_headers (Workers Static Assets header rules) for responses served
 * straight from ASSETS. The CSP rides on every asset path because the SPA fallback (deep links)
 * can be any path; on JS/CSS/font responses a CSP header is inert.
 */
export function renderHeadersFile(): string {
  const lines = [
    "# GENERATED from src/lib/security-headers.ts (renderHeadersFile) — do not edit by hand.",
    "# scripts/check-units.ts fails if this file drifts from the module.",
    "/*",
  ];
  for (const [k, v] of Object.entries({ ...BASE_SECURITY_HEADERS, ...HTML_SECURITY_HEADERS })) lines.push(`  ${k}: ${v}`);
  return lines.join("\n") + "\n";
}

const KEYWORD = /^[a-z][a-z0-9-]{0,39}$/;

/** Reduce a blocked-uri to something safe to log: an origin, or a CSP keyword (inline/eval/data/blob…). */
export function blockedOrigin(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") return "unknown";
  const s = raw.trim().toLowerCase();
  if (KEYWORD.test(s)) return s; // "inline", "eval", "self", "data", "blob", "wasm-eval", "trusted-types-sink"
  try {
    const u = new URL(raw);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "wss:" || u.protocol === "ws:") return u.origin;
    return u.protocol.replace(/:$/, "").slice(0, 20); // data:/blob:/chrome-extension: → scheme only
  } catch {
    return "unparseable";
  }
}

/**
 * Summarise a CSP violation report body (legacy `application/csp-report` or Reporting-API
 * `application/reports+json`) into `directive=… blocked=<origin|keyword> mode=…` lines — NEVER the
 * raw report, whose document-uri / blocked-uri / source-file / script-sample can carry full URLs,
 * query strings and page content (personal information). Returns [] for anything unrecognised.
 */
export function summariseCspReport(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const items: Array<Record<string, unknown>> = [];
  if (Array.isArray(parsed)) {
    for (const r of parsed.slice(0, 10)) {
      const b = (r as { body?: unknown })?.body;
      if (b && typeof b === "object") items.push(b as Record<string, unknown>);
    }
  } else if (parsed && typeof parsed === "object") {
    const b = (parsed as Record<string, unknown>)["csp-report"];
    if (b && typeof b === "object") items.push(b as Record<string, unknown>);
  }
  return items.map((r) => {
    const dirRaw = r["effective-directive"] ?? r["effectiveDirective"] ?? r["violated-directive"] ?? r["violatedDirective"];
    const dir = typeof dirRaw === "string" ? (dirRaw.trim().split(/\s+/)[0] ?? "").toLowerCase() : "";
    const directive = KEYWORD.test(dir) ? dir : "unknown";
    const blocked = blockedOrigin(r["blocked-uri"] ?? r["blockedURL"]);
    const dispRaw = r["disposition"];
    const mode = dispRaw === "report" || dispRaw === "enforce" ? dispRaw : "unknown";
    return `directive=${directive} blocked=${blocked} mode=${mode}`;
  });
}

/** Short, non-reversible tag for an identifier in logs (correlate lines without logging the id). */
export async function logTag(value: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(d).slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
}
