// ── The myTax self-lodge worksheet (#575, spec A9 ticket a; flag `mytax_worksheet`) ──────────────────────
// Quillo can't lodge for anyone (docs/first-timer/lodgement-routes.md: the ATO's only machine channel for an
// individual return accepts a registered tax agent alone), so the free "ship it" path is a worksheet the user
// types into myTax line by line. This module builds that worksheet's DATA; the Ship it page renders it
// (ticket b).
//
// Layout follows myTax's own order (rule pack `mytax_sections`; #590 re-ordered it to the ATO research in
// docs/first-timer/ato-lodgement-process.md §b): Contact and bank details → Personalise return (what to tick,
// built from the situation profile + the income on file) → Income (prefilled "check this matches", typed-in,
// rent, sole trader/business) → Deductions → Losses/offsets/adjustments → Medicare and private health →
// Spouse and income tests. Prefilled income becomes a short "check this matches" list; everything else is
// "type these in"; questions myTax asks are `answer` lines with no figure.
//
// PRESENTATION ONLY. Every figure is a re-grouping of rows buildReport and buildAccountantSchedule already
// produced (buildScheduleDetail exposes the schedule's own rows without building its sections), so nothing here can disagree
// with the report — and `tie_back` proves it per tenant. Work-related rows with no D-label are deliberately
// NOT given a line (guessing a label would be a customised judgement); they surface as the
// `worksheet_unlabelled` readiness finding until the user confirms a label.
//
// GENERAL INFORMATION ONLY. No refund, tax payable, offset, levy or rate is computed or returned — every
// amount is the user's own recorded assertion (TPB(GS) 14/2011: a non-customised software tool).

import type { Env } from "../env";
import auV1RulePack from "../rulepacks/au-v1.json";
import { featureOn } from "./features";
import { buildReport, resolveRulePack, refundNetting, type Report } from "./report";
import { buildScheduleDetail, atoReturnLabel, type ScheduleDetail } from "./accountant-schedule";
import { classifyAttribution, attributionCountsInPosition, isSoleTraderBusinessAttribution } from "./attribution";
import { resolveJurisdictionForUser, type JurisdictionDescriptor } from "./jurisdiction";
import { lodgementTiming, selfLodgeDueDate } from "./lodging-year";
import { profileForFy, type SituationProfile } from "./situation-profile";
import { occupationGuide } from "./occupations";
import { payerKey } from "./first-timer-signals";
import { confirmedPrefillSignals } from "./noticed-signals";
import { READINESS_DISCLAIMER } from "./readiness";
import { BUSINESS_INCOME_TYPES, RENT_INCOME_TYPES, isPropertyBucket } from "./taxonomy";
import { NON_RESIDENT_FOREIGN, NON_RESIDENT_FOREIGN_NOTE } from "./residency-assessability";

export type WorksheetLineKind = "check" | "type_in" | "answer" | "note";

export interface WorksheetLine {
  key: string; // stable within the section (drives tick persistence in ticket b)
  label: string; // the myTax item / label: "1", "5/6", "D5", "21", "P8", "M2"
  name: string; // plain-English name of the line
  amount_cents: number | null; // null ⇒ "not entered" (e.g. an employer with no income statement yet)
  kind: WorksheetLineKind; // check = prefilled, tick if it matches · type_in = enter it · answer = a question myTax asks · note = information only, nothing to enter (amount always null)
  record_href: string | null; // SPA link to the records behind the line
  note?: string;
}

export interface WorksheetSection {
  key: string;
  title: string;
  lines: WorksheetLine[];
}

export interface WorksheetTieBack {
  // Income: every income line (check + type-in + rental gross rent) sums to report.total_income_cents.
  income_check_total_cents: number;
  income_type_in_total_cents: number;
  rental_income_total_cents: number;
  report_income_cents: number;
  income_ok: boolean;
  // Deductions: D-lines + unlabelled + rental + business expenses — each ALREADY net of the refunds matched to
  // its expenses — recomputed with the report's own formula (max(0, gross − refunds) + work-method deductions)
  // equals report.total_deductions_cents.
  deduction_lines_total_cents: number;
  unlabelled_cents: number;
  rental_deductions_total_cents: number;
  business_expenses_total_cents: number;
  netted_credits_cents: number; // report.refunds_cents (purchase refunds netted against deductions) — named so no worksheet field reads as a tax refund
  netted_credits_unplaced_cents: number; // the part whose matched expense isn't itemised on any line (0 in practice) — subtracted in the total, never dropped
  deductions_total_cents: number;
  report_deductions_cents: number;
  deductions_ok: boolean;
  // Decline in value: work-asset line + per-property lines equal report.depreciation_cents.
  depreciation_total_cents: number;
  report_depreciation_cents: number;
  depreciation_ok: boolean;
  ok: boolean;
}

export interface WorksheetHeader {
  prefill_ready_hint: string;
  self_lodge_due: string;
  intro: string;
  /** #590: the self-lodger due date for this FY (ISO), so the page can switch to after_due_note on the user's LOCAL day. */
  self_lodge_due_on: string;
  /** #590: quoted ATO information once the due date has passed — never a promise. */
  after_due_note: string;
  /** #590: "contact them before <due>" — a registered agent's lodgment program needs you on their books by then. */
  agent_note: string;
  /** #590 (ato §b row 10): a residency period that ends before the FY does (leaving Australia) ⇒ early-lodgment note; else null. */
  early_lodge_note: string | null;
  /** #590 (ato §b rows 25, 27, 28): after-lodging timing, quoted from the pack. */
  processing_hint: string;
  amend_window: string;
  records_keep: string;
}

export interface MytaxWorksheet {
  fy: string;
  header: WorksheetHeader;
  sections: WorksheetSection[];
  unlabelled: { n: number; cents: number }; // counted work-related rows with no D-label (⇒ worksheet_unlabelled)
  tie_back: WorksheetTieBack;
  disclaimer: string;
}

// ── Rule-pack content ───────────────────────────────────────────────────────────────────────────────────

