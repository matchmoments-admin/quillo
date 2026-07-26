import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import type { Profile } from "./lib/db";
import { recordUsage, noteMeteringError } from "./lib/usage";
import { signBedrockInvoke } from "./lib/sigv4";

/**
 * Inference factory — the single seam through which ALL Claude calls go.
 *
 * This is what makes the "start on US Anthropic now, switch to AU-resident
 * Bedrock later" decision a config flip rather than a refactor. The Anthropic
 * SDK and the Bedrock SDK (@anthropic-ai/bedrock-sdk) expose the SAME
 * `.messages.create` surface and identical content-block shapes, so call sites
 * (src/extract.ts) never change — only the client + model id swap here.
 *
 * Rule: never construct `new Anthropic()` anywhere else.
 */
export interface LLM {
  client: Anthropic;
  modelId: string;
  /**
   * Metered message create — the single seam where EVERY model call is measured + costed.
   * Pass a `feature` tag (receipt | text | statement_pdf | statement_batch | ...). Usage is
   * recorded only when a userId context was supplied to getLLM (skipped in offline/eval use).
   */
  create(params: Anthropic.MessageCreateParamsNonStreaming, feature: string): Promise<Anthropic.Message>;
}

export interface LLMContext {
  userId: string;
}

const ANTHROPIC_HAIKU = "claude-haiku-4-5-20251001";
// Bedrock uses an inference-profile id (region / geographic cross-region profile). This is the
// `au.` profile, which keeps the whole request lifecycle inside Australia — as opposed to `apac.`,
// which spans the wider Asia-Pacific geography and therefore does NOT satisfy an AU-residency
// claim. CDR Privacy Safeguard 8 makes that distinction load-bearing (see assertAuResidency), so
// this is deliberately the narrow profile even though it has fewer regions to fail over into.
// Confirm the EXACT id in the Bedrock console at activation.
const BEDROCK_HAIKU = "au.anthropic.claude-haiku-4-5-20251001-v1:0";

// Every model id getLLM can emit. The check-units golden asserts each has a PRICING entry in
// usage.ts, so swapping the model here without updating pricing fails CI rather than silently
// under-counting spend and defeating the budget gate (#80).
export const LLM_MODEL_IDS = [ANTHROPIC_HAIKU, BEDROCK_HAIKU] as const;

// Exported so residency checks (and their goldens) can name the exact shape the provider is
// resolved from, rather than casting.
export type ProviderProfile = Pick<Profile, "inference_provider" | "inference_region">;

/**
 * The ONE place the inference provider is resolved: per-tenant override → env default → Anthropic.
 * Exported so residency checks and getLLM can never drift apart on the precedence rules.
 */
export function resolveProvider(env: Env, profile: ProviderProfile | null): string {
  return profile?.inference_provider ?? env.DEFAULT_INFERENCE_PROVIDER ?? "anthropic";
}

/**
 * Hard AU data-residency assert — throws unless this tenant's inference stays in Australia.
 *
 * This is NOT the APP-8 cross-border consent gate, and consent is NOT a substitute for it. Data
 * collected under the Consumer Data Right is governed by CDR Privacy Safeguard 8, which restricts
 * disclosure to overseas recipients and carries penalty provisions — a consumer cannot consent
 * their way past it, and the OSP-chain principal is liable for a breach. So any code path carrying
 * CDR-derived data must call this BEFORE a model call, and must fail closed: no feature flag, no
 * warn-and-continue, no silent fallback to the US provider.
 *
 * Bedrock in ap-southeast-2 on the `au.` inference profile is the only compliant path today.
 */
export function assertAuResidency(env: Env, profile: ProviderProfile | null, context: string): void {
  const provider = resolveProvider(env, profile);
  if (provider !== "bedrock") {
    throw new Error(
      `au_residency_required: ${context} carries CDR data, which must not leave Australia ` +
        `(CDR Privacy Safeguard 8), but inference_provider resolved to '${provider}'. ` +
        `Set the tenant's profiles.inference_provider to 'bedrock' — see CONFIG.md (AU residency).`,
    );
  }
}

