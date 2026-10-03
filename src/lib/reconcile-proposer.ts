// Receipt ↔ bank-line match PROPOSER (A8, #574; decision #437; background docs/ux/reconcile-fold-findings.md).
//
// Pure: same inputs → same output, no I/O. The caller (src/lib/queries.ts reconcileProposals) loads
// the rows, the user's dismissals and the rule-pack thresholds, and hands plain values in.
//
// What it decides, and what it never does:
//  - It SUGGESTS a pair for one user confirm. It never writes a match. Confirming is the user-tapped
//    Link (TaxAgent.linkReceipt). NOTE: the import-time auto-matcher TaxAgent.matchReceipt (its own
//    stricter merchant-aware scorer) still links on statement / feed import as it always has — that
//    is pre-existing behaviour, out of this ticket; with reconcile_proposals ON it skips dismissed pairs.
//  - It proposes only when the best line clears an absolute bar AND clearly beats the runner-up, and
//    a line two receipts both want is proposed to neither. Anything less confident falls through to
//    the manual two-pane picker. A wrong match attaches the wrong evidence to a claim, so the gate
//    errs towards "ask the user".
//  - A pair the user dismissed ("Not this one") is removed from the candidate set entirely, so it is
//    never proposed again and never blocks another line as a phantom runner-up.
//
// JURISDICTION-NEUTRAL: thresholds come from the rule pack (`reconcile` section); FY bounds come from
// the caller's jurisdiction descriptor.

/** The receipt ↔ line scorer: amount tolerance max(50¢, 1%) weighted 0.7 + a 7-day date window weighted
 *  0.3. Shared by the proposer and the manual picker's server ordering (reconcilePairs). The SPA's
 *  Reconcile.tsx still carries a mirror for its per-receipt re-sort until the Check page (#589). */
export function reconcileScore(rCents: number, rTime: number | null, lCents: number, lTime: number | null): number {
  const amt = 1 - Math.min(Math.abs(rCents - lCents) / Math.max(50, rCents * 0.01), 1);
  let date = 0;
  if (rTime != null && lTime != null) {
    const d = Math.abs(rTime - lTime) / 86_400_000;
    date = 1 - Math.min(d, 7) / 7;
  }
  return amt * 0.7 + date * 0.3;
}

/** Amount tolerance the scorer uses (the amount component is > 0 only strictly inside it). */
const tolerance = (rCents: number) => Math.max(50, rCents * 0.01);
/** Max score a line OUTSIDE the amount tolerance can reach (the date component alone). */
const OUT_OF_TOLERANCE_MAX = 0.3;
/** Date window (days) of the scorer — callers load lines this far either side of the FY. */
export const RECONCILE_WINDOW_DAYS = 7;
const WINDOW_MS = RECONCILE_WINDOW_DAYS * 86_400_000;
/** Past this many same-amount candidates a confident margin is impossible — stop scoring (CPU bound). */
const MAX_IN_TOLERANCE = 64;
const EPS = 1e-9;

export interface ReconcileConfig {
  proposeMinScore: number;
  proposeMargin: number;
}

export const DEFAULT_RECONCILE_CONFIG: ReconcileConfig = { proposeMinScore: 0.85, proposeMargin: 0.15 };

/** Read the `reconcile` section of a rule pack. A missing or malformed value (a KV override that drifted)
 *  falls back to the default rather than throwing. */
export function reconcileConfigFromPack(pack: unknown): ReconcileConfig {
  const sec = (pack as { reconcile?: { propose_min_score?: unknown; propose_margin?: unknown } } | null)?.reconcile;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : d);
  return {
    proposeMinScore: num(sec?.propose_min_score, DEFAULT_RECONCILE_CONFIG.proposeMinScore),
    proposeMargin: num(sec?.propose_margin, DEFAULT_RECONCILE_CONFIG.proposeMargin),
  };
}

export interface ProposerRow {
  id: string;
  cents: number; // AUD cents (amount_aud_cents ?? amount_cents), always positive
  date: string | null; // ISO yyyy-mm-dd
  direction: string | null; // 'debit' | 'credit'; NULL ⇒ debit (the column default)
}

export interface MatchProposal {
  receipt_id: string;
  line_id: string;
  score: number;
  runner_up_score: number;
}

export interface ProposerResult {
  proposals: MatchProposal[];
  /** Receipts with at least one plausible line in the FY but no confident proposal → the manual picker. */
  ambiguous: { receipt_id: string; candidates: number }[];
  /** Receipts dated in the FY with NO plausible line anywhere near ("No bank line this year" — a
   *  substantiation hint, not a matching task). Receipts dated outside the FY with no line here are not
   *  this FY's business; undated receipts can't be placed in a year and stay in the manual picker. */
  no_line: string[];
}

const dir = (d: string | null) => (d === "credit" ? "credit" : "debit");
const timeOf = (d: string | null) => {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isFinite(t) ? t : null;
};
const inFy = (d: string | null, fy: { start: string; end: string }) => !!d && d >= fy.start && d <= fy.end;

/**
 * Propose receipt ↔ bank-line matches for one FY.
 *
 * @param receipts   unmatched receipts (any FY — a receipt near the boundary must still find its line)
 * @param lines      unmatched bank lines dated in the FY **plus RECONCILE_WINDOW_DAYS either side**. The
 *                   margin is only honest if the runner-up was seen, and a runner-up across the boundary
 *                   is still a runner-up; only a line dated IN the FY can be proposed (money decides the year).
 * @param dismissals pairs the user rejected ("Not this one")
 * @param fy         the FY's inclusive date bounds
 */
