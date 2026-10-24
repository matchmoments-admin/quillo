import { mapBatchItems, type BatchItem } from "../extract";
import type { CategoriseMode } from "./features";

/**
 * Statement categorisation that outlives the upload request (review F2, flag `import_continuation`).
 *
 * WHY THIS EXISTS. Bedrock is the default provider and has no Message Batches API, so every Bedrock
 * statement import used to be categorised LIVE inside the upload request, three 40-line chunks at a
 * time. A 2,000-line import is 50 chunks ≈ 85-255 s, past the ~100 s edge timeout: the request died
 * part-way and the user saw an error for an import that had in fact landed. The recategorise backfill
 * (`{ bulk: true }`) had the same problem, behind a "bulk → batch" comment that stopped being true.
 *
 * THE SHAPE (mirrors the bank-feed backfill, src/lib/bank-sync.ts + ADR-0001's amendment):
 *
 *   startCategorisation  → in the upload request: categorise up to INLINE_MAX_CHUNKS (or until
 *                          INLINE_TIME_BUDGET_MS), then, if lines remain, open a job row and schedule
 *                          hop 1 on a DO alarm. The request returns "categorising N more in the background".
 *   runHop               → each alarm hop: the next HOP_MAX_CHUNKS through the same model call, a budget
 *                          check before every round, then commit the cursor and schedule the next hop,
 *                          or finish (finalise + notify), or stop on a budget refusal (notify).
 *
 * STATE lives in D1, never in the DO: the job is a `batch_jobs` row with status 'continuing' and its
 * cursor in `chunk_map` (JSON), and the statement reads status 'categorising' while it runs, so the
 * Accounts / Connect pages show their existing "Sorting X of N" progress (listStatements counts the
 * categorised lines) and poll until it flips back to 'imported'. No migration: the Anthropic poller only
 * reads status 'submitted', so a 'continuing' row is invisible to it. The alarm payload carries only
 * { userId, jobId, hop }.
 *
 * IDEMPOTENT AND EXACTLY-ONCE.
 *   - Only lines still `needs_review` are read, and every UPDATE is guarded by `status='needs_review'`,
 *     so a line is categorised once however many times a slice runs.
 *   - The cursor (last line id attempted, lines read in id order) means a line the model left out is
 *     not retried forever: the chain moves past it and it stays needs_review for the user.
 *   - A hop runs only when the job's committed hop is payload.hop - 1, and commits with an optimistic
 *     `WHERE hop = payload.hop - 1`. A duplicate or stale alarm is a no-op; a hop that died before it
 *     committed (DO eviction) re-runs from the same cursor and re-reads only what is still pending.
 *
 * Everything here takes its I/O as arguments (a D1 handle, the model call, the scheduler), so the
 * chain is unit-tested with fakes (scripts/check-units.ts, "import continuation").
 */

/** Lines per model call (the batch prompt's chunk). */
export const CHUNK_LINES = 40;
/** Chunks per round on the Bedrock live path; the `au.` profile's on-demand quota applies. */
export const CONTINUATION_CONCURRENCY = 3;
/** In the upload request: at most this many chunks (480 lines), so a normal statement still finishes inline. */
export const INLINE_MAX_CHUNKS = 12;
/** In the upload request: no new round starts after this, well inside the ~100 s edge timeout. */
export const INLINE_TIME_BUDGET_MS = 25_000;
/** Per alarm hop. The SDK can run a due callback inside blockConcurrencyWhile (30 s) on a cold start. */
export const HOP_MAX_CHUNKS = 6;
export const HOP_TIME_BUDGET_MS = 15_000;
/** Backstop: 400 hops x 240 lines is far past any real statement. */
export const MAX_HOPS = 400;
/** A model error in a hop is retried this many times (same hop, same cursor) before the job fails. */
export const MAX_HOP_RETRIES = 2;
export const RETRY_DELAY_SECONDS = 30;
/** The `batch_jobs.status` of a live continuation job. */
export const CONTINUING = "continuing";
/**
 * A 'continuing' job whose last commit is older than this has lost its alarm (a schedule that never
 * fired); the frequent cron re-delivers its next hop (staleJobs). Hops commit every few seconds.
 */
