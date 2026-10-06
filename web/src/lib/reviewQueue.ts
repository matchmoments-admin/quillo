// Pure logic behind the Review step (spec §0 step 3, #587, absorbing #588 Records and #589 Check; flag
// ft_journey). ONE self-completing card queue: what still needs the user, in the order it's worth doing.
// Kept free of React so scripts/check-units.ts can test it directly (the repo has no browser test runner).
//
// Counts only. Nothing here reads or produces a money figure: the header shows how many cards are left and
// how complete the records are, never a refund, a tax figure or a saving.

import type { RecordsView } from "../types";

/** The queue's card kinds, in queue order. "fix" = a readiness blocker; "check" = a review-level finding. */
export const QUEUE_KINDS = ["fix", "noticed", "claims", "records", "matches", "check"] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];
export type QueueFilter = "all" | QueueKind;

/** Short names for the header chips (plural-neutral; the count sits beside them). */
export const QUEUE_KIND_LABEL: Record<QueueKind, string> = {
  fix: "To fix",
  noticed: "We noticed",
  claims: "Worth a look",
  records: "Records",
  matches: "Receipts to match",
  check: "Worth checking",
};

export interface QueueInputs {
  /** Readiness blockers (journey whats_left, severity blocker). */
  blockers: number;
  /** Readiness review findings (severity review). */
  review: number;
  /** Open "we noticed" signals. */
  noticed: number;
  /** Worth-a-look claim cards (grouped, pending only). */
  claimGroups: number;
  /** Confident receipt-match proposals + receipts waiting for the user to pick a line. */
  proposals: number;
  ambiguous: number;
  /** Confirmed claims still needing a record. */
  recordRows: number;
  /** Facts the user still has to state (needed, not done). */
  factsOpen: number;
}

export type QueueCounts = Record<QueueKind, number> & { total: number };

const n0 = (x: number) => (Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);

/** Cards left per kind and in total. Negative / non-finite inputs count as 0. */
export function queueCounts(i: QueueInputs): QueueCounts {
  const c = {
    fix: n0(i.blockers),
    noticed: n0(i.noticed),
    claims: n0(i.claimGroups),
    records: n0(i.recordRows) + n0(i.factsOpen),
    matches: n0(i.proposals) + n0(i.ambiguous),
    check: n0(i.review),
  };
  return { ...c, total: QUEUE_KINDS.reduce((s, k) => s + c[k], 0) };
}

/** How many cards are left, never an amount. */
export function queueSummary(c: QueueCounts): string {
  if (c.total === 0) return "Nothing left to look at";
  return `${c.total} to look at`;
}

/**
 * The header's ONE counts line (H&R Block review (d)11): cards left, then how many confirmed claims still
 * need a record and how many facts are still to state, e.g. "6 to look at · 3 claims need a record". Counts
 * only, never an amount; zero parts are left out.
 */
export function queueHeadline(c: QueueCounts, p: RecordsProgress | null): string {
  const parts = [queueSummary(c)];
  const claims = p ? Math.max(0, p.claimsTotal - p.claimsDone) : 0;
  const facts = p ? Math.max(0, p.factsTotal - p.factsDone) : 0;
  if (claims > 0) parts.push(`${claims} ${claims === 1 ? "claim needs" : "claims need"} a record`);
  if (facts > 0) parts.push(`${facts} ${facts === 1 ? "fact" : "facts"} to state`);
  return parts.join(" · ");
}

/** The kinds that have cards, in queue order (the header's filter chips). */
export function activeKinds(c: QueueCounts): QueueKind[] {
  return QUEUE_KINDS.filter((k) => c[k] > 0);
}

/** Is a card of this kind shown under this filter? */
export function showKind(filter: QueueFilter, kind: QueueKind): boolean {
  return filter === "all" || filter === kind;
}

/**
 * A filter chip whose kind has run out falls back to "all", so finishing the last card of a kind never
 * leaves the user looking at an empty filtered list.
 */
export function effectiveFilter(filter: QueueFilter, c: QueueCounts): QueueFilter {
  return filter === "all" || c[filter] > 0 ? filter : "all";
}

export interface RecordsProgress {
  claimsDone: number;
  claimsTotal: number;
  factsDone: number;
  factsTotal: number;
  done: number;
  total: number;
}

/**
 * The records completeness meter (spec A7): claims with a record (or under an attested exception) and
 * facts stated, as counts. Null when there is nothing to count yet.
 */
export function recordsProgress(block: RecordsView["block"] | null | undefined): RecordsProgress | null {
  if (!block) return null;
  const claimsTotal = n0(block.claims_total);
  const claimsDone = Math.min(claimsTotal, n0(block.claims_with_record) + n0(block.claims_exception));
  const factsTotal = block.facts_needed.length;
  const factsDone = block.facts_needed.filter((f) => block.facts_done.includes(f)).length;
  const total = claimsTotal + factsTotal;
  if (total === 0) return null;
  return { claimsDone, claimsTotal, factsDone, factsTotal, done: claimsDone + factsDone, total };
}

/** The records rows still needing the user (a confirmed claim with no record and no attested exception). */
export function openRecordRows(view: RecordsView | null | undefined): RecordsView["rows"] {
  return (view?.rows ?? []).filter((r) => r.status === "needs_record");
}

/** The records rows that are complete (shown under Done). */
export function doneRecordRows(view: RecordsView | null | undefined): RecordsView["rows"] {
  return (view?.rows ?? []).filter((r) => r.status !== "needs_record");
}

/** Facts the user still has to state this year. */
export function openFacts(view: RecordsView | null | undefined): RecordsView["facts"] {
  return (view?.facts ?? []).filter((f) => f.needed && !f.done);
}
