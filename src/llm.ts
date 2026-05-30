import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import type { Profile } from "./lib/db";

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
}

const ANTHROPIC_HAIKU = "claude-haiku-4-5-20251001";
// Bedrock uses a different model-id format (region / cross-region inference profile).
// Confirm the exact id in the Bedrock console for ap-southeast-2 at switch time.
const BEDROCK_HAIKU = "apac.anthropic.claude-haiku-4-5-20251001-v1:0";

type ProviderProfile = Pick<Profile, "inference_provider" | "inference_region">;

export function getLLM(env: Env, profile: ProviderProfile | null): LLM {
  const provider = profile?.inference_provider ?? env.DEFAULT_INFERENCE_PROVIDER ?? "anthropic";

  if (provider === "anthropic") {
    return {
      client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
      modelId: ANTHROPIC_HAIKU,
    };
  }

  if (provider === "bedrock") {
    // ── AU data-residency seam (review finding B5: the ONLY guaranteed AU path) ──
    // To enable:
    //   1. npm install @anthropic-ai/bedrock-sdk
    //   2. import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
    //   3. const region = profile?.inference_region ?? env.DEFAULT_INFERENCE_REGION;
    //      return {
    //        client: new AnthropicBedrock({
    //          awsRegion: region,
    //          awsAccessKey: env.AWS_ACCESS_KEY_ID,
    //          awsSecretKey: env.AWS_SECRET_ACCESS_KEY,
    //        }) as unknown as Anthropic,   // structurally compatible .messages.create
    //        modelId: BEDROCK_HAIKU,
    //      };
    //   4. FIRST confirm claude-haiku-4-5 is enabled in ap-southeast-2 (Sydney) in
    //      the Bedrock console — the investigation could not verify its availability.
    void BEDROCK_HAIKU;
    throw new Error(
      "inference_provider=bedrock is not yet wired — see the seam in src/llm.ts",
    );
  }

  throw new Error(`unknown inference_provider: ${provider}`);
}
