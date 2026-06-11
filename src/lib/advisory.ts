// Savings & Opportunities advisory engine — pure, deterministic, unit-tested. No I/O, no Claude.
//
// This is the brain behind the "Save" surface: it turns the transactions spine into (1) a factual
// annualised spend run-rate, (2) deterministic recurring-bill / subscription detection, and (3)
// FACTUAL opportunity copy. The DO does the D1 reads/writes around these pure functions (same shape
// as src/lib/clarify.ts), so the maths lands in scripts/check-units.ts as exact-value goldens rather
// than only being exercisable at deploy time (local runtime is deploy-only — see CLAUDE.md).
//
// COMPLIANCE (see the Savings & Opportunities critique): this layer is FACTUAL INFORMATION only —
// no recommendations, no forward save/invest projection off the user's surplus, no cohort
// benchmarks, no "best/cheapest", no product steer, no PII to any partner. Every user-facing string
// is built here and MUST pass assertFactual() (a unit test enforces it). The annualisation is plain
// arithmetic on money the user already gave us ("at this rate that's ~$X/year"), framed as a fact —
// NOT a prediction of an outcome.

import { cleanMerchant } from "./bank-parsers";

// ── Factual-copy guardrail ────────────────────────────────────────────────────
// Tokens that would drag a factual statement toward financial-product advice / a comparison claim /
// an outcome projection. Centralised so a single unit test can assert NO advisory copy contains them.
// (Kept deliberately broad; "save"/"saving" is allowed only as a neutral noun in links, never as a
// "save up to $X" claim — see assertFactual which catches the dangerous bigrams.)
const BANNED_TOKEN_RE =
  /\b(should|recommend|recommended|best|cheapest|invest|investing|investment|gamble|gambling|guaranteed|projected|projection)\b/i;
const BANNED_PHRASE_RE = /\b(save up to|you could save|whole[ -]of[ -]market|we compared|too (?:high|much)|better off)\b/i;

/** True when copy stays on the factual side of the advice line (no recommend/projection/comparison). */
export function assertFactual(text: string): boolean {
  return !BANNED_TOKEN_RE.test(text) && !BANNED_PHRASE_RE.test(text);
}

/** The standing disclaimer shown on every advisory surface. Factual-info posture, no AFSL. */
export const ADVISORY_DISCLAIMER =
  "General information only — not financial product advice. Quillo doesn't hold an AFSL.";

// ── Biller normalisation ───────────────────────────────────────────────────────
// A STABLE, coarse biller identity derived from a noisy bank description. Reuses cleanMerchant as the
// base (strips whitespace/asterisks/trailing refs), then strips payment-CHANNEL prefixes only —
// NEVER cross-maps different legal entities (merging "Ergon" into "Origin" would corrupt per-biller
// apportionment, the money-math path CLAUDE.md protects). Unlike clarify.groupKey this preserves
// word order and all identity tokens (groupKey reduces to two sorted tokens — lossy, wrong here).
const CHANNEL_TOKENS = new Set([
  "bpay", "osko", "payid", "payto", "eftpos", "visa", "mastercard", "amex", "direct", "credit",
  "debit", "pos", "purchase", "payment", "payments", "pmt", "transfer", "transfers", "withdrawal",
  "deposit", "netbank", "commbank", "anytime", "internet", "online", "mobile", "ref", "reference",
  "value", "date", "aus", "au", "australia", "pty", "ltd", "from", "to", "recur", "recurring", "dd",
  "tfr", "dep", "card", "tap", "www", "com", "net", "org", "co", "inc", "llc", "corp", "limited",
]);

/** A ref/store code, not merchant identity: 2+ embedded digits (keeps legit names like "7eleven"). */
function isRefToken(t: string): boolean {
  return (t.replace(/[^0-9]/g, "").length >= 2) && /[a-z]/.test(t);
}
const DATEY_RE = /\b\d{1,4}([/\-.]\d{1,4}){1,2}\b/g;

/**
 * Normalise (merchant, raw_description) into a stable biller_key, or null when there's no usable
 * merchant identity. Lowercase → strip dates/refs → keep alnum → drop channel + pure-number tokens →
 * join in original order. Channel-prefix stripping only; no entity merging.
 */