export function proposeMatches(
  receipts: ProposerRow[],
  lines: ProposerRow[],
  dismissals: ReadonlyArray<{ receipt_id: string; line_id: string }>,
  cfg: ReconcileConfig,
  fy: { start: string; end: string },
): ProposerResult {
  const dismissedFor = new Map<string, Set<string>>();
  for (const d of dismissals) {
    if (!dismissedFor.has(d.receipt_id)) dismissedFor.set(d.receipt_id, new Set());
    dismissedFor.get(d.receipt_id)!.add(d.line_id);
  }
  // Lines grouped by direction (a purchase receipt never matches a refund credit, and vice versa) and
  // sorted by amount, so each receipt only scores the lines inside its amount tolerance (binary search).
  type L = { id: string; cents: number; time: number | null; inFy: boolean };
  const byDir = new Map<string, L[]>();
  const idsByDir = new Map<string, Set<string>>();
  for (const l of lines) {
    const k = dir(l.direction);
    if (!byDir.has(k)) { byDir.set(k, []); idsByDir.set(k, new Set()); }
    byDir.get(k)!.push({ id: l.id, cents: l.cents, time: timeOf(l.date), inFy: inFy(l.date, fy) });
    idsByDir.get(k)!.add(l.id);
  }
  for (const arr of byDir.values()) arr.sort((a, b) => a.cents - b.cents || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const picks: (MatchProposal & { plausible: number })[] = [];
  const ambiguous: ProposerResult["ambiguous"] = [];
  const noLine: string[] = [];

  for (const r of receipts) {
    const k = dir(r.direction);
    const pool = byDir.get(k) ?? [];
    const poolIds = idsByDir.get(k);
    const dismissed = dismissedFor.get(r.id);
    const rTime = timeOf(r.date);
    const tol = tolerance(r.cents);
    // First line with cents > r.cents - tol (strictly inside the tolerance; the boundary scores 0 on amount).
    let lo = 0, hi = pool.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pool[mid]!.cents <= r.cents - tol) lo = mid + 1;
      else hi = mid;
    }
    let best: { id: string; score: number; plausible: boolean; inFy: boolean } | null = null;
    let second = 0;
    let plausibleInFy = 0;
    let plausibleAny = 0;
    let inTolerance = 0; // non-dismissed lines inside the amount tolerance
    let saturated = false;
    for (let i = lo; i < pool.length && pool[i]!.cents < r.cents + tol; i++) {
      const l = pool[i]!;
      if (dismissed?.has(l.id)) continue;
      if (++inTolerance > MAX_IN_TOLERANCE) { saturated = true; break; }
      const s = reconcileScore(r.cents, rTime, l.cents, l.time);
      // Plausible = amount inside the tolerance AND date inside the 7-day window (both components > 0).
      const isPlausible = rTime != null && l.time != null && Math.abs(rTime - l.time) < WINDOW_MS;
      if (isPlausible) { plausibleAny++; if (l.inFy) plausibleInFy++; }
      if (!best || s > best.score + EPS) {
        if (best) second = Math.max(second, best.score);
        best = { id: l.id, score: s, plausible: isPlausible, inFy: l.inFy };
      } else {
        second = Math.max(second, s);
      }
    }
    if (saturated) {
      // Too many same-amount candidates to ever clear the margin: straight to the picker (if it's this FY's).
      if (plausibleInFy > 0 || inFy(r.date, fy)) ambiguous.push({ receipt_id: r.id, candidates: Math.max(plausibleInFy, MAX_IN_TOLERANCE) });
      continue;
    }
    // Lines outside the amount tolerance can still score up to 0.3 on date alone. Rather than score
    // them all, treat their existence as a runner-up at that ceiling — conservative: it can only ever
    // SUPPRESS a proposal (and only when the bar is set below 0.45), never create one.
    let dismissedInPool = 0;
    if (dismissed && poolIds) for (const id of dismissed) if (poolIds.has(id)) dismissedInPool++;
    if (pool.length - dismissedInPool > inTolerance) second = Math.max(second, OUT_OF_TOLERANCE_MAX);

    if (best && best.plausible && best.inFy && best.score + EPS >= cfg.proposeMinScore && best.score - second + EPS >= cfg.proposeMargin) {
      picks.push({ receipt_id: r.id, line_id: best.id, score: round4(best.score), runner_up_score: round4(second), plausible: plausibleInFy });
    } else if (plausibleInFy > 0) {
      ambiguous.push({ receipt_id: r.id, candidates: plausibleInFy });
    } else if (plausibleAny === 0 && inFy(r.date, fy)) {
      noLine.push(r.id);
    }
    // else: its only plausible lines sit just across the boundary — the neighbouring FY's business.
  }

  // A line two receipts both want (e.g. two identical receipts, one payment) is proposed to NEITHER —
  // picking one would be a coin-toss the user should make in the picker.
  const claims = new Map<string, number>();
  for (const p of picks) claims.set(p.line_id, (claims.get(p.line_id) ?? 0) + 1);
  const proposals: MatchProposal[] = [];
  for (const { plausible, ...p } of picks) {
    if ((claims.get(p.line_id) ?? 0) > 1) ambiguous.push({ receipt_id: p.receipt_id, candidates: plausible });
    else proposals.push(p);
  }
  proposals.sort((a, b) => b.score - a.score || (a.receipt_id < b.receipt_id ? -1 : a.receipt_id > b.receipt_id ? 1 : 0));
  return { proposals, ambiguous, no_line: noLine };
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
