// The new-user journeys (#699). Each journey drives the real SPA (QA bundle) against the local Worker and
// records pass / fail / gap per check. A journey never throws: a step that blows up becomes a failed check
// and the journey carries on, so one defect doesn't hide the next.
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { apiCall, feedback, openPage, pageInvariants, settle, type Ctx } from "./harness";
import { QA_DIR, ROOT, defaultProvider, type QaServer } from "./server";

export const FIXTURE_CSV = path.join(ROOT, "evals", "statements", "westpac-sample.csv");

/** Every SPA route in docs/architecture/feature-inventory.md ("Every SPA route"), sign-in/up aside (Clerk widgets). */
export const ROUTES = [
  "/", "/start", "/inbox", "/transactions", "/transactions?view=review", "/dashboard", "/income", "/assets", "/documents",
  "/accounts", "/reconcile", "/notifications", "/settings", "/onboarding", "/quickbooks", "/reports", "/savings", "/extras",
  "/billing", "/filing", "/admin", "/admin/security", "/partner", "/setup", "/connect", "/review", "/review/match", "/lodge",
  "/lodge/print", "/about", "/bring-in", "/claims", "/records", "/check", "/check/match", "/ship",
  "/grow/property", "/grow/investments", "/grow/business", "/grow/assets", "/grow/integrations", "/grow/extras", "/grow/savings",
  "/grow/advisers", "/glossary",
];

/** The router's default 404 and Quillo's own not-found page. */
export const NOT_FOUND = /404 Not Found|That link doesn't go anywhere in Quillo/i;

/** A tagged check: `flags` are the journey flags this check is evidence for (the per-flag verdict). */
type Tag = { flags?: string[] };
export const flagTags = new Map<string, string[]>(); // "suite|check" → flags
const tag = (suite: string, check: string, t: Tag) => { if (t.flags?.length) flagTags.set(`${suite}|${check}`, t.flags); };

async function step(ctx: Ctx, suite: string, check: string, t: Tag, fn: () => Promise<string | null | undefined | void>) {
  tag(suite, check, t);
  try {
    const problem = await fn();
    if (problem) ctx.rec.fail(suite, ctx.vp, check, problem);
    else ctx.rec.pass(suite, ctx.vp, check);
  } catch (e) {
    ctx.rec.fail(suite, ctx.vp, check, `threw: ${String((e as Error).message ?? e).split("\n")[0]!.slice(0, 240)}`);
  }
}

/** Load one route and assert the page invariants + no console/page errors + no 5xx. */
export async function visit(page: Page, probe: { reset(): void; problems(): string[] }, base: string, route: string, vp: Ctx["vp"]): Promise<string | null> {
  probe.reset();
  const resp = await page.goto(base + route, { waitUntil: "domcontentloaded" });
  if (resp && resp.status() >= 500) return `HTTP ${resp.status()}`;
  await settle(page);
  const issues = [...(await pageInvariants(page, vp)), ...probe.problems()];
  return issues.length ? issues.join("; ") : null;
}

/** Route sweep: every inventory route loads cleanly. `label` distinguishes empty vs seeded vs flags-OFF runs. */
export async function routeSweep(ctx: Ctx, label: string, t: Tag = {}, opts: { expect404?: string[] } = {}) {
  const suite = `routes:${label}`;
  const { context, page, probe } = await openPage(ctx);
  for (const route of ROUTES) {
    await step(ctx, suite, route, t, async () => {
      if (opts.expect404?.includes(route)) {
        // A flag-gated public route with its flag OFF shows the router's 404 by design (e.g. /start).
        probe.reset();
        await page.goto(ctx.base + route, { waitUntil: "domcontentloaded" });
        await settle(page);
        const body = await page.locator("body").innerText();
        const shows404 = NOT_FOUND.test(body);
        return shows404 && probe.serverErrors.length === 0 ? null : `expected the flag-OFF 404 page; saw "${body.slice(0, 120).replace(/\s+/g, " ")}" (5xx: ${probe.serverErrors.join(", ") || "none"})`;
      }
      const p = await visit(page, probe, ctx.base, route, ctx.vp);
      const landed = new URL(page.url()).pathname + new URL(page.url()).search;
      return p ? `${p} (landed on ${landed})` : null;
    });
  }
  await context.close();
}

