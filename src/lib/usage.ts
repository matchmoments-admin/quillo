import type { Env } from "../env";

// Inference cost accounting. Every Claude call (via the metered LLM seam in llm.ts) records
// its real token usage + computed cost here, so spend is MEASURED, not estimated — and the
// budget cap (Phase 2) reads from the same KV counter this maintains.

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

/** Record one call's usage: fast KV daily-cost counter (for the budget) + a D1 history row. */
export async function recordUsage(
  env: Env,
  userId: string,
  feature: string,
  model: string,
  usage: Usage,
  discount = 1, // Message Batches bill at 50% → pass 0.5
): Promise<number> {
  const cents = costCents(model, usage) * discount;
  const day = new Date().toISOString().slice(0, 10);
  const round4 = (n: number) => Math.round(n * 10_000) / 10_000; // keep the running total at 4dp
  const key = `cost:${userId}:${day}`;
  const cur = Number((await env.RULES.get(key)) ?? 0);
  await env.RULES.put(key, String(round4(cur + cents)), { expirationTtl: 60 * 60 * 26 });
  // Platform-wide counter too, so the global daily ceiling (across ALL tenants) is enforceable —
  // N testers × the per-tenant cap would otherwise be unbounded.
  // NOTE: this is a non-atomic read-compute-write on a single hot KV key (every tenant's DO writes
  // it). Concurrent writers can lose updates → the global total UNDER-counts under load, so the
  // ceiling can be overshot. Interim mitigations: keep MAX_DAILY_COST_CENTS_GLOBAL set below the
  // true hard limit (headroom) and watch the 80%-of-global soft alert. The durable fix is a single
  // serialised counter (a dedicated CostCounter DO, or a D1 atomic `UPDATE … SET cents = cents + ?`).
  const gkey = `cost:global:${day}`;
  const gcur = Number((await env.RULES.get(gkey)) ?? 0);
  await env.RULES.put(gkey, String(round4(gcur + cents)), { expirationTtl: 60 * 60 * 26 });
  await env.DB.prepare(
    `INSERT INTO llm_usage (id, user_id, feature, model, input_tokens, output_tokens, cache_read_tokens, cost_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      userId,
      feature,
      model,
      usage.input_tokens ?? 0,
      usage.output_tokens ?? 0,
      usage.cache_read_input_tokens ?? 0,
      cents,
    )
    .run();
  return cents;
}

/** Today's spend in cents for a user (from the KV counter — cheap, for the budget gate). */
export async function spentTodayCents(env: Env, userId: string): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  return Number((await env.RULES.get(`cost:${userId}:${day}`)) ?? 0);
}

/** Today's platform-wide spend in cents (all tenants) — for the global daily ceiling. */
export async function spentTodayGlobalCents(env: Env): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  return Number((await env.RULES.get(`cost:global:${day}`)) ?? 0);
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