export const CONTINUATION_STALE_MS = 15 * 60 * 1000;

// Routing thresholds, moved here from src/agent.ts so the route decision is a pure, tested function.
/** Above this many lines, `auto` mode sends an Anthropic tenant's import to the async Batch API. */
export const BATCH_THRESHOLD = 60;
/** Forced `live` mode falls back to batch past this many lines (one request can't hold it). */
export const LIVE_MAX_LINES = 200;

export type CategoriseRoute = "batch" | "live" | "continuation";

/**
 * Which path a statement categorisation takes. With `continuation` OFF this is exactly the routing
 * src/agent.ts always did (batch, or the in-request live loop). With it ON, the ONLY change is that a
 * tenant who cannot batch (Bedrock) gets the continuation instead of the in-request loop. An Anthropic
 * tenant routes identically whatever the flag says.
 */
export function categoriseRoute(i: {
  canBatch: boolean;
  mode: CategoriseMode;
  lines: number;
  bulk: boolean;
  continuation: boolean;
}): { route: CategoriseRoute; fallback: boolean } {
  let useBatch = i.canBatch && (i.mode === "batch" || (i.mode === "auto" && i.lines > BATCH_THRESHOLD));
  const fallback = i.mode === "live" && (i.bulk || i.lines > LIVE_MAX_LINES);
  if (fallback) useBatch = i.canBatch;
  if (useBatch) return { route: "batch", fallback };
  return { route: i.continuation && !i.canBatch ? "continuation" : "live", fallback };
}

export interface PendingLine {
  id: string;
  merchant: string | null;
  amount_cents: number | null;
  txn_date: string | null;
  direction: string | null;
}

export interface ContinuationState {
  kind: "live_continuation";
  /** Last line id attempted; the next slice reads ids strictly after it. null = from the start. */
  cursor: string | null;
  /** The last COMMITTED hop (0 = the inline slice in the upload request). */
  hop: number;
  /** Lines categorised so far across the whole chain (inline + hops). */
  categorised: number;
  updated_ms: number;
}

export interface HopPayload {
  userId: string;
  jobId: string;
  hop: number;
  /** Retries of THIS hop after a model error (0 on the first attempt). */
  attempt?: number;
}

export interface SliceDeps {
  db: D1Database;
  userId: string;
  /** The per-tenant + global cost caps, checked before every round. */
  withinBudget(): Promise<boolean>;
  /** One model call for one chunk (already shaped for the model by `prepare`). */
  extract(chunk: PendingLine[]): Promise<BatchItem[]>;
  /** Model-input shaping (S8b redaction). Must keep each row's id. Default: identity. */
  prepare?(rows: PendingLine[]): PendingLine[];
  now?(): number;
}

export interface SliceResult {
  categorised: number;
  /** Last line id attempted (unchanged if nothing was read). */
  cursor: string | null;
  /** The budget gate refused before a round; the rest stays needs_review. */
  budgetStopped: boolean;
  /** Lines still pending after the cursor (0 ⇒ the statement is done). */
  remaining: number;
}

const pendingWhere = (cursor: string | null) =>
  `user_id = ? AND statement_id = ? AND kind = 'bank_line' AND status = 'needs_review'${cursor == null ? "" : " AND id > ?"}`;

/** Lines still to categorise after `cursor`, in id order (the order the cursor walks). */
export async function pendingLines(db: D1Database, userId: string, statementId: string, cursor: string | null, limit: number): Promise<PendingLine[]> {
  const binds: unknown[] = [userId, statementId];
  if (cursor != null) binds.push(cursor);
  const r = await db.prepare(
    `SELECT id, merchant, amount_cents, txn_date, direction FROM transactions WHERE ${pendingWhere(cursor)} ORDER BY id LIMIT ?`,
  ).bind(...binds, limit).all<PendingLine>();
  return r.results ?? [];
}

