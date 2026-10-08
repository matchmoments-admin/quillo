import { feedFingerprint, ProviderError, type TransactionPageResult } from "./bank-feed-core";
import { isTransferLike } from "./statements";
import { cleanMerchant } from "./bank-parsers";

/**
 * The bank-feed importer's bounded, resumable core (#511, ADR-0003, flag `bank_feed_cdr`).
 *
 * WHY THIS EXISTS. `bankSync` used to walk up to 200 pages x 500 rows inside ONE Durable Object
 * request, accumulating a prepared statement per row in memory, and wrote its `bank_sync_runs` row
 * only after the work. That blew the Workers 1000-subrequest cap around ~45k rows, and a request that
 * died mid-pull left no evidence at all. This module turns a sync into a sequence of bounded STEPS
 * over a run row that is written FIRST:
 *
 *   openRun      → INSERT status='running' (atomic concurrency guard: one running run per connection)
 *   syncRunStep  → fetch ≤ pageBudget pages, flush each page to D1 as it lands, checkpoint the resume
 *                  cursor + counters on the run row after every page
 *   finishRun    → terminal status (ok | partial | failed), finished_at, connection last_sync_at
 *
 * The DO (src/agent.ts) owns scheduling — the first step runs inline in the HTTP request, any
 * remainder continues on a DO alarm. Everything here takes its I/O as arguments (a D1 handle and a
 * page TRANSPORT), so the money-visible decisions are unit-testable with a fake transport.
 *
 * SUBREQUEST BUDGET per step: each page is 1 provider fetch + ⌈rows/50⌉ D1 batches + 1 selection
 * re-check + 1 checkpoint ≈ 13 at 500 rows/page. An alarm step (PAGES_PER_STEP = 8) is ≈ 105 plus
 * the token fetch and a handful of setup reads; the inline HTTP step (10 pages) ≈ 130. The
 * tenant-wide post-import pipeline is NOT stacked on a multi-hop backfill's slices — it runs once,
 * in its own invocation, when the chain ends (agent.ts bankSyncFinalise / runFeedPostImport).
 */

/**
 * Pages one alarm-driven step may consume. Kept small because the Agents SDK can run due callbacks
 * inside `blockConcurrencyWhile` (30 s) when the DO cold-starts, and 8 provider round trips plus
 * ~100 D1 calls fits comfortably.
 */
export const PAGES_PER_STEP = 8;
/** Pages the synchronous HTTP step may consume before handing off to the alarm. */
export const FIRST_STEP_PAGES = 10;
/**
 * Runaway guard across a whole run: 400 pages x 500 = 200k rows, far past any real 24-month
 * account. A run that hits it is recorded as 'partial', never 'ok' — a truncated import that reads
 * as complete is exactly the silent undercount a coverage record exists to prevent.
 */
export const MAX_PAGES_PER_RUN = 400;
/** A 'running' row not checkpointed for this long is an interrupted run, not a live one. */
export const STALE_RUN_MINUTES = 10;
const INSERT_CHUNK = 50;

/** A fed line's status — the one decision that decides whether its money counts. */
export type FeedLineStatus = "ignored" | "needs_review" | "extracted";

/**
 * The three money-visible status decisions, in priority order:
 *
 *  - transfer ⇒ 'ignored'. A movement between the consumer's own accounts is not income or spend.
 *  - unconverted foreign currency ⇒ 'needs_review'. It has no trustworthy base-currency value until
 *    the FX layer converts it, so FX_CONVERTED (queries.ts) excludes it from every money sum. Parking
 *    it in review keeps the excluded money VISIBLE — an 'extracted' row that silently contributes
 *    nothing is exactly the shape of a quietly-understated position.
 *  - otherwise 'extracted' when the deterministic pass categorised it, else 'needs_review'.
 */
