import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import type { Profile } from "./lib/db";
import { recordUsage, noteMeteringError } from "./lib/usage";
import { signBedrockInvoke } from "./lib/sigv4";
import { AU_DESCRIPTOR, ALL_JURISDICTIONS, type JurisdictionDescriptor } from "./lib/jurisdiction";

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

// Bedrock addresses a model through a GEOGRAPHIC inference profile: a jurisdiction prefix plus the
// base model id. The prefix is what confines the request lifecycle to a geography — `au.` stays in
// Australia (verified: ap-southeast-2 + ap-southeast-4 only), whereas `apac.` spans the wider
// Asia-Pacific and `global.` routes anywhere, neither of which supports a residency claim.
//
// The prefix therefore comes from the tenant's jurisdiction (JurisdictionDescriptor.residency), not
// from a constant here — an AU customer gets `au.`, a UK customer gets `eu.`. Only the base id is
// shared.
const BEDROCK_BASE_MODEL = "anthropic.claude-haiku-4-5-20251001-v1:0";

/** The Bedrock model id for a jurisdiction, e.g. 'au.' + base ⇒ au.anthropic.claude-haiku-…. */
export function bedrockModelIdFor(descriptor: JurisdictionDescriptor): string {
  return `${descriptor.residency.profilePrefix}${BEDROCK_BASE_MODEL}`;
}

// Every model id getLLM can emit. The check-units golden asserts each has a PRICING entry in
// usage.ts, so swapping the model here without updating pricing fails CI rather than silently
// under-counting spend and defeating the budget gate (#80). Derived from the jurisdiction table so
// adding a jurisdiction can't forget to price its profile.
export const LLM_MODEL_IDS = [
  ANTHROPIC_HAIKU,
  ...ALL_JURISDICTIONS.map(bedrockModelIdFor),
] as const;

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
 * The region inference will actually run in for this tenant. Single source of truth, shared by the
 * residency assert and getLLM so the thing we CHECK is the thing we CALL.
 */
export function resolveRegion(env: Env, profile: ProviderProfile | null, descriptor: JurisdictionDescriptor): string {
  return profile?.inference_region ?? env.DEFAULT_INFERENCE_REGION ?? descriptor.residency.regions[0];
}

/**
 * Hard data-residency assert — throws unless this tenant's inference stays inside their own
 * jurisdiction.
 *
 * This is NOT the APP-8 cross-border consent gate, and consent is NOT a substitute for it. Data
 * collected under the Consumer Data Right is governed by CDR Privacy Safeguard 8, which restricts
 * disclosure to overseas recipients and carries penalty provisions — a consumer cannot consent
 * their way past it, and the OSP-chain principal is liable for a breach. So any code path carrying
 * such data must call this BEFORE a model call, and must fail closed: no feature flag, no
 * warn-and-continue, no silent fallback to a foreign provider.
 *
 * THREE conditions, all required. The original version checked only the first, which meant a tenant
 * on inference_provider='bedrock' with inference_region='us-east-1' passed an assert whose name
 * promised Australian residency. AWS IAM caught that in practice — but relying on it is
 * infrastructure compensating for an application bug, and it stops working as soon as a second
 * jurisdiction exists, because a multi-jurisdiction credential must be allowed in both regions.
 */
