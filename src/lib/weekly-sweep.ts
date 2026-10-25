import type { Env, TaxAgentRpc } from "../env";
import { featureOn } from "./features";
import { AU_DESCRIPTOR, fyStartYearForDate } from "./jurisdiction";
import { emptyTally, publishLifecycleRecord, type LifecycleTally } from "./retention-schedule";
import { platformDb } from "./tenant-db";

/**
 * The weekly per-tenant maintenance sweep (proactive scan, depreciation roll-forward, retention flagging,
 * advisory, CDR consent lifecycle, data lifecycle). It is paged: each call processes ONE bounded slice of
 * tenants after the cursor and advances it. The Monday cron STARTS a sweep; while one is in progress, every
 * 10-minute tick runs the next slice, so N tenants finish in ceil(N / SLICE) ticks the same day (~57k
 * tenants/day at 400 a tick). A Queue consumer is the next step if per-tenant retries or more throughput are
 * needed; the per-tenant unit of work is already isolated for it.
 *
 * State lives in ONE D1 row (cron_sweeps, migration 0091), not KV: D1 is strongly consistent, so the lease
 * is a conditional UPDATE that exactly one tick can win (two ticks can never run the same slice), the
 * cursor can't be read stale, and the lifecycle tally accumulates across slices and is published per sweep.
 * cursor NULL = idle; a string (possibly '') = in progress.
 *
 * A slice runs in CHUNKs and checkpoints after each one (cursor, tally, lease renewal), and stops at a time
 * budget well inside the lease. So a tick killed mid-slice re-runs at most one chunk, a slow slice can never
 * outlive its lease into a parallel run, and a chunk that keeps killing its tick is skipped after
 * MAX_ATTEMPTS lease takeovers rather than retried forever. A sweep stuck for STALE_DAYS can be restarted
 * by the Monday tick, so it can't block the next week either.
 */
export const WEEKLY_SLICE = 400;
export const WEEKLY_SWEEP = "weekly";
export const WEEKLY_CHUNK = 24; // tenants per checkpoint (4 rounds at concurrency 6)
const CONCURRENCY = 6;
const LEASE_S = 900; // renewed at every checkpoint, so it only has to outlast one chunk
const BUDGET_MS = 240_000; // a slice stops starting chunks after this, leaving the tick time for its other work
const MAX_ATTEMPTS = 3; // lease takeovers without a checkpoint before the next chunk is skipped
const STALE_DAYS = 6; // an in-progress sweep older than this no longer blocks Monday's start

/** Run `fn` over `items` with at most `concurrency` in flight. fn must not throw (callers catch
 *  per-item) — a rejection would abort the worker and starve the rest of the slice. */
export async function runPooled<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

/** The Monday tick: start a sweep unless one is already in progress (or stuck for STALE_DAYS). Independent of
 *  the lease, so a slice that is still running at 08:00 can't swallow the week's start. */
export async function startWeeklySweep(env: Env): Promise<boolean> {
  const r = await platformDb(env).prepare(
    `INSERT INTO cron_sweeps (name, cursor, tally_json, started_at) VALUES (?, '', NULL, datetime('now'))
     ON CONFLICT(name) DO UPDATE SET cursor = '', tally_json = NULL, started_at = datetime('now'), attempts = 0
       WHERE cron_sweeps.cursor IS NULL OR cron_sweeps.started_at < datetime('now', ?)`,
  ).bind(WEEKLY_SWEEP, `-${STALE_DAYS} days`).run();
  return Number(r.meta?.changes ?? 0) === 1;
}

/** True while a sweep is part-way through (the 10-minute tick continues it). One indexed D1 read. */
export async function weeklySweepInProgress(env: Env): Promise<boolean> {
  const row = await platformDb(env).prepare(`SELECT cursor FROM cron_sweeps WHERE name = ?`).bind(WEEKLY_SWEEP).first<{ cursor: string | null }>();
  return row != null && row.cursor != null;
}

/** Take the slice lease atomically: exactly one caller's conditional UPDATE changes the row. Each take counts
 *  as an attempt at the next chunk; a checkpoint resets the count. */
