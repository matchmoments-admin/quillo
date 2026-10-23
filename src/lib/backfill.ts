// One-time, all-tenant backfills run from the `*/10` cron (#724).
//
// The old shape ran each backfill over EVERY tenant on EVERY tick, forever: a `SELECT user_id FROM
// profiles` with no limit plus one KV read per tenant per backfill, long after the work was done.
// `runBackfillOnce` keeps the per-tenant claim-before-work guard (`runOnceGuarded`, so tenants that
// already ran in prod are honoured) and adds:
//   - one GLOBAL completion marker per backfill (KV `backfill:<key>:done`): once set, a tick costs one
//     KV read and no D1 scan;
//   - KV-cursor paging over `profiles` (the weekly-scan pattern, #79), at most `pageSize` tenants a tick.
// The marker is set only after a full pass in which every tenant finished. A tenant that throws or has
// given up (attempts exhausted) leaves the pass "dirty", so the next tick starts a fresh pass and
// retries it; tenants already done cost one KV read each on that pass.
// New tenants never need these backfills (they write the fixed shapes from day one), so a tenant
// created after the marker is set is correctly skipped.

/** The slice of KV this module uses (Cloudflare's KVNamespace satisfies it; tests pass a Map fake). */
export interface BackfillKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The slice of D1 this module uses. */
export interface BackfillDb {
  prepare(sql: string): {
    bind(...args: unknown[]): { all<T>(): Promise<{ results?: T[] }> };
  };
}

export interface BackfillEnv {
  RULES: BackfillKv;
  DB: BackfillDb;
}

export type GuardOutcome = "already_done" | "ran" | "gave_up";

/**
 * Run a one-time, KV-guarded per-tenant step at most `maxAttempts` times, claiming the attempt BEFORE
 * the work. The old pattern set the "done" flag AFTER the AI work, so a mid-run failure (e.g. an
 * Anthropic 429 that lands AFTER some paid batches were already submitted) left the flag unset and
 * the 10-minute cron re-ran — and re-paid for — the whole backfill every tick, forever (C2). Claiming up
 * front bounds the blast radius to `maxAttempts` paid tries even if every one crashes; on success
 * we flip to "done" so it never runs again. The work itself stays idempotent.
 * KV states: "done" | "attempt:N". Throws whatever `fn` throws.
 */
export async function runOnceGuarded(
  kv: BackfillKv,
  flag: string,
  maxAttempts: number,
  fn: () => Promise<void>,
): Promise<GuardOutcome> {
  const cur = await kv.get(flag);
  if (cur === "done") return "already_done";
  const attempts = cur?.startsWith("attempt:") ? Number(cur.slice("attempt:".length)) || 0 : 0;
  if (attempts >= maxAttempts) return "gave_up"; // don't keep paying to retry
  // Interim "attempt:N" state carries a TTL so a permanently-wedged tenant self-heals after the window
  // rather than counting failed attempts forever; the terminal "done" flag is PERMANENT (no TTL) so a
  // completed one-time backfill never silently re-runs and re-spends.
  await kv.put(flag, `attempt:${attempts + 1}`, { expirationTtl: 60 * 60 * 24 * 7 }); // claim BEFORE the work
  await fn();
  await kv.put(flag, "done"); // success → never re-run (permanent)
  return "ran";
}

export const backfillDoneKey = (key: string) => `backfill:${key}:done`;
export const backfillCursorKey = (key: string) => `backfill:${key}:cursor`;

export const BACKFILL_PAGE_SIZE = 100;

export interface BackfillOptions {
  /** The legacy per-tenant `runOnceGuarded` flag, kept so tenants that already ran aren't re-run. */
  tenantFlag: (userId: string) => string;
  /** Per-tenant attempt cap passed to runOnceGuarded. */
  maxAttempts?: number;
  /** Max tenants handled per tick. */
  pageSize?: number;
  /** Checked after the marker read and before any D1 scan; false ⇒ skip this tick (e.g. AI ceiling). */
  gate?: () => Promise<boolean>;
  /** Log label. */
  label?: string;
}

export type BackfillResult =
  | { state: "done" } // global marker already set: one KV read, nothing else
  | { state: "gated" } // gate said no this tick
  | { state: "paged"; processed: number; failures: number } // more tenants remain in this pass
  | { state: "completed"; processed: number } // pass finished clean → marker set
  | { state: "retry"; processed: number; failures: number }; // pass finished dirty → fresh pass next tick

interface CursorState {
  after: string;
  dirty: boolean;
}

function parseCursor(raw: string | null): CursorState {
  if (!raw) return { after: "", dirty: false };
  try {
    const o = JSON.parse(raw) as Partial<CursorState>;
    return { after: typeof o.after === "string" ? o.after : "", dirty: o.dirty === true };
  } catch {
    return { after: "", dirty: false };
  }
}

export async function runBackfillOnce(
  env: BackfillEnv,
  key: string,
  perTenant: (userId: string) => Promise<void>,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const kv = env.RULES;
  if ((await kv.get(backfillDoneKey(key))) === "done") return { state: "done" };
  if (opts.gate && !(await opts.gate())) return { state: "gated" };

  const pageSize = Math.max(1, opts.pageSize ?? BACKFILL_PAGE_SIZE);
  const label = opts.label ?? key;
  const cursor = parseCursor(await kv.get(backfillCursorKey(key)));
  // Iterate REAL tenants from `profiles` (the founder's data lives under "me", not a Clerk id).
  const page =
    (
      await env.DB.prepare(`SELECT user_id FROM profiles WHERE user_id > ? ORDER BY user_id LIMIT ?`)
        .bind(cursor.after, pageSize)
        .all<{ user_id: string }>()
    ).results ?? [];

  let failures = 0;
  for (const t of page) {
    try {
      const outcome = await runOnceGuarded(kv, opts.tenantFlag(t.user_id), opts.maxAttempts ?? 3, () => perTenant(t.user_id));
      if (outcome === "gave_up") failures++;
    } catch (e) {
      failures++;
      console.error(`${label} backfill failed for ${t.user_id}: ${(e as Error).message}`);
    }
  }
  const dirty = cursor.dirty || failures > 0;

  if (page.length === pageSize) {
    // A full page ⇒ more tenants may remain: resume after the last id next tick.
    await kv.put(backfillCursorKey(key), JSON.stringify({ after: page[page.length - 1]!.user_id, dirty }));
    return { state: "paged", processed: page.length, failures };
  }
  // A short page ⇒ end of the pass.
  if (dirty) {
    // Someone didn't finish: start a fresh pass next tick (done tenants are skipped by their flag).
    await kv.put(backfillCursorKey(key), JSON.stringify({ after: "", dirty: false }));
    return { state: "retry", processed: page.length, failures };
  }
  await kv.put(backfillDoneKey(key), "done"); // permanent
  await kv.delete(backfillCursorKey(key));
  console.log(`${label} backfill complete for every tenant — marker set`);
  return { state: "completed", processed: page.length };
}
