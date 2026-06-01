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
  return (c / 1_000_000) * 100; // → cents (fractional)
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
  const key = `cost:${userId}:${day}`;
  const cur = Number((await env.RULES.get(key)) ?? 0);
  await env.RULES.put(key, String(cur + cents), { expirationTtl: 60 * 60 * 26 });
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
