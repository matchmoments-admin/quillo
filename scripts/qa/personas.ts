// Life-situation personas (#699): seed each through the public API (exactly what the SPA's forms post),
// then confirm the result reaches the position API AND a page the persona can see. A missing UI path is a
// recorded GAP, not a failure — "engine ✓ + UI ✓ + display ✓" is the contract (CLAUDE.md).
import { apiCall, openPage, type Ctx } from "./harness";
import { visit } from "./journeys";

type Api = <T = unknown>(m: string, p: string, b?: unknown) => Promise<{ status: number; data: T }>;
const FY = "2025-26";
const FY_START = 2025;

export interface Persona {
  key: string;
  name: string;
  seed(api: Api): Promise<void>;
  /** What the position API must show once seeded. */
  expectReport(r: Report): string | null;
  /** Text the persona should be able to see on a page (route → regex). */
  expectUi: [string, RegExp][];
}
interface Report {
  total_income_cents: number;
  income: { by_type: { income_type: string; gross_cents: number }[] };
  per_property?: unknown[];
  by_property?: unknown[];
  company_positions?: unknown[];
  abn?: unknown;
}

const must = async <T>(p: Promise<{ status: number; data: T }>, what: string): Promise<T> => {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
  return r.data;
};
const consent = (api: Api) => must(api("POST", "/api/consent", { text: "QA persona consent", method: "web" }), "consent");
const selfId = async (api: Api) => {
  const s = await must(api<{ persons: { id: string; role: string }[] }>("GET", "/api/situation"), "situation");
  return s.persons.find((p) => p.role === "self")!.id;
};
const income = (api: Api, body: Record<string, unknown>) => must(api("POST", "/api/income", { fy: FY, txn_date: "2026-03-01", ...body }), `income ${body.income_type}`);
let dupRoleStatus = 0; // set by James's seed; checked in personaRun
const typeTotal = (r: Report, t: string) => r.income.by_type.filter((b) => b.income_type === t).reduce((s, b) => s + b.gross_cents, 0);

export const PERSONAS: Persona[] = [
  {
    key: "maya",
    name: "P1 Maya — PAYG renter",
    async seed(api) {
      await consent(api);
      await income(api, { income_type: "salary_payg", gross_cents: 8_000_000, withholding_cents: 1_500_000 });
    },
    expectReport: (r) => (typeTotal(r, "salary_payg") === 8_000_000 ? null : `salary_payg total ${typeTotal(r, "salary_payg")}`),
    expectUi: [["/reports", /80,000/], ["/lodge", /80,000/]],
  },
  {
    key: "susan-greg",
    name: "P6 Susan & Greg — co-owned landlords",
    async seed(api) {
      await consent(api);
      const me = await selfId(api);
      const greg = await must(api<{ id: string }>("POST", "/api/persons", { display_name: "Greg", role: "spouse" }), "person");
      const prop = await must(api<{ id: string }>("POST", "/api/properties", { label: "Unit 4 Rental", status: "rented", use_status: "rented", ownership_pct: 50, acquired_date: "2019-02-01" }), "property");
      await must(api("POST", "/api/property-owners", { property_id: prop.id, person_id: me, ownership_pct: 50 }), "owner self");
      await must(api("POST", "/api/property-owners", { property_id: prop.id, person_id: greg.id, ownership_pct: 50 }), "owner greg");
      await income(api, { income_type: "salary_payg", gross_cents: 13_000_000, withholding_cents: 3_000_000 });
      await income(api, { income_type: "rent", gross_cents: 3_000_000, property_id: prop.id });
    },
    expectReport: (r) => (typeTotal(r, "rent") > 0 ? ((r.per_property?.length ?? 0) + (r.by_property?.length ?? 0) > 0 ? null : "rent recorded but no per-property line") : "no rent income in the position"),
    expectUi: [["/reports", /Unit 4 Rental/], ["/lodge", /rent/i]],
  },
  {
    key: "priya",
    name: "P4 Priya — rideshare sole trader (ABN, GST)",
    async seed(api) {
      await consent(api);
      await must(api("POST", "/api/income-activities", { activity_type: "business", label: "Rideshare", fy: FY }), "activity");
      await must(api("POST", "/api/gst-registered", { registered: true }), "gst");
      await income(api, { income_type: "business", gross_cents: 4_500_000 });
    },
    expectReport: (r) => (typeTotal(r, "business") === 4_500_000 ? null : `business total ${typeTotal(r, "business")}`),
    expectUi: [["/reports", /45,000/], ["/lodge", /business|sole trader|ABN/i]],
  },
  {
    key: "james",
    name: "P8 James — company director",
    async seed(api) {
      await consent(api);
      const me = await selfId(api);
      const co = await must(api<{ id: string }>("POST", "/api/entities", { kind: "company", name: "James Holdings Pty Ltd" }), "company");
      // Creating a company already seeds the self → director role (addEntity). Posting it again is what a
      // double-submit does; it must be refused cleanly (4xx), never a 500.
      const dup = await api("POST", "/api/entity-roles", { person_id: me, entity_id: co.id, role: "director", ownership_pct: 100 });
      dupRoleStatus = dup.status;
      await income(api, { income_type: "salary_payg", gross_cents: 12_000_000, withholding_cents: 3_000_000 });
      await income(api, { income_type: "business", gross_cents: 25_000_000, entity_id: co.id });
    },
    expectReport: (r) => ((r.company_positions?.length ?? 0) > 0 ? null : "company income recorded but no company position"),
    // The /reports gap is #766: company_positions are computed but no SPA code renders them.
    expectUi: [["/reports", /James Holdings/], ["/settings", /James Holdings/]],
  },
];