interface IncomeItem {
  item: string;
  name: string;
  prefilled: boolean;
}
interface PackLine {
  key: string;
  label: string;
  name: string;
  note: string;
  when?: string; // medicare/spouse: "non_resident_period" | "spouse" — absent ⇒ always
  kind?: "answer" | "note";
}
interface PersonaliseItem {
  key: string;
  name: string;
  income_types: string[];
  employers?: boolean; // an employer on file (no statement yet) also means this tick
  profile?: "abn" | "foreign_income" | "whm";
  deductions?: boolean;
}
interface MytaxPack {
  lodgement: {
    prefill_ready_hint: string;
    self_lodge_due: string;
    employer_finalise_by: string;
    tax_ready_chase_after: string;
    after_due_note: string;
    processing_hint: string;
    amend_window: string;
    records_keep: string;
    phi_report_by: string;
  };
  mytax_sections: { key: string; title: string }[];
  mytax_income_items: Record<string, IncomeItem>; // key order = myTax's Income banner order
  mytax_deduction_labels: Record<string, string>; // key order = the order myTax lists them
  mytax_work_method_labels: { wfh: string; car: string };
  mytax_decline_in_value_label: string;
  mytax_medicare_lines: PackLine[];
  mytax_contact_lines: PackLine[];
  mytax_spouse_lines: PackLine[];
  mytax_personalise_items: PersonaliseItem[];
}

/** What the worksheet knows about the person (#590) — read only for the full worksheet, never the readiness signal. */
export interface WorksheetContext {
  /** The occupation where they earned most (persons.occupation, else the profile's longest job), as a display label. */
  occupation: string | null;
  /** The self person's situation profile for the FY (situation_profile ON), else null. */
  profile: SituationProfile | null;
  /** The self-lodger due date for the FY (ISO). */
  dueOn: string;
}

/**
 * The worksheet's pack content. The tenant's pack (KV override first) wins key by key; the bundled pack fills
 * any key a KV pack pushed before #575 doesn't carry yet — so the endpoint works the moment it deploys, before
 * `npm run rulepack:push`.
 */
export function mytaxPackContent(pack: unknown): MytaxPack {
  const p = (pack ?? {}) as Partial<MytaxPack>;
  const b = auV1RulePack as unknown as MytaxPack;
  const arr = <T,>(v: T[] | undefined, fb: T[]): T[] => (Array.isArray(v) ? v : fb);
  // A KV pack pushed before #590 has the old section order (no Personalise) and managed funds as a type-in. Its
  // sections + income items would silently drop the new sections, so until `rulepack:push` lands the bundled
  // order and item map stand in for it. A KV pack that carries `personalise` is #590-aware and wins outright.
  const pre590 = Array.isArray(p.mytax_sections) && p.mytax_sections.length > 0 && !p.mytax_sections.some((x) => x?.key === "personalise");
  return {
    // Key by key: a KV pack pushed before #590 carries the timing keys but not the after-lodging ones.
    lodgement: p.lodgement?.prefill_ready_hint && p.lodgement?.self_lodge_due ? { ...b.lodgement, ...p.lodgement } : b.lodgement,
    mytax_sections: Array.isArray(p.mytax_sections) && p.mytax_sections.length && !pre590 ? p.mytax_sections : b.mytax_sections,
    mytax_income_items: p.mytax_income_items && !pre590 ? p.mytax_income_items : b.mytax_income_items,
    mytax_deduction_labels: p.mytax_deduction_labels ?? b.mytax_deduction_labels,
    mytax_work_method_labels: p.mytax_work_method_labels?.wfh && p.mytax_work_method_labels?.car ? p.mytax_work_method_labels : b.mytax_work_method_labels,
    mytax_decline_in_value_label: p.mytax_decline_in_value_label ?? b.mytax_decline_in_value_label,
    mytax_medicare_lines: arr(p.mytax_medicare_lines, b.mytax_medicare_lines),
    mytax_contact_lines: arr(p.mytax_contact_lines, b.mytax_contact_lines),
    mytax_spouse_lines: arr(p.mytax_spouse_lines, b.mytax_spouse_lines),
    mytax_personalise_items: arr(p.mytax_personalise_items, b.mytax_personalise_items),
  };
}

// ── Pure helpers (unit-tested in scripts/check-units.ts) ──────────────────────────────────────────────