export interface SetupAnswers {
  residency: string;            // RESIDENCY_CHOICES label
  visa?: string;                // VISA_CHOICES label when not resident
  spouse: "Yes" | "No";
  state: string;                // e.g. "New South Wales"
  occupation: string;           // typed occupation
  ticks: string[];              // TICK_CHOICES labels
}

async function clickIfVisible(page: Page, name: RegExp | string, role: "button" | "link" = "button"): Promise<boolean> {
  const b = page.getByRole(role, { name, exact: typeof name === "string" }).first();
  if (await b.isVisible().catch(() => false)) { await b.click(); return true; }
  return false;
}

async function pressChip(page: Page, label: string) {
  const chip = page.locator("main").getByRole("button", { name: label, exact: true }).first();
  if ((await chip.getAttribute("aria-pressed")) !== "true") await chip.click();
}

/** Walk Get set up (intro → myTax check → consent → six questions → confirm → save). */
async function walkSetup(page: Page, a: SetupAnswers): Promise<string[]> {
  const seen: string[] = [];
  await clickIfVisible(page, "Start");
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(200);
    if (!new URL(page.url()).pathname.startsWith("/setup")) break;
    const main = page.locator("main");
    const text = await main.innerText();
    // The question title: the first line of main that isn't the step chrome.
    const h = text.split("\n").map((l) => l.trim()).filter((l) => l && !/current step|to do|^Step \d|^Why\?$|^Get set up$|^For FY/i.test(l)).slice(0, 2).join(" / ");
    seen.push(h.slice(0, 80));
    const chip = async (label: string) => (await main.getByRole("button", { name: label, exact: true }).count()) > 0;
    // myTax check: tick what's true (all three for the happy path).
    for (const cb of await main.getByRole("checkbox").all()) if (!(await cb.isChecked())) await cb.check();
    if (await clickIfVisible(page, "I consent")) await page.getByText(/consent.*(recorded|given)|Thanks/i).first().waitFor({ timeout: 5000 }).catch(() => {});
    // Screens are told apart by the chips they offer (headings are copy that changes).
    if (await chip(a.residency)) {
      await pressChip(page, a.residency);
      if (a.visa) await pressChip(page, a.visa);
    } else if (await chip("A job")) {
      for (const t of a.ticks) await pressChip(page, t);
    } else if (await chip(a.state)) {
      await pressChip(page, a.state);
    } else if (await page.locator("#about-occupation").isVisible().catch(() => false)) {
      if (!(await page.locator("#about-occupation").inputValue())) await page.locator("#about-occupation").fill(a.occupation);
    } else if (await chip(a.spouse)) {
      await pressChip(page, a.spouse);
    }
    const save = page.getByRole("button", { name: /^Save and /i }).first();
    if (await save.isVisible().catch(() => false)) {
      await save.click();
      await page.waitForURL((u) => !u.pathname.startsWith("/setup"), { timeout: 15_000 }).catch(() => {});
      break;
    }
    const next = page.getByRole("button", { name: "Next", exact: true }).first();
    if (await next.isVisible().catch(() => false)) {
      if (await next.isDisabled()) { seen.push(`BLOCKED at: ${h}`); break; }
      await next.click();
    } else if (!(await clickIfVisible(page, "Keep going"))) {
      seen.push(`no Next at: ${h}`);
      break;
    }
  }
  return seen;
}

function shiftedCsv(days: number): string {
  const lines = fs.readFileSync(FIXTURE_CSV, "utf8").trim().split("\n");
  return [lines[0], ...lines.slice(1).map((l) => {
    const [d, ...rest] = l.split(",");
    const [dd, mm, yyyy] = d!.split("/").map(Number);
    const dt = new Date(Date.UTC(yyyy!, mm! - 1, dd! + days));
    return [`${String(dt.getUTCDate()).padStart(2, "0")}/${String(dt.getUTCMonth() + 1).padStart(2, "0")}/${dt.getUTCFullYear()}`, ...rest].join(",");
  })].join("\n") + "\n";
}

