// The Grow layer (first-timer spec A11 ticket b, #592; flag ft_journey).
//
// Property, Shares & investments, Business & companies, Assets, Integrations, Extras, Savings and Advisers
// live in "Grow", hidden from the navigation until they matter. Owner ruling #535: a layer is visible when
// ANY of
//   1. the user switched it on (the account menu's Grow switcher or a Grow page's "Show in my menu"; the About
//      you page (#585) writes the same PUT /api/grow-layers for its ticks)          → grow_layers 'on'/'switched'
//   2. the user said Yes to a detection ("Looks like you have rental income: add it?") → grow_layers 'on'/'detected'
//   3. the tenant already HAS data in it (properties, holdings, entities other than employment / a novated
//      lease (an employment benefit, not a business), assets, a
//      QuickBooks connection, private-health rows, savings rows the user acted on, partner role).
// and is NEVER switched on silently: a detection only ever produces a suggestion. Rule 3 is computed on every
// read (growDataPresence), never stored, so an existing tenant — the owner is property-heavy — sees their
// layers on first load with no backfill. A layer with data can't be switched off (nobody loses sight of their
// own records); the switch only governs layers with nothing in them yet.
//
// The visibility rules are a PURE function (growView) so they are unit-tested offline; growDataPresence and
// growDetections do the D1 reads for the DO's journey() / growLayers().
//
// Not a money module: visibility changes what the navigation SHOWS, never what is counted.

import type { Env } from "../env";
import { featureOn, type FeatureKey } from "./features";
import { fyBounds } from "./ledger-totals";
import { brokerCodeFor, isRentLikeStem } from "./clarify";
import { AU_DESCRIPTOR, type JurisdictionDescriptor } from "./jurisdiction";
import auV1RulePack from "../rulepacks/au-v1.json";

export const GROW_LAYERS = ["property", "investments", "business", "assets", "integrations", "extras", "savings", "advisers"] as const;
export type GrowLayerKey = (typeof GROW_LAYERS)[number];

/** Layers a detection can suggest (spec: rent, dividends / broker activity, platform payouts / an ABN). */
export const DETECTABLE_LAYERS = ["property", "investments", "business"] as const satisfies readonly GrowLayerKey[];
export type DetectableLayer = (typeof DETECTABLE_LAYERS)[number];

export function isGrowLayer(v: unknown): v is GrowLayerKey {
  return typeof v === "string" && (GROW_LAYERS as readonly string[]).includes(v);
}

interface LayerSpec {
  /** The page behind this layer is itself flag-gated today; the layer only exists while that flag is ON. */
  flag?: FeatureKey;
  /** Advisers is the Partner portal: role-gated exactly as today, never switchable. */
  roleGated?: boolean;
}
const LAYER_SPEC: Record<GrowLayerKey, LayerSpec> = {
  property: {},
  investments: {},
  business: {},
  assets: {},
  integrations: {},
  extras: { flag: "phi_extras_tracker" },
  savings: { flag: "advisory_layer" },
  advisers: { roleGated: true },
};

/** The layers this tenant can have at all: page flag ON, and Advisers only for the partner role. */
export function availableLayers(env: Pick<Env, "FEATURES">, isPartner: boolean): GrowLayerKey[] {
  return GROW_LAYERS.filter((k) => {
    const s = LAYER_SPEC[k];
    if (s.roleGated) return isPartner;
    return !s.flag || featureOn(env as Env, s.flag);
  });
}

export function isSwitchable(layer: GrowLayerKey): boolean {
  return !LAYER_SPEC[layer].roleGated;
}

export type GrowState = "on" | "off";
export type GrowSource = "switched" | "detected";
/** Why a layer is visible ('data' | 'switched' | 'detected'), or 'none' when it's hidden. */
export type GrowReason = "data" | GrowSource | "none";

export interface GrowLayerRow {
  layer: string;
  state: string;
  source: string;
  dismissed_fy: number | null;
}

export interface GrowLayerView {
  key: GrowLayerKey;
  state: GrowState;
  reason: GrowReason;
  /** The tenant has data in it (rule 3) — the UI shows the switch as locked on. */
  has_data: boolean;
  switchable: boolean;
}

export interface GrowDetection {
  layer: DetectableLayer;
  /** Matching bank lines in the FY (0 for the ABN tick). */
  lines: number;
  /** One matching line's text, for "We noticed credits like …". null for the ABN tick. */
  sample: string | null;
  /** True when the user ticked an ABN activity in About you (business only). */
  abn_tick?: boolean;
}

export interface GrowSuggestion {
  layer: DetectableLayer;
  kind: `grow_${DetectableLayer}`;
  title: string;
  body: string;
  lines: number;
  sample: string | null;
}

