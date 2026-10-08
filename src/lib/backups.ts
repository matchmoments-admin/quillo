import type { Env } from "../env";
import { featureOn } from "./features";
import { SECURITY_KV, repoLink, type SecuritySourceRecord } from "./security-dashboard";

// ── Daily D1 export → R2 (#635, A2 of epic #633) ────────────────────────────────────────────────
//
// D1 has no in-binding "dump" API, but the account REST endpoint
//   POST /accounts/{account}/d1/database/{db}/export  { output_format: "polling", current_bookmark? }
// produces a full SQL dump (schema + data) and hands back a one-hour signed URL. It is callable from a
// Worker with a D1-scoped API token — this is Cloudflare's own documented pattern
// (developers.cloudflare.com/workflows/examples/backup-d1) and the same endpoint `wrangler d1 export
// --remote` polls. So the export runs HERE, in the Worker's own daily cron, not in GitHub Actions:
// no CI secret, no extra moving part, and the dashboard's status comes from the same process.
//
// Caveats (documented in docs/security/backup-dr.md):
//   • the DB doesn't serve queries while an export runs — seconds at today's size, so it runs at
//     16:30 UTC (02:30 AEST / 03:30 AEDT), the quietest hour;
//   • an in-progress export must be continually polled or it cancels — we poll until complete;
//   • the signed URL is a bearer credential for the whole DB: it is never logged or stored.
//
// Layout (lifecycle rules on the bucket enforce retention — see the doc):
//   d1/daily/<YYYY-MM-DD>.sql     every run              → expire after 35 days
//   d1/monthly/<YYYY-MM>.sql      first run of a month  → expire after 366 days (12 monthlies)
// After each run ONE status record goes to KV `security:source:backups` (the #636 contract) — counts,
// keys and timestamps only.

/** The cron expression in wrangler.toml that triggers the export. Must match exactly. */
export const BACKUP_CRON = "30 16 * * *";
export const BACKUP_PREFIX = { daily: "d1/daily/", monthly: "d1/monthly/" } as const;
export const BACKUP_RETENTION = "35 daily + 12 monthly";

/**
 * The most recent restore test (docs/security/backup-dr.md §6). Update this when the test is re-run —
 * it is what the dashboard shows as last_restore_test_at / last_restore_result.
 */
export const LAST_RESTORE_TEST = {
  at: "2026-10-08T10:14:00Z",
  result: "pass — prod export restored to a scratch DB: 80/80 tables, 6037/6037 rows match",
} as const;

const POLL_DEADLINE_MS = 10 * 60 * 1000; // the scheduled handler's wall-clock budget is 15 min
const POLL_INTERVAL_MS = 1000;

export interface BackupDeps {
  fetch: typeof fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}
const defaultDeps = (): BackupDeps => ({
  fetch: (i, init) => fetch(i, init),
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

export type BackupOutcome =
  | { status: "flag_off" }
  | { status: "skipped"; key: string }
  | { status: "ok"; key: string; bytes: number; monthly: string | null }
  | { status: "fail"; reason: string };

class BackupError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "BackupError";
  }
}

interface ExportPoll {
  success?: boolean;
  result?: {
    status?: string;
    at_bookmark?: string;
    error?: string;
    result?: { filename?: string; signed_url?: string };
  };
}

