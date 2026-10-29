// Filing readiness — the D1 side of the capstone readiness check (src/lib/readiness.ts is the pure engine).
//
// Gathers every impure signal the engine needs (buildReport, the situation, the matched claim rules, the
// counted review/evidence signals and each flag-gated signal helper) and hands them to assessReadiness.
// Extracted from TaxAgent.computeFilingReadiness (#595) so the first-timer e2e journey
// (scripts/e2e-first-timer.ts) exercises THIS code rather than a hand-typed replica of it — the same reason
// capital-signals.ts was extracted. The DO keeps the audit row (assessFilingReadiness) and supplies its
// KV-first rule-pack loader; behaviour is unchanged.
//
// GENERAL-INFO only: nothing here computes tax, a refund or a rate.

import type { Env } from "../env";
import { getProfile, getSituation, type Profile } from "./db";
import { buildReport } from "./report";
import { matchClaimRules, type ClaimRule } from "./claimability";
import { fyBounds, fyLabel } from "./ledger-totals";
import { COUNTABLE } from "./queries";
import { parseAmmaComponents } from "./managed-fund";
import { capitalReadinessSignals } from "./capital-signals";
import { firstTimerIncomeSignals } from "./first-timer-signals";
import { mytaxWorksheetSignals } from "./mytax-worksheet";
import { situationProfileSignals } from "./situation-profile";
import { payrollEmployerSignals, unfiledRentalSignals } from "./noticed-signals";
import { statementCoverageSignals, unlinkedLoanSignals } from "./statement-coverage";
import { featureOn } from "./features";
import { resolveJurisdictionForUser } from "./jurisdiction";
import { assessReadiness, type FilingReadiness, type FilingReadinessSignals } from "./readiness";
import { tenantDb } from "./tenant-db";

export interface FilingReadinessDeps {
  /** The tenant's rule pack by version (the DO's KV-first loader; the bundled pack when KV has none). */
  loadRulePack: (ver: string) => Promise<unknown>;
  /** generatedAt clock (tests pin it; production = now). */
  now?: Date;
}

async function requireProfile(env: Env, userId: string): Promise<Profile> {
  const p = await getProfile(env, userId);
  if (!p) throw new Error(`no profile for tenant ${userId}`);
  return p;
}

/**
 * The tenant's claim-rule set: the rule pack ∪ per-tenant D1 rows. D1 rows are scoped so a global pack
 * override (user_id IS NULL) applies to everyone while AI gap-fill rows stay tenant-private. The single
 * implementation: the DO's loadClaimRules (suggestClaims / reviewClaims) delegates here.
 */
export async function loadClaimRules(env: Env, userId: string, rulePackVer: string, deps: FilingReadinessDeps): Promise<ClaimRule[]> {
  const pack = await deps.loadRulePack(rulePackVer);
  const packRules = ((pack as { claimability?: ClaimRule[] }).claimability ?? []) as ClaimRule[];
  // NB: requires_entity_kind is a pack-only field (JSON rules); the claimability_rules table has no such column.
  const d1 = (
    await tenantDb(env, userId).prepare(
      `SELECT id, scope_type, scope_value, merchant_hint, ato_label, claim_type, default_method, general_info_note, defer_to_agent
         FROM claimability_rules WHERE rule_pack_ver = ? AND (user_id IS NULL OR user_id = ?)`,
    ).bind(rulePackVer).all<ClaimRule>()
  ).results ?? [];
  return [...packRules, ...d1];
}

/**
 * The readiness computation itself, without the audit row. assessFilingReadiness (the Filing page — an
 * explicit "assess my year") audits; the journey reads it on every shell load and must not flood the audit
 * log with one readiness_assessed row per navigation.
 */
