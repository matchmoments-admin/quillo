// Residency assessability (first-timer spec A13, #580, flag `residency_assessability`; owner rulings #557 +
// spec residual Q2).
//
// Foreign-sourced income dated inside a person's foreign / working-holiday-maker / temporary-resident period is
// captured but LEFT OUT of the indicative position, with a general-information note — except that temporary
// residents keep foreign employment income (the ATO says it is declared). Which residency value excludes which
// income types is DATA, in the rule pack (`residency_assessability`), never a TS literal, so a jurisdiction
// changes the carve-out without code.
//
// This module is the one decision point. It is pure apart from the context loader, and it never touches the
// money pipeline itself: ledger-totals (the position), report (per-property rent), the accountant schedule and
// the myTax worksheet all ask classifyIncomeRow() the same question, so every report-derived surface agrees.
//
// Guard rails (spec A13 acceptance):
//   - Exclusion only ever applies inside a DATED residency period (situation_periods) — never on the binary
//     persons.tax_residency alone.
//   - An undated row whose FY is not wholly covered by one excluding residency value STAYS IN, and readiness
//     asks when it was earned (foreign_income_undated_part_year). No automatic split.
//   - Every excluded dollar stays visible (IncomeTotals.excluded_by_type, reason non_resident_foreign).

import type { Env } from "../env";
import auV1RulePack from "../rulepacks/au-v1.json";
import { featureOn } from "./features";
import { AU_DESCRIPTOR, type JurisdictionDescriptor } from "./jurisdiction";
import { isIsoDate, profileForFy, residencyOn, residencyPeriodsForFy, type SituationProfile } from "./situation-profile";

/** excluded_by_type reason for income left out because it was earned while not an Australian resident. */
export const NON_RESIDENT_FOREIGN = "non_resident_foreign";

/** The general-information note every excluded row carries (spec A13). */
export const NON_RESIDENT_FOREIGN_NOTE =
  "Foreign income earned while you were a foreign resident or a temporary resident for tax purposes is generally not taxed in Australia, so Quillo has left it out of your estimate. This is general information; confirm with a registered tax agent.";

/** G11 caveat on occupation suggestions for a person with a non-resident period. */
export const AU_WORK_DEDUCTIONS_CAVEAT = "Deductions against your Australian work income generally still apply; confirm with a registered tax agent.";

// ── Pack ────────────────────────────────────────────────────────────────────────

interface PackRule {
  exclude?: string | string[];
  keep?: string[];
}
interface PackTable {
  foreign_sourced_types?: string[];
  rules?: Record<string, PackRule>;
}

/** residency value → the income types it excludes. Values with no rule (resident, unsure) are absent. */
export type AssessabilityTable = Record<string, ReadonlySet<string>>;

/**
 * Resolve the pack's table. A KV pack that predates the key falls back to the bundled pack, so pushing the
 * pack late never silently turns the carve-out off (or on) — same pattern as the myTax worksheet keys. Pure.
 */
export function residencyAssessabilityTable(pack: unknown = auV1RulePack): AssessabilityTable {
  const fromPack = (pack as { residency_assessability?: PackTable } | null)?.residency_assessability;
  const raw: PackTable = fromPack && typeof fromPack === "object" && fromPack.rules ? fromPack : ((auV1RulePack as { residency_assessability?: PackTable }).residency_assessability ?? {});
  const group = new Set((raw.foreign_sourced_types ?? []).filter((t): t is string => typeof t === "string"));
  const out: Record<string, ReadonlySet<string>> = {};
  for (const [value, rule] of Object.entries(raw.rules ?? {})) {
    if (value.startsWith("_") || !rule || typeof rule !== "object") continue;
    const base = rule.exclude === "foreign_sourced" ? [...group] : Array.isArray(rule.exclude) ? rule.exclude.filter((t) => typeof t === "string") : [];
    const keep = new Set(Array.isArray(rule.keep) ? rule.keep : []);
    const set = new Set(base.filter((t) => !keep.has(t)));
    if (set.size) out[value] = set;
  }
  return out;
}

/** Every income type some residency value can exclude (bounds the row-level query). Pure. */
export function excludableIncomeTypes(table: AssessabilityTable): string[] {
  const all = new Set<string>();
  for (const s of Object.values(table)) for (const t of s) all.add(t);
  return [...all].sort();
}

// ── Classification ──────────────────────────────────────────────────────────────

export interface ResidencyAssessabilityContext {
  table: AssessabilityTable;
  profiles: ReadonlyMap<string, SituationProfile>; // person id → profile for the FY
  selfPersonId: string | null; // income.person_id NULL ⇒ the self person
}

