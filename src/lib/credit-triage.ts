// Credit triage — the deterministic engine behind the "We noticed…" cards (first-timer spec A3, #577,
// flag `wages_payer`). PURE: no I/O, no model call, unit-tested in scripts/check-units.ts and exercised
// end-to-end by the pft8 persona golden.
//
// A bank credit says WHERE to look, never WHAT to record (#532). So the output is a list of proposals —
// "looks like pay from Big Retail", "payouts from DoorDash" — each of which the user confirms. Nothing here
// decides that money is income. In particular a payroll signal can never become income: a deposit is
// take-home pay, so recording it would understate gross pay and double-count once the income statement
// arrives (owner ruling #554).
//
// Order matters: the named lists (platform, government, interest, foreign) are checked FIRST, because a
// weekly DoorDash payout has exactly the cadence of a weekly wage. Only what's left can be payroll.
// Credits a dedicated movement step owns (own-account transfers, card payments) are skipped — same
// predicate the Clarify scan uses, so a line never surfaces in two places.

import { groupKey } from "./clarify";
import { classifyMovement, movementTreatment } from "./statements";
import { anyPatternHits } from "./token-match";
import auV1RulePack from "../rulepacks/au-v1.json";

export type SignalKind = "payroll" | "platform" | "government" | "interest" | "foreign";

export interface PlatformEntry { key: string; match: string; label: string; activity: string }
export interface GovernmentEntry { key: string; match: string; label: string; income_type: string }
export interface ForeignEntry { key: string; match: string; label: string }

export interface CreditSignalLists {
  payroll: {
    words: string;
    cadence_days: number[];
    cadence_tolerance_days: number;
    amount_band: number;
    min_count: number;
    /** A credit with one of these and NO business_marker is person-to-person (PayID from a friend) — never payroll. */
    p2p_markers?: string;
    business_markers?: string;
  };
  /** Refunds / rebates / reversals: never a signal of any kind. */
  skip_words?: string;
  platform: PlatformEntry[];
  government: GovernmentEntry[];
  interest: { match: string; label: string; income_type: string };
  foreign: ForeignEntry[];
}

/** The pack's credit_signals, falling back to the bundled AU pack per key (a partial KV pack can't disable triage). */
export function creditSignalLists(pack: unknown = auV1RulePack): CreditSignalLists {
  const base = (auV1RulePack as unknown as { credit_signals: CreditSignalLists }).credit_signals;
  const p = ((pack as { credit_signals?: Partial<CreditSignalLists> } | null)?.credit_signals ?? {}) as Partial<CreditSignalLists>;
  return {
    // Merged per field so a stale KV pack missing a newer key keeps the bundled default.
    payroll: { ...base.payroll, ...(p.payroll ?? {}) },
    skip_words: typeof p.skip_words === "string" ? p.skip_words : base.skip_words,
    platform: Array.isArray(p.platform) ? p.platform : base.platform,
    government: Array.isArray(p.government) ? p.government : base.government,
    interest: p.interest ?? base.interest,
    foreign: Array.isArray(p.foreign) ? p.foreign : base.foreign,
  };
}

export interface TriageCredit {
  id: string;
  raw_description: string | null;
  merchant: string | null;
  amount_cents: number | null;
  amount_aud_cents: number | null;
  txn_date: string | null;
}

/** Counts, dates and a total only — never a raw bank description (minimisation, spec A3 acceptance). */
export interface SignalEvidence {
  n: number;
  first_date: string | null;
  last_date: string | null;
  total_cents: number;
  /** A display name for the payer: the pack label, or the description's letters with channel/payroll noise removed. */
  label: string;
  /** payroll only: the detected cadence in days, when regular. */
  cadence_days?: number;
  /** payroll only: another employer is already known (or ranks above this one) — "a second employer?". */
  second_payer?: boolean;
  /** platform only: the abn_activity value a confirm writes. */
  activity?: string;
  /** government / interest: the income type manual entry would use. */
  income_type?: string;
}

export interface TriageSignal {
  kind: SignalKind;
  signal_key: string;
  evidence: SignalEvidence;
  /** The credits behind the signal — used by the caller, never persisted. */
  txn_ids: string[];
}

const descOf = (r: { raw_description?: string | null; merchant?: string | null }): string => r.raw_description ?? r.merchant ?? "";
const centsOf = (r: TriageCredit): number => Math.abs(r.amount_aud_cents ?? r.amount_cents ?? 0);

