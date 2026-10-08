import type { Env } from "../env";
import { featureOn } from "./features";
import { inactiveEndUserQueueSize } from "./bank-consent";
import { SECURITY_KV, type SecuritySourceRecord } from "./security-dashboard";

// ── The weekly data-lifecycle run's evidence record (#639 / #594) ────────────────────────────────────────
//
// The weekly cron (src/index.ts, `0 8 * * 1`) runs, per tenant: the retention FLAG sweep (flagOldData — 5 years
// from the lodge date), bank-data minimisation (bank_minimisation), the consent lifecycle incl. expiry deletion
// (bank_feed_cdr + cdr_expiry_delete) and the inactive end-user deletion (cdr_inactive_user_delete). It tallies
// what happened and publishes ONE document to KV `security:source:retention` — the "Data lifecycle" panel of the
// admin Security & compliance page (src/lib/security-dashboard.ts, source key `retention`). COUNTS ONLY: no
// tenant id, merchant, amount or CDR field ever goes in (the dashboard's privacy contract).

export interface LifecycleTally {
  tenants: number;
  /** Tenants who got a "records past the retention window" nudge this run. */
  flagged: number;
  /** Irrelevant bank lines shrunk into per-account totals (bank_minimisation). */
  shrunk: number;
  /** Expired consents whose CDR lines were deleted (cdr_expiry_delete). */
  expired_consents_deleted: number;
  /** Bank lines those expiry deletes removed. */
  expiry_lines_deleted: number;
  /** Aggregator end users deleted after 30 days inactive (cdr_inactive_user_delete). */
  end_users_deleted: number;
  /** Per-tenant failures in any lifecycle step (incl. a failed end-user delete) — retried next week. */
  failures: number;
}

export function emptyTally(): LifecycleTally {
  return { tenants: 0, flagged: 0, shrunk: 0, expired_consents_deleted: 0, expiry_lines_deleted: 0, end_users_deleted: 0, failures: 0 };
}

/** Pure: the dashboard source record for one run. `queue` = the inactive end-user deletion queue size. */
export function lifecycleSourceRecord(
  env: Env,
  t: LifecycleTally,
  queue: number,
  at: Date,
  opts: { partial: boolean },
): SecuritySourceRecord {
  const flags = {
    bank_minimisation: featureOn(env, "bank_minimisation"),
    cdr_expiry_delete: featureOn(env, "cdr_expiry_delete"),
    cdr_inactive_user_delete: featureOn(env, "cdr_inactive_user_delete"),
  };
  const off = Object.entries(flags).filter(([, on]) => !on).map(([k]) => k);
  const status: SecuritySourceRecord["status"] = t.failures > 0 || off.length > 0 ? "warn" : "ok";
  const parts = [
    `${t.tenants} tenant${t.tenants === 1 ? "" : "s"} swept${opts.partial ? " (one slice; the rest next week)" : ""}`,
    `${t.flagged} retention nudge${t.flagged === 1 ? "" : "s"}`,
    `${t.shrunk + t.expiry_lines_deleted} bank line${t.shrunk + t.expiry_lines_deleted === 1 ? "" : "s"} deleted`,
    `${t.end_users_deleted} end user${t.end_users_deleted === 1 ? "" : "s"} deleted, ${queue} queued`,
  ];
  if (t.failures) parts.push(`${t.failures} failure${t.failures === 1 ? "" : "s"} (retried next week)`);
  if (off.length) parts.push(`OFF: ${off.join(", ")}`);
  return {
    at: at.toISOString(),
    status,
    summary: parts.join(" · "),
    metrics: {
      last_run_at: at.toISOString(),
      tenants: t.tenants,
      flagged: t.flagged,
      deleted: t.shrunk + t.expiry_lines_deleted,
      shrunk: t.shrunk,
      expired_consents_deleted: t.expired_consents_deleted,
      expiry_lines_deleted: t.expiry_lines_deleted,
      end_users_deleted: t.end_users_deleted,
      deletion_queue: queue,
      failures: t.failures,
      partial_slice: opts.partial,
      ...flags,
    },
    evidence: [
      { label: "src/lib/minimise.ts", href: "https://github.com/matchmoments-admin/quillo/blob/main/src/lib/minimise.ts" },
      { label: "src/lib/bank-consent.ts", href: "https://github.com/matchmoments-admin/quillo/blob/main/src/lib/bank-consent.ts" },
      { label: "data-handling.md §4–5", href: "https://github.com/matchmoments-admin/quillo/blob/main/docs/security/data-handling.md#4-retention-schedule" },
    ],
  };
}

/** Write the run's record to KV. Never throws (telemetry must not fail the sweep). */
export async function publishLifecycleRecord(env: Env, t: LifecycleTally, at: Date, opts: { partial: boolean }): Promise<void> {
  try {
    const queue = await inactiveEndUserQueueSize(env).catch(() => 0);
    await env.RULES.put(SECURITY_KV.source("retention"), JSON.stringify(lifecycleSourceRecord(env, t, queue, at, opts)));
  } catch (e) {
    console.error(`lifecycle record publish failed: ${(e as Error).name}`);
  }
}