export type IncomeRowVerdict = "kept" | "excluded" | "undated_part_year";

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** True when the (sorted, non-overlapping, clipped) periods cover [start, end] with no gap. Pure. */
function coversWholeFy(periods: ReadonlyArray<{ starts_on: string; ends_on: string }>, start: string, end: string): boolean {
  let cursor = start;
  for (const p of periods) {
    if (p.starts_on > cursor) return false;
    if (p.ends_on >= cursor) cursor = nextDay(p.ends_on);
    if (cursor > end) return true;
  }
  return cursor > end;
}

/**
 * Is this income row in the position? Pure.
 * - Dated: excluded when the residency period covering txn_date excludes the row's type.
 * - Undated: excluded only when the person's FY holds ONE residency value, it excludes the type, and its periods
 *   cover the whole FY (the date can't matter). Otherwise, if any of the FY's residency periods would exclude the
 *   type, the row stays in and is flagged undated_part_year so readiness asks when it was earned.
 * - No profile / no excluding period ⇒ kept.
 */
export function classifyIncomeRow(
  row: { income_type: string; person_id: string | null; txn_date: string | null },
  ctx: ResidencyAssessabilityContext,
): IncomeRowVerdict {
  const personId = row.person_id ?? ctx.selfPersonId;
  const profile = personId ? ctx.profiles.get(personId) : undefined;
  if (!profile) return "kept";
  const excludes = (type: string | null) => !!type && (ctx.table[type]?.has(row.income_type) ?? false);
  const periods = residencyPeriodsForFy(profile);
  if (!periods.some((p) => excludes(p.type))) return "kept";
  if (isIsoDate(row.txn_date)) return excludes(residencyOn(profile, row.txn_date)) ? "excluded" : "kept";
  const values = new Set(periods.map((p) => p.type));
  if (values.size === 1 && coversWholeFy(periods, profile.fy_start, profile.fy_end)) return "excluded";
  return "undated_part_year";
}

/**
 * G11: how Find My Claims treats a rule for a non-AU-resident taxpayer. Today every rule is forced to 'defer'.
 * With a non-resident residency PERIOD (and the flag on), occupation suggestions for Australian work classify
 * normally but carry AU_WORK_DEDUCTIONS_CAVEAT; every other rule keeps the defer. Pure.
 */
export function nonResidentClaimTreatment(rule: { scope_type: string; scope_value: string }, nonAuResident: boolean, narrowDefer: boolean): "normal" | "defer" | "caveat" {
  if (!nonAuResident) return "normal";
  if (narrowDefer && rule.scope_type === "occupation" && rule.scope_value !== "all") return "caveat";
  return "defer";
}

/** True when the person's FY profile holds a residency period that excludes something (foreign / whm / temporary). Pure. */
export function hasNonResidentPeriod(profile: SituationProfile | undefined, table: AssessabilityTable): boolean {
  return !!profile && residencyPeriodsForFy(profile).some((p) => (table[p.type]?.size ?? 0) > 0);
}

// ── Loader ──────────────────────────────────────────────────────────────────────

/**
 * Both flags are needed: residency_assessability moves money, and situation_profile is what lets the user see
 * and edit the periods that drive it (About you). Either OFF ⇒ no exclusion ⇒ byte-identical.
 */
export function residencyAssessabilityOn(env: Env): boolean {
  return featureOn(env, "residency_assessability") && featureOn(env, "situation_profile");
}

/**
 * The classification context for a tenant's FY, or null when the flags are off or nobody has an excluding
 * residency period in the FY (then callers take the legacy path — no extra query, byte-identical output).
 * `rulePack` is the tenant's resolved pack (KV-shadowed) where the caller has it.
 */
export async function residencyAssessabilityContext(
  env: Env,
  userId: string,
  startYear: number,
  opts: { descriptor?: JurisdictionDescriptor; rulePack?: unknown } = {},
): Promise<ResidencyAssessabilityContext | null> {
  if (!residencyAssessabilityOn(env)) return null;
  const table = residencyAssessabilityTable(opts.rulePack);
  if (!Object.keys(table).length) return null;
  let profiles: SituationProfile[];
  let self: { id: string } | null;
  try {
    [profiles, self] = await Promise.all([
      profileForFy(env, userId, startYear, opts.descriptor ?? AU_DESCRIPTOR),
      env.DB.prepare(`SELECT id FROM persons WHERE user_id = ? AND role = 'self' ORDER BY created_at LIMIT 1`).bind(userId).first<{ id: string }>(),
    ]);
  } catch (e) {
    // e.g. migration 0078 not applied while the flag is ON: fall back to the legacy path (all income kept) rather
    // than failing every report. Logged so the misconfiguration is visible.
    console.warn(`[residency_assessability] context load failed — income kept in: ${(e as Error).message}`);
    return null;
  }
  if (!profiles.some((p) => hasNonResidentPeriod(p, table))) return null;
  return { table, profiles: new Map(profiles.map((p) => [p.person_id, p])), selfPersonId: self?.id ?? null };
}