export function billerNormalize(merchant: string | null | undefined, raw?: string | null): string | null {
  const src = (merchant ?? raw ?? "").toString();
  if (!src.trim()) return null;
  const s = cleanMerchant(src)
    .toLowerCase()
    .replace(DATEY_RE, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = s
    .split(" ")
    .filter((t) => t.length > 0 && !CHANNEL_TOKENS.has(t) && !/^\d+$/.test(t) && !isRefToken(t));
  if (tokens.length === 0) return null;
  return tokens.join(" ");
}

// ── Biller categorisation (factual, keyword-based) ─────────────────────────────
export const BILLER_CATEGORIES = [
  "energy", "gas", "water", "internet", "mobile", "insurance", "health", "streaming", "other",
] as const;
export type BillerCategory = (typeof BILLER_CATEGORIES)[number];

const CATEGORY_HINTS: { category: BillerCategory; essential: boolean; re: RegExp }[] = [
  { category: "energy", essential: true, re: /\b(energy|electric|electricity|origin|agl|energyaustralia|ergon|powershop|red energy|alinta|momentum|ovo|simply energy)\b/ },
  { category: "gas", essential: true, re: /\bgas\b/ },
  { category: "water", essential: true, re: /\b(water|sydney water|yarra valley|sa water|unitywater)\b/ },
  { category: "internet", essential: true, re: /\b(internet|broadband|nbn|aussie broadband|superloop|tangerine|launtel|iinet|tpg|exetel|dodo)\b/ },
  { category: "mobile", essential: true, re: /\b(mobile|telstra|optus|vodafone|boost|amaysim|belong|kogan mobile|felix|moose)\b/ },
  { category: "insurance", essential: true, re: /\b(insurance|insur|nrma|aami|allianz|budget direct|youi|racv|racq|qbe|suncorp)\b/ },
  { category: "health", essential: true, re: /\b(health|bupa|medibank|hcf|nib|ahm|frank health|gmhba)\b/ },
  { category: "streaming", essential: false, re: /\b(netflix|spotify|disney|stan|binge|kayo|youtube|amazon prime|prime video|apple tv|paramount|audible|patreon|twitch|foxtel|crunchyroll)\b/ },
];

/** Classify a biller_key into a factual category + whether it's a switchable essential (utility/insurance). */
export function classifyBiller(billerKey: string): { category: BillerCategory; essential: boolean } {
  for (const h of CATEGORY_HINTS) if (h.re.test(billerKey)) return { category: h.category, essential: h.essential };
  return { category: "other", essential: false };
}

// ── Annualised run-rate ────────────────────────────────────────────────────────
const MS_PER_DAY = 86_400_000;

/** Whole days between two ISO YYYY-MM-DD dates (a..b), >= 0. Returns 0 for malformed input. */
export function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(`${aIso}T00:00:00Z`);
  const b = Date.parse(`${bIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / MS_PER_DAY));
}

/**
 * Annualise FY-to-date spend by elapsed days: factual arithmetic ("at this rate, ~$X across the full
 * year"), NOT a prediction. `asOf` is clamped to the FY window; before any time has elapsed we return
 * the raw figure (no divide-by-zero, no inflated extrapolation). Never extrapolates BELOW the actual
 * spent figure (a full year can't be less than what's already spent).
 */
export function annualiseSpendCents(spentCents: number, fyStartIso: string, fyEndIso: string, asOfIso: string): number {
  const totalDays = daysBetween(fyStartIso, fyEndIso) + 1; // inclusive FY length (~365/366)
  let elapsed = daysBetween(fyStartIso, asOfIso) + 1;
  if (elapsed < 1) elapsed = 1;
  if (elapsed >= totalDays) return spentCents; // FY complete (or past) → the actual figure IS the annual
  const annual = Math.round((spentCents * totalDays) / elapsed);
  return Math.max(annual, spentCents);
}

// ── Recurring / subscription detection ─────────────────────────────────────────
export type Cadence = "weekly" | "fortnightly" | "monthly" | "quarterly" | "annual" | "irregular";

const CADENCE_BANDS: { name: Exclude<Cadence, "irregular">; days: number; tol: number }[] = [
  { name: "weekly", days: 7, tol: 2 },
  { name: "fortnightly", days: 14, tol: 3 },
  { name: "monthly", days: 30, tol: 6 }, // covers 28–31 day months
  { name: "quarterly", days: 91, tol: 14 },
  { name: "annual", days: 365, tol: 35 },
];

/** Approx number of payments per year for a cadence (for annualised commitment maths). */
export function paymentsPerYear(c: Cadence): number {
  switch (c) {
    case "weekly": return 52;
    case "fortnightly": return 26;
    case "monthly": return 12;
    case "quarterly": return 4;
    case "annual": return 1;
    default: return 0; // irregular → don't annualise a commitment from it
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export interface RecurringOccurrence {
  date: string; // ISO YYYY-MM-DD
  amount_cents: number;
}

export interface RecurringDetection {
  cadence: Cadence;
  occurrences: number;
  typical_amount_cents: number;
  amount_variance_cents: number; // max−min spread; 0 ≈ fixed subscription
  is_subscription: boolean;      // fixed-amount (variance within the subscription band)
  status: "early" | "confirmed"; // early = 2 occ / loose; confirmed = ≥3 occ on a consistent cadence
  first_seen: string;
  last_seen: string;
  next_expected: string | null;  // last_seen + cadence; null for irregular
}

/** Map a median gap (days) to a cadence band, or "irregular" if it matches none. */
export function classifyCadence(medianGapDays: number): Cadence {
  for (const b of CADENCE_BANDS) if (Math.abs(medianGapDays - b.days) <= b.tol) return b.name;
  return "irregular";
}

function addDays(iso: string, days: number): string | null {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Detect a recurring stream from one biller's dated debits. Covers BOTH variable bills (energy/insurance)
 * AND fixed subscriptions (streaming/SaaS/gym). Needs ≥2 occurrences; ≥3 on a consistent cadence →
 * "confirmed", else "early" (the Plaid early-detection pattern). Returns null below the floor or when
 * there's no discernible cadence at all. Pure: caller supplies the rows (already grouped by biller_key).
 */
export function detectRecurrence(occ: RecurringOccurrence[]): RecurringDetection | null {
  const rows = occ
    .filter((o) => o.date && /^\d{4}-\d{2}-\d{2}$/.test(o.date) && o.amount_cents > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) gaps.push(daysBetween(rows[i - 1]!.date, rows[i]!.date));
  const medGap = median(gaps);
  if (medGap <= 0) return null; // same-day duplicates, not a recurrence
  const cadence = classifyCadence(medGap);

  const amounts = rows.map((r) => r.amount_cents);
  const typical = median(amounts);
  const variance = Math.max(...amounts) - Math.min(...amounts);
  // Fixed within $2 or 2% of typical → a subscription; otherwise a usage-based bill.
  const subThreshold = Math.max(200, Math.round(typical * 0.02));
  const isSubscription = variance <= subThreshold;

  // Consistency: a stream is "confirmed" only with ≥3 occurrences on a real (non-irregular) cadence
  // whose gaps mostly sit within the band tolerance — otherwise it's an early/loose detection.
  const band = CADENCE_BANDS.find((b) => b.name === cadence);
  const within = band ? gaps.filter((g) => Math.abs(g - band.days) <= band.tol).length : 0;
  const consistent = band != null && within >= Math.ceil(gaps.length * 0.6);
  const status: "early" | "confirmed" = rows.length >= 3 && consistent ? "confirmed" : "early";

  const last = rows[rows.length - 1]!.date;
  const next = cadence === "irregular" || !band ? null : addDays(last, band.days);

  return {
    cadence,
    occurrences: rows.length,
    typical_amount_cents: typical,
    amount_variance_cents: variance,
    is_subscription: isSubscription,
    status,
    first_seen: rows[0]!.date,
    last_seen: last,
    next_expected: next,
  };
}

// ── Factual copy builders (every string here must pass assertFactual) ──────────
function money(cents: number): string {
  return `$${(Math.round(cents) / 100).toLocaleString("en-AU", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

const CADENCE_WORD: Record<Cadence, string> = {
  weekly: "week", fortnightly: "fortnight", monthly: "month",
  quarterly: "quarter", annual: "year", irregular: "period",
};

/** Government / independent comparison signposts — whole-of-market, no commission, zero PII. */
export function signpostFor(category: BillerCategory): { label: string; url: string } | null {
  switch (category) {
    case "energy": case "gas":
      return { label: "Compare energy plans at the AER's Energy Made Easy", url: "https://www.energymadeeasy.gov.au" };
    case "health":
      return { label: "Compare health cover at the government's privatehealth.gov.au", url: "https://www.privatehealth.gov.au" };
    default:
      return null;
  }
}

/** Factual run-rate sentence: spent-so-far + the at-this-rate annualised figure. */
export function runRateCopy(spentCents: number, annualisedCents: number, items: number): string {
  return `You've spent ${money(spentCents)} across ${items} item${items === 1 ? "" : "s"} so far this financial year. At this rate that's about ${money(annualisedCents)} across a full year.`;
}

/** Factual recurring-stream sentence: how much, how often, annual commitment. */
export function recurringCopy(billerLabel: string, d: RecurringDetection): string {
  const per = CADENCE_WORD[d.cadence];
  const annual = paymentsPerYear(d.cadence) * d.typical_amount_cents;
  const kind = d.is_subscription ? "subscription" : "bill";
  const base = d.cadence === "irregular"
    ? `${billerLabel}: ${d.occurrences} payments of about ${money(d.typical_amount_cents)} (${kind}).`
    : `${billerLabel}: about ${money(d.typical_amount_cents)} per ${per} (${kind})` +
      (annual > 0 ? ` — roughly ${money(annual)} a year.` : ".");
  return base;
}
