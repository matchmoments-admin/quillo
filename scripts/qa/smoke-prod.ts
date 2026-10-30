#!/usr/bin/env tsx
// Read-only production smoke test (#699) — `npm run qa:smoke-prod`.
//
// GET https://app.quillo.au/healthz, then a cold load of `/` and `/start` in a fresh Chromium profile: the
// app shell and bundle load, `/start` renders, and there is no uncaught page error, console error or 5xx.
// It NEVER signs in and NEVER sends anything but GET: every non-GET request the page makes (Clerk's
// dev-browser handshake, the browser's own CSP reports) is aborted and listed, not failed — so `/` stops
// at the signed-out shell, which is all an anonymous visitor's cold load proves anyway.
// Override the origin with QA_PROD_ORIGIN (e.g. a preview deployment).
import { loadChromium } from "./harness";

const ORIGIN = (process.env.QA_PROD_ORIGIN ?? "https://app.quillo.au").replace(/\/$/, "");
let fail = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) console.log(`  ✓ ${name}`);
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log(`Prod smoke against ${ORIGIN} (read-only)`);
{
  const r = await fetch(`${ORIGIN}/healthz`, { method: "GET" });
  const body = await r.text();
  check("GET /healthz → 200 {ok:true}", r.status === 200 && /"ok":\s*true/.test(body), `${r.status} ${body.slice(0, 80)}`);
}

const chromium = loadChromium();
if (!chromium) {
  console.log("SKIP browser checks — playwright not resolvable.");
} else {
  const browser = await chromium.launch();
  try {
    for (const route of ["/", "/start"]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
      const blocked: string[] = [];
      // Read-only by construction: anything but GET/HEAD/OPTIONS is aborted before it leaves the browser.
      await context.route("**/*", (req) => {
        const m = req.request().method();
        if (m === "GET" || m === "HEAD" || m === "OPTIONS") return req.continue();
        blocked.push(`${m} ${req.request().url().slice(0, 100)}`);
        return req.abort();
      });
      const page = await context.newPage();
      const errors: string[] = [];
      const fivexx: string[] = [];
      // A request this script aborted logs a bare "net::ERR_FAILED"; that is our doing, not the page's.
      page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource: net::ERR_FAILED$/.test(m.text())) errors.push(m.text().slice(0, 200)); });
      let bundleOk = false;
      page.on("response", (r) => { if (/\/assets\/index-[^/]+\.js$/.test(new URL(r.url()).pathname) && r.status() === 200) bundleOk = true; });
      page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
      const clientErrors: string[] = [];
      page.on("response", (r) => {
        if (r.status() >= 500) fivexx.push(`${r.status()} ${r.url().slice(0, 100)}`);
        else if (r.status() >= 400) clientErrors.push(`${r.status()} ${r.url().replace(/\?.*/, "").slice(0, 100)}`);
      });
      const resp = await page.goto(ORIGIN + route, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(1000);
      const rendered = await page.evaluate("(() => { const r = document.getElementById('root'); return !!r && r.childElementCount > 0; })()");
      const landed = new URL(page.url()).pathname;
      check(`cold load ${route}: HTTP ${resp?.status()} → ${landed}, app bundle loaded`, (resp?.status() ?? 0) < 400 && bundleOk);
      // ft_journey OFF in prod: /api/public/before-you-start falls through to the Clerk gate (401) and /start
      // shows the router's 404 — by design (src/index.ts). Reported, not failed, until the flag flips.
      const startOff = route === "/start" && clientErrors.some((c) => /\/api\/public\/before-you-start$/.test(c)) &&
        /404 Not Found|That link doesn't go anywhere in Quillo/i.test(await page.locator("body").innerText());
      if (route === "/start") {
        if (startOff) console.log("    · /start: ft_journey is OFF in prod, so it shows the 404 page (expected until the flip)");
        else check("cold load /start: the public page rendered", rendered === true);
      }
      // Clerk's dev instance can't finish its handshake once we abort its POST, and it says so (a "Failed to
      // fetch" from clerk-js, then a 401 on its client read). That follows from read-only mode, not from the app.
      const clerkAborted = blocked.some((b) => /clerk\.accounts\.dev\/v1\/dev_browser/.test(b));
      const fromClerk = (e: string) => clerkAborted && (/clerk\.browser\.js|clerk/i.test(e) || /status of 401/.test(e) && clientErrors.every((c) => /clerk/.test(c)));
      const flagOff = (e: string) => startOff && (/default ErrorBoundary/.test(e) || /status of 401/.test(e));
      const real = errors.filter((e) => !fromClerk(e) && !flagOff(e));
      check(`cold load ${route}: no console/page errors`, real.length === 0, real.slice(0, 3).join(" | "));
      check(`cold load ${route}: no 5xx`, fivexx.length === 0, fivexx.join(", "));
      if (blocked.length) console.log(`    · aborted ${blocked.length} non-GET request(s) the page made: ${[...new Set(blocked.map((b) => b.replace(/\?.*/, "")))].join(", ")}`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
console.log(fail === 0 ? "\nprod smoke: PASS" : `\nprod smoke: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