/** Strip the pack's payroll words before stemming so "BIG RETAIL SALARY" and "BIG RETAIL PAY" are one payer. */
function stripWords(desc: string, words: string): string {
  const list = words.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return desc;
  const re = new RegExp(`\\b(${list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})s?\\b`, "gi");
  return desc.replace(re, " ");
}

/**
 * The payer key of a credit: the clarify groupKey stem of its description with payroll words removed. Shared by
 * the triage, the payroll confirm (which stamps every credit with the same key) and the Clarify "My wages"
 * answer, so all three agree on which credits are one payer.
 */
export function payerStem(desc: string | null | undefined, lists: CreditSignalLists = creditSignalLists()): string | null {
  return groupKey(stripWords(desc ?? "", lists.payroll.words));
}

// Channel / entity noise dropped from a display name (a superset of the stemmer's: we keep short words like "BIG").
const LABEL_NOISE = new Set([
  "transfer", "transfers", "deposit", "deposits", "payment", "payments", "pmt", "direct", "credit", "osko", "payid",
  "payto", "bpay", "eftpos", "netbank", "internet", "mobile", "online", "ref", "reference", "from", "pty", "ltd",
  "limited", "the", "value", "date", "tfr", "dep", "rcv", "received", "inc", "co", "au", "aus", "australia",
]);