export function feedLineStatus(o: { transfer: boolean; unconverted: boolean; categorised: boolean }): FeedLineStatus {
  if (o.transfer) return "ignored";
  if (o.unconverted) return "needs_review";
  return o.categorised ? "extracted" : "needs_review";
}

export type RunStatus = "running" | "ok" | "partial" | "failed";

/**
 * Terminal status for a run. 'partial' when the run was truncated by the page cap or the provider
 * returned rows outside the requested window (a sign its filter did not do what we assumed).
 */
export function runOutcome(o: { error: string | null; truncated: boolean; skippedOutOfWindow: number }): Exclude<RunStatus, "running"> {
  if (o.error) return "failed";
  if (o.truncated || o.skippedOutOfWindow > 0) return "partial";
  return "ok";
}

/** One selected + mapped feed account, as snapshotted onto the run when it opened. */
export interface RunAccount {
  /** provider account id */
  p: string;
  /** Quillo accounts.id it lands in */
  a: string;
}

/** Resume point. `accounts` is a snapshot so a mid-run selection change cannot shift the index. */
export interface SyncCursor {
  accounts: RunAccount[];
  i: number;
  next: string | null;
}

export interface SyncCounters {
  pages: number;
  fetched: number;
  imported: number;
  duplicates: number;
  skippedPending: number;
  skippedOutOfWindow: number;
}

export interface SyncRun {
  id: string;
  connectionId: string;
  from: string;
  to: string;
  cursor: SyncCursor;
  counters: SyncCounters;
}

/** The page transport. Production binds the connection's provider fetchTransactionPage (bank-provider.ts); tests pass a fake. */
export type FeedTransport = (q: { providerAccountId: string; from: string; to: string; next: string | null }) => Promise<TransactionPageResult>;

export interface FeedCategory {
  bucket: string;
  ato_label: string;
  confidence: number;
  property_id?: string | null;
}

export interface SyncStepDeps {
  db: D1Database;
  userId: string;
  baseCurrency: string;
  transport: FeedTransport;
  /** Deterministic categorisation (user rules, then merchant hints for debits). */
  categorise: (merchant: string, direction: "debit" | "credit") => FeedCategory | null;
  /**
   * Is a selected account still selected and mapped to the same Quillo account? Re-checked per
   * account so a consumer who DESELECTS mid-run stops collection on the next page (CDR data
   * minimisation is about collection), and a remap mid-run cannot land lines in the old account.
   */
  stillSelected: (acct: RunAccount) => Promise<boolean>;
  /** Called once, BEFORE the first line of this step is written (the PS8 taint hook). */
  beforeFirstWrite?: () => Promise<void>;
  /**
   * bank_minimisation (#581): skip a line whose fingerprint is tombstoned (it was shrunk into a rollup), so a
   * re-sync can't revive it. Off/absent ⇒ the insert SQL is byte-identical and the 0081 table is never read.
   */
  honourTombstones?: boolean;
}

export interface SyncStepResult {
  done: boolean;
  truncated: boolean;
  pagesUsed: number;
  importedThisStep: number;
  error: string | null;
  correlationId: string | null;
  run: SyncRun;
}

export const emptyCounters = (): SyncCounters => ({ pages: 0, fetched: 0, imported: 0, duplicates: 0, skippedPending: 0, skippedOutOfWindow: 0 });

/** `skipped` is the SUM of counted reasons — never a residual that absorbs the unexplained. */
export const skippedOf = (c: SyncCounters) => c.duplicates + c.skippedPending + c.skippedOutOfWindow;

/**
 * Close 'running' rows nobody has checkpointed for STALE_RUN_MINUTES as 'failed'. An interrupted run
 * must never keep looking live (it would block every future sync) or healthy (it would read as
 * coverage). Re-syncing is safe: the importer is idempotent on the feed fingerprint.
 */
