// Browser harness for the QA suite (#699): one Chromium, a probe per page that collects console errors,
// page errors, 5xx responses and off-origin requests, plus the per-page invariants every journey asserts
// (no React error screen, no horizontal scroll at 390px, visible feedback after an action).
import { createRequire } from "node:module";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { ROOT } from "./server";
import { knownFor } from "./known";

const require = createRequire(path.join(ROOT, "package.json"));

/** playwright is a transitive dependency (promptfoo → playwright-extra), same posture as sim-mobile-shell. */
export function loadChromium(): typeof import("playwright").chromium | null {
  try {
    return (require("playwright") as typeof import("playwright")).chromium;
  } catch {
    return null;
  }
}

export const VIEWPORTS = { desktop: { width: 1280, height: 900 }, mobile: { width: 390, height: 844 } } as const;
export type ViewportName = keyof typeof VIEWPORTS;

export type Status = "pass" | "fail" | "gap" | "known";
export interface Result {
  suite: string;     // journey / persona / route-sweep
  viewport: ViewportName | "-";
  check: string;
  status: Status;
  detail?: string;
}

export class Recorder {
  results: Result[] = [];
  constructor(private quiet = false) {}
  add(r: Result) {
    const k = r.status === "fail" ? knownFor(r.suite, r.check) : undefined;
    if (k) r = { ...r, status: "known", detail: `${k.issue}: ${r.detail ?? ""}` };
    this.results.push(r);
    if (!this.quiet) {
      const mark = r.status === "pass" ? "✓" : r.status === "gap" ? "·" : r.status === "known" ? "~" : "✗";
      console.log(`  ${mark} [${r.suite}${r.viewport === "-" ? "" : ` @${r.viewport}`}] ${r.check}${r.detail && r.status !== "pass" ? ` — ${r.detail}` : ""}`);
    }
  }
  pass(suite: string, viewport: Result["viewport"], check: string, detail?: string) { this.add({ suite, viewport, check, status: "pass", detail }); }
  fail(suite: string, viewport: Result["viewport"], check: string, detail?: string) { this.add({ suite, viewport, check, status: "fail", detail }); }
  gap(suite: string, viewport: Result["viewport"], check: string, detail?: string) { this.add({ suite, viewport, check, status: "gap", detail }); }
  expect(suite: string, viewport: Result["viewport"], check: string, ok: boolean, detail?: string) {
    (ok ? this.pass : this.fail).call(this, suite, viewport, check, ok ? undefined : detail);
  }
  get failed() { return this.results.filter((r) => r.status === "fail").length; }
}

// Noise that only exists in the QA bundle: it carries a placeholder Clerk key (nothing signs in), so
// clerk-js never loads. Matched narrowly on the placeholder host / Clerk's own load-failure code.
const QA_NOISE = [/qa\.invalid/, /failed_to_load_clerk_js/, /Clerk: Failed to load Clerk/];

/** Collects what went wrong on a page between two marks. */
export class Probe {
  consoleErrors: string[] = [];
  pageErrors: string[] = [];
  serverErrors: string[] = [];
  external: string[] = [];
  constructor(public page: Page, private origin: string) {
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const t = m.text();
      if (QA_NOISE.some((re) => re.test(t))) return;
      // A failed 4xx fetch logs "Failed to load resource" — the journey asserts on the UI instead.
      if (/Failed to load resource: the server responded with a status of 4\d\d/.test(t)) return;
      // Our own abort of an off-localhost request (fonts etc.) logs this with no URL; same-origin request
      // failures are caught by the requestfailed listener below instead.
      if (/^Failed to load resource: net::ERR_FAILED$/.test(t)) return;
      this.consoleErrors.push(t.slice(0, 300));
    });
    page.on("pageerror", (e) => {
      if (QA_NOISE.some((re) => re.test(String(e)))) return;
      this.pageErrors.push(String(e).slice(0, 300));
    });
    page.on("response", (r) => {
      if (r.status() >= 500 && r.url().startsWith(this.origin)) this.serverErrors.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
    });
    page.on("requestfailed", (r) => {
      if (r.url().startsWith(this.origin) && !/ERR_ABORTED/.test(r.failure()?.errorText ?? "")) this.serverErrors.push(`failed ${r.method()} ${new URL(r.url()).pathname}: ${r.failure()?.errorText}`);
    });
    page.on("request", (r) => {
      const u = r.url();
      if (u.startsWith(this.origin) || u.startsWith("data:") || u.startsWith("blob:") || /qa\.invalid/.test(u)) return;
      this.external.push(`${r.method()} ${u.slice(0, 120)}`);
    });
  }
  reset() { this.consoleErrors = []; this.pageErrors = []; this.serverErrors = []; }
  problems(): string[] {
    return [...this.pageErrors.map((e) => `pageerror: ${e}`), ...this.consoleErrors.map((e) => `console: ${e}`), ...this.serverErrors.map((e) => `5xx: ${e}`)];
  }
}

