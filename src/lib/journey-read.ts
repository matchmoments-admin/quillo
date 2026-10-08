// GET /api/journey — the D1 composition behind the first-timer app shell + Home (spec A11, #582; flag
// ft_journey). journey.ts holds the pure step rules (assessJourney) and the per-step D1 counts
// (journeySignals); this module stitches them to readiness, the A8 receipt-match proposals, A7's records
// block and the A11b Grow layer exactly as the Durable Object serves them.
//
// Extracted from TaxAgent.journey (#595) so the first-timer e2e journey (scripts/e2e-first-timer.ts) drives
// THIS composition rather than a replica of it. Read-only; behaviour unchanged.
//
// GENERAL-INFO only: nothing here computes tax, a refund or a rate.

import type { Env } from "../env";
import { getProfile, getSituation } from "./db";
import { featureOn } from "./features";
import { resolveJurisdictionForUser } from "./jurisdiction";
import { resolveRulePack } from "./report";
import { reconcileProposals } from "./queries";
import { reconcileConfigFromPack } from "./reconcile-proposer";
import { recordsView } from "./records";
import { listNoticed } from "./noticed-signals";
import { growPayload, type GrowPayload } from "./grow";
import { isPartner } from "./roles";
import { lodgingFy } from "./lodging-year";
import { computeFilingReadiness, type FilingReadinessDeps } from "./filing-readiness";
import { assessJourney, coldJourney, journeyLodgedFys, journeySignals, type Journey } from "./journey";

/**
 * One composite read for the new app shell + Home: readiness (unaudited — see computeFilingReadiness),
 * the per-step signals and, with reconcile_proposals ON, the confident receipt-to-line proposals still
 * waiting for a tap. `deps.now` is the clock for the lodging-year default (production = now).
 */
export async function readJourney(env: Env, userId: string, startYear: number, deps: FilingReadinessDeps): Promise<Journey> {
  const now = deps.now ?? new Date();
  // A brand-new signup has no profile until onboarding writes one, but the shell mounts this read
  // straight away: answer "nothing started" instead of a 500 (+ client retries) on every first load.
  const profile = await getProfile(env, userId);
  if (!profile) return coldJourney(startYear, lodgingFy(now, (await resolveJurisdictionForUser(env, userId)).taxPeriod, []));
  const jur = await resolveJurisdictionForUser(env, userId);
  const [readiness, situation] = await Promise.all([computeFilingReadiness(env, userId, startYear, deps), getSituation(env, userId, profile)]);
  const signals = await journeySignals(env, userId, startYear, situation, jur);
  const pack = await resolveRulePack(env, userId, jur);
  // A3 (#577) + spec §0: the open "We noticed…" cards (payroll / platform / government / interest / foreign) are
  // Review cards, so they count in the Review step. Without this the step could read "done" while a payroll card
  // still waited for its answer (#595). wages_payer OFF ⇒ no read, count stays 0.
  if (featureOn(env, "wages_payer")) signals.bring_in.open_signals = (await listNoticed(env, userId, startYear)).length;
  if (featureOn(env, "reconcile_proposals")) {
    const cfg = reconcileConfigFromPack(pack);
    signals.check.proposals = (await reconcileProposals(env, userId, startYear, cfg, jur)).proposals.length;
  }
  // A7 (#588): the Records step's counts — claims with a record / under an exception, facts needed/stated.
  signals.records = (await recordsView(env, userId, startYear, pack, jur)).block;
  // A11b (#592): Grow visibility (data presence is computed here, so existing tenants see their layers on
  // first load) + the open "looks like you have X" suggestions.
  // Navigation extras only: a Grow failure (e.g. 0083 not yet applied) must never take the whole shell down.
  const grow = await (async () => growPayload(env, userId, startYear, { isPartner: isPartner(profile), pack, descriptor: jur }))()
    .catch((e): GrowPayload => { console.error("journey: grow payload failed", e instanceof Error ? e.message : String(e)); return { layers: [], suggestions: [] }; });
  // lodging_fy = #572's lodging-year default (the earliest unlodged FY whose year has ended), not the FY asked for.
  return assessJourney({ readiness, signals, grow, lodgingFy: lodgingFy(now, jur.taxPeriod, await journeyLodgedFys(env, userId)) });
}