async function acquireLease(env: Env, holder: string): Promise<boolean> {
  const r = await platformDb(env).prepare(
    `UPDATE cron_sweeps SET lease_holder = ?, lease_until = datetime('now', ?), attempts = attempts + 1
      WHERE name = ? AND cursor IS NOT NULL AND (lease_until IS NULL OR lease_until < datetime('now'))`,
  ).bind(holder, `+${LEASE_S} seconds`, WEEKLY_SWEEP).run();
  return Number(r.meta?.changes ?? 0) === 1;
}

/** Save progress and renew the lease, only while this tick still holds it. False ⇒ the lease was lost. */
async function checkpoint(env: Env, holder: string, cursor: string | null, tally: LifecycleTally): Promise<boolean> {
  const r = await platformDb(env).prepare(
    `UPDATE cron_sweeps SET cursor = ?, tally_json = ?, attempts = 0, lease_until = datetime('now', ?)
      WHERE name = ? AND lease_holder = ?`,
  ).bind(cursor, JSON.stringify(tally), `+${LEASE_S} seconds`, WEEKLY_SWEEP, holder).run();
  return Number(r.meta?.changes ?? 0) === 1;
}

const addTally = (a: LifecycleTally, b: LifecycleTally): LifecycleTally =>
  Object.fromEntries(Object.keys(a).map((k) => [k, a[k as keyof LifecycleTally] + (b[k as keyof LifecycleTally] ?? 0)])) as unknown as LifecycleTally;

export type WeeklySliceResult = { swept: number; done: boolean } | { skipped: "leased" | "idle" };

export async function runWeeklySlice(
  env: Env,
  stubFor: (env: Env, userId: string) => TaxAgentRpc,
  opts: { budgetMs?: number; now?: () => number } = {},
): Promise<WeeklySliceResult> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? BUDGET_MS);
  if (!(await weeklySweepInProgress(env))) return { skipped: "idle" };
  const holder = crypto.randomUUID();
  if (!(await acquireLease(env, holder))) return { skipped: "leased" };
  try {
    // Current FY start year for the depreciation roll-forward (the sweep is AU-only today).
    const fyStart = fyStartYearForDate(AU_DESCRIPTOR, new Date().toISOString().slice(0, 10));
    // Paged (#79) so a large tenant set can't blow one tick's wall-clock and drop the tail: a bounded,
    // ordered slice (round-robin by user_id), swept in checkpointed chunks with bounded concurrency.
    const SLICE = WEEKLY_SLICE;
    const state = await platformDb(env).prepare(`SELECT cursor, tally_json, attempts FROM cron_sweeps WHERE name = ?`).bind(WEEKLY_SWEEP).first<{ cursor: string | null; tally_json: string | null; attempts: number | null }>();
    const startCursor = state?.cursor ?? "";
    const users = await platformDb(env).prepare(`SELECT user_id FROM profiles WHERE user_id > ? ORDER BY user_id LIMIT ?`)
      .bind(startCursor, SLICE)
      .all<{ user_id: string }>();
    const batch = users.results ?? [];
    // #639: the data-lifecycle tally — counts only — accumulates across the sweep's slices, so the dashboard
    // record always shows the WHOLE sweep so far.
    let total = emptyTally();
    try { if (state?.tally_json) total = { ...total, ...(JSON.parse(state.tally_json) as LifecycleTally) }; } catch { /* corrupt ⇒ restart the tally */ }
    // A full slice means more tenants may remain → resume after the last id swept. A short slice swept to
    // its end means we reached the end → cursor NULL (idle) until next Monday.
    const cursorAfter = (i: number) => (i === batch.length && batch.length < SLICE ? null : batch[i - 1]?.user_id ?? startCursor);
    let i = 0;
    // The next chunk has already cost MAX_ATTEMPTS ticks without a checkpoint (each was killed mid-chunk):
    // skip it, counted as failures, so one poison chunk can't pin the sweep.
    if ((state?.attempts ?? 0) > MAX_ATTEMPTS) {
      const skipped = batch.slice(0, WEEKLY_CHUNK);
      i = skipped.length;
      total = addTally(total, { ...emptyTally(), tenants: skipped.length, failures: skipped.length });
      console.error(`weekly sweep: skipped ${skipped.length} tenants after ${state?.attempts} attempts (${skipped[0]?.user_id}…${skipped[skipped.length - 1]?.user_id})`);
      if (!(await checkpoint(env, holder, cursorAfter(i), total))) return { skipped: "leased" };
    }
    let lost = false;
    const first = i; // at least one chunk per lease, so the budget can't strand the attempt count
    while (i < batch.length && (i === first || now() < deadline)) {
      const chunk = batch.slice(i, i + WEEKLY_CHUNK);
      const tally = emptyTally();
      tally.tenants = chunk.length;
      await sweepChunk(env, stubFor, fyStart, chunk, tally);
      i += chunk.length;
      total = addTally(total, tally);
      if (!(await checkpoint(env, holder, cursorAfter(i), total))) { lost = true; break; }
    }
    const done = !lost && i === batch.length && batch.length < SLICE;
    await publishLifecycleRecord(env, total, new Date(), { partial: !done });
    console.log(`weekly sweep: swept ${i} tenants from cursor "${startCursor}"${done ? " (sweep complete)" : lost ? "; lease lost" : "; continuing next tick"}`);
    return { swept: i, done };
  } finally {
    await platformDb(env).prepare(`UPDATE cron_sweeps SET lease_holder = NULL, lease_until = NULL WHERE name = ? AND lease_holder = ?`)
      .bind(WEEKLY_SWEEP, holder).run().catch(() => {});
  }
}