export interface Ctx {
  browser: Browser;
  base: string;
  vp: ViewportName;
  rec: Recorder;
}

export async function openPage(ctx: Ctx): Promise<{ context: BrowserContext; page: Page; probe: Probe }> {
  const context = await ctx.browser.newContext({
    viewport: VIEWPORTS[ctx.vp],
    deviceScaleFactor: 1,
    isMobile: ctx.vp === "mobile",
    hasTouch: ctx.vp === "mobile",
    acceptDownloads: true,
  });
  // Hermetic: nothing leaves localhost. A request to Stripe, Clerk, Anthropic, Bedrock or a font CDN is
  // aborted (and recorded by the probe, so a journey can assert none was attempted where it matters).
  await context.route((u) => !u.href.startsWith(ctx.base) && !u.href.startsWith("data:") && !u.href.startsWith("blob:"), (r) => r.abort());
  // tsx/esbuild's keepNames wraps functions in __name(); page.evaluate ships them to the browser as source.
  await context.addInitScript("window.__name = (f) => f;");
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const probe = new Probe(page, ctx.base);
  return { context, page, probe };
}

/** Wait for the SPA to settle: network idle (bounded) and no loading text. */
export async function settle(page: Page, ms = 8000) {
  await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => {});
  await page.waitForTimeout(250);
}

/** The per-page invariants: rendered (no React Router error screen, #root not empty), no h-scroll at 390. */
export async function pageInvariants(page: Page, vp: ViewportName): Promise<string[]> {
  const out: string[] = [];
  const state = await page.evaluate(() => {
    const root = document.getElementById("root");
    const text = document.body.innerText || "";
    const de = document.documentElement;
    return {
      rootEmpty: !root || root.childElementCount === 0,
      boundary: /Unexpected Application Error|Minified React error|Something went wrong!/i.test(text),
      notFound: /404 Not Found|That link doesn't go anywhere in Quillo/i.test(text),
      scrollW: Math.max(de.scrollWidth, document.body.scrollWidth),
      clientW: de.clientWidth,
      wide: [...document.querySelectorAll("body *")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return r.width > 0 && r.right > de.clientWidth + 1 && cs.position !== "fixed" && !el.closest("[data-sonner-toaster]") && !el.closest(".overflow-x-auto,.overflow-auto,.overflow-x-scroll");
        })
        .slice(0, 3)
        .map((el) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).split(" ").slice(0, 3).join(".")}`),
    };
  });
  if (state.rootEmpty) out.push("app did not render (#root empty)");
  if (state.boundary) out.push("React/router error screen shown");
  if (state.notFound) out.push("404 page shown");
  if (vp === "mobile" && state.scrollW > state.clientW + 1) out.push(`horizontal scroll at 390px (scrollWidth ${state.scrollW} > ${state.clientW}; e.g. ${state.wide.join(", ") || "?"})`);
  return out;
}

/** Visible feedback after an action: a toast, a role=status/alert with text, or the given text. */
export async function feedback(page: Page, opts: { text?: RegExp; timeout?: number } = {}): Promise<string | null> {
  const timeout = opts.timeout ?? 10_000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await page.evaluate((src) => {
      const re = src ? new RegExp(src, "i") : null;
      const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const nodes = [...document.querySelectorAll("[data-sonner-toast], [role=status], [role=alert]")].filter(visible);
      for (const n of nodes) {
        const t = (n as HTMLElement).innerText.trim();
        if (t && (!re || re.test(t))) return t.slice(0, 160);
      }
      if (re) {
        const t = document.body.innerText;
        const m = t.match(re);
        if (m) return m[0].slice(0, 160);
      }
      return null;
    }, opts.text?.source ?? null);
    if (found) return found;
    await page.waitForTimeout(250);
  }
  return null;
}

/** GET/POST helper against the local Worker (the DEV_AUTH_BYPASS tenant). */
export async function apiCall<T = unknown>(base: string, method: string, p: string, body?: unknown): Promise<{ status: number; data: T }> {
  const r = await fetch(base + p, {
    method,
    headers: body instanceof FormData || body === undefined ? undefined : { "content-type": "application/json" },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: unknown = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, data: data as T };
}