export function writeFixtures(): Record<string, string> {
  const dir = path.join(QA_DIR, "fixtures");
  fs.mkdirSync(dir, { recursive: true });
  const f = {
    good: FIXTURE_CSV,
    second: path.join(dir, "westpac-next-fortnight.csv"),
    bad: path.join(dir, "not-a-statement.csv"),
    oversize: path.join(dir, "oversize-statement.csv"),
  };
  fs.writeFileSync(f.second, shiftedCsv(14));
  fs.writeFileSync(f.bad, "\u0000\u0001PK\u0003\u0004 this is not a bank statement ÿþ\n");
  // ~12 MB of plausible rows — bigger than any real personal statement export.
  const row = "02/05/2026,OFFICEWORKS 2099 SYDNEY PADDING PADDING PADDING PADDING,45.00,,955.00\n";
  fs.writeFileSync(f.oversize, "Date,Description,Debit,Credit,Balance\n" + row.repeat(Math.ceil((12 * 1024 * 1024) / row.length)));
  return f;
}

async function uploadStatement(page: Page, file: string, bankName?: string) {
  if (!(await page.getByRole("button", { name: /Choose a file/ }).isVisible().catch(() => false))) {
    await clickIfVisible(page, /^Upload a statement( instead)?$/);
  }
  const nameBox = page.getByPlaceholder("e.g. CommBank Everyday");
  if (bankName && (await nameBox.isVisible().catch(() => false))) await nameBox.fill(bankName);
  await page.locator('input[type="file"]').first().setInputFiles(file);
}