export async function computeFilingReadiness(env: Env, userId: string, startYear: number, deps: FilingReadinessDeps): Promise<FilingReadiness> {
  const profile = await requireProfile(env, userId);
  const fy = fyLabel(startYear);
  const readinessJur = await resolveJurisdictionForUser(env, userId);
  const { start, end } = fyBounds(startYear, readinessJur);
  const [report, situation] = await Promise.all([buildReport(env, userId, startYear), getSituation(env, userId, profile)]);

  // Matched situation-level claim rules (defer-to-agent ones become "judgement" findings). Iterate
  // distinct property statuses since the context carries a single property_status; occupation/
  // entity rules match regardless. Merchant-scoped rules can't fire here (no merchant) — intended.
  const pack = await deps.loadRulePack(profile.rule_pack_ver); // for thresholds_by_fy below
  const allRules = await loadClaimRules(env, userId, profile.rule_pack_ver, deps);
  const occupations = situation.persons.map((p) => p.occupation).filter((o): o is string => !!o);
  const entity_kinds = situation.entities.map((e) => e.kind);
  const statuses = [...new Set(situation.properties.map((p) => p.status))];
  const matchedById = new Map<string, ClaimRule>();
  for (const st of statuses.length ? statuses : [null]) {
    for (const r of matchClaimRules(allRules, { property_status: st, occupations, entity_kinds })) {
      matchedById.set(r.id ?? `${r.scope_type}:${r.scope_value}`, r);
    }
  }

  // Pre-counted impure signals handed to the pure engine.
  const unknownRow = report.by_bucket.find((b) => b.bucket === "unknown");
  const confidenceFloor = 0.6;
  // Foreign-currency rows we couldn't convert (currency != AUD AND amount_aud_cents IS NULL): excluded
  // from the position by FX_CONVERTED, surfaced here so the excluded money stays visible. Counts the
  // income rows + the dated transactions in this FY window.
  const fxUnconvertedPredicate = "COALESCE(currency,'AUD') <> 'AUD' AND amount_aud_cents IS NULL";
  const [needsIncome, needsAssets, lowConf, divDoc, agentSummaryProps, disposed, fxIncome, fxTxns] = await Promise.all([
    tenantDb(env, userId).prepare(`SELECT COUNT(*) AS n FROM income WHERE user_id = ? AND fy = ? AND needs_review = 1`).bind(fy).first<{ n: number }>(),
    tenantDb(env, userId).prepare(`SELECT COUNT(*) AS n FROM assets WHERE user_id = ? AND needs_review = 1 AND status = 'active'`).bind().first<{ n: number }>(),
    tenantDb(env, userId).prepare(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND confidence IS NOT NULL AND confidence < ? AND txn_date >= ? AND txn_date <= ? AND ${COUNTABLE}`).bind(confidenceFloor, start, end).first<{ n: number }>(),
    tenantDb(env, userId).prepare(`SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND doc_type IN ('dividend_statement','managed_fund_amma') AND (fy = ? OR fy IS NULL)`).bind(fy).first<{ n: number }>(),
    tenantDb(env, userId).prepare(`SELECT DISTINCT property_id FROM documents WHERE user_id = ? AND doc_type = 'agent_rental_summary' AND property_id IS NOT NULL`).bind().all<{ property_id: string }>(),
    tenantDb(env, userId).prepare(`SELECT COUNT(*) AS n FROM assets WHERE user_id = ? AND disposed_date IS NOT NULL AND disposed_date >= ? AND disposed_date <= ?`).bind(start, end).first<{ n: number }>(),
    tenantDb(env, userId).prepare(`SELECT COUNT(*) AS n FROM income WHERE user_id = ? AND fy = ? AND ${fxUnconvertedPredicate}`).bind(fy).first<{ n: number }>(),
    tenantDb(env, userId).prepare(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND txn_date >= ? AND txn_date <= ? AND status NOT IN ('duplicate','ignored') AND ${fxUnconvertedPredicate}`).bind(start, end).first<{ n: number }>(),
  ]);
  const haveSummaryFor = new Set((agentSummaryProps.results ?? []).map((r) => r.property_id));
  const rentalPropsMissingSummary = report.per_property
    .filter((p) => p.income_cents > 0 && !haveSummaryFor.has(p.property_id))
    .map((p) => ({ property_id: p.property_id, label: p.label }));

  const thresholds = (pack as { thresholds_by_fy?: Record<string, { instant_asset_write_off_cents?: number; div293_threshold_cents?: number; gst_registration_threshold_cents?: number }> }).thresholds_by_fy ?? {};
  // Prior-year capital losses are an all-time carry-forward (not FY-scoped) — sum them so readiness
  // can surface a defer finding (capture-only; never applied to the headline).
  const capLoss = await tenantDb(env, userId).prepare(`SELECT COALESCE(SUM(loss_cents),0) AS total FROM capital_loss_carryins WHERE user_id = ?`).bind().first<{ total: number }>();
  // F: properties flagged as a main residence and disposed in this FY — their gain is kept OUT of the
  // computed position (no auto-exemption), so readiness surfaces a defer nudge.
  const mainResDisposal = await tenantDb(env, userId).prepare(
    `SELECT COUNT(*) AS n FROM properties WHERE user_id = ? AND main_residence_flag = 1
       AND disposal_date IS NOT NULL AND disposal_date >= ? AND disposal_date <= ?
       AND cost_base_cents IS NOT NULL AND disposal_proceeds_cents IS NOT NULL`,
  ).bind(start, end).first<{ n: number }>();
  // B: net AMIT cost-base amount across this FY's managed-fund distributions (capture-only; defer nudge).
  let mfCostBaseAdjustmentCents = 0;
  if (featureOn(env, "mf_components")) {
    const mfRows = (await tenantDb(env, userId).prepare(
      `SELECT detail_json FROM income WHERE user_id = ? AND fy = ? AND income_type = 'managed_fund_distribution' AND detail_json IS NOT NULL`,
    ).bind(fy).all<{ detail_json: string | null }>()).results ?? [];
    for (const r of mfRows) {
      const c = parseAmmaComponents(r.detail_json);
      if (c) mfCostBaseAdjustmentCents += c.amit_cost_base_net_amount_cents;
    }
  }
  // C1 + C3 capital readiness signals. Both queries and the complementarity invariant between the
  // "no cost base" review finding and its promoted blocker now live in src/lib/capital-signals.ts —
  // extracted so the persona goldens exercise THIS code rather than a hand-typed replica of it, which
  // is what the C3 hardening review found them doing. Populated only when the relevant flag is on, so
  // OFF keeps the findings byte-identical.
  const capitalSignals = await capitalReadinessSignals(env, userId);
  // #550 first_timer_income: payer count + sole-trader expense total (src/lib/first-timer-signals.ts — the
  // same function the persona goldens call). Flag OFF ⇒ {} ⇒ findings byte-identical.
  const firstTimerSignals = await firstTimerIncomeSignals(env, userId, startYear, readinessJur);
  // #575 mytax_worksheet: unlabelled work-related rows (src/lib/mytax-worksheet.ts — the same function the
  // persona goldens call). Reuses the report already built. Flag OFF ⇒ {} ⇒ findings byte-identical.
  // Isolated: a presentation-only REVIEW nudge must never take down the readiness page (the endpoint itself still fails loudly).
  const worksheetSignals = await mytaxWorksheetSignals(env, userId, startYear, report).catch((e) => {
    console.error("mytax_worksheet signal failed", (e as Error).message);
    return {};
  });
  // #571 situation_profile: per-person dated situation periods for this FY (src/lib/situation-profile.ts —
  // the same function the persona goldens call). Flag OFF ⇒ {} ⇒ findings byte-identical.
  const situationSignals = await situationProfileSignals(env, userId, startYear, readinessJur);
  // #577 wages_payer: per-employer "income statement not recorded" (src/lib/noticed-signals.ts — the same
  // function the persona goldens call). Flag OFF ⇒ {} ⇒ findings byte-identical.
  const payrollSignals = await payrollEmployerSignals(env, userId, startYear, readinessJur);
  // #472 statement_coverage: statement accounts whose uploads leave part of the FY uncovered. Flag OFF ⇒ not
  // read ⇒ findings byte-identical.
  const statementCoverage = featureOn(env, "statement_coverage") ? await statementCoverageSignals(env, userId, start, end) : undefined;
  // loan_purpose_prompt: loans charging interest this FY that no property link counts. Flag OFF ⇒ not read.
  const unlinkedLoans = featureOn(env, "loan_purpose_prompt") ? await unlinkedLoanSignals(env, userId, start, end) : undefined;
  // rental_property_gate: open "add this property?" cards whose rent is still unfiled. Flag OFF ⇒ not read.
  const unfiledRentals = await unfiledRentalSignals(env, userId, fy);
  // GST registration status for the turnover nudge — registered if the tenant default is set OR any
  // entity is flagged (mirrors gstTotals' registration test in ledger-totals.ts).
  const entGstReg = (await tenantDb(env, userId).prepare(`SELECT COUNT(*) AS n FROM entities WHERE user_id = ? AND COALESCE(gst_registered,0) = 1`).bind().first<{ n: number }>())?.n ?? 0;
  const isGstRegistered = (profile.gst_registered ?? 0) === 1 || entGstReg > 0;
  // S2: self-declared PSI status across the user's business activities → sharpen/suppress the PSI nudge.
  const psiRows = (await tenantDb(env, userId).prepare(`SELECT psi_status FROM income_activities WHERE user_id = ? AND activity_type = 'business'`).bind().all<{ psi_status: string | null }>()).results ?? [];
  const psiAppliesDeclared = psiRows.some((r) => r.psi_status === "psi_applies");
  const psiAllAssessed = psiRows.length > 0 && psiRows.every((r) => r.psi_status != null);
  // integrity_nudges (audit wave 1): populate the four extra signals ONLY when the flag is on, so
  // OFF ⇒ the readiness findings are byte-identical. Reference thresholds come from the pack (never
  // computed into $ outcomes); the rideshare heuristic looks at occupations + business-activity labels.
  const integrityOn = featureOn(env, "integrity_nudges");
  let rideshareGstLikely = false;
  let nonConcessionalContributedCents = 0;
  if (integrityOn) {
    const RIDESHARE_HINTS = ["uber", "didi", "ola", "rideshare", "ride-share", "ride sourcing", "ride-sourcing", "taxi"];
    const bizActivities = (await tenantDb(env, userId).prepare(
      `SELECT occupation_scope, label FROM income_activities WHERE user_id = ? AND activity_type = 'business'`,
    ).bind().all<{ occupation_scope: string | null; label: string | null }>()).results ?? [];
    const looksRideshare = (s: string | null | undefined) => !!s && RIDESHARE_HINTS.some((h) => s.toLowerCase().includes(h));
    rideshareGstLikely = occupations.includes("driver")
      || bizActivities.some((a) => a.occupation_scope === "driver" || looksRideshare(a.label));
    try {
      nonConcessionalContributedCents = (await tenantDb(env, userId).prepare(
        `SELECT COALESCE(SUM(amount_cents),0) AS c FROM super_contributions WHERE user_id = ? AND fy = ? AND type = 'non_concessional'`,
      ).bind(fy).first<{ c: number }>())?.c ?? 0;
    } catch (e) {
      if (!/no such table|no such column/i.test((e as Error).message)) throw e;
    }
  }
  const integrityThresholds = thresholds[fy] as { franking_holding_rule_threshold_cents?: number; fito_de_minimis_cents?: number; super_non_concessional_cap_cents?: number } | undefined;
  const signals: FilingReadinessSignals = {
    unknownBucketCents: unknownRow?.total_cents ?? 0,
    unknownBucketN: unknownRow?.n ?? 0,
    lowConfidenceN: lowConf?.n ?? 0,
    needsReviewIncomeN: needsIncome?.n ?? 0,
    needsReviewAssetsN: needsAssets?.n ?? 0,
    hasDividendStatementDoc: (divDoc?.n ?? 0) > 0,
    rentalPropsMissingSummary,
    disposedAssetsN: disposed?.n ?? 0,
    instantAssetWriteOffCentsThisFy: thresholds[fy]?.instant_asset_write_off_cents ?? null,
    instantAssetWriteOffCentsPrevFy: thresholds[fyLabel(startYear - 1)]?.instant_asset_write_off_cents ?? null,
    capitalLossCarryinCents: capLoss?.total ?? 0,
    fxUnconvertedN: (fxIncome?.n ?? 0) + (fxTxns?.n ?? 0),
    div293ThresholdCents: thresholds[fy]?.div293_threshold_cents ?? null,
    gstRegistrationThresholdCents: thresholds[fy]?.gst_registration_threshold_cents ?? null,
    isGstRegistered,
    psiAppliesDeclared,
    psiAllAssessed,
    mainResidenceDisposalN: mainResDisposal?.n ?? 0,
    mfCostBaseAdjustmentCents,
    ...capitalSignals,
    ...firstTimerSignals,
    ...worksheetSignals,
    ...situationSignals,
    ...payrollSignals,
    ...(statementCoverage ? { statementCoverage } : {}),
    ...(unlinkedLoans ? { unlinkedLoans } : {}),
    ...(unfiledRentals ? { unfiledRentals } : {}),
    ...(featureOn(env, "ft_journey") ? { journeyCopy: true } : {}),
    ...(featureOn(env, "non_cash_income") ? { nonCashIncomeEnabled: true } : {}),
    ...(integrityOn ? {
      frankingHoldingThresholdCents: integrityThresholds?.franking_holding_rule_threshold_cents ?? null,
      fitoDeMinimisCents: integrityThresholds?.fito_de_minimis_cents ?? null,
      rideshareGstLikely,
      superNonConcessionalCapCents: integrityThresholds?.super_non_concessional_cap_cents ?? null,
      nonConcessionalContributedCents,
    } : {}),
  };

  return assessReadiness({ report, situation, claimMatches: [...matchedById.values()], signals, generatedAt: (deps.now ?? new Date()).toISOString(), excludeNonDeductible: featureOn(env, "position_excludes_nondeductible"), excludePropertyUndetermined: featureOn(env, "position_excludes_property_undetermined"), auditFindingsV2: featureOn(env, "readiness_audit_v2"), reconcileProposals: featureOn(env, "reconcile_proposals"), journeyHomes: featureOn(env, "ft_journey") ? { aboutYou: featureOn(env, "situation_profile") } : undefined });
}