export async function closeStaleRuns(db: D1Database, userId: string): Promise<number> {
  const r = await db
    .prepare(
      `UPDATE bank_sync_runs
          SET status = 'failed', error = 'interrupted before completion — sync again to finish',
              cursor = NULL, finished_at = datetime('now'), updated_at = datetime('now')
        WHERE user_id = ? AND status = 'running'
          AND COALESCE(updated_at, created_at) < datetime('now', ?)`,
    )
    .bind(userId, `-${STALE_RUN_MINUTES} minutes`)
    .run();
  return Number(r.meta?.changes ?? 0);
}

/** One connection's latest sync run, for the Connect step's import progress (#586). Counts and dates only. */
export interface SyncRunStatus {
  connection_id: string;
  institution: string | null;
  status: "running" | "ok" | "partial" | "failed";
  /** A 'running' row nobody has checkpointed for STALE_RUN_MINUTES: interrupted, not live. */
  stale: boolean;
  fetched: number;
  imported: number;
  duplicates: number;
  from_date: string | null;
  to_date: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

/**
 * READ-ONLY: the most recent sync run per live connection (active or expired, never a withdrawn one,
 * whose lines are gone). Surfaces #511's run status in the UI: "still importing in the background",
 * "done", or a failed / partial run the user can retry. Writes nothing, so a status poll can never
 * race the importer; `stale` is computed here and recorded by the next sync's closeStaleRuns.
 */
export async function latestSyncRuns(db: D1Database, userId: string): Promise<SyncRunStatus[]> {
  const rows = await db
    .prepare(
      `SELECT r.connection_id, c.institution, c.institution_id, r.status, r.fetched, r.imported, r.duplicates,
              r.from_date, r.to_date, r.error, r.created_at, r.finished_at,
              (r.status = 'running' AND COALESCE(r.updated_at, r.created_at) < datetime('now', ?)) AS stale
         FROM bank_sync_runs r
         JOIN bank_connections c ON c.id = r.connection_id AND c.user_id = r.user_id
        WHERE r.user_id = ? AND c.status IN ('active', 'expired')
          AND r.id = (SELECT r2.id FROM bank_sync_runs r2
                       WHERE r2.user_id = r.user_id AND r2.connection_id = r.connection_id
                       ORDER BY r2.created_at DESC, r2.rowid DESC LIMIT 1)
        ORDER BY r.created_at DESC`,
    )
    .bind(`-${STALE_RUN_MINUTES} minutes`, userId)
    .all<{
      connection_id: string; institution: string | null; institution_id: string | null; status: string; fetched: number; imported: number;
      duplicates: number; from_date: string | null; to_date: string | null; error: string | null; created_at: string; finished_at: string | null; stale: number;
    }>();
  return (rows.results ?? []).map((r) => ({
    connection_id: r.connection_id,
    institution: r.institution ?? r.institution_id,
    status: (["running", "ok", "partial", "failed"].includes(r.status) ? r.status : "failed") as SyncRunStatus["status"],
    stale: Number(r.stale) === 1,
    fetched: Number(r.fetched ?? 0),
    imported: Number(r.imported ?? 0),
    duplicates: Number(r.duplicates ?? 0),
    from_date: r.from_date,
    to_date: r.to_date,
    error: r.error,
    created_at: r.created_at,
    finished_at: r.finished_at,
  }));
}

/**
 * Write the run row FIRST, as 'running'. Returns null when this connection already has a running
 * run — the concurrency guard (two tabs no longer both run a full pagination). Atomic: the
 * NOT EXISTS is part of the same INSERT statement, so two interleaved callers cannot both win.
 */
export async function openRun(
  db: D1Database,
  o: { userId: string; connectionId: string; from: string; to: string; accounts: RunAccount[] },
): Promise<SyncRun | null> {
  const id = crypto.randomUUID();
  const cursor: SyncCursor = { accounts: o.accounts, i: 0, next: null };
  const r = await db
    .prepare(
      `INSERT INTO bank_sync_runs (id, user_id, connection_id, from_date, to_date, status, cursor, updated_at)
       SELECT ?, ?, ?, ?, ?, 'running', ?, datetime('now')
        WHERE NOT EXISTS (SELECT 1 FROM bank_sync_runs WHERE user_id = ? AND connection_id = ? AND status = 'running')`,
    )
    .bind(id, o.userId, o.connectionId, o.from, o.to, JSON.stringify(cursor), o.userId, o.connectionId)
    .run();
  if (Number(r.meta?.changes ?? 0) === 0) return null;
  return { id, connectionId: o.connectionId, from: o.from, to: o.to, cursor, counters: emptyCounters() };
}

/** Re-load a running run (for an alarm continuation). Null when it is gone or already terminal. */
export async function loadRun(db: D1Database, userId: string, runId: string): Promise<SyncRun | null> {
  const row = await db
    .prepare(
      `SELECT id, connection_id, from_date, to_date, cursor, pages, fetched, imported, duplicates,
              skipped_pending, skipped_out_of_window
         FROM bank_sync_runs WHERE id = ? AND user_id = ? AND status = 'running'`,
    )
    .bind(runId, userId)
    .first<{
      id: string; connection_id: string; from_date: string; to_date: string; cursor: string | null;
      pages: number; fetched: number; imported: number; duplicates: number; skipped_pending: number; skipped_out_of_window: number;
    }>();
  if (!row || !row.cursor) return null;
  let cursor: SyncCursor;
  try {
    cursor = JSON.parse(row.cursor) as SyncCursor;
  } catch {
    return null;
  }
  if (!Array.isArray(cursor.accounts) || typeof cursor.i !== "number") return null;
  return {
    id: row.id,
    connectionId: row.connection_id,
    from: row.from_date,
    to: row.to_date,
    cursor,
    counters: {
      pages: row.pages, fetched: row.fetched, imported: row.imported, duplicates: row.duplicates,
      skippedPending: row.skipped_pending, skippedOutOfWindow: row.skipped_out_of_window,
    },
  };
}

/** Bump a queued run's heartbeat so the stale sweep does not mistake "waiting" for "dead". */
export async function touchRun(db: D1Database, userId: string, runId: string): Promise<void> {
  await db
    .prepare(`UPDATE bank_sync_runs SET updated_at = datetime('now') WHERE id = ? AND user_id = ? AND status = 'running'`)
    .bind(runId, userId)
    .run();
}

function checkpointStmt(db: D1Database, userId: string, run: SyncRun): D1PreparedStatement {
  const c = run.counters;
  return db
    .prepare(
      `UPDATE bank_sync_runs
          SET cursor = ?, pages = ?, fetched = ?, imported = ?, duplicates = ?, skipped_pending = ?,
              skipped_out_of_window = ?, skipped = ?, updated_at = datetime('now')
        WHERE id = ? AND user_id = ? AND status = 'running'`,
    )
    .bind(JSON.stringify(run.cursor), c.pages, c.fetched, c.imported, c.duplicates, c.skippedPending, c.skippedOutOfWindow, skippedOf(c), run.id, userId);
}

/**
 * Advance a run by at most `pageBudget` provider pages. Each page is written to D1 before the next
 * is fetched, and the run row's cursor + counters are checkpointed (a separate write) after the
 * page's insert batches — so a request that dies between pages loses at most the page in flight,
 * and the run row always says how far it got.
 *
 * Never throws for a provider/D1 failure: it returns `error` (+ the aggregator correlation id) so the
 * caller can record a 'failed' run rather than leave a 'running' one behind.
 */
export async function syncRunStep(deps: SyncStepDeps, run: SyncRun, pageBudget: number): Promise<SyncStepResult> {
  const { db, userId } = deps;
  let pagesUsed = 0;
  let importedThisStep = 0;
  let truncated = false;
  let wroteOnce = false;
  const cur = run.cursor;
  const c = run.counters;

  try {
    while (cur.i < cur.accounts.length && pagesUsed < pageBudget) {
      if (c.pages >= MAX_PAGES_PER_RUN) {
        truncated = true;
        break;
      }
      const acct = cur.accounts[cur.i]!;
      // Deselected or remapped since the run opened ⇒ stop collecting this account immediately.
      if (!(await deps.stillSelected(acct))) {
        cur.i++;
        cur.next = null;
        continue;
      }

      const page = await deps.transport({ providerAccountId: acct.p, from: run.from, to: run.to, next: cur.next });
      pagesUsed++;
      c.pages++;
      c.fetched += page.transactions.length;
      c.skippedPending += page.skippedPending;
      c.skippedOutOfWindow += page.skippedOutOfWindow;

      // Fingerprints are independent hashes — computed together rather than one await per row.
      const fps = await Promise.all(page.transactions.map((t) => feedFingerprint(t.id)));
      const inserts: D1PreparedStatement[] = [];
      // Per TENANT, like the feed fingerprint itself (the provider transaction id) — index idx_bank_tomb_fp (0081).
      const tombGuard = deps.honourTombstones
        ? `\n                  AND NOT EXISTS (SELECT 1 FROM bank_line_tombstones WHERE user_id = ? AND line_fingerprint = ?)`
        : "";
      page.transactions.forEach((t, k) => {
        const merchant = cleanMerchant(t.description);
        const transfer = isTransferLike(t.description);
        const cat = transfer ? null : deps.categorise(merchant, t.direction);
        const unconverted = t.currency !== deps.baseCurrency;
        const status = feedLineStatus({ transfer, unconverted, categorised: !!cat });
        inserts.push(
          db
            .prepare(
              // CROSS-ACCOUNT DEDUP. The unique index is (user_id, account_id, line_fingerprint), so
              // it cannot see a line already imported under a DIFFERENT Quillo account — re-pointing a
              // feed account used to re-import the whole year and leave both copies counting. A feed
              // fingerprint is the provider's transaction id, unique per tenant, so NOT EXISTS over
              // (user_id, line_fingerprint) is the guard (index idx_txn_user_fingerprint, 0086).
              //
              // LIVE-CONSENT GATE (#576). stillSelected runs BEFORE the provider fetch, and the fetch
              // yields the DO — a withdrawal can complete in that gap (status='revoked', PS12 delete,
              // account handed back to statements). Re-checking the consent INSIDE the insert means a
              // resumed step can never land lines after the delete ran.
              `INSERT INTO transactions
                 (id, user_id, source, status, kind, account_id, statement_id, line_fingerprint, raw_description,
                  merchant, amount_cents, currency, amount_aud_cents, txn_date, direction, bucket, ato_label, confidence, property_id)
               SELECT ?, ?, 'cdr_feed', ?, 'bank_line', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                WHERE NOT EXISTS (SELECT 1 FROM transactions WHERE user_id = ? AND line_fingerprint = ?)
                  AND EXISTS (SELECT 1 FROM bank_connections WHERE id = ? AND user_id = ? AND status = 'active')${tombGuard}
               ON CONFLICT(user_id, account_id, line_fingerprint) DO NOTHING`,
            )
            .bind(
              crypto.randomUUID(), userId, status, acct.a, fps[k], t.description, merchant,
              t.amountCents, t.currency,
              // NOT silently treated as base currency: NULL + the FX_CONVERTED guard keeps an
              // unconverted foreign line out of every money sum rather than counting USD as AUD.
              unconverted ? null : t.amountCents,
              t.postDate, t.direction,
              cat?.bucket ?? null, cat?.ato_label ?? null, cat ? cat.confidence : null, cat?.property_id ?? null,
              userId, fps[k],
              run.connectionId, userId,
              ...(deps.honourTombstones ? [userId, fps[k]] : []),
            ),
        );
      });

      // Advance the in-memory cursor now; it is persisted by the checkpoint after the writes.
      if (page.next) cur.next = page.next;
      else {
        cur.i++;
        cur.next = null;
      }

      if (inserts.length && !wroteOnce) {
        wroteOnce = true;
        if (deps.beforeFirstWrite) await deps.beforeFirstWrite();
      }

      let imported = 0;
      for (let i = 0; i < inserts.length; i += INSERT_CHUNK) {
        const res = await db.batch(inserts.slice(i, i + INSERT_CHUNK));
        let n = 0;
        for (const r of res) n += Number(r.meta?.changes ?? 0);
        // Counted per batch, as each lands: if a later chunk throws, the rows already committed are
        // still recorded as imported — so the run stays eligible for the post-import pipeline.
        imported += n;
        c.imported += n;
        importedThisStep += n;
      }
      // Counted, not inferred: every fetched row either inserted or was already held.
      c.duplicates += page.transactions.length - imported;
      // Checkpoint as a separate write AFTER the page's batches, so the persisted cursor never points
      // past unwritten rows (a death in between re-fetches the page; dedup makes that safe).
      const ck = await checkpointStmt(db, userId, run).run();
      // Zero rows matched ⇒ the run was closed under us (a stale sweep, a purge). Stop collecting.
      if (Number(ck.meta?.changes ?? 0) === 0) throw new Error("sync run was closed while in progress");
    }
  } catch (e) {
    return {
      done: true, truncated, pagesUsed, importedThisStep,
      error: (e as Error).message || "sync failed",
      correlationId: e instanceof ProviderError ? (e.correlationId ?? null) : null,
      run,
    };
  }

  if (!truncated && cur.i < cur.accounts.length && c.pages >= MAX_PAGES_PER_RUN) truncated = true;
  return { done: truncated || cur.i >= cur.accounts.length, truncated, pagesUsed, importedThisStep, error: null, correlationId: null, run };
}

/**
 * Close a run with its terminal status. `last_sync_at` moves only when the run did NOT fail — a
 * failed run stamping it made the connection look freshly synced when nothing landed.
 */
export async function finishRun(
  db: D1Database,
  userId: string,
  run: SyncRun,
  o: { status: Exclude<RunStatus, "running">; error: string | null; correlationId: string | null },
): Promise<void> {
  const c = run.counters;
  await db.batch([
    db
      .prepare(
        `UPDATE bank_sync_runs
            SET status = ?, error = ?, correlation_id = ?, cursor = NULL,
                pages = ?, fetched = ?, imported = ?, duplicates = ?, skipped_pending = ?,
                skipped_out_of_window = ?, skipped = ?,
                finished_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND user_id = ? AND status = 'running'`,
      )
      .bind(o.status, o.error, o.correlationId, c.pages, c.fetched, c.imported, c.duplicates, c.skippedPending, c.skippedOutOfWindow, skippedOf(c), run.id, userId),
    // A run already closed under us (stale sweep) keeps ITS terminal status — a zombie step must not
    // overwrite 'failed' with 'ok' — but must not under-report lines it really wrote, or it would
    // drop out of the post-import pipeline (which keys on imported > 0).
    db
      .prepare(`UPDATE bank_sync_runs SET imported = MAX(imported, ?) WHERE id = ? AND user_id = ?`)
      .bind(c.imported, run.id, userId),
    db
      .prepare(
        `UPDATE bank_connections
            SET last_sync_at = CASE WHEN ? = 'failed' THEN last_sync_at ELSE datetime('now') END,
                last_error = ?
          WHERE id = ? AND user_id = ? AND status <> 'revoked'`,
      )
      // A withdrawn connection's row is the consumer's record of the withdrawal (#576) — a zombie
      // step must not stamp a fresh sync time or overwrite its revoke status message.
      .bind(o.status, o.error, run.connectionId, userId),
  ]);
}