/** Poll the export endpoint until the dump is ready. Returns the signed URL + the Time Travel bookmark. */
async function pollExport(env: Env, d: BackupDeps): Promise<{ url: string; bookmark: string | null }> {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.D1_DATABASE_ID}/export`;
  const deadline = d.now().getTime() + POLL_DEADLINE_MS;
  let bookmark: string | undefined;
  for (let i = 0; ; i++) {
    const res = await d.fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${env.D1_EXPORT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ output_format: "polling", ...(bookmark ? { current_bookmark: bookmark } : {}) }),
    });
    // Never keep a vendor error body: reduce to the HTTP status.
    if (!res.ok) { await res.body?.cancel(); throw new BackupError(`export API HTTP ${res.status}`); }
    const body = (await res.json().catch(() => null)) as ExportPoll | null;
    const r = body?.result;
    if (!body?.success || !r) throw new BackupError("export API returned no result");
    if (r.status === "error") throw new BackupError("export reported an error");
    const url = r.result?.signed_url;
    if (r.status === "complete") {
      if (!url || !/^https:\/\//.test(url)) throw new BackupError("export complete without a download URL");
      return { url, bookmark: r.at_bookmark ?? bookmark ?? null };
    }
    bookmark = r.at_bookmark ?? bookmark;
    if (!bookmark) throw new BackupError("export API returned no bookmark");
    if (d.now().getTime() > deadline) throw new BackupError(`export not complete after ${i + 1} polls`);
    await d.sleep(POLL_INTERVAL_MS);
  }
}

/** Dumps up to this size are buffered (robust: no reliance on the stream reporting a length). */
const BUFFER_MAX_BYTES = 48 * 1024 * 1024;

/**
 * Download the dump into R2. Small dumps (today's ≈ 5 MB) are buffered. A large one is streamed, which
 * R2 only accepts when the stream has a known length — a fetch body with Content-Length does. If the
 * DB ever outgrows that path, move the export into a Workflow / multipart upload (see the doc).
 */
async function storeDump(env: Env, d: BackupDeps, url: string, key: string, meta: Record<string, string>): Promise<number> {
  const res = await d.fetch(url);
  if (!res.ok || !res.body) { await res.body?.cancel(); throw new BackupError(`dump download HTTP ${res.status}`); }
  const len = Number(res.headers.get("content-length") ?? NaN);
  const opts: R2PutOptions = { httpMetadata: { contentType: "application/sql" }, customMetadata: meta };
  const obj = Number.isFinite(len) && len > BUFFER_MAX_BYTES
    ? await env.BACKUPS!.put(key, res.body, opts)
    : await env.BACKUPS!.put(key, await res.arrayBuffer(), opts);
  if (!obj || obj.size === 0) throw new BackupError("empty dump");
  return obj.size;
}

/** The first export of each calendar month is also kept as the monthly copy (copied from R2, not re-exported). */
async function ensureMonthly(env: Env, dailyKey: string, month: string, meta: Record<string, string>): Promise<string | null> {
  const key = `${BACKUP_PREFIX.monthly}${month}.sql`;
  if (await env.BACKUPS!.head(key)) return null;
  const src = await env.BACKUPS!.get(dailyKey);
  if (!src) throw new BackupError("daily export vanished before the monthly copy");
  await env.BACKUPS!.put(key, src.body /* R2 object bodies have a known length */, { httpMetadata: { contentType: "application/sql" }, customMetadata: meta });
  return key;
}

function record(at: string, o: Exclude<BackupOutcome, { status: "flag_off" }>, extra: Record<string, string | number | null> = {}): SecuritySourceRecord {
  const ok = o.status !== "fail";
  return {
    at,
    status: ok ? "ok" : "fail",
    summary: (ok ? `Daily D1 export ok (${BACKUP_RETENTION} retained)` : `Daily D1 export FAILED: ${o.reason}`) + ` · last restore test ${LAST_RESTORE_TEST.at.slice(0, 10)} ${LAST_RESTORE_TEST.result.split(" ")[0]}`,
    metrics: {
      last_run_at: at,
      last_run_result: ok ? "ok" : o.reason,
      ...(o.status === "ok" ? { last_export_key: o.key, last_export_bytes: o.bytes } : {}),
      ...extra,
      retention: BACKUP_RETENTION,
      last_restore_test_at: LAST_RESTORE_TEST.at,
      last_restore_result: LAST_RESTORE_TEST.result,
    },
    evidence: [{ label: "docs/security/backup-dr.md", href: repoLink("docs/security/backup-dr.md") }],
  };
}

/**
 * The daily cron hook. Flag OFF ⇒ returns having touched NOTHING (no KV, no R2, no fetch).
 * Flag ON ⇒ exports D1, stores it, keeps the month's first copy, and writes the status record. A run
 * whose daily object already exists (a retried cron) is skipped. Never throws.
 */
export async function runD1Backup(env: Env, deps: BackupDeps = defaultDeps()): Promise<BackupOutcome> {
  if (!featureOn(env, "d1_backups")) return { status: "flag_off" };
  const now = deps.now();
  const at = now.toISOString();
  const day = at.slice(0, 10);
  const dailyKey = `${BACKUP_PREFIX.daily}${day}.sql`;
  let outcome: Exclude<BackupOutcome, { status: "flag_off" }>;
  const extra: Record<string, string | number | null> = {};
  try {
    const missing = [!env.BACKUPS && "BACKUPS bucket", !env.D1_EXPORT_TOKEN && "D1_EXPORT_TOKEN", !env.CF_ACCOUNT_ID && "CF_ACCOUNT_ID", !env.D1_DATABASE_ID && "D1_DATABASE_ID"].filter(Boolean);
    if (missing.length) throw new BackupError(`not configured (missing ${missing.join(", ")})`);
    if (await env.BACKUPS!.head(dailyKey)) {
      // Retried cron: today's export exists. Still make sure the monthly copy does (a previous attempt
      // may have stored the daily and then failed on the copy).
      await ensureMonthly(env, dailyKey, day.slice(0, 7), { source: "d1-export", database_id: String(env.D1_DATABASE_ID), exported_at: at });
      outcome = { status: "skipped", key: dailyKey };
    } else {
      const { url, bookmark } = await pollExport(env, deps);
      const meta = { source: "d1-export", database_id: String(env.D1_DATABASE_ID), exported_at: at, ...(bookmark ? { at_bookmark: bookmark } : {}) };
      const bytes = await storeDump(env, deps, url, dailyKey, meta);
      const monthly = await ensureMonthly(env, dailyKey, day.slice(0, 7), meta);
      if (bookmark) extra.export_bookmark = bookmark;
      outcome = { status: "ok", key: dailyKey, bytes, monthly };
    }
  } catch (e) {
    const reason = e instanceof BackupError ? e.reason : `unexpected ${e instanceof Error ? e.name : "error"}`;
    outcome = { status: "fail", reason };
    console.error(`d1 backup failed: ${reason}`);
  }
  // A skipped (retried) run must not overwrite the successful run's record.
  if (outcome.status !== "skipped") {
    try {
      await env.RULES.put(SECURITY_KV.source("backups"), JSON.stringify(record(at, outcome, extra)));
    } catch (e) {
      console.error(`d1 backup status write failed: ${(e as Error).name}`);
    }
  }
  return outcome;
}