export interface GrowPayload {
  layers: GrowLayerView[];
  suggestions: GrowSuggestion[];
}

const TITLE: Record<DetectableLayer, string> = {
  property: "Looks like you have rental income: add Property?",
  investments: "Looks like you have shares or investments: add them?",
  business: "Looks like you have a business or an ABN: add it?",
};
const WHAT: Record<DetectableLayer, string> = {
  property: "Property gives you a place for a rental property, its loan and its income.",
  investments: "Shares & investments gives you a place for holdings, dividends and distributions.",
  business: "Business & companies gives you a place for an ABN activity, GST and company details.",
};
const NOTICED: Record<DetectableLayer, string> = {
  property: "rent coming in",
  investments: "dividends or broker activity",
  business: "platform or business payouts",
};

function suggestionBody(d: GrowDetection): string {
  const seen = d.abn_tick && d.lines === 0
    ? "You told us you have an ABN activity."
    : `We noticed ${d.lines === 1 ? "1 bank line" : `${d.lines} bank lines`} this year that ${d.lines === 1 ? "looks" : "look"} like ${NOTICED[d.layer]}${d.sample ? `, such as "${d.sample}"` : ""}.`;
  return `${seen} ${WHAT[d.layer]} Nothing changes unless you say yes. General information only.`;
}

/** Which layers still need a detection scan: available, detectable, hidden, not switched off, not declined for this FY. */
export function detectionCandidates(input: {
  available: readonly GrowLayerKey[];
  stored: readonly GrowLayerRow[];
  data: Partial<Record<GrowLayerKey, boolean>>;
  startYear: number;
}): DetectableLayer[] {
  const byLayer = new Map(input.stored.map((r) => [r.layer, r]));
  return DETECTABLE_LAYERS.filter((k) => {
    if (!input.available.includes(k) || input.data[k]) return false;
    const r = byLayer.get(k);
    if (!r) return true;
    if (r.state === "on") return false; // already visible
    if (r.source === "switched") return false; // the user turned it off: don't nag
    return Number(r.dismissed_fy) !== input.startYear; // declined for this FY only
  });
}

/** The Grow payload: every available layer with its visibility + reason, and the open suggestions. Pure. */
export function growView(input: {
  available: readonly GrowLayerKey[];
  stored: readonly GrowLayerRow[];
  data: Partial<Record<GrowLayerKey, boolean>>;
  detections: readonly GrowDetection[];
  startYear: number;
}): GrowPayload {
  const byLayer = new Map(input.stored.map((r) => [r.layer, r]));
  const layers: GrowLayerView[] = input.available.map((key) => {
    const r = byLayer.get(key);
    const hasData = !!input.data[key];
    const reason: GrowReason = r?.state === "on" && (r.source === "switched" || r.source === "detected") ? r.source : hasData ? "data" : "none";
    return { key, state: reason === "none" ? "off" : "on", reason, has_data: hasData, switchable: isSwitchable(key) };
  });
  const candidates = new Set(detectionCandidates(input));
  const suggestions: GrowSuggestion[] = input.detections
    .filter((d) => candidates.has(d.layer) && (d.lines > 0 || d.abn_tick))
    .map((d) => ({ layer: d.layer, kind: `grow_${d.layer}` as const, title: TITLE[d.layer], body: suggestionBody(d), lines: d.lines, sample: d.sample }));
  return { layers, suggestions };
}

// ── Detection config (rule pack `grow_detection`) ─────────────────────────────────────────────────────

export interface GrowDetectionRule {
  direction: "credit" | "debit" | "any";
  stems: string[];
  min_lines: number;
}