export async function countPending(db: D1Database, userId: string, statementId: string, cursor: string | null): Promise<number> {
  const binds: unknown[] = [userId, statementId];
  if (cursor != null) binds.push(cursor);
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${pendingWhere(cursor)}`).bind(...binds).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/**
 * Categorise the next slice of a statement: up to `maxChunks` chunks of CHUNK_LINES, `concurrency` at
 * a time, stopping early when the budget refuses or `timeBudgetMs` has passed (checked between rounds,
 * so a round already started always finishes and is written). Writes are guarded by
 * `status='needs_review'` and counted by rows actually changed.
 */
export async function categoriseSlice(
  deps: SliceDeps,
  o: { statementId: string; cursor: string | null; maxChunks: number; timeBudgetMs: number; concurrency?: number },
): Promise<SliceResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const concurrency = Math.max(1, o.concurrency ?? CONTINUATION_CONCURRENCY);
  const rows = await pendingLines(deps.db, deps.userId, o.statementId, o.cursor, Math.max(0, o.maxChunks) * CHUNK_LINES);
  const items = deps.prepare ? deps.prepare(rows) : rows;
  const chunks: PendingLine[][] = [];
  for (let i = 0; i < items.length; i += CHUNK_LINES) chunks.push(items.slice(i, i + CHUNK_LINES));

  let cursor = o.cursor;
  let categorised = 0;
  let budgetStopped = false;
  for (let i = 0; i < chunks.length; i += concurrency) {
    if (i > 0 && now() - started >= o.timeBudgetMs) break;
    if (!(await deps.withinBudget())) {
      budgetStopped = true;
      break;
    }
    const round = chunks.slice(i, i + concurrency);
    // allSettled, not all: a chunk that errors must not throw away its siblings' answers (already paid
    // for). They are written first; then the error propagates, the hop's cursor is NOT committed, and
    // the retry re-reads only what is still needs_review — so nothing written here is sent again.
    const settled = await Promise.allSettled(round.map((chunk) => deps.extract(chunk)));
    const updates: D1PreparedStatement[] = [];
    round.forEach((chunk, k) => {
      const r = settled[k]!;
      if (r.status !== "fulfilled") return;
      for (const { id, item } of mapBatchItems(chunk.map((c) => c.id), r.value)) {
        updates.push(
          deps.db.prepare(
            `UPDATE transactions SET status='extracted', bucket=?, ato_label=?, confidence=?, reasoning=?
              WHERE id=? AND user_id=? AND status='needs_review'`,
          ).bind(item.bucket, item.ato_label, item.confidence, item.reasoning, id, deps.userId),
        );
      }
    });
    for (let k = 0; k < updates.length; k += 50) {
      const res = await deps.db.batch(updates.slice(k, k + 50));
      categorised += res.reduce((s, r) => s + Number(r.meta?.changes ?? 0), 0);
    }
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    // Lines are read in id order and chunked in that order, so the round's last line is the cursor.
    const last = round[round.length - 1]!;
    cursor = last[last.length - 1]!.id;
  }
  const remaining = await countPending(deps.db, deps.userId, o.statementId, cursor);
  return { categorised, cursor, budgetStopped, remaining };
}

// ── The job row (batch_jobs, status 'continuing') ─────────────────────────────────────────────────

export interface ContinuationJob {
  id: string;
  statement_id: string;
  status: string;
  state: ContinuationState;
}

function parseState(raw: string | null): ContinuationState | null {
  try {
    const s = JSON.parse(raw ?? "") as ContinuationState;
    return s && s.kind === "live_continuation" && Number.isInteger(s.hop) ? s : null;
  } catch {
    return null;
  }
}

export async function loadJob(db: D1Database, userId: string, jobId: string): Promise<ContinuationJob | null> {
  const r = await db.prepare(`SELECT id, statement_id, status, chunk_map FROM batch_jobs WHERE id = ? AND user_id = ?`)
    .bind(jobId, userId).first<{ id: string; statement_id: string; status: string; chunk_map: string | null }>();
  if (!r) return null;
  const state = parseState(r.chunk_map);
  return state ? { id: r.id, statement_id: r.statement_id, status: r.status, state } : null;
}

/** The statement's live continuation job, if one is running (a second start must not fork the chain). */
export async function runningJobFor(db: D1Database, userId: string, statementId: string): Promise<string | null> {
  const r = await db.prepare(`SELECT id FROM batch_jobs WHERE user_id = ? AND statement_id = ? AND status = ? LIMIT 1`)
    .bind(userId, statementId, CONTINUING).first<{ id: string }>();
  return r?.id ?? null;
}

/** True when this payload is the job's next hop. Anything else (duplicate, stale, closed) is a no-op. */
export function hopIsDue(job: ContinuationJob | null, payload: HopPayload): job is ContinuationJob {
  return !!job && job.status === CONTINUING && job.state.hop === payload.hop - 1;
}

async function openJob(db: D1Database, userId: string, statementId: string, state: ContinuationState): Promise<string> {
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO batch_jobs (id, user_id, statement_id, batch_id, status, chunk_map) VALUES (?, ?, ?, NULL, ?, ?)`)
      .bind(id, userId, statementId, CONTINUING, JSON.stringify(state)),
    db.prepare(`UPDATE statements SET status = 'categorising' WHERE id = ? AND user_id = ?`).bind(statementId, userId),
  ]);
  return id;
}

