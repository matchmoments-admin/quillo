import type { Env } from "../env";
import { getLLM, resolveProvider, type LLM, type ProviderProfile } from "../llm";
import type { JurisdictionDescriptor } from "./jurisdiction";
import { budgetRefusal } from "./billing";

// ── The one gate in front of every model call (#721, docs/architecture/deepening-2026-10.md §1) ──
//
// Every DO method that calls the model used to hand-write the same sequence: resolve the provider, run
// the APP-8 cross-border consent check, run the budget gate, build the client, record the inference
// audit, then call the extractor. Twelve copies, in slightly different orders, enforced only by
// convention. The APP-8 invariant (CLAUDE.md: "the gate runs BEFORE any model call") now lives here:
// the callback that makes the model call cannot run until consent and budget have both passed.
//
// The error messages are the ones src/api.ts has always mapped (403 / 429), so callers that throw keep
// their wire contract. Callers that degrade instead of throwing (the categorisation paths return 0 or
// mark the row) pass onConsentRequired / onBudgetReached, which run INSTEAD of throwing and only for a
// gate refusal, never for an error the callback raises.

export const CONSENT_REQUIRED = "consent_required";
export const AI_BUDGET_REACHED = "ai_budget_reached";

/** Every feature tag a model call is audited under. One per call site in src/agent.ts. */
export const AI_PURPOSES = [
  "parse_statement",
  "parse_capital_import",
  "categorise_statement",
  "categorise_feed",
  "categorise",
  "classify_document",
  "import_depreciation_schedule",
  "claim_review_draft",
  "phi_claim",
  "onboarding_draft",
  "ask",
  "guide_me",
] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];

/** What the gate needs from a tenant profile: the provider override plus the recorded consent. */
export type AiProfile = ProviderProfile & { consent_xborder?: number | null };

export interface AiCallDeps {
  env: Env;
  /** The per-tenant + global cost caps and the billing wallet. txnId, when given, is marked on refusal. */
  withinBudget(userId: string, txnId: string | null): Promise<boolean>;
  /** Append to the hash-chained audit log (the DO passes its own so appends stay serialised). */
  audit(userId: string, event: string, detail: string): Promise<void>;
}

export interface AiCallRequest<T> {
  userId: string;
  purpose: AiPurpose;
  profile: AiProfile;
  /** Passed to withinBudget so a refused receipt is marked needs_review and the user told. */
  txnId?: string | null;
  /**
   * "gate" (default): one budget check before the callback. "caller": the callback checks the budget
   * itself before each chunk (the categorisation loops, which stop part-way and keep what they did).
   */
  budget?: "gate" | "caller";
  /** The tenant's jurisdiction, resolved after the gates (getLLM picks the residency profile from it). */
  descriptor?: () => Promise<JurisdictionDescriptor>;
  /**
   * Work that must happen after the gates pass but before the client is built: a rate limiter, or a
   * duplicate short-circuit that needs no model call. Returning `{ result }` ends the call there, with
   * no client built and no inference audited.
   */
  afterGates?: () => Promise<{ result: T } | void>;
  /** Return this instead of throwing consent_required. */
  onConsentRequired?: () => T | Promise<T>;
  /** Return this instead of throwing ai_budget_reached. */
  onBudgetReached?: () => T | Promise<T>;
}

export interface AiCallContext {
  /** The resolved provider ("anthropic" | "bedrock" | ...), for callers whose routing depends on it. */
  provider: string;
}

/** True when this tenant's calls go to the US provider and they have not recorded APP-8 consent. */
export function needsXborderConsent(env: Env, profile: AiProfile): boolean {
  return resolveProvider(env, profile) === "anthropic" && profile.consent_xborder !== 1;
}

/**
 * The consent check on its own, for a caller that must refuse before doing cheap work that needs no
 * model call (guideMe checks consent before its cache). aiCall runs the same check again; it is pure.
 */
export function requireXborderConsent(env: Env, profile: AiProfile): void {
  if (needsXborderConsent(env, profile)) throw new Error(CONSENT_REQUIRED);
}

/**
 * Record that an inference happened, once per operation, with the feature and model id and NEVER any
 * payload. A US call is an APP-8 cross-border disclosure (`xborder_inference`); an AU call still leaves
 * an `au_inference` breadcrumb because CDR requires a positive record of every use of CDR data.
 */
export async function recordInference(
  audit: AiCallDeps["audit"],
  userId: string,
  provider: string,
  feature: string,
  model: string,
): Promise<void> {
  if (provider === "anthropic") {
    await audit(userId, "xborder_inference", JSON.stringify({ feature, model }));
    return;
  }
  await audit(userId, "au_inference", JSON.stringify({ provider, feature, model }));
}

/**
 * Run `fn` with a model client, but only after the APP-8 consent gate and the budget gate pass.
 * Order: consent → budget → afterGates → getLLM → inference audit → fn.
 */
export async function aiCall<T>(
  deps: AiCallDeps,
  req: AiCallRequest<T>,
  fn: (llm: LLM, ctx: AiCallContext) => Promise<T>,
): Promise<T> {
  const { env } = deps;
  const provider = resolveProvider(env, req.profile);
  if (provider === "anthropic" && req.profile.consent_xborder !== 1) {
    if (req.onConsentRequired) return req.onConsentRequired();
    throw new Error(CONSENT_REQUIRED);
  }
  if ((req.budget ?? "gate") === "gate" && !(await deps.withinBudget(req.userId, req.txnId ?? null))) {
    if (req.onBudgetReached) return req.onBudgetReached();
    throw new Error(AI_BUDGET_REACHED);
  }
  if (req.afterGates) {
    const early = await req.afterGates();
    if (early) return early.result;
  }
  const descriptor = req.descriptor ? await req.descriptor() : undefined;
  const llm = await getLLM(env, req.profile, { userId: req.userId }, descriptor);
  await recordInference(deps.audit, req.userId, provider, req.purpose, llm.modelId);
  return fn(llm, { provider });
}

const json = (data: unknown, status: number) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/**
 * The HTTP answer for a gate refusal: consent_required → 403, ai_budget_reached → 429 with the reason
 * (empty wallet vs daily cap). Anything else → null, so the route handles its own errors.
 * `budgetMessage` lets a route add to the refusal text (the onboarding draft offers the manual form).
 */
export async function aiErrorResponse(
  e: unknown,
  env: Env,
  userId: string,
  opts?: { budgetMessage?: (message: string) => string },
): Promise<Response | null> {
  const msg = (e as Error)?.message;
  if (msg === CONSENT_REQUIRED) return json({ error: CONSENT_REQUIRED }, 403);
  if (msg === AI_BUDGET_REACHED) {
    const reason = await budgetRefusal(env, userId);
    return json({ error: opts?.budgetMessage ? opts.budgetMessage(reason) : reason }, 429);
  }
  return null;
}
