import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import type { Profile } from "./lib/db";
import { recordUsage } from "./lib/usage";

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
// Bedrock uses a different model-id format (region / cross-region inference profile).
// Confirm the exact id in the Bedrock console for ap-southeast-2 at switch time.
const BEDROCK_HAIKU = "apac.anthropic.claude-haiku-4-5-20251001-v1:0";

type ProviderProfile = Pick<Profile, "inference_provider" | "inference_region">;

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
        } catch {
          /* never let metering break a real call */
        }
      }
      return msg;
    },
  };
}

export async function getLLM(env: Env, profile: ProviderProfile | null, ctx?: LLMContext): Promise<LLM> {
  const provider = profile?.inference_provider ?? env.DEFAULT_INFERENCE_PROVIDER ?? "anthropic";

  if (provider === "anthropic") {
    return meter(env, ctx, new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }), ANTHROPIC_HAIKU);
  }

  if (provider === "bedrock") {
    // ── AU data-residency seam (review finding B5: the ONLY guaranteed AU path). ──
    // The `@anthropic-ai/bedrock-sdk` dependency is INSTALLED and the wiring is ready (the
    // exact code is below + in CONFIG.md), but its transitive `@aws-sdk/*` credential
    // providers don't bundle into a Cloudflare Worker (a known Workers incompatibility), so
    // we keep it un-imported until activation. Claude (US) stays the default. At switch time,
    // either resolve the AWS-SDK bundling (wrangler alias/nodejs_compat) or sign Bedrock
    // InvokeModel calls directly with WebCrypto SigV4 — both keep the `.messages.create`
    // surface so src/extract.ts is unchanged. Requires AWS_ACCESS_KEY_ID / _SECRET_ACCESS_KEY
    // and Claude Haiku enabled in ap-southeast-2.
    //
    //   const { AnthropicBedrock } = await import("@anthropic-ai/bedrock-sdk");
    //   return { client: new AnthropicBedrock({ awsRegion, awsAccessKey, awsSecretKey })
    //              as unknown as Anthropic, modelId: BEDROCK_HAIKU };
    void BEDROCK_HAIKU;
    void env;
    throw new Error("inference_provider=bedrock isn't activated yet — see CONFIG.md (AU residency).");
  }

  throw new Error(`unknown inference_provider: ${provider}`);
}