/** Order D-labels the way myTax lists them: by the first label number (D1 … D10), then lexically. */
export function compareDeductionLabels(a: string, b: string): number {
  const n = (s: string) => {
    const m = /^D(\d+)/.exec(s);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  return n(a) - n(b) || a.localeCompare(b);
}

const UNLABELLED = atoReturnLabel(null); // "Work-related (confirm label)" — the schedule's placeholder

const money = (c: number) => `$${(c / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function employerOf(detail_json: string | null): string | null {
  if (!detail_json) return null;
  try {
    const e = (JSON.parse(detail_json) as { employer?: unknown }).employer;
    return typeof e === "string" && e.trim() ? e.trim() : null;
  } catch {
    return null;
  }
}

// ── The builder ───────────────────────────────────────────────────────────────────────────────────────

export async function buildMytaxWorksheet(env: Env, userId: string, startYear: number, opts?: { report?: Report; signalOnly?: boolean }): Promise<MytaxWorksheet> {
  const report = opts?.report ?? (await buildReport(env, userId, startYear));
  // Independent reads — resolve concurrently (the schedule rows dominate). #590: the detail-only schedule build
  // skips every read that feeds a schedule section alone (the worksheet never reads the sections).
  const excludeNonDeductible = featureOn(env, "position_excludes_nondeductible");
  const jurisdictionP = resolveJurisdictionForUser(env, userId);
  const [detail, [descriptor, rawPack], employerEntities, refunds, noticed, ctxPart] = await Promise.all([
    buildScheduleDetail(env, userId, startYear, { report }),
    jurisdictionP.then(async (j) => [j, await resolveRulePack(env, userId, j)] as const),
    // The readiness signal reads only `unlabelled`, which employer lines never touch — skip the read there.
    opts?.signalOnly ? Promise.resolve([] as string[]) : employmentEntityNames(env, userId),
    // The SAME per-expense netting buildReport ran (report.start/end are its bounds), so each refund can be
    // netted on the line its expense lands on.
    featureOn(env, "refund_netting") ? refundNetting(env, userId, report.start, report.end, excludeNonDeductible).then((r) => r.netted) : Promise.resolve(new Map<string, number>()),
    // #577 wages_payer: confirmed government / interest "We noticed" signals ⇒ a "check this matches" line.
    // Flag OFF ⇒ [] (no read) ⇒ worksheet byte-identical.
    opts?.signalOnly ? Promise.resolve([] as { kind: string; label: string; income_type: string }[]) : confirmedPrefillSignals(env, userId, startYear),
    // #590: who the person is (occupation, residency dates, spouse, WHM) — the Personalise / Medicare / spouse
    // answer lines. The readiness signal reads only `unlabelled`, so it skips these reads.
    opts?.signalOnly ? Promise.resolve(null) : jurisdictionP.then((j) => personContext(env, userId, startYear, j)),
  ]);
  const pack = mytaxPackContent(rawPack);
  const ctx: WorksheetContext = { occupation: ctxPart?.occupation ?? null, profile: ctxPart?.profile ?? null, dueOn: selfLodgeDueDate(startYear, descriptor, lodgementTiming(rawPack)) };
  return assembleWorksheet(report, detail, pack, employerEntities, excludeNonDeductible, new Map(refunds), noticed, ctx);
}

/** The self person's occupation + situation profile for the FY. The profile is read only with situation_profile ON. */
async function personContext(env: Env, userId: string, startYear: number, descriptor: JurisdictionDescriptor): Promise<{ occupation: string | null; profile: SituationProfile | null }> {
  const [occ, profiles] = await Promise.all([
    env.DB.prepare(`SELECT id, occupation FROM persons WHERE user_id = ? AND role = 'self' ORDER BY created_at LIMIT 1`).bind(userId).first<{ id: string; occupation: string | null }>()
      .catch((e: Error) => { if (/no such table|no such column/i.test(e.message)) return null; throw e; }),
    featureOn(env, "situation_profile") ? profileForFy(env, userId, startYear, descriptor) : Promise.resolve([] as SituationProfile[]),
  ]);
  // Only the SELF person's profile (profileForFy sorts self first, but an account with no self person must not
  // answer Personalise from someone else's periods).
  const profile = profiles.find((p) => !!occ && p.person_id === occ.id) ?? null;
  // The FY's own job (from the profile) first: persons.occupation mirrors only the most recent year.
  return { occupation: occupationDisplay(null, profile) ?? occupationDisplay(occ?.occupation ?? null, null), profile };
}

/** A display label for the occupation token (pack guide label, else the token in words). Exported for units. */
export function occupationDisplay(token: string | null, profile: SituationProfile | null): string | null {
  let t = token?.trim() || null;
  if (!t && profile?.jobs.length) {
    // The job held longest in the FY stands in for "where you earned most" — the user confirms it in myTax.
    const days = (j: { starts_on: string; ends_on: string }) => Date.parse(j.ends_on) - Date.parse(j.starts_on);
    t = [...profile.jobs].sort((a, b) => days(b) - days(a))[0]?.occupation_token ?? null;
  }
  if (!t) return null;
  return occupationGuide(t)?.label ?? t.replace(/_/g, " ");
}

/** Employer entities from About you / situation (kind 'employment'), so an employer with no income row yet still gets a line. */
async function employmentEntityNames(env: Env, userId: string): Promise<string[]> {
  try {
    const rows = (await env.DB.prepare(
      `SELECT name FROM entities WHERE user_id = ? AND (kind = 'employment' OR entity_type = 'payg_employment') AND name IS NOT NULL ORDER BY created_at`,
    ).bind(userId).all<{ name: string }>()).results ?? [];
    return rows.map((r) => r.name);
  } catch (e) {
    if (/no such table|no such column/i.test((e as Error).message)) return [];
    throw e;
  }
}

const NO_CONTEXT: WorksheetContext = { occupation: null, profile: null, dueOn: "" };

const PAYER_STILL_WRONG = "If it still doesn't match, contact the employer or payer so they correct it with the ATO (changing a prefilled figure in myTax can lead to an ATO query).";
const EMPLOYER_ABN = "myTax will ask for the employer's ABN (it's on your payslip or income statement).";

/** Residency types that are not an ordinary resident period — the Medicare exemption / entitlement questions. */
const NON_ORDINARY_RESIDENCY = new Set(["temporary", "foreign", "whm"]);
const RESIDENCY_WORDS: Record<string, string> = { resident: "Australian resident", temporary: "temporary resident", foreign: "foreign resident", whm: "working holiday maker", unsure: "not sure" };

// Fixed formatting (not toLocaleDateString: ICU builds differ, and the worksheet must be byte-stable).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : iso;
};

function assembleWorksheet(report: Report, detail: ScheduleDetail, pack: MytaxPack, employerEntities: string[], excludeNonDeductible: boolean, netted: Map<string, number>, noticed: { kind: string; label: string; income_type: string }[] = [], ctx: WorksheetContext = NO_CONTEXT): MytaxWorksheet {
  const items = pack.mytax_income_items;
  const itemFor = (t: string): IncomeItem => items[t] ?? { item: items.other?.item ?? "24", name: t.replace(/_/g, " "), prefilled: false };
  const byType = new Map(report.income.by_type.map((r) => [r.income_type, r]));

  // ── 1. Income: check this matches (prefilled in myTax) ────────────────────────────────────────────
  const check: WorksheetLine[] = [];
  const salary = byType.get("salary_payg");
  if (salary && items.salary_payg?.prefilled !== false) {
    // One line per employer (payerKey merges name variants). Only when the per-employer rows reconcile to the
    // report's salary total; otherwise one line, so the worksheet can never disagree with the report.
    const groups = new Map<string, { name: string; cents: number }>();
    for (const r of detail.income.filter((x) => x.income_type === "salary_payg")) {
      const name = employerOf(r.detail_json);
      const key = payerKey(name) || "(not named)";
      const g = groups.get(key) ?? { name: name ?? "Employer not named", cents: 0 };
      g.cents += r.gross_cents;
      groups.set(key, g);
    }
    // Hand-keyed salary rows carry no employer name. With exactly one unmatched employer on file, the unnamed
    // salary is that employer's — never show it as "not named" beside a "not entered" line for the same job.
    const unnamed = groups.get("(not named)");
    const unmatchedEmployers = employerEntities.filter((n) => payerKey(n) && !groups.has(payerKey(n)));
    if (unnamed && unmatchedEmployers.length === 1) {
      const name = unmatchedEmployers[0] as string;
      groups.delete("(not named)");
      groups.set(payerKey(name), { name, cents: unnamed.cents });
    }
    const reconciles = [...groups.values()].reduce((s, g) => s + g.cents, 0) === salary.gross_cents;
    const withheld = salary.withholding_cents > 0 ? ` Tax withheld you recorded across all employers: ${money(salary.withholding_cents)}.` : "";
    if (reconciles && groups.size > 0) {
      let i = 0;
      for (const [key, g] of groups) {
        check.push({ key: `salary:${key}`, label: itemFor("salary_payg").item, name: `${itemFor("salary_payg").name} — ${g.name}`, amount_cents: g.cents, kind: "check",
          record_href: "/income?type=salary_payg",
          note: `myTax prefills this from your employer's income statement. Tick it when myTax shows the same gross amount; if it doesn't, check the income statement says "Tax ready" in myGov. ${PAYER_STILL_WRONG}${i++ === 0 ? withheld : ""}` });
      }
    } else {
      check.push({ key: "salary", label: itemFor("salary_payg").item, name: itemFor("salary_payg").name, amount_cents: salary.gross_cents, kind: "check", record_href: "/income?type=salary_payg",
        note: `myTax prefills this from your employers' income statements. Tick it when myTax shows the same total; if it doesn't, check each income statement says "Tax ready" in myGov. ${PAYER_STILL_WRONG}${withheld}` });
    }
    // An employer you told us about with no income recorded: the commonest first-timer miss.
    for (const name of employerEntities) {
      const key = payerKey(name);
      if (!key || groups.has(key)) continue;
      groups.set(key, { name, cents: 0 });
      check.push({ key: `salary:${key}`, label: itemFor("salary_payg").item, name: `${itemFor("salary_payg").name} — ${name}`, amount_cents: null, kind: "check", record_href: "/income?type=salary_payg",
        note: `Not entered — add your income statement from this employer. myTax should show it once the employer marks it "Tax ready". If it hasn't prefilled, ${EMPLOYER_ABN}` });
    }
  } else {
    for (const name of employerEntities) {
      const key = payerKey(name);
      if (!key || check.some((l) => l.key === `salary:${key}`)) continue;
      check.push({ key: `salary:${key}`, label: itemFor("salary_payg").item, name: `${itemFor("salary_payg").name} — ${name}`, amount_cents: null, kind: "check", record_href: "/income?type=salary_payg",
        note: `Not entered — add your income statement from this employer. myTax should show it once the employer marks it "Tax ready". If it hasn't prefilled, ${EMPLOYER_ABN}` });
    }
  }
  for (const [t, it] of Object.entries(items)) {
    if (t === "salary_payg" || !it.prefilled) continue;
    const r = byType.get(t);
    if (!r || r.gross_cents === 0) continue;
    const credit = t === "dividend" && r.franking_credit_cents > 0 ? ` Franking credits you recorded: ${money(r.franking_credit_cents)}.`
      : r.withholding_cents > 0 ? ` Tax withheld you recorded: ${money(r.withholding_cents)}.` : "";
    check.push({ key: t, label: it.item, name: it.name, amount_cents: r.gross_cents, kind: "check", record_href: `/income?type=${t}`,
      note: `myTax usually prefills this. Tick it when myTax shows the same amount; if it doesn't, check which statement is missing. ${PAYER_STILL_WRONG}${credit}` });
  }
  // #577: a payer the user confirmed from bank credits ("Payments from Services Australia", "Interest from ING")
  // with no income of that type recorded: a "not entered" check line, never a figure from the bank credits.
  for (const n of noticed) {
    const r = byType.get(n.income_type);
    if (r && r.gross_cents !== 0) continue; // already recorded ⇒ the line above covers it
    const it = itemFor(n.income_type);
    const key = `noticed:${n.kind}:${payerKey(n.label) || n.kind}`;
    if (check.some((l) => l.key === key)) continue;
    check.push({ key, label: it.item, name: `${it.name} — ${n.label}`, amount_cents: null, kind: "check", record_href: `/income?type=${n.income_type}`,
      note: `Your bank shows payments from ${n.label}. myTax usually prefills these: check this matches what myTax shows, or add it on the Income page. Quillo doesn't count the bank deposits themselves.` });
  }

  // #590 (ato §b row 17): the salary banner asks the occupation where you earned most. An answer line, never a figure.
  if (check.some((l) => l.key === "salary" || l.key.startsWith("salary:"))) {
    const idx = check.findIndex((l) => l.key === "salary" || l.key.startsWith("salary:"));
    check.splice(idx, 0, { key: "occupation", label: itemFor("salary_payg").item, name: "Occupation where you earned most of your income", amount_cents: null, kind: "answer", record_href: "/about",
      note: ctx.occupation ? `You told Quillo: ${ctx.occupation}. myTax asks this on the salary and wages banner.` : "myTax asks this on the salary and wages banner. Tell Quillo your job in About you so it's here for you." });
  }

  // ── 2. Income: type these in (not prefilled) ──────────────────────────────────────────────────────
  // Rent linked to a property lives in the rental section (item 21, per property); only rent NOT linked to a
  // property shows here, so no dollar appears twice.
  const typeIn: WorksheetLine[] = [];
  // Rent per property from the schedule's own income rows — already scoped like the report's income
  // (separate-taxpayer entity rent excluded) and filtered to AUD-converted rows the way incomeTotals is. NOT
  // per_property.income_cents, whose query has neither filter, so it can carry a trust's rent or raw
  // foreign cents the report never counts.
  const rentByProp = new Map<string, number>();
  for (const r of detail.income) {
    if (!RENT_INCOME_TYPES.has(r.income_type) || !r.property_id || r.fx_unconverted) continue;
    rentByProp.set(r.property_id, (rentByProp.get(r.property_id) ?? 0) + r.gross_cents);
  }
  let rentUnlinked = -[...rentByProp.values()].reduce((s, c) => s + c, 0);
  for (const r of report.income.by_type) {
    if (r.income_type === "salary_payg" || items[r.income_type]?.prefilled) continue;
    if (RENT_INCOME_TYPES.has(r.income_type)) {
      rentUnlinked += r.gross_cents;
      continue;
    }
    if (r.gross_cents === 0) continue;
    const it = itemFor(r.income_type);
    const foreignTax = r.foreign_tax_paid_cents > 0 ? ` Foreign tax paid you recorded: ${money(r.foreign_tax_paid_cents)}.` : "";
    typeIn.push({ key: r.income_type, label: it.item, name: it.name, amount_cents: r.gross_cents, kind: "type_in", record_href: `/income?type=${r.income_type}`,
      note: (BUSINESS_INCOME_TYPES.has(r.income_type)
        ? "myTax doesn't prefill this. Enter it in the business and professional items schedule."
        : "myTax doesn't prefill this — type it in.") + foreignTax });
  }
  // Never a negative line: if linked rent ever exceeded the report's rent, the income tie-back fails instead.
  if (rentUnlinked > 0) {
    typeIn.push({ key: "rent_unlinked", label: itemFor("rent").item, name: "Rent not linked to a property", amount_cents: rentUnlinked, kind: "type_in", record_href: "/income?type=rent",
      note: "Link this rent to its property so it lands in that property's rental schedule." });
  }
  // myTax's Income banner order (the pack's mytax_income_items key order): rent before business, foreign after.
  const itemOrder = Object.keys(items);
  const typeRank = (k: string) => {
    const i = itemOrder.indexOf(k === "rent_unlinked" ? "rent" : k);
    return i < 0 ? itemOrder.length : i;
  };
  typeIn.sort((a, b) => typeRank(a.key) - typeRank(b.key));
  // A13 (#580, residency_assessability): foreign income left out for a non-resident period is NOT a type-in line —
  // one information note says how much and why. amount_cents stays null so the income tie-back is untouched.
  // One note per myTax item the left-out types belong to (pack labels: item 20 vs P8 for foreign business).
  const leftOutByItem = new Map<string, number>();
  for (const x of report.income.excluded_by_type ?? []) {
    if (x.reason !== NON_RESIDENT_FOREIGN || x.gross_cents <= 0) continue;
    const item = itemFor(x.income_type).item;
    leftOutByItem.set(item, (leftOutByItem.get(item) ?? 0) + x.gross_cents);
  }
  for (const [item, cents] of leftOutByItem) {
    typeIn.push({ key: leftOutByItem.size === 1 ? "foreign_left_out" : `foreign_left_out:${item}`, label: item, name: `Foreign income — left out: ${money(cents)} while you were a foreign or temporary resident (see note)`, amount_cents: null, kind: "note", record_href: "/income",
      note: NON_RESIDENT_FOREIGN_NOTE });
  }

  // Refund netting (report's refund_netting): each refund is netted on the SAME line its matched expense lands
  // on, so the amounts the user types are already net. `placed` tracks what found a line; anything left over
  // (a matched expense this worksheet doesn't itemise) is carried in the tie-back, never silently dropped.
  let placed = 0;
  const net = (id: string, cents: number): number => {
    const n = netted.get(id) ?? 0;
    if (n) {
      placed += n;
      netted.delete(id); // a refund nets once, even if its expense appears on two rows
    }
    return cents - n;
  };

  // ── 3. Rental properties (rent item) ───────────────────────────────────────────────────────────────
  const rentItem = itemFor("rent").item;
  const rental: WorksheetLine[] = [];
  let rentalIncome = 0;
  let rentalDeductions = 0;
  let rentalDep = 0;
  // per_property.deduction_cents counts every row propertyRowCounts accepts — including rows the HEADLINE
  // excludes (an 'asset' purchase or an unresolved payg row tagged to the property). Those never reach the
  // report's deductions, so they come off the line; refunds matched to the property's rows are netted here too.
  const propLess = new Map<string, number>();
  for (const r of detail.property_items) {
    const less = r.headline ? r.counted_cents - net(r.id, r.counted_cents) : r.counted_cents;
    if (less) propLess.set(r.property_id, (propLess.get(r.property_id) ?? 0) + less);
  }
  const propLabel = new Map(report.per_property.map((p) => [p.property_id, p.label]));
  const propIds = [...new Set([...report.per_property.map((p) => p.property_id), ...rentByProp.keys()])];
  const perProp = new Map(report.per_property.map((p) => [p.property_id, p]));
  for (const pid of propIds) {
    const p = perProp.get(pid);
    const name = propLabel.get(pid) ?? "Property";
    const href = `/transactions?property=${encodeURIComponent(pid)}`;
    const rent = rentByProp.get(pid) ?? 0;
    if (rent) {
      rentalIncome += rent;
      rental.push({ key: `rent:${pid}`, label: rentItem, name: `Gross rent — ${name}`, amount_cents: rent, kind: "type_in", record_href: `/income?type=rent` });
    }
    if (!p) continue;
    const ded = p.deduction_cents - (propLess.get(pid) ?? 0);
    if (ded) {
      rentalDeductions += ded;
      rental.push({ key: `rental_deductions:${p.property_id}`, label: rentItem, name: `Rental deductions — ${name}`, amount_cents: ded, kind: "type_in", record_href: href,
        note: "myTax asks for these split into interest, capital works and other rental deductions — the full breakdown has each expense." });
    }
    if (p.depreciation_cents) {
      rentalDep += p.depreciation_cents;
      rental.push({ key: `rental_dep:${p.property_id}`, label: rentItem, name: `Decline in value — ${name}`, amount_cents: p.depreciation_cents, kind: "type_in", record_href: "/assets" });
    }
  }
  // Rental spend with no property: raw property-bucket rows (the schedule routes them with the work-related
  // rows because they can't land in any per-property schedule) and property-track attributions with no
  // property. Both count in the report's deductions, so they get one honest line rather than masquerading as
  // unlabelled work expenses.
  let propUnlinked = 0;
  for (const r of detail.work_related) if (isPropertyBucket(r.bucket)) propUnlinked += net(r.id, r.counted_cents);

  // ── 4. Deductions ─────────────────────────────────────────────────────────────────────────────────
  // Work-related itemised rows (the schedule's section 4) + counted individual-track attributions that aren't
  // a business activity, grouped by the SAME atoReturnLabel the schedule's label routing uses. Attributions go
  // through the position's own veto (attributionCountsInPosition) so a suggestion never reaches a line.
  const groups = new Map<string, { cents: number; n: number; notes: string[] }>();
  const add = (label: string, cents: number, n: number, note?: string) => {
    const g = groups.get(label) ?? { cents: 0, n: 0, notes: [] };
    g.cents += cents;
    g.n += n;
    if (note) g.notes.push(note);
    groups.set(label, g);
  };
  for (const r of detail.work_related) if (!isPropertyBucket(r.bucket)) add(atoReturnLabel(r.ato_label), net(r.id, r.counted_cents), 1);
  const bizByActivity = new Map<string, { label: string; cents: number; soleTrader: boolean }>();
  for (const a of detail.attributions) {
    const track = classifyAttribution(a);
    if (track === "company" || track === "excluded" || (track === "property" && a.property_id)) continue; // separate return / per_property
    if (!attributionCountsInPosition(track, a.deductibility, excludeNonDeductible)) continue;
    const cents = net(a.transaction_id, a.amount_cents);
    if (track === "property") {
      propUnlinked += cents;
      continue;
    }
    if (a.activity_type === "business") {
      const key = a.income_activity_id ?? "unlinked";
      const g = bizByActivity.get(key) ?? { label: a.activity_label ?? "Business activity", cents: 0, soleTrader: isSoleTraderBusinessAttribution(track, a) };
      g.cents += cents;
      bizByActivity.set(key, g);
      continue;
    }
    add(atoReturnLabel(a.ato_label), cents, 1);
  }
  if (propUnlinked !== 0) {
    rentalDeductions += propUnlinked;
    rental.push({ key: "rental_deductions_unlinked", label: rentItem, name: "Rental expenses not linked to a property", amount_cents: propUnlinked, kind: "type_in", record_href: "/transactions?bucket=property_rented",
      note: "Set the property on these expenses so they land in that property's rental schedule." });
  }
  const wm = report.work_method;
  const wml = pack.mytax_work_method_labels;
  let wmInLines = 0;
  if (wm && wm.wfh_cents > 0) {
    add(wml.wfh, wm.wfh_cents, 0, `includes working from home at the fixed rate: ${wm.wfh_hours} hrs (${money(wm.wfh_cents)})`);
    wmInLines += wm.wfh_cents;
  }
  if (wm && wm.car_cents > 0) {
    add(wml.car, wm.car_cents, 0, `includes car expenses at cents per km: ${Math.min(wm.car_work_km, wm.rates.car_km_cap)} km (${money(wm.car_cents)})`);
    wmInLines += wm.car_cents;
  }
  const unl = groups.get(UNLABELLED) ?? { cents: 0, n: 0, notes: [] };
  groups.delete(UNLABELLED);
  const labelOrder = Object.keys(pack.mytax_deduction_labels);
  const rank = (l: string) => {
    const i = labelOrder.indexOf(l.split("/")[0] ?? l);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const deductions: WorksheetLine[] = [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || compareDeductionLabels(a, b))
    .map(([label, g]) => {
      const named = pack.mytax_deduction_labels[label];
      const parts = label.split("/");
      const name = named ?? (parts.length > 1 ? `Split across ${parts.join(" and ")} — confirm which label each expense belongs to` : label);
      const basis = g.n ? `${g.n} expense${g.n === 1 ? "" : "s"} you recorded` : "";
      const note = [basis, ...g.notes].filter(Boolean).join("; ");
      return { key: label, label, name, amount_cents: g.cents, kind: "type_in" as const, record_href: `/transactions?label=${encodeURIComponent(label)}`,
        ...(note ? { note: note.charAt(0).toUpperCase() + note.slice(1) + "." } : {}) };
    });
  const deductionLines = deductions.reduce((s, l) => s + (l.amount_cents ?? 0), 0);
  // Decline in value NOT attributed to a rental property. The report carries depreciation as one total with no
  // work/business split, so this is the remainder after the per-property lines (the depreciation tie-back is
  // therefore by construction) — and it is flagged to confirm, never asserted to be a work deduction.
  const workDep = report.depreciation_cents - rentalDep;
  if (workDep !== 0) {
    deductions.push({ key: "decline_in_value", label: pack.mytax_decline_in_value_label, name: "Decline in value of assets you own (not rental)", amount_cents: workDep, kind: "type_in", record_href: "/assets",
      note: "Where this goes depends on what each asset is used for (work equipment, a car, or a business). Confirm with a registered tax agent." });
  }

  // ── 5. Business and professional items ────────────────────────────────────────────────────────────
  const bizItem = itemFor("business").item;
  const business: WorksheetLine[] = [];
  const bizIncome = report.income.by_type.filter((r) => BUSINESS_INCOME_TYPES.has(r.income_type)).reduce((s, r) => s + r.gross_cents, 0);
  let bizExpenses = 0;
  if (bizByActivity.size || bizIncome) {
    const acts = [...bizByActivity.entries()];
    const sole = acts.filter(([, a]) => a.soleTrader);
    if (bizIncome) {
      // Income isn't linked to an activity in the data model, so it's credited to the one sole-trader activity
      // only when there is exactly one; otherwise it's one total.
      const only = sole.length === 1 ? sole[0] : undefined;
      business.push({ key: only ? `income:${only[0]}` : "income:unlinked", label: bizItem, name: only ? `Business income — ${only[1].label}` : "Business income", amount_cents: bizIncome, kind: "type_in", record_href: "/income?type=business",
        note: only ? "The same income as in 'Income: type these in' — shown here because myTax's business schedule asks for it per business."
          : "The same income as in 'Income: type these in'. It isn't linked to a specific business, so it's shown as one total — myTax asks for it per business." });
    }
    for (const [key, a] of acts) {
      bizExpenses += a.cents;
      business.push({ key: `expenses:${key}`, label: bizItem, name: `Business expenses — ${a.label}`, amount_cents: a.cents, kind: "type_in", record_href: key === "unlinked" ? null : `/transactions?activity=${encodeURIComponent(key)}`,
        note: a.soleTrader ? "myTax asks for these by expense type in the business schedule — the full breakdown lists each one."
          : "This activity is held through a trust, partnership or other entity, so these costs may belong on that entity's return rather than yours. Confirm with a registered tax agent." });
    }
  }

  // ── #590 Who the person is: the situation profile's residency / spouse answers ─────────────────────
  const prof = ctx.profile;
  const residency = prof?.residency ?? [];
  const hasResidency = (t: string) => residency.some((r) => r.type === t);
  const nonOrdinary = residency.some((r) => NON_ORDINARY_RESIDENCY.has(r.type));
  const packLine = (m: PackLine, extraNote = ""): WorksheetLine => ({ key: m.key, label: m.label, name: m.name, amount_cents: null, kind: m.kind === "note" ? "note" : "answer", record_href: null, note: `${m.note}${extraNote}` });
  const applies = (m: PackLine) => !m.when || (m.when === "non_resident_period" && nonOrdinary) || (m.when === "spouse" && prof?.flags.spouse === true);

  // ── 0a. Contact and bank details (myTax shows these before Personalise) ─────────────────────────────
  const contact: WorksheetLine[] = pack.mytax_contact_lines.map((m) => packLine(m));

  // ── 0b. Personalise return: what to tick (ato §b row 13) ─────────────────────────────────────────────
  const personalise: WorksheetLine[] = [];
  const residencyNote = residency.length
    ? `You told Quillo: ${residency.map((r) => `${RESIDENCY_WORDS[r.type] ?? r.type} ${dayLabel(r.starts_on)} to ${dayLabel(r.ends_on)}`).join("; ")}. myTax asks whether you were an Australian resident for tax purposes, and the dates if it was only part of the year.`
    : "myTax asks this first, with the dates if you were a resident for only part of the year. Add your residency in About you so it's here for you.";
  personalise.push({ key: "residency", label: "", name: "Were you an Australian resident for tax purposes all year?", amount_cents: null, kind: "answer", record_href: "/about",
    note: `${residencyNote}${hasResidency("unsure") ? " If you're unsure, confirm with a registered tax agent." : ""}` });
  personalise.push({ key: "spouse", label: "", name: "Did you have a spouse at any time during the year?", amount_cents: null, kind: "answer", record_href: "/about",
    note: prof?.flags.spouse == null ? "myTax asks this next." : `You told Quillo: ${prof.flags.spouse ? "yes" : "no"}.` });
  const incomeTypesOnFile = new Set(report.income.by_type.filter((r) => r.gross_cents !== 0).map((r) => r.income_type));
  const profileSays = (k: PersonaliseItem["profile"]) =>
    k === "abn" ? (prof?.abn_activities.length ?? 0) > 0 : k === "foreign_income" ? prof?.flags.foreign_income === true : k === "whm" ? hasResidency("whm") : false;
  // Rental deductions and business expenses go in the rent item / business schedule, not under the Deductions tick.
  const hasDeductionLines = deductions.length > 0;
  for (const it of pack.mytax_personalise_items) {
    const on = it.income_types.some((t) => incomeTypesOnFile.has(t)) || (it.employers && employerEntities.length > 0) || profileSays(it.profile) || (it.deductions && hasDeductionLines);
    if (!on) continue;
    personalise.push({ key: `tick:${it.key}`, label: "", name: `Tick: ${it.name}`, amount_cents: null, kind: "answer", record_href: null,
      ...(it.key === "business" ? { note: "myTax then asks whether you received personal services income. The ATO has a PSI tool; if you're unsure, confirm with a registered tax agent." } : {}) });
  }
  personalise.push({ key: "pre_ticked", label: "", name: "Already ticked by myTax", amount_cents: null, kind: "note", record_href: null,
    note: "myTax may tick some items itself from prefilled information, and you can't untick those. That's normal. Gifts, interest and tax-affairs deductions, Medicare and income tests always show without a tick." });
  if (prof?.flags.study_loan) {
    personalise.push({ key: "study_loan", label: "", name: "Study and training loans (HELP and others)", amount_cents: null, kind: "note", record_href: null,
      note: "myTax works out any study loan repayment from your income. There's nothing to enter or tick." });
  }

  // ── 5b. Losses, offsets and adjustments (ato §b rows 16, 32) ─────────────────────────────────────────
  const adjustments: WorksheetLine[] = [];
  if (hasResidency("whm")) {
    adjustments.push({ key: "whm_net_income", label: "", name: "Working holiday maker net income", amount_cents: null, kind: "answer", record_href: "/about",
      note: "myTax asks your home country and whether all your income was earned while on your working holiday visa. myTax works out the tax on it. If you're unsure, confirm with a registered tax agent." });
  }
  // Temporary residents are residents for tax purposes, so only a resident/temporary gap makes it part-year.
  const residentLike = (t: string) => t === "resident" || t === "temporary";
  const residentDays = residency.filter((r) => residentLike(r.type));
  if (residentDays.length && prof && (residency.some((r) => !residentLike(r.type)) || residentDays[0]!.starts_on > prof.fy_start || residentDays[residentDays.length - 1]!.ends_on < prof.fy_end)) {
    adjustments.push({ key: "part_year_threshold", label: "", name: "Part-year tax-free threshold", amount_cents: null, kind: "note", record_href: null,
      note: "myTax works this out from the residency dates you give on Personalise return. There's nothing to enter." });
  }

  // ── 6. Medicare and private health (questions myTax asks — never a figure) ─────────────────────────
  const medicare: WorksheetLine[] = pack.mytax_medicare_lines.filter(applies).map((m) =>
    packLine(m, m.key === "private_hospital_cover" && prof?.flags.private_hospital_cover === true ? ` You told Quillo you held hospital cover: check the policy lines myTax prefilled (insurers aim to report by ${pack.lodgement.phi_report_by}).` : ""));

  // ── 7. Spouse details and income tests ───────────────────────────────────────────────────────────────
  const spouseTests: WorksheetLine[] = pack.mytax_spouse_lines.filter(applies).map((m) => packLine(m));

  // ── Assemble in pack order; empty sections drop out ───────────────────────────────────────────────
  const byKey: Record<string, WorksheetLine[]> = { contact_bank: contact, personalise, income_check: check, income_type_in: typeIn, rental, deductions, business, adjustments, medicare, spouse_income_tests: spouseTests };
  const sections: WorksheetSection[] = pack.mytax_sections
    .flatMap((s) => {
      const lines = byKey[s.key] ?? [];
      return lines.length ? [{ key: s.key, title: s.title, lines }] : [];
    });

  // ── Tie-back: the report's own formula, recomputed from the (already net) lines ───────────────────
  const checkTotal = check.reduce((s, l) => s + (l.amount_cents ?? 0), 0);
  const typeInTotal = typeIn.reduce((s, l) => s + (l.amount_cents ?? 0), 0);
  const incomeOk = checkTotal + typeInTotal + rentalIncome === report.total_income_cents;
  const unplaced = report.refunds_cents - placed;
  const nonWm = deductionLines - wmInLines + unl.cents + rentalDeductions + bizExpenses;
  const deductionsTotal = Math.max(0, nonWm - unplaced) + wmInLines;
  const deductionsOk = deductionsTotal === report.total_deductions_cents && wmInLines === (wm?.total_cents ?? 0);
  const depTotal = workDep + rentalDep;
  const depOk = depTotal === report.depreciation_cents;

  return {
    fy: report.fy,
    header: worksheetHeader(pack, ctx),
    sections,
    unlabelled: { n: unl.n, cents: unl.cents },
    tie_back: {
      income_check_total_cents: checkTotal,
      income_type_in_total_cents: typeInTotal,
      rental_income_total_cents: rentalIncome,
      report_income_cents: report.total_income_cents,
      income_ok: incomeOk,
      deduction_lines_total_cents: deductionLines,
      unlabelled_cents: unl.cents,
      rental_deductions_total_cents: rentalDeductions,
      business_expenses_total_cents: bizExpenses,
      netted_credits_cents: report.refunds_cents,
      netted_credits_unplaced_cents: unplaced,
      deductions_total_cents: deductionsTotal,
      report_deductions_cents: report.total_deductions_cents,
      deductions_ok: deductionsOk,
      depreciation_total_cents: depTotal,
      report_depreciation_cents: report.depreciation_cents,
      depreciation_ok: depOk,
      ok: incomeOk && deductionsOk && depOk,
    },
    disclaimer: READINESS_DISCLAIMER,
  };
}

