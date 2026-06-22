import type { Env } from "../env";

/**
 * Env-driven feature flags. `FEATURES` (wrangler.toml [vars]) is a comma-separated list of
 * enabled keys, e.g. "refund_netting,bulk_import". A behaviour ships behind a flag so it can be
 * disabled with one var edit + redeploy (instant rollback) with no data change. Single tenant
 * today, so flags are env-global; per-tenant gating can move to `profiles` later without changing
 * call sites (they only see `featureOn(env, key)`).
 */
export const FEATURE_KEYS = [
  "refund_netting",
  "refund_netting_v2", // #258 (Wave 1): net a refund ONLY against the specific DEDUCTIBLE expense it reverses (refund_for_txn_id), capped at that expense; unlinked/personal refunds are position-neutral. Fixes v1's global netting that subtracted personal reimbursements from unrelated deductions (under-claim). Separate flag from refund_netting (which is ON in prod) so this money-output change flips deliberately. OFF ⇒ v1 global netting ⇒ byte-identical.
  "income_dedupe",
  "asset_defaults",
  "bulk_import",
  "deductibility_review",
  "guide_me",
  "onboarding_checklist", // #246 (Wave 3): a situation-derived "bring these in" evidence checklist on the Dashboard (which accounts/statements/docs to add + WHY, with completion). OFF ⇒ the card isn't rendered ⇒ byte-identical.
  "journey_spine", // #247/#244 (Wave 3): a persistent breadcrumb of the 6 stops (Set up→Bring in→Sort→Check→Position→File) in the app shell — current stop highlighted, data-aware badges from progress. OFF ⇒ not rendered ⇒ byte-identical.
  "categorise_v2", // #253 (Wave 3): simplify TxnDetail to one primary Category decision + adaptive Confirm/Save, with ATO label / property / refund / date tucked behind an "Add detail" disclosure (auto-opened when detail exists). OFF ⇒ all fields inline as before ⇒ byte-identical.
  "txn_bulk_edit", // #252 (Wave 3): multi-select + the BulkBar on the Transactions page (where search/filter/group isolate a merchant's look-alikes) so already-categorised lines can be re-bucketed/attributed in one audited, undoable batch. OFF ⇒ no checkboxes/bar ⇒ byte-identical.
  "claim_review",
  "txn_scan", // #256 (Wave 2): pre-handoff "double-check my transactions" scan — deterministic over-claim + missed-deduction review surfaced on Reports + a non-blocking download gate. Read-only/additive (proposals only, no auto-claim). OFF ⇒ /api/scan 404s, no UI, byte-identical.
  "position_confirmed_range", // #255 (Wave 3): surface a CONFIRMED-end taxable position alongside the existing (tracked, optimistic) one, so the Reports headline reads as a range confirmed→tracked instead of presenting the optimistic figure as THE position. ADDITIVE display output (taxable_position_confirmed_cents) — the existing taxable_position_cents is untouched. OFF ⇒ field omitted ⇒ byte-identical.
  "position_excludes_nondeductible",
  "position_excludes_property_undetermined", // #254 (Wave 1): deny-by-default for property-bucket spend that can't yet land in an income-producing property — no property_id, or a property whose use_status isn't 'rented'/'genuinely_available_for_rent'. Mirrors the payg 'undetermined' deny. Separate flag (NOT folded into position_excludes_nondeductible, which is already ON in prod) so the money-output change flips deliberately. OFF ⇒ the SQL marker is the literal "0" ⇒ byte-identical.
  "accountant_pass",
  "wfh_car_methods",
  "car_methods", // #245 (Wave 3): source car cents-per-km km from the dedicated car_inputs table (split out of work_use_inputs) so WFH and car are separate typed units. OFF ⇒ car km read from the legacy work_use_inputs.car_work_km column ⇒ byte-identical. The 0061 backfill seeds car_inputs from the legacy column so flag-ON is identical for existing data.
  "wfh_generate_diary",  // 0059 (Part 1): emit a generated WFH diary section in the accountant CSV. OFF by default — flag-OFF + own-record paths keep the legacy CSV byte-identical.
  "loan_split",
  "attribution_engine", // 0032-0034: sum transaction_attributions for the position (payer≠claimant, ownership split). OFF in prod until validated.
  "cgt_engine",         // 0037 (#138): add net capital gain (shares/crypto/property disposals; 50% discount; loss offset) to the position. OFF in prod until validated.
  "ess_engine",         // 0038 (#141): add assessable ESS discount (taxed-upfront / deferral) to the position; startup concession defers to CGT. OFF in prod until validated.
  "gst_bas",            // 0039 (#137): indicative BAS position (output GST − input credits) for GST-registered businesses. SEPARATE from income tax. OFF in prod until validated.
  "car_logbook",        // 0040 (#142): logbook-method car deduction vs cents-per-km (informational). OFF in prod until validated.
  "trust_distributions",// 0041 (#139): add assessable trust distributions (character retained) to the beneficiary's position. OFF in prod until validated.
  "smsf_engine",        // 0042 (#140): per-SMSF fund position after ECPI (separate taxpayer); keeps fund income out of the member's personal headline. OFF in prod until validated.
  "apply_to_siblings",  // Sort epic S1: "edit one line → update its look-alikes" (+ learn a rule) off the normal edit path. No position math. OFF until the S2 UI ships.
  "loan_interest_v2",   // Sort epic S4/S5 (#157): evidence-first loan interest (lender/statement actual → property position), retiring the per-line loan_split. Capture-only in S4; report wiring in S5. OFF until validated.
  "ask_quillo",         // C1: single-turn grounded tax-Q&A — answers a free-text question from the user's OWN ledger (consent + budget gated, GENERAL-INFO, no refund/rates). Multi-turn chat is a later epic.
  "accountant_schedule",// #179/#181: itemised accountant schedule CSV (per-txn lines, engine schedules, NOT-CLAIMED, substantiation) replaces the thin summary CSV at format=csv. OFF in prod until validated.
  "ask_actions",        // Ask Quillo C3: FY txn digest in the Ask prompt + model-PROPOSED one-click fixes (set_deductibility / recategorise / add_rule). Propose→confirm→execute via the EXISTING write endpoints — never autonomous. Applying a deductibility card needs deductibility_review ON. OFF ⇒ Ask byte-identical.
  "advisory_layer",     // Savings & Opportunities (#182–184): annualised spend run-rate + deterministic recurring-bill/subscription detection + FACTUAL opportunity nudges + the "Save" surface. No LLM, no partners, no PII egress, no projections/benchmarks (src/lib/advisory.ts). OFF ⇒ no read/write path, byte-identical.
  "advisory_partners_energy", // Advisory Phase 2 (docs/advisory-phase2-partners.md): the Tier-1 energy partner CTA on advisory opportunities + the create-referral path. Identity/data-model scaffold ships flag-OFF (Slice 1); no consumer CTA, no live partner, no PII egress until this is ON *and* legal sign-off (§5) lands. OFF ⇒ byte-identical.
  "franking_gross_up",  // Phase 3a (s207-20): gross franked dividend/distribution franking credits INTO assessable income (the credit is also a refundable offset, out of scope). ADDS to taxable_position. OFF ⇒ byte-identical.
  "super_deduction",    // Phase 3a (s290-150): personal-deductible super contributions (type='personal_deductible' only — never employer SG) reduce assessable income up to the concessional cap. SUBTRACTS from taxable_position. OFF ⇒ byte-identical.
  "partnership_distributions", // Slice E: a partner's share of partnership net income (character retained, ITAA36 Div 5) feeds the personal position like a trust distribution — same trust_distributions table, source_kind='partnership' (migration 0056). ADDS to taxable_position. OFF ⇒ byte-identical.
  "mf_components",      // Slice B: managed-fund (AMMA) distribution component split. A managed_fund_distribution row's ordinary income lands in gross_cents; its capital-gain components are materialised into the CGT engine (50% discount + loss-offset); the AMIT cost-base amount stays out of the position (defer nudge). v1: AUD-only + personal-only. Gated on flag AND presence-of-components, so OFF or a no-components row ⇒ byte-identical.
  "ai_edit_feed",       // Phase 4: the ai_edits audit/undo log (migration 0057) + its "AI changes — undo" feed (GET /api/ai-edits, POST /api/ai-edits/undo). Read/undo surface for the audited entity-write path. OFF ⇒ feed endpoints 404 ⇒ byte-identical.
  "ask_actions_v2",     // Phase 3: extended chat write tools — model PROPOSES create/edit of property|entity|person|rule; user confirms a card; execution routes through the audited DO path (aiWriteEntity → ai_edits + audit_log), idempotent per action_id, NEVER autonomous. Requires ai_edit_feed for the undo backstop. OFF ⇒ no entity-write proposals ⇒ byte-identical.
  "chat_nav",           // Phase 2: the chat agent may propose navigating to an allowlisted SPA route (navigate field on give_answer) + receives the user's current page as grounding. Rendered as a "Take me to …" button (never a silent jump); route enum + server re-check. OFF ⇒ no navigate emitted/honoured + no page line ⇒ byte-identical.
  "floating_chat",      // Floating "Ask Quillo" bubble (assistant-ui headless runtime + our tokens): relocates the embedded Dashboard chat into a persistent portal-mounted widget that survives navigation. Reuses the existing /api/chat + proposed-action path; no engine/position change. OFF ⇒ the widget renders nothing ⇒ byte-identical.
  "jurisdiction_period",// UK epic stop 1: the tax period is resolved from profiles.jurisdiction via a JurisdictionDescriptor (src/lib/jurisdiction.ts) instead of a hardcoded Jul–Jun. MASTER GATE: OFF ⇒ always the AU descriptor regardless of the stored code ⇒ byte-identical. ON ⇒ a tenant with jurisdiction='UK' gets the Apr 6 – Apr 5 period (de-hardcodes fyBounds / currentFyStartYear / fyForDate / fyStartYearOf + the queries.ts SQL month gate). No currency/rule-pack/engine change this stop.
  "currency_base",      // UK epic stop 2: de-anchor the money model from AUD to the tenant's BASE currency (descriptor.baseCurrency — AU 'AUD', UK 'GBP'). Routed through baseCurrencyOf(env, descriptor) (src/lib/jurisdiction.ts), the single chokepoint every base read uses. The FX layer converts foreign amounts to the base (fx.ts toBaseCurrency); amount_aud_cents now means "base-currency cents" (legacy name kept — the ~17 SUM(COALESCE) sites are currency-agnostic). OFF ⇒ base forced to 'AUD' everywhere regardless of jurisdiction ⇒ byte-identical. ON + AU profile ⇒ base='AUD' ⇒ still byte-identical. (The SPA display follows the payload's base_currency, NOT this flag — money() defaults to '$'/'en-AU' when base_currency is absent/'AUD'.)
  "record_credit_income", // #130: a one-click "Record as rental income" button on a rent CREDIT tagged to a property (TxnDetail) — the per-txn equivalent of the Clarify group income answer (recordTxnAsIncome → recordIncome + matched_income_id link, single-count). OFF ⇒ the button is hidden + POST /api/transactions/:id/record-income 404s ⇒ byte-identical.
  "unified_transactions", // Research Slice 1: merge the Inbox review queue into the Transactions page as a "Needs review"(default)/"All" segmented control — one transaction surface (matches Xero/QBO/MYOB). Needs-review stays all-time (preserves the cross-year backlog invariant); All stays FY-scoped. Collapses the Sort nav to one item, points the spine "Sort" stop + the /inbox route at /transactions. Pure IA/UI — no data-model or position-math change. OFF ⇒ separate /inbox + /transactions, current nav ⇒ byte-identical.
  "phi_extras_tracker", // Private Health Extras Tracker (engagement, NOT a tax output): track per-category private-health EXTRAS limits + spend-to-date against the reset date ("use it before you lose it"), with manual policy/limit entry, a detected `phi_extras` advisory opportunity, and an in-app reset reminder. Reads/writes the phi_policy/phi_limit/phi_benefit_usage tables (0062), gated everywhere by this flag. Display/categorisation only — never feeds report.ts; taxable_position_cents is byte-identical ON vs OFF (persona golden). OFF ⇒ no read/write path, no UI, byte-identical.
  "phi_tax_inputs", // PHI annual-statement capture → MLS/rebate DEFER-NUDGE (sibling of the Div 293 nudge in readiness.ts). Captures phi_statement (0062) + a "income near the MLS threshold and no hospital cover on file — confirm with a registered tax agent" nudge. NEVER a computed $ amount and NEVER summed into taxable_position_cents (rebate/MLS stay reference-only per CLAUDE.md). Held OFF pending owner sign-off (needs-decision). OFF ⇒ no statement capture, no nudge, byte-identical.
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

function enabledSet(env: Env): Set<string> {
  return new Set(
    (env.FEATURES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** True when `key` is listed in the FEATURES var. */
export function featureOn(env: Env, key: FeatureKey): boolean {
  return enabledSet(env).has(key);
}

/** The subset of known feature keys that are enabled — sent to the SPA so it can gate UI. */
export function enabledFeatures(env: Env): FeatureKey[] {
  const on = enabledSet(env);
  return FEATURE_KEYS.filter((k) => on.has(k));
}

/**
 * How statement categorisation should run. `live` = synchronous Claude calls (instant, full price);
 * `batch` = the async Message Batches API (~50% cheaper, applied by the cron); `auto` = today's
 * size-based routing (>BATCH_THRESHOLD lines → batch, else live). Resolution order, narrowest first:
 * per-tenant `profiles.categorise_mode` → env `CATEGORISE_MODE` → `auto`. Same single-call-site shape
 * as `featureOn`, so the per-tenant override lands with no churn at the call site (it already passes
 * the profile). An unrecognised value degrades safely to `auto`.
 */
export const CATEGORISE_MODES = ["auto", "live", "batch"] as const;
export type CategoriseMode = (typeof CATEGORISE_MODES)[number];

export function categoriseMode(env: Env, profile?: { categorise_mode?: string | null }): CategoriseMode {
  const raw = (profile?.categorise_mode ?? env.CATEGORISE_MODE ?? "auto").trim().toLowerCase();
  return (CATEGORISE_MODES as readonly string[]).includes(raw) ? (raw as CategoriseMode) : "auto";
}