/** The first-timer journey: Before you start → Get set up → Connect → Review → Check → Position → Lodge. */
export async function firstTimerJourney(ctx: Ctx, server: QaServer, answers: SetupAnswers, fx: Record<string, string>) {
  const suite = "first-timer";
  const { context, page, probe } = await openPage(ctx);
  const api = <T = unknown>(m: string, p: string, b?: unknown) => apiCall<T>(ctx.base, m, p, b);

  await step(ctx, suite, "Before you start (/start) renders publicly", { flags: ["ft_journey"] }, async () => {
    const p = await visit(page, probe, ctx.base, "/start", ctx.vp);
    if (p) return p;
    const t = await page.locator("body").innerText();
    return /before you start/i.test(t) ? null : "no 'Before you start' heading";
  });

  await step(ctx, suite, "first run lands on Get set up", { flags: ["ft_journey"] }, async () => {
    // The first-run redirect fires ONCE per tenant (#765, ui_state.setup_started). The empty route sweep
    // runs on this same tenant first and uses it up, so clear the marker to test a true first visit.
    await api("PATCH", "/api/ui-state", { patch: { setup_started: false } });
    const p = await visit(page, probe, ctx.base, "/", ctx.vp);
    if (p) return p;
    await page.waitForURL(/\/setup/, { timeout: 8000 }).catch(() => {});
    const at = new URL(page.url()).pathname;
    if (at === "/setup") return null;
    const cta = await page.locator("main").getByRole("link", { name: /Get set up/i }).count() + await page.locator("main").getByRole("button", { name: /^Start/ }).count();
    return `a brand-new tenant landed on ${at}, not Get set up (Home ${cta ? "does" : "does NOT"} offer a way into it)`;
  });

  let seen: string[] = [];
  await step(ctx, suite, "Get set up: walk intro → consent → questions → save", { flags: ["ft_journey", "situation_profile"] }, async () => {
    probe.reset();
    if (new URL(page.url()).pathname !== "/setup") { await page.goto(ctx.base + "/setup"); await settle(page); }
    seen = await walkSetup(page, answers);
    await settle(page);
    const blocked = seen.find((s) => /BLOCKED|no Next/.test(s));
    if (blocked) return `${blocked} (screens: ${seen.join(" → ")})`;
    const path_ = new URL(page.url()).pathname;
    const issues = [...(await pageInvariants(page, ctx.vp)), ...probe.problems()];
    if (issues.length) return issues.join("; ");
    return path_ === "/connect" ? null : `after save landed on ${path_} (screens: ${seen.join(" → ")})`;
  });

  await step(ctx, suite, "setup recorded: consent (or AU processing) + dated situation periods", { flags: ["situation_profile"] }, async () => {
    const s = await api<{ profile?: { consent_xborder?: number; inference_provider?: string | null }; profile_periods?: unknown[] }>("GET", "/api/situation");
    // On Bedrock (AU) no cross-border consent is needed, so Get set up rightly skips the consent screen.
    const onAu = (s.data.profile?.inference_provider ?? defaultProvider()) === "bedrock";
    if (s.data.profile?.consent_xborder !== 1 && !onAu) return "consent_xborder not recorded on the US path";
    return (s.data.profile_periods?.length ?? 0) > 0 ? null : "no situation periods written";
  });

  await step(ctx, suite, "journey read model: setup no longer 'not_started'", { flags: ["ft_journey"] }, async () => {
    const j = await api<{ steps: { key: string; status: string }[] }>("GET", "/api/journey");
    const st = j.data.steps?.find((s) => s.key === "setup")?.status;
    return st && st !== "not_started" ? null : `setup status ${st}`;
  });

  // ── Connect: error paths, then the happy path ──
  await step(ctx, suite, "Connect renders (empty state)", { flags: ["ft_journey"] }, async () => visit(page, probe, ctx.base, "/connect", ctx.vp));

  await step(ctx, suite, "error path: zero credit → visible, accurate message", { flags: ["ft_journey"] }, async () => {
    await api("GET", "/api/billing"); // grants the one-off allowance, so the zero below is a real "spent it all"
    server.sql(`UPDATE profiles SET credit_balance_e4 = 0 WHERE user_id = 'me'`);
    probe.reset();
    let msg: string | null;
    try {
      await uploadStatement(page, fx.good!, "QA Bank");
      msg = await feedback(page, { text: /couldn't read|credit|paused|limit|top up/i });
    } finally {
      server.sql(`UPDATE profiles SET credit_balance_e4 = 50000000 WHERE user_id = 'me'`);
    }
    if (!msg) return "no visible feedback";
    if (probe.serverErrors.length) return `5xx: ${probe.serverErrors.join(", ")}`;
    return /credit|top up|billing/i.test(msg) ? null : `message doesn't mention credits: "${msg}"`;
  });

  await step(ctx, suite, "error path: bad file → visible error, no 5xx", { flags: ["ft_journey"] }, async () => {
    await page.reload(); await settle(page);
    probe.reset();
    await uploadStatement(page, fx.bad!, "QA Bank");
    const msg = await feedback(page, { text: /couldn't read|not|unrecognis|error|invalid/i });
    if (!msg) return "no visible feedback";
    return probe.serverErrors.length ? `5xx: ${probe.serverErrors.join(", ")}` : null;
  });

  await step(ctx, suite, "error path: oversize (12 MB) file → refused with feedback", { flags: ["ft_journey"] }, async () => {
    await page.reload(); await settle(page);
    probe.reset();
    const t0 = Date.now();
    await uploadStatement(page, fx.oversize!, "QA Bank");
    const msg = await feedback(page, { text: /couldn't read|too (big|large)|size|limit|Read\. Check it below/i, timeout: 60_000 });
    const secs = Math.round((Date.now() - t0) / 1000);
    if (!msg) return `no visible feedback after ${secs}s`;
    if (probe.serverErrors.length) return `5xx: ${probe.serverErrors.join(", ")}`;
    // Accepting a 12 MB statement is the defect: no size cap means unbounded parse work in the DO.
    return /Read\. Check it below/i.test(msg) ? `accepted a 12 MB file without a size limit (${secs}s)` : null;
  });

  // Clean up anything the oversize upload left so the happy path starts clear.
  {
    const st = await api<{ statements?: { id: string; filename?: string }[] } | { id: string; filename?: string }[]>("GET", "/api/statements");
    const list = Array.isArray(st.data) ? st.data : st.data.statements ?? [];
    for (const s of list) if (/oversize/.test(s.filename ?? "")) await api("DELETE", `/api/statements/${s.id}`);
  }

  await step(ctx, suite, "happy path: upload the CSV statement → 'Read' feedback", { flags: ["ft_journey"] }, async () => {
    await page.reload(); await settle(page);
    probe.reset();
    await uploadStatement(page, fx.good!, "QA Bank");
    const msg = await feedback(page, { text: /Read\. Check it below|already uploaded|couldn't read/i, timeout: 30_000 });
    if (!msg) return "no feedback";
    return /couldn't read/i.test(msg) ? `upload failed: ${msg}` : null;
  });

  await step(ctx, suite, "happy path: Import → 'Imported N lines' toast", { flags: ["ft_journey"] }, async () => {
    probe.reset();
    const btn = page.getByRole("button", { name: /^Import( anyway)?$/ }).first();
    await btn.waitFor({ timeout: 15_000 });
    await btn.click();
    const msg = await feedback(page, { text: /Imported|didn't go through/i, timeout: 30_000 });
    if (!msg) return "no feedback";
    if (/didn't go through/i.test(msg)) return msg;
    return probe.problems().length ? probe.problems().join("; ") : null;
  });

  await step(ctx, suite, "second fortnight imported (pay recurs ⇒ wages signal)", { flags: ["wages_payer"] }, async () => {
    await page.reload(); await settle(page);
    await uploadStatement(page, fx.second!);
    if (!(await feedback(page, { text: /Read\. Check it below/i, timeout: 30_000 }))) return "second upload not read";
    await page.getByRole("button", { name: /^Import( anyway)?$/ }).first().click();
    return (await feedback(page, { text: /Imported/i, timeout: 30_000 })) ? null : "second import gave no feedback";
  });

  await step(ctx, suite, "Connect after import: invariants hold", { flags: ["ft_journey"] }, async () => visit(page, probe, ctx.base, "/connect", ctx.vp));

  // ── Review / Check ──
  await step(ctx, suite, "Review queue renders with work to do", { flags: ["ft_journey", "relevance_scan", "wages_payer"] }, async () => {
    const p = await visit(page, probe, ctx.base, "/review", ctx.vp);
    if (p) return p;
    const t = await page.locator("main").innerText();
    return t.trim().length > 40 ? null : "review main is empty";
  });

  for (const [ep, flags] of [["/api/relevance?fy=2025", ["relevance_scan"]], ["/api/noticed?fy=2025", ["wages_payer"]], ["/api/reconcile/proposals?fy=2025", ["reconcile_proposals"]], ["/api/records?fy=2025", ["ft_journey"]], ["/api/data-retention", ["bank_minimisation"]]] as const) {
    await step(ctx, suite, `API ${ep} answers 200`, { flags: [...flags] }, async () => {
      const r = await api("GET", ep);
      return r.status === 200 ? null : `HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 160)}`;
    });
  }

  await step(ctx, suite, "wages: the recurring salary is noticed", { flags: ["wages_payer"] }, async () => {
    const r = await api<{ signals?: unknown[] }>("GET", "/api/noticed?fy=2025");
    const items = r.data.signals ?? [];
    return items.length > 0 ? null : `nothing noticed after two pay credits: ${JSON.stringify(r.data).slice(0, 200)}`;
  });

  await step(ctx, suite, "Review: one action gives visible feedback", { flags: ["ft_journey"] }, async () => {
    await visit(page, probe, ctx.base, "/review", ctx.vp);
    const main = page.locator("main");
    const candidates = main.getByRole("button", { name: /^(Yes|No|Not for work|Not work-related|For work|Confirm|Keep|Skip|It's my pay|Looks right|Dismiss)/i });
    if (!(await candidates.count())) return "no actionable card on the queue";
    const before = await main.innerText();
    probe.reset();
    await candidates.first().click();
    const fb = await feedback(page, { timeout: 6000 });
    await settle(page);
    const after = await main.innerText();
    if (probe.problems().length) return probe.problems().join("; ");
    return fb || after !== before ? null : "clicked an action but nothing visibly changed";
  });

  await step(ctx, suite, "Check (/review/match) renders", { flags: ["reconcile_proposals"] }, async () => visit(page, probe, ctx.base, "/review/match", ctx.vp));

  // ── Position ──
  await step(ctx, suite, "Position (/reports) renders, general-info framed, no refund figure", { flags: ["residency_assessability"] }, async () => {
    const p = await visit(page, probe, ctx.base, "/reports", ctx.vp);
    if (p) return p;
    const t = await page.locator("body").innerText();
    if (/refund of \$|your refund is|you will get back/i.test(t)) return "refund figure shown";
    return /general information/i.test(t) ? null : "no general-information framing on the position";
  });

  await step(ctx, suite, "API /api/report answers 200", { flags: ["residency_assessability"] }, async () => {
    const r = await api("GET", "/api/report?fy=2025");
    return r.status === 200 ? null : `HTTP ${r.status}`;
  });

  // ── Lodge ──
  await step(ctx, suite, "Lodge: myTax worksheet renders", { flags: ["mytax_worksheet", "ft_journey"] }, async () => {
    const p = await visit(page, probe, ctx.base, "/lodge", ctx.vp);
    if (p) return p;
    const t = await page.locator("main").innerText();
    return /myTax/i.test(t) && /worksheet|copy|type in|Personalise/i.test(t) ? null : "no worksheet content on /lodge";
  });

  // #790 the myTax mirror: one card per myTax screen, Copy gives visible feedback, a tick survives a reload.
  await step(ctx, suite, "Lodge: myTax mirror — screens, Copy feedback, tick persists", { flags: ["mytax_worksheet", "ft_journey"] }, async () => {
    const p = await visit(page, probe, ctx.base, "/lodge", ctx.vp);
    if (p) return p;
    const main = page.locator("main");
    if (!/myTax screens done/.test(await main.innerText())) return "no 'myTax screens done' progress on /lodge";
    if (!(await page.getByRole("heading", { name: "Contact details" }).first().isVisible().catch(() => false))) return "no Contact details screen card";
    const copy = page.getByRole("button", { name: /^Copy .*figure$/ }).first();
    if (await copy.isVisible().catch(() => false)) {
      await copy.click();
      const fed = await page.getByText(/^Copied$|Couldn't copy/).first().waitFor({ timeout: 3000 }).then(() => true, () => false);
      if (!fed) return "Copy gave no visible feedback";
    }
    const box = page.getByLabel("Done this screen in myTax").first();
    if (!(await box.isVisible().catch(() => false))) return "no screen tick on a notes-only screen";
    const was = await box.isChecked();
    const saved = page.waitForResponse((r) => r.url().includes("/api/ui-state") && r.request().method() === "PATCH", { timeout: 8000 });
    await box.click();
    await saved.catch(() => null);
    await page.reload({ waitUntil: "networkidle" });
    const after = page.getByLabel("Done this screen in myTax").first();
    await after.waitFor({ timeout: 8000 }).catch(() => null);
    const now = await after.isChecked().catch(() => was);
    if (now === was) return "the screen tick didn't survive a reload";
    await after.click(); // leave the tenant as it was
    return null;
  });

  await step(ctx, suite, "API /api/mytax-worksheet answers 200", { flags: ["mytax_worksheet"] }, async () => {
    const r = await api("GET", "/api/mytax-worksheet?fy=2025");
    return r.status === 200 ? null : `HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 160)}`;
  });

  await step(ctx, suite, "Lodge: print view renders", { flags: ["mytax_worksheet"] }, async () => visit(page, probe, ctx.base, "/lodge/print", ctx.vp));

  await step(ctx, suite, "Lodge: mark as lodged → confirmation shown", { flags: ["mytax_worksheet", "bank_minimisation"] }, async () => {
    await visit(page, probe, ctx.base, "/lodge", ctx.vp);
    const open = page.getByRole("button", { name: "I've lodged in myTax" }).first();
    if (!(await open.isVisible().catch(() => false))) return "no 'I've lodged in myTax' button";
    await open.click();
    probe.reset();
    await page.getByRole("button", { name: /Confirm: I've lodged/ }).click();
    const fb = await feedback(page, { text: /lodged on|marked|Undo lodged mark|Start next year/i });
    if (probe.problems().length) return probe.problems().join("; ");
    return fb ? null : "no confirmation after marking lodged";
  });

  // ── Ask / Guide (stubbed) ──
  await step(ctx, suite, "Ask (Why? drawer) returns the stubbed general-info answer", { flags: ["ft_journey"] }, async () => {
    await visit(page, probe, ctx.base, "/review", ctx.vp);
    await page.getByRole("button", { name: "Why?" }).first().click();
    const box = page.getByLabel("Ask Quillo a question about this");
    await box.waitFor({ timeout: 8000 });
    await box.fill("Can I claim my work laptop?");
    probe.reset();
    await box.press("Enter");
    const fb = await feedback(page, { text: /QA stub reply/i, timeout: 15_000 });
    if (probe.problems().length) return probe.problems().join("; ");
    return fb ? null : "stub answer never shown";
  });

  for (const [ep, body] of [["/api/guide", { tab: "review" }], ["/api/chat", { message: "What should I do next?" }]] as const) {
    await step(ctx, suite, `API ${ep} answers via the stub (no paid model)`, {}, async () => {
      const r = await api("POST", ep, body);
      return r.status === 200 ? null : `HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`;
    });
  }

  await step(ctx, suite, "nothing left localhost during the journey", {}, async () => {
    const off = probe.external.filter((u) => !/fonts\.(googleapis|gstatic)\.com/.test(u));
    return off.length ? off.slice(0, 5).join("; ") : null;
  });

  await context.close();
  return seen;
}

/** Billing: renders the wallet, no Stripe call; Settings → Privacy: consent, export, delete-account dry path. */
export async function accountJourneys(ctx: Ctx) {
  const { context, page, probe } = await openPage(ctx);
  const api = <T = unknown>(m: string, p: string, b?: unknown) => apiCall<T>(ctx.base, m, p, b);

  await step(ctx, "billing", "Billing renders the wallet balance", {}, async () => {
    const p = await visit(page, probe, ctx.base, "/billing", ctx.vp);
    if (p) return p;
    const t = await page.locator("main").innerText();
    return /AI credit balance/i.test(t) ? null : "no balance card";
  });
  await step(ctx, "billing", "top-up: unconfigured Stripe is explained, buttons disabled, no Stripe request", {}, async () => {
    const t = await page.locator("main").innerText();
    const btn = page.getByRole("button", { name: /^Add \$/ }).first();
    const disabled = await btn.isDisabled().catch(() => false);
    const stripe = probe.external.filter((u) => /stripe/i.test(u));
    if (stripe.length) return `Stripe request attempted: ${stripe[0]}`;
    if (!/aren't switched on yet/i.test(t)) return "no 'not switched on' explanation";
    return disabled ? null : "top-up button enabled without Stripe";
  });

  let usConsent = false;
  await step(ctx, "settings", "Settings renders Privacy (AU processing, or consent with withdraw offered)", {}, async () => {
    const p = await visit(page, probe, ctx.base, "/settings", ctx.vp);
    if (p) return p;
    usConsent = (await page.getByRole("button", { name: /Withdraw consent/ }).count()) > 0;
    if (usConsent) return null;
    return /Processed in Australia/i.test(await page.locator("main").innerText()) ? null : "neither AU processing nor a 'Withdraw consent' control shown";
  });
  await step(ctx, "settings", "withdraw consent: cancelling the confirm keeps consent", {}, async () => {
    if (!usConsent) return null; // AU processing: there is no cross-border consent to withdraw
    page.once("dialog", (d) => d.dismiss());
    await page.getByRole("button", { name: /Withdraw consent/ }).first().click();
    await page.waitForTimeout(800);
    const s = await api<{ profile?: { consent_xborder?: number } }>("GET", "/api/situation");
    return s.data.profile?.consent_xborder === 1 ? null : "consent was withdrawn after Cancel";
  });
  await step(ctx, "settings", "export my data downloads a JSON file", {}, async () => {
    const dl = page.waitForEvent("download", { timeout: 15_000 });
    await page.getByRole("button", { name: /Export my data/ }).first().click();
    const d = await dl;
    return /\.json$/.test(d.suggestedFilename()) ? null : `downloaded ${d.suggestedFilename()}`;
  });
  await step(ctx, "settings", "delete account: dismissing the DELETE prompt deletes nothing", {}, async () => {
    const before = await api<unknown>("GET", "/api/transactions");
    page.once("dialog", (d) => d.dismiss());
    await page.getByRole("button", { name: /Delete my account/ }).first().click();
    await page.waitForTimeout(1000);
    const after = await api<unknown>("GET", "/api/transactions");
    const s = await api<{ profile_periods?: unknown[] }>("GET", "/api/situation");
    if (JSON.stringify(before.data) !== JSON.stringify(after.data)) return "transactions changed after a dismissed delete";
    return (s.data.profile_periods?.length ?? 0) > 0 ? null : "profile reset after a dismissed delete";
  });
  await step(ctx, "settings", "delete account: a wrong confirmation word deletes nothing", {}, async () => {
    const before = await api<unknown>("GET", "/api/transactions");
    page.once("dialog", (d) => d.accept("delete please"));
    await page.getByRole("button", { name: /Delete my account/ }).first().click();
    await page.waitForTimeout(1000);
    const after = await api<unknown>("GET", "/api/transactions");
    return JSON.stringify(before.data) === JSON.stringify(after.data) ? null : "data changed after a wrong confirmation";
  });
  await context.close();
}