export function assertDataResidency(
  env: Env,
  profile: ProviderProfile | null,
  descriptor: JurisdictionDescriptor,
  context: string,
): void {
  const { regions, basis, profilePrefix } = descriptor.residency;
  const fail = (detail: string): never => {
    throw new Error(
      `data_residency_required: ${context} carries data that must stay in ${descriptor.code} ` +
        `(${basis}), but ${detail}. Allowed regions: ${regions.join(", ")}. See CONFIG.md (data residency).`,
    );
  };

  // 1. Provider — only Bedrock offers a region we control. The Anthropic API is US-served.
  const provider = resolveProvider(env, profile);
  if (provider !== "bedrock") {
    fail(`inference_provider resolved to '${provider}' (set profiles.inference_provider to 'bedrock')`);
  }

  // 2. Region — the actual region this call will be signed for.
  const region = resolveRegion(env, profile, descriptor);
  if (!regions.includes(region)) {
    fail(`the resolved region is '${region}', which is outside the jurisdiction`);
  }

  // 3. Model profile — a regional endpoint can still be handed a `global.`/`us.` inference profile,
  // which would route the request back out of the geography. The prefix is the actual containment.
  const modelId = bedrockModelIdFor(descriptor);
  if (!modelId.startsWith(profilePrefix)) {
    fail(`the model id '${modelId}' is not on the '${profilePrefix}' geographic inference profile`);
  }
}

/**
 * @deprecated Use assertDataResidency with the tenant's descriptor. Retained so existing AU call
 * sites and their goldens keep working unchanged while jurisdictions are threaded through.
 */
export function assertAuResidency(env: Env, profile: ProviderProfile | null, context: string): void {
  assertDataResidency(env, profile, AU_DESCRIPTOR, context);
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

/**
 * Resolve the AWS credentials for a jurisdiction.
 *
 * Per-jurisdiction by design. A single credential permitted in every supported region would
 * destroy the property that makes the IAM layer worth having: each key's policy denies everything
 * outside its own regions, so an application bug cannot route one country's data into another's
 * Bedrock. One shared key would make IAM allow both, and the guarantee would rest entirely on
 * application correctness — which is exactly what it exists to backstop.
 *
 * Falls back to the unsuffixed pair so a single-jurisdiction deployment (today) needs no new
 * secrets and behaves identically.
 */
function awsCredentialsFor(env: Env, descriptor: JurisdictionDescriptor): { accessKeyId?: string; secretAccessKey?: string } {
  // Dynamic key lookup: the suffixed names are declared on Env, but which one applies is only known
  // at runtime from the descriptor.
  const vars = env as unknown as Record<string, string | undefined>;
  const suffix = descriptor.residency.credentialSuffix;
  return {
    accessKeyId: vars[`AWS_ACCESS_KEY_ID_${suffix}`] ?? env.AWS_ACCESS_KEY_ID,
    secretAccessKey: vars[`AWS_SECRET_ACCESS_KEY_${suffix}`] ?? env.AWS_SECRET_ACCESS_KEY,
  };
}

export async function getLLM(
  env: Env,
  profile: ProviderProfile | null,
  ctx?: LLMContext,
  // Optional so all existing call sites are byte-identical: every tenant today is AU.
  descriptor: JurisdictionDescriptor = AU_DESCRIPTOR,
): Promise<LLM> {
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
    const region = resolveRegion(env, profile, descriptor);
    const { accessKeyId, secretAccessKey } = awsCredentialsFor(env, descriptor);
    const suffix = descriptor.residency.credentialSuffix;
    if (!accessKeyId || !secretAccessKey) {
      // Inert: the default Claude path is untouched; flipping a tenant to bedrock without secrets
      // fails loudly here rather than silently falling back to the US provider.
      throw new Error(
        `inference_provider=bedrock requires AWS_ACCESS_KEY_ID_${suffix} / AWS_SECRET_ACCESS_KEY_${suffix} ` +
          `(or the unsuffixed pair) — see CONFIG.md (data residency).`,
      );
    }
    // Belt-and-braces: getLLM is reachable from paths that never called the residency assert (an
    // ordinary receipt, say). Re-checking the region here means a mis-set inference_region can
    // never be SIGNED for a foreign endpoint, whatever the caller did or didn't check.
    if (!descriptor.residency.regions.includes(region)) {
      throw new Error(
        `data_residency_required: refusing to sign a Bedrock call for region '${region}', outside ` +
          `${descriptor.code} (${descriptor.residency.basis}). Allowed: ${descriptor.residency.regions.join(", ")}.`,
      );
    }
    const modelId = bedrockModelIdFor(descriptor);
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