// Wraps a client + model into a metered LLM. `create` records usage after each call.
function meter(env: Env, ctx: LLMContext | undefined, client: Anthropic, modelId: string): LLM {
  return {
    client,
    modelId,
    async create(params, feature) {
      const msg = await client.messages.create(params);
      if (ctx?.userId && msg.usage) {
        try {
          await recordUsage(env, ctx.userId, feature, modelId, msg.usage);
        } catch (e) {
          // Never let metering break a real call — but don't swallow the SIGNAL: the cost was
          // really incurred, so log + bump the cost_errors counter so the gap is visible/alertable.
          await noteMeteringError(env, ctx.userId, e);
        }
      }
      return msg;
    },
  };
}

export async function getLLM(env: Env, profile: ProviderProfile | null, ctx?: LLMContext): Promise<LLM> {
  const provider = resolveProvider(env, profile);

  if (provider === "anthropic") {
    return meter(env, ctx, new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }), ANTHROPIC_HAIKU);
  }

  if (provider === "bedrock") {
    // ── AU data-residency path (the ONLY guaranteed-AU option). ──
    // Fully wired but FLAG-GATED: inert until a tenant is on inference_provider='bedrock' AND the
    // AWS secrets are configured. We sign Bedrock InvokeModel directly with WebCrypto SigV4 (NO
    // @aws-sdk/*, which doesn't bundle into workerd), preserving the `.messages.create` surface so
    // src/extract.ts is unchanged. Requires Claude Haiku enabled in ap-southeast-2. See CONFIG.md.
    const region = profile?.inference_region ?? env.DEFAULT_INFERENCE_REGION ?? "ap-southeast-2";
    const accessKeyId = env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
      // Inert: the default Claude path is untouched; flipping a tenant to bedrock without secrets
      // fails loudly here rather than silently falling back to the US provider.
      throw new Error(
        "inference_provider=bedrock requires AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY secrets — see CONFIG.md (AU residency).",
      );
    }
    const modelId = BEDROCK_HAIKU;
    // Only the Anthropic Batch API reaches `.client` directly (agent.ts) — Bedrock has no equivalent,
    // so categoriseStatement routes Bedrock tenants to live mode. This stub throws clearly if a batch
    // path is ever hit on Bedrock, instead of a confusing undefined-property error.
    const client = new Proxy({} as Anthropic, {
      get() {
        throw new Error("Bedrock provider supports metered create() only — the Anthropic Batch API isn't available; use live categorisation.");
      },
    });
    return {
      client,
      modelId,
      async create(params, feature) {
        // Bedrock's body is the Anthropic Messages payload WITHOUT `model` (it's in the URL) and WITH
        // the bedrock anthropic_version marker.
        const { model: _model, ...rest } = params as Anthropic.MessageCreateParamsNonStreaming & { model?: string };
        const body = JSON.stringify({ anthropic_version: "bedrock-2023-05-31", ...rest });
        const signed = await signBedrockInvoke({ region, accessKeyId, secretAccessKey, modelId, body });
        const res = await fetch(signed.url, { method: "POST", headers: signed.headers, body: signed.body });
        if (!res.ok) {
          throw new Error(`Bedrock InvokeModel ${res.status}: ${await res.text()}`);
        }
        const msg = (await res.json()) as Anthropic.Message;
        if (ctx?.userId && msg.usage) {
          try {
            await recordUsage(env, ctx.userId, feature, modelId, msg.usage);
          } catch (e) {
            // Never break the real call, but surface the signal (same as the Anthropic path) — the
            // cost was incurred, so log + bump the cost_errors counter instead of swallowing it.
            await noteMeteringError(env, ctx.userId, e);
          }
        }
        return msg;
      },
    };
  }

  throw new Error(`unknown inference_provider: ${provider}`);
}