/** Commit a hop's progress, but only if no other run committed this hop first. */
async function commitHop(db: D1Database, userId: string, jobId: string, expectedHop: number, next: ContinuationState): Promise<boolean> {
  const r = await db.prepare(
    `UPDATE batch_jobs SET chunk_map = ?
      WHERE id = ? AND user_id = ? AND status = ? AND json_extract(chunk_map, '$.hop') = ?`,
  ).bind(JSON.stringify(next), jobId, userId, CONTINUING, expectedHop).run();
  return Number(r.meta?.changes ?? 0) === 1;
}

/** End the job. The statement goes back to 'imported' whatever the outcome: its lines ARE imported. */
async function closeJob(db: D1Database, userId: string, job: ContinuationJob, status: "applied" | "stopped" | "failed", state: ContinuationState): Promise<boolean> {
  const res = await db.batch([
    db.prepare(`UPDATE batch_jobs SET status = ?, chunk_map = ? WHERE id = ? AND user_id = ? AND status = ?`)
      .bind(status, JSON.stringify(state), job.id, userId, CONTINUING),
    db.prepare(`UPDATE statements SET status = 'imported' WHERE id = ? AND user_id = ? AND status = 'categorising'`)
      .bind(job.statement_id, userId),
  ]);
  return Number(res[0]?.meta?.changes ?? 0) === 1;
}

// ── Orchestration ────────────────────────────────────────────────────────────────────────────────

export interface ChainDeps extends SliceDeps {
  schedule(delaySeconds: number, payload: HopPayload): Promise<void>;
  notify(body: string): Promise<void>;
  audit(event: string, detail: string): Promise<void>;
  /** The post-categorisation pipeline (deductibility stamp, asset links, …), once the chain ends. */
  finalise(statementId: string): Promise<void>;
  /** The user-facing reason a budget gate refused (empty wallet vs daily cap). */
  budgetReason?(): Promise<string>;
}

const lines = (n: number) => `${n.toLocaleString("en-AU")} transaction${n === 1 ? "" : "s"}`;

async function budgetMessage(deps: ChainDeps, categorised: number, remaining: number): Promise<string> {
  const why = deps.budgetReason ? await deps.budgetReason().catch(() => "") : "";
  return `Categorised ${lines(categorised)} from your statement, then stopped: ${why || "the AI budget is used up for now"}. ` +
    `The other ${lines(remaining)} are imported and waiting in Review.`;
}

export interface StartResult {
  categorised: number;
  /** Lines left to the background chain (0 ⇒ finished inline, or stopped on budget). */
  background: number;
  budgetStopped: boolean;
  jobId: string | null;
}

