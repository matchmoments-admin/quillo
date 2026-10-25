import type { Env, TaxAgentRpc } from "../env";
import { featureOn } from "./features";
import { emptyTally, publishLifecycleRecord } from "./retention-schedule";

/**
 * The weekly per-tenant maintenance sweep (proactive scan, depreciation roll-forward, retention flagging,
 * advisory, CDR consent lifecycle, data lifecycle). It is paged: each call processes ONE bounded slice of
 * tenants after the KV cursor and advances it. The Monday cron starts a sweep; while the cursor is
 * non-empty, every 10-minute tick continues it, so a sweep of N tenants finishes in ceil(N / SLICE) ticks
 * the same day (~57k tenants/day at 400 a tick) instead of one slice a week. A lease key stops two ticks
 * running the same slice when one overruns. A Queue consumer is the next step if per-tenant retries or
 * more throughput are needed; the per-tenant unit of work is already isolated for it.
 */
export const WEEKLY_SLICE = 400;
export const WEEKLY_CURSOR_KEY = "cron:weekly:cursor";
export const WEEKLY_LEASE_KEY = "cron:weekly:lease";
const LEASE_TTL_S = 900; // longer than a slice can run; KV's minimum TTL is 60s

/** Run `fn` over `items` with at most `concurrency` in flight. fn must not throw (callers catch
 *  per-item) — a rejection would abort the worker and starve the rest of the slice. */
export async function runPooled<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

/** True while a sweep is part-way through (the 10-minute tick continues it). One KV read. */
export async function weeklySweepInProgress(env: Env): Promise<boolean> {
  return !!(await env.RULES.get(WEEKLY_CURSOR_KEY));
}

export type WeeklySliceResult = { swept: number; done: boolean } | { skipped: "leased" };

export async function runWeeklySlice(env: Env, stubFor: (env: Env, userId: string) => TaxAgentRpc): Promise<WeeklySliceResult> {
  if (await env.RULES.get(WEEKLY_LEASE_KEY)) return { skipped: "leased" };
  await env.RULES.put(WEEKLY_LEASE_KEY, new Date().toISOString(), { expirationTtl: LEASE_TTL_S });
  try {
    // Current AU FY start year (Jul–Jun) for the depreciation roll-forward.
    const now = new Date();
    const fyStart = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    // Paged (#79) so a large tenant set can't blow one tick's wall-clock and drop the tail: a bounded,
    // ordered slice (round-robin by user_id) with bounded concurrency, then the cursor advances.
    const SLICE = WEEKLY_SLICE;
    const CONCURRENCY = 6;
    const cursorKey = WEEKLY_CURSOR_KEY;
    const cursor = (await env.RULES.get(cursorKey)) ?? "";
    const users = await env.DB.prepare(`SELECT user_id FROM profiles WHERE user_id > ? ORDER BY user_id LIMIT ?`)
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
    await publishLifecycleRecord(env, tally, new Date(), { partial: batch.length === SLICE || cursor !== "" });
    // A full slice means more tenants remain → resume after the last id next tick. A short slice
    // means we reached the end → clear the cursor so the next run round-robins from the start.
    if (batch.length === SLICE) {
      await env.RULES.put(cursorKey, batch[batch.length - 1]!.user_id);
      console.log(`weekly sweep: swept ${batch.length} tenants from cursor "${cursor}"; more remain — continuing next tick`);
      return { swept: batch.length, done: false };
    }
    if (cursor !== "") await env.RULES.delete(cursorKey);
    console.log(`weekly sweep: swept ${batch.length} tenants (sweep complete)`);
    return { swept: batch.length, done: true };
  } finally {
    await env.RULES.delete(WEEKLY_LEASE_KEY).catch(() => {});
  }
}
