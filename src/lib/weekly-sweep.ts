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
 */
export const WEEKLY_SLICE = 400;
export const WEEKLY_SWEEP = "weekly";
const LEASE_S = 900; // longer than a slice can run

/** Run `fn` over `items` with at most `concurrency` in flight. fn must not throw (callers catch
 *  per-item) — a rejection would abort the worker and starve the rest of the slice. */
export async function runPooled<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

/** The Monday tick: start a sweep unless one is already in progress. Independent of the lease, so a slice
 *  that is still running at 08:00 can't swallow the week's start. */
export async function startWeeklySweep(env: Env): Promise<boolean> {
  const r = await platformDb(env).prepare(
    `INSERT INTO cron_sweeps (name, cursor, tally_json, started_at) VALUES (?, '', NULL, datetime('now'))
     ON CONFLICT(name) DO UPDATE SET cursor = '', tally_json = NULL, started_at = datetime('now') WHERE cron_sweeps.cursor IS NULL`,
  ).bind(WEEKLY_SWEEP).run();
  return Number(r.meta?.changes ?? 0) === 1;
}

/** True while a sweep is part-way through (the 10-minute tick continues it). One indexed D1 read. */
export async function weeklySweepInProgress(env: Env): Promise<boolean> {
  const row = await platformDb(env).prepare(`SELECT cursor FROM cron_sweeps WHERE name = ?`).bind(WEEKLY_SWEEP).first<{ cursor: string | null }>();
  return row != null && row.cursor != null;
}

/** Take the slice lease atomically: exactly one caller's conditional UPDATE changes the row. */
async function acquireLease(env: Env, holder: string): Promise<boolean> {
  const r = await platformDb(env).prepare(
    `UPDATE cron_sweeps SET lease_holder = ?, lease_until = datetime('now', ?)
      WHERE name = ? AND cursor IS NOT NULL AND (lease_until IS NULL OR lease_until < datetime('now'))`,
  ).bind(holder, `+${LEASE_S} seconds`, WEEKLY_SWEEP).run();
  return Number(r.meta?.changes ?? 0) === 1;
}

const addTally = (a: LifecycleTally, b: LifecycleTally): LifecycleTally =>
  Object.fromEntries(Object.keys(a).map((k) => [k, a[k as keyof LifecycleTally] + (b[k as keyof LifecycleTally] ?? 0)])) as unknown as LifecycleTally;

export type WeeklySliceResult = { swept: number; done: boolean } | { skipped: "leased" | "idle" };

export async function runWeeklySlice(env: Env, stubFor: (env: Env, userId: string) => TaxAgentRpc): Promise<WeeklySliceResult> {
  if (!(await weeklySweepInProgress(env))) return { skipped: "idle" };
  const holder = crypto.randomUUID();
  if (!(await acquireLease(env, holder))) return { skipped: "leased" };
  try {
    // Current FY start year for the depreciation roll-forward (the sweep is AU-only today).
    const fyStart = fyStartYearForDate(AU_DESCRIPTOR, new Date().toISOString().slice(0, 10));
    // Paged (#79) so a large tenant set can't blow one tick's wall-clock and drop the tail: a bounded,
    // ordered slice (round-robin by user_id) with bounded concurrency, then the cursor advances.
    const SLICE = WEEKLY_SLICE;
    const CONCURRENCY = 6;
    const state = await platformDb(env).prepare(`SELECT cursor, tally_json FROM cron_sweeps WHERE name = ?`).bind(WEEKLY_SWEEP).first<{ cursor: string | null; tally_json: string | null }>();
    const cursor = state?.cursor ?? "";
    const users = await platformDb(env).prepare(`SELECT user_id FROM profiles WHERE user_id > ? ORDER BY user_id LIMIT ?`)
      .bind(cursor, SLICE)
      .all<{ user_id: string }>();
    const batch = users.results ?? [];
    // #639: what the data-lifecycle steps did this run — counts only — published for the admin dashboard.
    const tally = emptyTally();
    tally.tenants = batch.length;
    await runPooled(batch, CONCURRENCY, async (u) => {
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
    // The tally accumulates across the sweep's slices; the dashboard record always shows the WHOLE sweep so far.
    let sofar = emptyTally();
    try { if (state?.tally_json) sofar = { ...sofar, ...(JSON.parse(state.tally_json) as LifecycleTally) }; } catch { /* corrupt ⇒ restart the tally */ }
    const total = addTally(sofar, tally);
    // A full slice means more tenants remain → resume after the last id next tick. A short slice means we
    // reached the end → cursor NULL (idle) until next Monday.
    const done = batch.length < SLICE;
    await platformDb(env).prepare(`UPDATE cron_sweeps SET cursor = ?, tally_json = ? WHERE name = ?`)
      .bind(done ? null : batch[batch.length - 1]!.user_id, JSON.stringify(total), WEEKLY_SWEEP).run();
    await publishLifecycleRecord(env, total, new Date(), { partial: !done });
    console.log(`weekly sweep: swept ${batch.length} tenants from cursor "${cursor}"${done ? " (sweep complete)" : "; continuing next tick"}`);
    return { swept: batch.length, done };
  } finally {
    await platformDb(env).prepare(`UPDATE cron_sweeps SET lease_holder = NULL, lease_until = NULL WHERE name = ? AND lease_holder = ?`)
      .bind(WEEKLY_SWEEP, holder).run().catch(() => {});
  }
}