/** One chunk of tenants through the weekly steps, bounded concurrency, every tenant isolated. */
async function sweepChunk(
  env: Env,
  stubFor: (env: Env, userId: string) => TaxAgentRpc,
  fyStart: number,
  chunk: { user_id: string }[],
  tally: LifecycleTally,
): Promise<void> {
  await runPooled(chunk, CONCURRENCY, async (u) => {
    // Isolate per-tenant failures — one tenant's bad asset/data must not abort the sweep for all.
    try {
      const stub = stubFor(env, u.user_id);
      await stub.runProactiveScan(u.user_id);
      // Keep each tenant's depreciation_schedule materialised through the current FY (carry-forward).
      await stub.rollForward(u.user_id, fyStart);
      // Retention: flag (never delete) records past the tenant's window (5 years from the lodge date).
      if ((await stub.flagOldData(u.user_id)).flagged) tally.flagged++;
      // Savings & Opportunities: deterministic recurring-bill detection + factual opportunities
      // (no LLM → no AI-spend interaction). Flag-gated so OFF ⇒ no read/write path, byte-identical.
      if (featureOn(env, "advisory_layer")) await stub.detectAdvisory(u.user_id);
      // PHI Extras Tracker: deterministic (no-LLM) setup nudge + reset reminder. Writes only to
      // opportunities + notifications. Flag-gated ⇒ OFF means no read/write path, byte-identical.
      if (featureOn(env, "phi_extras_tracker")) await stub.detectBenefitsReset(u.user_id);
      // Bank-feed consents (#576, ADR-0003 §6.4): mark expired, remind before expiry, retry failed
      // upstream revokes. Flag-gated ⇒ OFF means no read/write path, byte-identical.
      if (featureOn(env, "bank_feed_cdr")) {
        const lc = await stub.bankConsentLifecycle(u.user_id);
        tally.expired_consents_deleted += lc.expiredDeleted ?? 0;
        tally.expiry_lines_deleted += lc.expiredLinesDeleted ?? 0;
      }
    } catch (e) {
      tally.failures++;
      console.error(`weekly cron failed for ${u.user_id}: ${(e as Error).message}`);
    }
    // Data lifecycle (#594 / #639), each step isolated so one failing can't skip the others. Each is
    // flag-gated here AND inside (OFF ⇒ no DO call, no read, no write — byte-identical).
    // Retention schedule: irrelevant debits of a lodged FY (or due date + 60 days) shrink to per-account totals.
    if (featureOn(env, "bank_minimisation")) {
      try {
        tally.shrunk += (await stubFor(env, u.user_id).minimiseBankLines(u.user_id))?.shrunk ?? 0;
      } catch (e) {
        tally.failures++;
        console.error(`bank minimisation failed for ${u.user_id}: ${(e as Error).name}`);
      }
    }
    // Inactive end users: 30 days with no live consent ⇒ delete the aggregator end user.
    if (featureOn(env, "cdr_inactive_user_delete")) {
      try {
        const r = await stubFor(env, u.user_id).bankInactiveEndUser(u.user_id);
        if (r.state === "deleted") tally.end_users_deleted++;
        if (r.state === "failed") tally.failures++;
      } catch (e) {
        tally.failures++;
        console.error(`inactive end-user sweep failed for ${u.user_id}: ${(e as Error).name}`);
      }
    }
  });
}
