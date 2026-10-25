/**
 * The daily operational-log prune. Deletes rows older than their table's age limit from the tables the
 * manifest classes as `{ log: days }` (traces, eval_cases, read notifications, ai_edits), so these
 * stop growing without limit in the same 10 GB database as the ledger. Ledger and keep tables are never
 * touched: tax records are only ever FLAGGED (retention.ts), and audit/billing rows are kept.
 *
 * Flag `log_retention`, OFF by default. Deleting old history is a data-retention policy, so turning it on is
 * the owner's call. Bounded work per run: each delete walks only the oldest `batch` rows by rowid (the b-tree
 * key, so no created_at index is needed). Rows are inserted with rowid = max + 1 and created_at = now, so
 * rowid order is age order; the run stops on a table once a batch deletes fewer than `batch` rows. An `only`
 * predicate (notifications prunes READ rows only) narrows the window itself, so rows that are never eligible —
 * old unread nudges — can't sit at the front and stall the drain.
 *
 * The caller runs this only after a successful (or already-done) D1 export, so the night's backup always
 * holds what it deletes.
 */
import type { Env } from "../env";
import { featureOn } from "./features";
import { LOG_TABLES } from "./table-manifest";
import { platformDb } from "./tenant-db";

export type PruneOutcome = { status: "flag_off" } | { status: "ok"; deleted: Record<string, number> };

export async function pruneLogs(env: Env, opts: { batch?: number; maxBatches?: number } = {}): Promise<PruneOutcome> {
  if (!featureOn(env, "log_retention")) return { status: "flag_off" };
  const batch = opts.batch ?? 500;
  const maxBatches = opts.maxBatches ?? 20; // ≤ 10k rows per table per day
  const deleted: Record<string, number> = {};
  for (const { table, days, only } of LOG_TABLES) {
    let n = 0;
    for (let i = 0; i < maxBatches; i++) {
      const r = await platformDb(env)
        .prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table}${only ? ` WHERE ${only}` : ""} ORDER BY rowid LIMIT ?) AND created_at < datetime('now', ?)`)
        .bind(batch, `-${days} days`)
        .run();
      const changed = Number(r.meta?.changes ?? 0);
      n += changed;
      if (changed < batch) break;
    }
    deleted[table] = n;
  }
  return { status: "ok", deleted };
}