/** The pack's grow_detection block; a pack without one (a KV override pushed before #592) uses the bundled default. */
export function growDetectionConfig(pack: unknown = auV1RulePack): Record<DetectableLayer, GrowDetectionRule> {
  const read = (p: unknown) => (p as { grow_detection?: Record<string, unknown> } | null)?.grow_detection;
  const raw = read(pack) ?? read(auV1RulePack) ?? {};
  const out = {} as Record<DetectableLayer, GrowDetectionRule>;
  for (const k of DETECTABLE_LAYERS) {
    const r = (raw[k] ?? {}) as Partial<GrowDetectionRule>;
    const direction = r.direction === "debit" || r.direction === "any" ? r.direction : "credit";
    const stems = Array.isArray(r.stems) ? r.stems.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim().toLowerCase()) : [];
    const min = typeof r.min_lines === "number" && Number.isFinite(r.min_lines) && r.min_lines >= 1 ? Math.floor(r.min_lines) : 1;
    out[k] = { direction, stems, min_lines: min };
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");

/** Whole-word, case-insensitive match of any stem. */
export function stemMatcher(stems: readonly string[]): (text: string) => boolean {
  if (!stems.length) return () => false;
  const re = new RegExp(`\\b(?:${stems.map(escapeRe).join("|")})\\b`, "i");
  return (text) => re.test(text);
}

export interface DetectLine {
  text: string;
  direction: string | null;
  ato_label: string | null;
}

/**
 * Classify one FY's bank lines into detections for the candidate layers. Pure: the D1 read is growDetections.
 * Property: the pack stems + isRentLikeStem on credits. Investments: the pack stems on credits, plus any line
 * naming a broker (BROKER_CODES) or answered as capital:investment. Business: the pack's platform stems on
 * credits, plus an ABN activity tick.
 */
export function detectFromLines(
  lines: readonly DetectLine[],
  candidates: readonly DetectableLayer[],
  config: Record<DetectableLayer, GrowDetectionRule>,
  abnTick: boolean,
): GrowDetection[] {
  const out: GrowDetection[] = [];
  for (const layer of candidates) {
    const rule = config[layer];
    const stem = stemMatcher(rule.stems);
    const dirOk = (d: string | null) => rule.direction === "any" || (d ?? "debit") === rule.direction;
    let n = 0;
    let sample: string | null = null;
    for (const l of lines) {
      const hit =
        (dirOk(l.direction) && (stem(l.text) || (layer === "property" && isRentLikeStem(l.text)))) ||
        (layer === "investments" && (l.ato_label === "capital:investment" || brokerCodeFor(l.text) !== null));
      if (!hit) continue;
      n++;
      sample ??= l.text.replace(/\s+/g, " ").trim().slice(0, 60);
    }
    const tick = layer === "business" && abnTick;
    if (n >= rule.min_lines) out.push({ layer, lines: n, sample, ...(tick ? { abn_tick: true } : {}) });
    else if (tick) out.push({ layer, lines: 0, sample: null, abn_tick: true });
  }
  return out;
}

// ── D1 reads ──────────────────────────────────────────────────────────────────────────────────────────

export async function growStored(env: Env, userId: string): Promise<GrowLayerRow[]> {
  return (await env.DB.prepare(`SELECT layer, state, source, dismissed_fy FROM grow_layers WHERE user_id = ?`).bind(userId).all<GrowLayerRow>()).results ?? [];
}

/**
 * Rule 3: which layers the tenant already has data in. One read of EXISTS probes, all tenant-scoped. These are
 * the user's own entries (or records derived from their own documents), never a guess from bank text.
 * Deliberately NOT probed (a layer with data is locked on, so a false unlock can't be undone): capital_imports
 * (parse staging — a committed import writes cgt_assets) and super_contributions (an employee's own personal
 * concessional contributions land there too; that is not a business).
 * Savings counts only rows the user acted on (a confirmed bill or a referral they started): the weekly
 * detector writes recurring_bills/opportunities for everyone with bank lines, and that must not unlock Savings.
 */
export async function growDataPresence(env: Env, userId: string, isPartner: boolean): Promise<Record<GrowLayerKey, boolean>> {
  const ex = (table: string, where = "") => `EXISTS (SELECT 1 FROM ${table} WHERE user_id = ?1${where ? ` AND ${where}` : ""})`;
  const sql = `SELECT
    (${ex("properties")} OR ${ex("loans_properties")} OR ${ex("loan_interest_summaries")}
       OR ${ex("income_activities", "activity_type = 'rental_property'")}
       OR ${ex("income", "income_type IN ('rent','foreign_rent')")}) AS property,
    (${ex("cgt_assets")} OR ${ex("cgt_events")} OR ${ex("ess_grants")}
       OR ${ex("income_activities", "activity_type = 'investment'")}
       OR ${ex("income", "income_type IN ('dividend','managed_fund_distribution')")}) AS investments,
    (${ex("entities", "active = 1 AND kind NOT IN ('employment','individual','novated_lease')")} OR ${ex("income_activities", "activity_type = 'business'")}
       OR ${ex("income", "income_type IN ('business','foreign_business','non_cash_business')")}
       OR ${ex("bas_periods")} OR ${ex("payg_instalments")} OR ${ex("trust_distributions")} OR ${ex("smsf_members")}
       OR ${ex("trading_stock")} OR ${ex("company_tax_positions")}
       OR ${ex("profiles", "gst_registered = 1")}) AS business,
    (${ex("assets")} OR ${ex("depreciation_opening_balances")}) AS assets,
    ${ex("qbo_connections")} AS integrations,
    (${ex("phi_policy")} OR ${ex("phi_limit")} OR ${ex("phi_benefit_usage")} OR ${ex("phi_statement")}) AS extras,
    (${ex("recurring_bills", "pinned = 1")} OR ${ex("referrals")}) AS savings`;
  const r = (await env.DB.prepare(sql).bind(userId).first<Record<string, number>>()) ?? {};
  const on = (k: string) => Number(r[k] ?? 0) === 1;
  return {
    property: on("property"),
    investments: on("investments"),
    business: on("business"),
    assets: on("assets"),
    integrations: on("integrations"),
    extras: on("extras"),
    savings: on("savings"),
    advisers: isPartner,
  };
}

/** Bounded scan: at most this many FY bank lines are read per detection pass. */
export const DETECT_LINE_CAP = 5000;

/** Read the FY's bank lines (bounded) + the ABN tick and run detectFromLines for the candidate layers. */
export async function growDetections(
  env: Env,
  userId: string,
  startYear: number,
  candidates: readonly DetectableLayer[],
  pack: unknown,
  descriptor: JurisdictionDescriptor = AU_DESCRIPTOR,
): Promise<GrowDetection[]> {
  if (!candidates.length) return [];
  const { start, end } = fyBounds(startYear, descriptor);
  const rows = (await env.DB.prepare(
    `SELECT TRIM(COALESCE(merchant,'') || ' ' || COALESCE(raw_description,'')) AS text, direction, ato_label
       FROM transactions
      WHERE user_id = ? AND kind = 'bank_line' AND status <> 'duplicate' AND txn_date >= ? AND txn_date <= ?
      ORDER BY txn_date DESC LIMIT ${DETECT_LINE_CAP}`,
  ).bind(userId, start, end).all<DetectLine>()).results ?? [];
  // An ABN activity ticked in About you (situation_periods, A1) overlapping the FY.
  const abnTick = candidates.includes("business")
    ? ((await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM situation_periods WHERE user_id = ? AND fact = 'abn_activity'
            AND (starts_on IS NULL OR starts_on <= ?) AND (ends_on IS NULL OR ends_on >= ?)`,
      ).bind(userId, end, start).first<{ n: number }>())?.n ?? 0) > 0
    : false;
  return detectFromLines(rows, candidates, growDetectionConfig(pack), abnTick);
}

/** The full Grow payload for one FY (journey() and GET /api/grow-layers). Read-only. */
export async function growPayload(
  env: Env,
  userId: string,
  startYear: number,
  opts: { isPartner: boolean; pack: unknown; descriptor?: JurisdictionDescriptor },
): Promise<GrowPayload> {
  const available = availableLayers(env, opts.isPartner);
  const [stored, data] = await Promise.all([growStored(env, userId), growDataPresence(env, userId, opts.isPartner)]);
  const candidates = detectionCandidates({ available, stored, data, startYear });
  const detections = await growDetections(env, userId, startYear, candidates, opts.pack, opts.descriptor);
  return growView({ available, stored, data, detections, startYear });
}

/**
 * Record a Grow choice. `switched` on/off from the switcher; `detected` on = Yes to a suggestion; `detected`
 * off = No for FY `fy` (start year). Returns an error string for an invalid request, else null.
 */
export async function setGrowLayer(
  env: Env,
  userId: string,
  input: { layer: unknown; state: unknown; source: unknown; fy?: unknown },
  available: readonly GrowLayerKey[],
): Promise<string | null> {
  const { layer, state, source } = input;
  if (!isGrowLayer(layer)) return "unknown layer";
  if (!available.includes(layer)) return "layer not available";
  if (!isSwitchable(layer)) return "layer can't be switched";
  if (state !== "on" && state !== "off") return "state must be on or off";
  if (source !== "switched" && source !== "detected") return "source must be switched or detected";
  if (source === "detected" && !(DETECTABLE_LAYERS as readonly string[]).includes(layer)) return "layer has no detection";
  let dismissedFy: number | null = null;
  if (source === "detected" && state === "off") {
    const fy = Number(input.fy);
    if (!Number.isInteger(fy) || fy < 1900 || fy > 2200) return "fy is required to decline a suggestion";
    dismissedFy = fy;
  }
  await env.DB.prepare(
    `INSERT INTO grow_layers (user_id, layer, state, source, dismissed_fy, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (user_id, layer) DO UPDATE SET state = excluded.state, source = excluded.source,
       dismissed_fy = excluded.dismissed_fy, updated_at = excluded.updated_at`,
  ).bind(userId, layer, state, source, dismissedFy).run();
  return null;
}