/**
 * The upload request's part: categorise a bounded first slice, then hand the rest to an alarm chain.
 * `inlineChunks` 0 (the bulk paths) does no model work here at all and schedules the chain straight away.
 */
export async function startCategorisation(
  deps: ChainDeps,
  o: { statementId: string; inlineChunks?: number; inlineTimeBudgetMs?: number },
): Promise<StartResult> {
  // Already continuing (a recategorise backfill racing an upload): that chain covers these lines.
  if (await runningJobFor(deps.db, deps.userId, o.statementId)) return { categorised: 0, background: 0, budgetStopped: false, jobId: null };
  const inline = Math.max(0, o.inlineChunks ?? INLINE_MAX_CHUNKS);
  const slice = inline > 0
    ? await categoriseSlice(deps, { statementId: o.statementId, cursor: null, maxChunks: inline, timeBudgetMs: o.inlineTimeBudgetMs ?? INLINE_TIME_BUDGET_MS })
    : { categorised: 0, cursor: null, budgetStopped: false, remaining: await countPending(deps.db, deps.userId, o.statementId, null) };

  if (slice.budgetStopped) {
    await deps.audit("categorise_stopped_budget", JSON.stringify({ statementId: o.statementId, categorised: slice.categorised, remaining: slice.remaining, hop: 0 }));
    await deps.notify(await budgetMessage(deps, slice.categorised, slice.remaining));
    return { categorised: slice.categorised, background: 0, budgetStopped: true, jobId: null };
  }
  if (slice.remaining === 0) return { categorised: slice.categorised, background: 0, budgetStopped: false, jobId: null };

  const state: ContinuationState = { kind: "live_continuation", cursor: slice.cursor, hop: 0, categorised: slice.categorised, updated_ms: (deps.now ?? Date.now)() };
  const jobId = await openJob(deps.db, deps.userId, o.statementId, state);
  await deps.audit("categorise_continuation_started", JSON.stringify({ statementId: o.statementId, jobId, categorised: slice.categorised, remaining: slice.remaining }));
  // Scheduled LAST, so the first hop can never interleave with this request's own writes. If the
  // schedule itself fails, the cron's stale sweep re-delivers hop 1 (the job row is already durable).
  await deps.schedule(1, { userId: deps.userId, jobId, hop: 1 }).catch((e) =>
    deps.audit("categorise_continuation_schedule_failed", JSON.stringify({ jobId, hop: 1, error: String((e as Error)?.message ?? e).slice(0, 200) })));
  return { categorised: slice.categorised, background: slice.remaining, budgetStopped: false, jobId };
}

export type HopOutcome = "noop" | "scheduled" | "done" | "stopped_budget" | "retry" | "failed" | "stopped";

/**
 * One alarm hop. Never throws: the Agents scheduler swallows callback errors and deletes the trigger,
 * so every failure is recorded on the job row (and the statement released) here.
 */
