import type { Env } from "../env";

/**
 * Connect-flow state for the bank feed (ADR-0003 §6.3).
 *
 * `src/lib/basiq.ts` is deliberately pure transport — it holds no tenant state. This module owns
 * the one piece of tenant state the connect flow needs: the handle that survives the round trip
 * through Basiq's hosted consent UI.
 *
 * WHY A HANDLE AT ALL. The consumer returns from consent.basiq.io as a top-level browser
 * navigation, which carries no Authorization header, so `/api/bank/callback` cannot be an
 * authenticated route (the QBO callback has the identical constraint — see `src/index.ts`). The
 * `state` parameter is echoed back untouched and is how we recover which tenant this is.
 *
 * That makes `state` security-relevant, not bookkeeping:
 *   - unguessable  — a random UUID, never the user id, so a callback cannot be forged by guessing
 *   - single-use   — consumed on read, so a leaked redirect URL (browser history, a shared link,
 *                    a referrer header) cannot be replayed into someone else's tenant
 *   - short-lived  — a 10-minute TTL bounds the window even if it is never consumed
 */

const STATE_PREFIX = "bankstate:";
/** Long enough for a consumer to authenticate at their bank, short enough to bound a leak. */
const STATE_TTL_SECONDS = 600;

/** Mint a single-use state handle for `userId` and return it. */
export async function putConnectState(env: Env, userId: string): Promise<string> {
  const state = crypto.randomUUID();
  await env.RULES.put(`${STATE_PREFIX}${state}`, userId, { expirationTtl: STATE_TTL_SECONDS });
  return state;
}

/**
 * Resolve a state handle to its tenant and CONSUME it. Returns null when unknown, expired or
 * already used — callers must treat null as "reject the callback", never as "assume the caller".
 *
 * The delete is best-effort and happens after the read: a KV delete failure must not turn a
 * legitimate first use into an error, and the TTL is the backstop.
 */
export async function takeConnectState(env: Env, state: string | null | undefined): Promise<string | null> {
  if (!state) return null;
  const key = `${STATE_PREFIX}${state}`;
  const userId = await env.RULES.get(key);
  if (!userId) return null;
  try {
    await env.RULES.delete(key);
  } catch {
    // TTL still bounds it; a failed delete must not break a valid connect.
  }
  return userId;
}

/**
 * The window a sync should actually request: the requested financial year, clamped to what the
 * regime can serve.
 *
 * TWO clamps, both load-bearing:
 *
 *  - THE 24-MONTH WALL. Data holders are not obliged to serve CDR transactions older than 24
 *    months, and asking for more produces silent partial coverage rather than an error. Clamping
 *    explicitly means `bank_sync_runs` records the window we REQUESTED, which is what makes a
 *    coverage check possible at all — the completeness gap that statements get wrong today (#472),
 *    where a missing month is silently absent and nothing anywhere reports it.
 *  - TODAY. Asking for future dates is meaningless and some providers error on it.
 *
 * Returns `null` when the clamps cross (an FY that ended before the wall), because "no window" and
 * "an inverted window" are different things and only one of them should reach the provider.
 *
 * Pure and date-injected so it is testable — the caller passes `today`, nothing here reads a clock.
 */
export function syncWindow(
  fyStart: string,
  fyEnd: string,
  today: string,
  monthsBack = 24,
): { from: string; to: string } | null {
  const wallDate = new Date(`${today}T00:00:00Z`);
  wallDate.setUTCMonth(wallDate.getUTCMonth() - monthsBack);
  const wall = wallDate.toISOString().slice(0, 10);
  const from = fyStart > wall ? fyStart : wall;
  const to = fyEnd < today ? fyEnd : today;
  return from > to ? null : { from, to };
}

/**
 * Basiq appends `jobIds` as a comma-separated list. Parsed defensively: a malformed value must
 * degrade to "no jobs" rather than throwing inside a redirect handler, because the consumer has
 * already consented at their bank by this point and the connection exists regardless — we can
 * always re-read accounts without the job ids.
 */
export function parseJobIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length < 128)
    .slice(0, 20); // a sane ceiling; a caller sending hundreds is not a flow we serve
}