/**
 * The page header (#590, ato §b rows 7–10): the ATO's "wait for Tax ready" rule leads, late July is only the
 * usual timing. Dates from the pack, never copy (§c rule 8). Exported for units.
 */
export function worksheetHeader(pack: MytaxPack, ctx: WorksheetContext): WorksheetHeader {
  const l = pack.lodgement;
  const prof = ctx.profile;
  // Leaving Australia: a resident period that ends before the FY does (and nothing resident after it).
  const res = prof?.residency ?? [];
  const lastResident = [...res].reverse().find((r) => r.type === "resident");
  const leaving = !!prof && !!lastResident && lastResident.ends_on < prof.fy_end && !res.some((r) => r.starts_on > lastResident.ends_on && r.type === "resident");
  return {
    prefill_ready_hint: l.prefill_ready_hint,
    self_lodge_due: l.self_lodge_due,
    intro: `Wait until your income statement says "Tax ready" in myGov before you lodge. Employers have until ${l.employer_finalise_by} to finalise them, and the ATO sends a message to your myGov Inbox when all of them are ready. That's ${l.prefill_ready_hint}. If one still isn't ready after ${l.tax_ready_chase_after}, ask your employer. Self-lodgers are due by ${l.self_lodge_due}. You lodge in myTax; Quillo helps you get ready, and this isn't tax advice.`,
    self_lodge_due_on: ctx.dueOn,
    after_due_note: l.after_due_note,
    agent_note: `Prefer a registered tax agent? Take this pack to any registered agent, and contact them before ${l.self_lodge_due} to be part of their lodgment program. The ATO's free Tax Help program is another option for simple returns.`,
    early_lodge_note: leaving
      ? "Leaving Australia? The ATO lets you lodge early. Prefilled information may not be complete yet, so check every line and type in anything myTax doesn't show."
      : null,
    processing_hint: l.processing_hint,
    amend_window: l.amend_window,
    records_keep: l.records_keep,
  };
}

// ── Readiness signal + endpoint ─────────────────────────────────────────────────────────────────────

/**
 * The worksheet_unlabelled readiness signal. Flag OFF ⇒ {} ⇒ assessReadiness sees nothing ⇒ findings
 * byte-identical. Called by the Durable Object AND the persona goldens (one definition to be right about).
 */
export async function mytaxWorksheetSignals(env: Env, userId: string, startYear: number, report?: Report): Promise<{ worksheetUnlabelled?: { n: number; cents: number } }> {
  if (!featureOn(env, "mytax_worksheet")) return {};
  const ws = await buildMytaxWorksheet(env, userId, startYear, { report, signalOnly: true });
  return { worksheetUnlabelled: ws.unlabelled };
}

/** GET /api/mytax-worksheet?fy= — 404 when the flag is off (byte-identical), else the worksheet. */
export async function mytaxWorksheetResponse(env: Env, userId: string, startYear: number): Promise<Response> {
  const headers = { "content-type": "application/json" };
  if (!featureOn(env, "mytax_worksheet")) return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers });
  return new Response(JSON.stringify(await buildMytaxWorksheet(env, userId, startYear)), { headers });
}