export async function personaRun(ctx: Ctx, p: Persona) {
  const suite = `persona:${p.key}`;
  const api: Api = (m, path, b) => apiCall(ctx.base, m, path, b);
  if (ctx.vp === "desktop") {
    try {
      await p.seed(api);
      ctx.rec.pass(suite, "-", "seeded through the API");
      if (p.key === "james") ctx.rec.expect(suite, "-", "a duplicate entity role is refused with a 4xx, not a 500", dupRoleStatus >= 400 && dupRoleStatus < 500, `HTTP ${dupRoleStatus}`);
    } catch (e) {
      ctx.rec.fail(suite, "-", "seeded through the API", String((e as Error).message));
      return;
    }
    const r = await api<Report>("GET", `/api/report?fy=${FY_START}`);
    const problem = r.status !== 200 ? `HTTP ${r.status}` : p.expectReport(r.data);
    if (problem) ctx.rec.fail(suite, "-", "position API reflects the data", problem);
    else ctx.rec.pass(suite, "-", "position API reflects the data");
    const w = await api("GET", `/api/mytax-worksheet?fy=${FY_START}`);
    if (w.status === 200) ctx.rec.pass(suite, "-", "myTax worksheet builds");
    else ctx.rec.fail(suite, "-", "myTax worksheet builds", `HTTP ${w.status}`);
  }
  const { context, page, probe } = await openPage(ctx);
  for (const route of ["/", "/setup", "/connect", "/review", "/reports", "/lodge", "/settings"]) {
    const issue = await visit(page, probe, ctx.base, route, ctx.vp);
    if (issue) ctx.rec.fail(suite, ctx.vp, `${route} renders`, issue);
    else ctx.rec.pass(suite, ctx.vp, `${route} renders`);
  }
  for (const [route, re] of p.expectUi) {
    await visit(page, probe, ctx.base, route, ctx.vp);
    const text = await page.locator("body").innerText();
    if (re.test(text)) ctx.rec.pass(suite, ctx.vp, `sees their data on ${route}`);
    else ctx.rec.gap(suite, ctx.vp, `sees their data on ${route}`, `no ${re} on ${new URL(page.url()).pathname}`);
  }
  await context.close();
}