/** A short display name for an unlisted payer ("BIG RETAIL PTY LTD SALARY 0412" → "Big Retail"). Letters only, ≤ 4 words. */
export function payerLabel(desc: string | null | undefined, lists: CreditSignalLists = creditSignalLists()): string {
  const words = stripWords(desc ?? "", lists.payroll.words)
    .replace(/\b\d{1,4}([/\-.]\d{1,4}){1,2}\b/g, " ")
    .split(/[^A-Za-z&']+/)
    .filter((w) => w.length >= 2 && !LABEL_NOISE.has(w.toLowerCase()))
    .slice(0, 4);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

/** Person-to-person: a P2P channel marker and no business marker ("PAYID JANE DOE" yes; "OSKO BIG RETAIL PTY LTD" no). */
export function isPersonToPerson(desc: string, lists: CreditSignalLists = creditSignalLists()): boolean {
  const P = lists.payroll;
  if (!P.p2p_markers || !anyPatternHits(P.p2p_markers, desc)) return false;
  return !(P.business_markers && anyPatternHits(P.business_markers, desc));
}

/** A credit a dedicated step owns (own-account transfer / card payment) — never a signal. */
function ownedByMovementStep(desc: string): boolean {
  return movementTreatment(classifyMovement(desc).klass, "credit") !== "skip";
}

function evidenceOf(rows: TriageCredit[], label: string): SignalEvidence {
  const dates = rows.map((r) => r.txn_date).filter((d): d is string => !!d).sort();
  return {
    n: rows.length,
    first_date: dates[0] ?? null,
    last_date: dates[dates.length - 1] ?? null,
    total_cents: rows.reduce((s, r) => s + centsOf(r), 0),
    label,
  };
}

const dayNo = (iso: string): number => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000);

/** The regular cadence (days) of a set of dated credits, or null. Every gap must sit within tolerance of ONE cadence. */
export function detectCadence(dates: ReadonlyArray<string>, cadences: ReadonlyArray<number>, tolerance: number): number | null {
  const ds = [...new Set(dates)].sort().map(dayNo);
  if (ds.length < 2) return null;
  const gaps = ds.slice(1).map((d, i) => d - ds[i]!);
  for (const c of cadences) if (gaps.every((g) => Math.abs(g - c) <= tolerance)) return c;
  return null;
}

/** Every amount within ±band of the median (a wage varies with shifts; a one-off bonus breaks the band). */
export function withinBand(amounts: ReadonlyArray<number>, band: number): boolean {
  if (amounts.length === 0) return false;
  const s = [...amounts].sort((a, b) => a - b);
  const mid = s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
  if (mid <= 0) return false;
  return s.every((a) => Math.abs(a - mid) <= band * mid);
}

/**
 * Triage one FY's credits into signals. `existingEmployerKeys` are payer stems already confirmed as an employer
 * (any FY), so a new payroll payer is flagged as a SECOND employer. Deterministic: same input ⇒ same output,
 * ordered by kind then biggest total.
 */
export function triageCredits(
  rows: ReadonlyArray<TriageCredit>,
  lists: CreditSignalLists = creditSignalLists(),
  existingEmployerKeys: ReadonlySet<string> = new Set(),
): TriageSignal[] {
  const named = new Map<string, { kind: SignalKind; key: string; label: string; extra: Partial<SignalEvidence>; rows: TriageCredit[] }>();
  const rest: TriageCredit[] = [];
  const add = (kind: SignalKind, key: string, label: string, extra: Partial<SignalEvidence>, r: TriageCredit) => {
    const k = `${kind}|${key}`;
    const g = named.get(k) ?? { kind, key, label, extra, rows: [] };
    g.rows.push(r);
    named.set(k, g);
  };
  for (const r of rows) {
    const desc = descOf(r);
    if (!desc.trim() || ownedByMovementStep(desc)) continue;
    if (lists.skip_words && anyPatternHits(lists.skip_words, desc)) continue; // a refund / rebate is not money earned
    const plat = lists.platform.find((p) => anyPatternHits(p.match, desc));
    if (plat) { add("platform", plat.key, plat.label, { activity: plat.activity }, r); continue; }
    const gov = lists.government.find((g) => anyPatternHits(g.match, desc));
    if (gov) { add("government", gov.key, gov.label, { income_type: gov.income_type }, r); continue; }
    if (anyPatternHits(lists.interest.match, desc)) {
      // One interest signal per payer stem (each bank), labelled from the description minus the word "interest".
      const key = payerStem(desc, lists) ?? "interest";
      add("interest", key, payerLabel(desc.replace(/\binterest\b/gi, " "), lists) || lists.interest.label, { income_type: lists.interest.income_type }, r);
      continue;
    }
    const fx = lists.foreign.find((f) => anyPatternHits(f.match, desc));
    if (fx) { add("foreign", fx.key, fx.label, {}, r); continue; }
    rest.push(r);
  }

  const out: TriageSignal[] = [...named.values()].map((g) => ({
    kind: g.kind,
    signal_key: g.key,
    evidence: { ...evidenceOf(g.rows, g.label), ...g.extra },
    txn_ids: g.rows.map((r) => r.id),
  }));

  // Payroll: the remaining credits grouped by payer stem.
  const P = lists.payroll;
  const byStem = new Map<string, TriageCredit[]>();
  for (const r of rest) {
    if (isPersonToPerson(descOf(r), lists)) continue; // spec A3: person-to-person gets no card
    const k = payerStem(descOf(r), lists);
    if (!k) continue;
    const g = byStem.get(k);
    if (g) g.push(r);
    else byStem.set(k, [r]);
  }
  const payroll: TriageSignal[] = [];
  for (const [key, rs] of byStem) {
    // min_count applies to BOTH paths: one credit with a payroll word ("PAY BACK") is not a job.
    if (rs.length < P.min_count) continue;
    const cadence = detectCadence(rs.map((r) => r.txn_date).filter((d): d is string => !!d), P.cadence_days, P.cadence_tolerance_days);
    const words = rs.some((r) => anyPatternHits(P.words, descOf(r)));
    if (cadence == null && !words) continue;
    if (!withinBand(rs.map(centsOf), P.amount_band)) continue;
    const ev = evidenceOf(rs, payerLabel(descOf(rs[0]!), lists) || key);
    payroll.push({ kind: "payroll", signal_key: key, evidence: cadence != null ? { ...ev, cadence_days: cadence } : ev, txn_ids: rs.map((r) => r.id) });
  }
  // Biggest payer first; anyone after the first (or after a known employer) is a second payer.
  payroll.sort((a, b) => b.evidence.total_cents - a.evidence.total_cents || (a.signal_key < b.signal_key ? -1 : 1));
  const known = [...existingEmployerKeys];
  payroll.forEach((s, i) => {
    if (i > 0 || known.some((k) => k !== s.signal_key)) s.evidence.second_payer = true;
  });

  const ORDER: SignalKind[] = ["payroll", "platform", "government", "interest", "foreign"];
  return [...payroll, ...out].sort(
    (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.evidence.total_cents - a.evidence.total_cents || (a.signal_key < b.signal_key ? -1 : 1),
  );
}