export async function runHop(deps: ChainDeps, payload: HopPayload): Promise<HopOutcome> {
  const job = await loadJob(deps.db, deps.userId, payload.jobId);
  if (!hopIsDue(job, payload)) return "noop";
  const now = deps.now ?? Date.now;
  let slice: SliceResult;
  try {
    slice = await categoriseSlice(deps, { statementId: job.statement_id, cursor: job.state.cursor, maxChunks: HOP_MAX_CHUNKS, timeBudgetMs: HOP_TIME_BUDGET_MS });
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 200);
    const attempt = payload.attempt ?? 0;
    if (attempt < MAX_HOP_RETRIES) {
      await deps.audit("categorise_continuation_retry", JSON.stringify({ jobId: job.id, hop: payload.hop, attempt: attempt + 1, error }));
      // A failed retry schedule leaves the job uncommitted: the cron's stale sweep re-delivers this hop.
      await deps.schedule(RETRY_DELAY_SECONDS, { ...payload, attempt: attempt + 1 }).catch(() => {});
      return "retry";
    }
    const remaining = await countPending(deps.db, deps.userId, job.statement_id, job.state.cursor).catch(() => 0);
    await closeJob(deps.db, deps.userId, job, "failed", { ...job.state, updated_ms: now() });
    await deps.audit("categorise_continuation_failed", JSON.stringify({ jobId: job.id, hop: payload.hop, error }));
    await deps.notify(`Background categorisation stopped after ${lines(job.state.categorised)}. The other ${lines(remaining)} are imported and waiting in Review.`);
    return "failed";
  }

  const next: ContinuationState = { ...job.state, cursor: slice.cursor, hop: payload.hop, categorised: job.state.categorised + slice.categorised, updated_ms: now() };
  if (slice.budgetStopped) {
    if (!(await closeJob(deps.db, deps.userId, job, "stopped", next))) return "noop";
    await deps.audit("categorise_stopped_budget", JSON.stringify({ statementId: job.statement_id, jobId: job.id, categorised: next.categorised, remaining: slice.remaining, hop: payload.hop }));
    await deps.notify(await budgetMessage(deps, next.categorised, slice.remaining));
    await deps.finalise(job.statement_id); // what WAS categorised still gets its deductibility stamp
    return "stopped_budget";
  }
  if (slice.remaining > 0 && payload.hop < MAX_HOPS) {
    // Another run committed this hop first: its own schedule carries the chain on.
    if (!(await commitHop(deps.db, deps.userId, job.id, payload.hop - 1, next))) return "noop";
    await deps.schedule(1, { userId: deps.userId, jobId: job.id, hop: payload.hop + 1 }).catch((e) =>
      deps.audit("categorise_continuation_schedule_failed", JSON.stringify({ jobId: job.id, hop: payload.hop + 1, error: String((e as Error)?.message ?? e).slice(0, 200) })));
    return "scheduled";
  }
  if (!(await closeJob(deps.db, deps.userId, job, "applied", next))) return "noop";
  // Lines the model left out (behind the cursor) or past the hop backstop: the user finishes those.
  const left = await countPending(deps.db, deps.userId, job.statement_id, null);
  await deps.audit("statement_categorised", JSON.stringify({ statementId: job.statement_id, categorised: next.categorised, hops: payload.hop, left }));
  await deps.finalise(job.statement_id);
  await deps.notify(
    left > 0
      ? `Categorised ${lines(next.categorised)} from your statement; ${lines(left)} are left for you in Review.`
      : `Finished categorising ${lines(next.categorised)} from your statement.`,
  );
  return "done";
}

/** Release a job without model work (flag turned off, consent withdrawn): the lines stay needs_review. */
export async function stopJob(deps: Pick<ChainDeps, "db" | "userId" | "audit" | "notify">, jobId: string, reason: string, notice: string | null): Promise<boolean> {
  const job = await loadJob(deps.db, deps.userId, jobId);
  if (!job || job.status !== CONTINUING) return false;
  if (!(await closeJob(deps.db, deps.userId, job, "stopped", { ...job.state, updated_ms: Date.now() }))) return false;
  await deps.audit("categorise_continuation_stopped", JSON.stringify({ jobId, reason }));
  if (notice) await deps.notify(notice);
  return true;
}

/**
 * Jobs whose alarm chain went quiet (no commit for CONTINUATION_STALE_MS), with the hop to re-deliver.
 * Re-delivering is safe: the hop is due only if nothing committed it, and runHop is idempotent.
 */
export async function staleJobs(db: D1Database, nowMs: number, limit = 50): Promise<HopPayload[]> {
  const r = await db.prepare(
    `SELECT id, user_id, json_extract(chunk_map, '$.hop') AS hop FROM batch_jobs
      WHERE status = ? AND json_extract(chunk_map, '$.kind') = 'live_continuation'
        AND json_extract(chunk_map, '$.updated_ms') < ?
      LIMIT ?`,
  ).bind(CONTINUING, nowMs - CONTINUATION_STALE_MS, limit).all<{ id: string; user_id: string; hop: number }>();
  return (r.results ?? []).map((j) => ({ userId: j.user_id, jobId: j.id, hop: Number(j.hop) + 1 }));
}
