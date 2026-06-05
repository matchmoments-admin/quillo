import type { Env } from "../env";
import { COUNTABLE, NEEDS_REVIEW, UNDATED_CLAUSE } from "./queries";

export type NextActionKind = "import" | "review" | "date" | "export";

export interface NextAction {
  kind: NextActionKind;
  count: number;
  label: string;
  href: string;
}

export interface Progress {
  imported: { statements: number; transactions: number };
  categorised: number;
  needs_review: number;
  undated: number;
  unreconciled_receipts: number;
  has_qbo: boolean;
  done: boolean;
  next_action: NextAction;
}

// The raw counts getProgress derives from D1, fed into the pure next-action picker below so the
// precedence logic stays unit-testable offline (no D1 / no Worker runtime).
export interface ProgressCounts {
  imported_statements: number;
  imported_transactions: number;
  categorised: number;
  needs_review: number;
  undated: number;
  unreconciled_receipts: number;
  has_qbo: boolean;
}

const plural = (n: number, one: string): string => (n === 1 ? one : `${one}s`);

/**
 * The single source of truth for "what's the ONE next thing to do?". Precedence:
 *   nothing imported → import; needs_review>0 → review; undated>0 → date; else → export.
 * File (/filing) is the lodge-ready finish line (its readiness view links the CSV export), so the
 * cleared state points there rather than at /reports. Pure + read-only (no D1, no mutation) so
 * every branch is covered by an offline unit test.
 */
export function nextAction(c: ProgressCounts): NextAction {
  if (c.imported_transactions === 0)
    return { kind: "import", count: 0, label: "Import a statement to get started", href: "/accounts" };
  if (c.needs_review > 0)
    return { kind: "review", count: c.needs_review, label: `${c.needs_review} ${plural(c.needs_review, "item")} to review`, href: "/" };
  if (c.undated > 0)
    return { kind: "date", count: c.undated, label: `${c.undated} ${plural(c.undated, "item")} to date`, href: "/reports" };
  return { kind: "export", count: 0, label: "Ready to lodge — review the position and export", href: "/filing" };
}

// "Done" = there's data AND no outstanding exceptions. The imported>0 guard stops a brand-new
// empty tenant (0 review, 0 undated by definition) from reading as "done".
export function isDone(c: ProgressCounts): boolean {
  return c.imported_transactions > 0 && c.needs_review === 0 && c.undated === 0;
}

export function buildProgress(c: ProgressCounts): Progress {
  return {
    imported: { statements: c.imported_statements, transactions: c.imported_transactions },
    categorised: c.categorised,
    needs_review: c.needs_review,
    undated: c.undated,
    unreconciled_receipts: c.unreconciled_receipts,
    has_qbo: c.has_qbo,
    done: isDone(c),
    next_action: nextAction(c),
  };
}

/**
 * Derived completion state for a tenant: how done are they, and what's the single next action.
 * Read-only — counts only, never mutates. Reuses COUNTABLE + NEEDS_REVIEW (the canonical <0.85
 * predicate) so it can't drift from the dashboard / report. One batched D1 round-trip.
 */
export async function getProgress(env: Env, userId: string): Promise<Progress> {
  const q = (sql: string) => env.DB.prepare(sql).bind(userId);
  // Every count here is ALL-TIME by design. These drive the cross-year work spine (NextAction) and
  // the nav review badge, which sit beside an Inbox/Reconcile queue that is itself NOT FY-scoped —
  // so an FY-scoped count here would diverge from the queue it links to (and a txn_date range would
  // silently drop the undated rows that most need attention). The dashboard's MONEY cards are
  // per-FY (see queries.dashboard); the review queue stays a single all-time backlog.
  const rows = await env.DB.batch<{ n: number }>([
    // Only statements that have actually been imported (status flips 'parsed'→'imported' on
    // confirmImport) — a parsed-but-unconfirmed or failed upload must NOT read as "your
    // statements are in" on the Accounts guide.
    q(`SELECT COUNT(*) AS n FROM statements WHERE user_id = ? AND status = 'imported'`),
    q(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND ${COUNTABLE}`),
    q(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND bucket IS NOT NULL AND ${COUNTABLE}`),
    q(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND ${NEEDS_REVIEW}`),
    q(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND ${COUNTABLE} AND ${UNDATED_CLAUSE}`),
    // Mirrors the receipts half of reconcilePairs() (src/lib/queries.ts) EXACTLY so this count
    // can't disagree with what the Reconcile page actually lists: drop only duplicates, unmatched,
    // with an amount.
    q(
      `SELECT COUNT(*) AS n FROM transactions
        WHERE user_id = ? AND kind = 'receipt' AND status NOT IN ('duplicate')
          AND matched_txn_id IS NULL AND amount_cents IS NOT NULL`,
    ),
    q(`SELECT COUNT(*) AS n FROM qbo_connections WHERE user_id = ?`),
  ]);
  const num = (i: number) => rows[i]?.results?.[0]?.n ?? 0;
  return buildProgress({
    imported_statements: num(0),
    imported_transactions: num(1),
    categorised: num(2),
    needs_review: num(3),
    undated: num(4),
    unreconciled_receipts: num(5),
    has_qbo: num(6) > 0,
  });
}
