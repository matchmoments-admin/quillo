import type { Env } from "../env";

// Inference cost accounting. Every Claude call (via the metered LLM seam in llm.ts) records
// its real token usage + computed cost here, so spend is MEASURED, not estimated — and the
// budget cap reads from the same atomic D1 `daily_cost` tallies this maintains (per-user +
// global), so concurrent writers can't under-count the platform ceiling.

export interface Usage {
  input_tokens?: number | null; // non-cached input tokens
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null; // cheap: cached prompt prefix
  cache_creation_input_tokens?: number | null; // slight premium to write the cache
}

// $ per 1M tokens. VERIFY against current Anthropic pricing before relying on the figures —
// these are Haiku-4.5 order-of-magnitude rates and only affect the displayed/budgeted cost.
interface Rate {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}
const HAIKU: Rate = { in: 1.0, out: 5.0, cacheRead: 0.1, cacheWrite: 1.25 };
const PRICING: Record<string, Rate> = {
  "claude-haiku-4-5-20251001": HAIKU,
  "apac.anthropic.claude-haiku-4-5-20251001-v1:0": HAIKU,
};

/** Cost in cents for one call. cents = Σ tokens × ($/1e6 tokens) × 100. */
export function costCents(model: string, u: Usage): number {
  const r = PRICING[model] ?? HAIKU;
  const c =
    (u.input_tokens ?? 0) * r.in +
    (u.output_tokens ?? 0) * r.out +
    (u.cache_read_input_tokens ?? 0) * r.cacheRead +
    (u.cache_creation_input_tokens ?? 0) * r.cacheWrite;
  // Quantise to 4 decimal places (1e-4 cents). A single Haiku call is often sub-cent (a ~40-line
  // chunk ≈ 0.2¢), so we must KEEP the fraction — rounding to whole cents would floor most calls to
  // 0 and the budget counter would never move. Fixed precision just bounds float drift so the KV
  // string the daily counter accumulates into stays stable and the running total is deterministic.
  return Math.round((c / 1_000_000) * 100 * 10_000) / 10_000;
}

/** Atomic UPSERT that increments a daily_cost tally without a read-modify-write race. */
function bumpDailyCost(env: Env, scope: string, day: string, cents: number) {
  // SQLite (D1) serialises writes, so `cents = cents + excluded.cents` can't lose a concurrent
  // increment — this is what makes the GLOBAL tally (written by every tenant's DO) safe.
  return env.DB.prepare(
    `INSERT INTO daily_cost (scope, day, cents) VALUES (?, ?, ?)
     ON CONFLICT(scope, day) DO UPDATE SET cents = cents + excluded.cents, updated_at = datetime('now')`,
  ).bind(scope, day, cents);
}

/** Record one call's usage: atomic per-user + global daily-cost counters + a D1 history row. */
export async function recordUsage(
  env: Env,
  userId: string,
  feature: string,
  model: string,
  usage: Usage,
  discount = 1, // Message Batches bill at 50% → pass 0.5
): Promise<number> {
  const round4 = (n: number) => Math.round(n * 10_000) / 10_000; // bound float drift to 4dp
  const cents = round4(costCents(model, usage) * discount);
  const day = new Date().toISOString().slice(0, 10);
  // One transactional round-trip: bump the per-user tally, the platform-wide tally (the global
  // daily ceiling across ALL tenants), and append the history row. Both tallies are atomic UPSERTs,
  // so the gate's MEASURED spend can't be under-counted by concurrent writers (fixes the old racy
  // KV read-compute-write). billing reads llm_usage, so the history row stays the source of truth.
  await env.DB.batch([
    bumpDailyCost(env, userId, day, cents),
    bumpDailyCost(env, "global", day, cents),
    env.DB.prepare(
      `INSERT INTO llm_usage (id, user_id, feature, model, input_tokens, output_tokens, cache_read_tokens, cost_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      userId,
      feature,
      model,
      usage.input_tokens ?? 0,
      usage.output_tokens ?? 0,
      usage.cache_read_input_tokens ?? 0,
      cents,
    ),
  ]);
  return cents;
}

/** Today's spend in cents for a user (atomic D1 tally — for the budget gate). */
export async function spentTodayCents(env: Env, userId: string): Promise<number> {
  return spentToday(env, userId);
}

/** Today's platform-wide spend in cents (all tenants) — for the global daily ceiling. */
export async function spentTodayGlobalCents(env: Env): Promise<number> {
  return spentToday(env, "global");
}

async function spentToday(env: Env, scope: string): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(`SELECT cents FROM daily_cost WHERE scope = ? AND day = ?`)
    .bind(scope, day)
    .first<{ cents: number }>();
  return Number(row?.cents ?? 0);
}

/**
 * Record that a metering write FAILED (KV/D1 transient error). The model call already succeeded and
 * its cost was really incurred, but it never landed in the counter — so the budget gate is now
 * reading a stale (under-)total and may let more spend through. We never let metering break the real
 * call, but we must not swallow the SIGNAL: log it and bump a per-day counter so the drift is
 * visible (and alertable) instead of silent. Best-effort — if even this write fails, just log.
 */
export async function noteMeteringError(env: Env, userId: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`metering write failed for ${userId}: ${msg}`);
  try {
    const day = new Date().toISOString().slice(0, 10);
    const key = `cost_errors:${day}`;
    const cur = Number((await env.RULES.get(key)) ?? 0);
    await env.RULES.put(key, String(cur + 1), { expirationTtl: 60 * 60 * 26 });
  } catch {
    /* counter write also failed — the console.error above is the floor of observability */
  }
}
