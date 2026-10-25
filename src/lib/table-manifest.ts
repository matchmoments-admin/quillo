/**
 * The table manifest: one entry per table in schema.sql, saying who owns its rows and what happens to them.
 * It is the single place that answers "is this tenant data, is it erased on account deletion, is it
 * exported, how long is it kept, which columns are secret, and is anything still using it?".
 *
 * - `tenant`: how a row is tied to a tenant. user_id = a column; scope = daily_cost's tenant-or-'global' key;
 *   none = platform data.
 * - `purge`: erased by purgeTenant AND returned by exportTenant (APP 11.2 / 12). PURGE_TABLES is derived from
 *   this, IN THIS ORDER (the purge batch runs in it).
 * - `retention`: ledger = tax records, kept for the retention window and only ever FLAGGED (retention.ts);
 *   keep = never pruned (audit, billing, compliance); { log: days } = operational logs that the daily prune
 *   deletes once older than `days` (flag log_retention, OFF until the owner signs the policy off).
 * - `secretCols`: stripped from an APP-12 export.
 * - `dark`: why the table has no live writer or no live reader. check-units derives "no writer / no reader"
 *   from src and fails when this label and the code disagree, so unused tables stay visible.
 *
 * check-units also fails when a schema.sql table is missing here, so a new table can't skip the decision.
 */
export type Retention = "ledger" | "keep" | { log: number };
export interface TableSpec {
  tenant: "user_id" | "scope" | "none";
  purge: boolean;
  retention: Retention;
  secretCols?: readonly string[];
  dark?: string;
}

export const TABLES = {
  tenants: { tenant: "user_id", purge: true, retention: "ledger", dark: "legacy HMAC-tenant row; superseded by profiles, read only by ingest auth" },
  tenant_keys: { tenant: "user_id", purge: true, retention: "ledger", secretCols: ["secret"] },
  profiles: { tenant: "user_id", purge: true, retention: "ledger" },
  transactions: { tenant: "user_id", purge: true, retention: "ledger" },
  accounts: { tenant: "user_id", purge: true, retention: "ledger" },
  statements: { tenant: "user_id", purge: true, retention: "ledger" },
  capital_imports: { tenant: "user_id", purge: true, retention: "ledger" }, // 0074: staged capital CSV imports (C6) — tenant rows, must purge
  corrections: { tenant: "user_id", purge: true, retention: "ledger" },
  ai_edits: { tenant: "user_id", purge: true, retention: { log: 730 } }, // 0057: AI-driven/manual entity-write undo log
  traces: { tenant: "user_id", purge: true, retention: { log: 90 } },
  eval_cases: { tenant: "user_id", purge: true, retention: { log: 90 }, dark: "retired: written from corrections, never read (eval_cases_retired stops the write)" },
  notifications: { tenant: "user_id", purge: true, retention: { log: 365 } },
  qbo_connections: { tenant: "user_id", purge: true, retention: "ledger", secretCols: ["access_token", "refresh_token"] },
  persons: { tenant: "user_id", purge: true, retention: "ledger" },
  property_owners: { tenant: "user_id", purge: true, retention: "ledger" },
  properties: { tenant: "user_id", purge: true, retention: "ledger" },
  entities: { tenant: "user_id", purge: true, retention: "ledger" },
  user_rules: { tenant: "user_id", purge: true, retention: "ledger" },
  llm_usage: { tenant: "user_id", purge: true, retention: "keep" },
  batch_jobs: { tenant: "user_id", purge: true, retention: "ledger" },
  income: { tenant: "user_id", purge: true, retention: "ledger" },
  documents: { tenant: "user_id", purge: true, retention: "ledger" },
  assets: { tenant: "user_id", purge: true, retention: "ledger" },
  depreciation_schedule: { tenant: "user_id", purge: true, retention: "ledger" },
  fy_checklist: { tenant: "user_id", purge: true, retention: "ledger" },
  claim_suggestions: { tenant: "user_id", purge: true, retention: "ledger" },
  claimability_rules: { tenant: "user_id", purge: true, retention: "ledger" }, // only per-tenant rows: DELETE WHERE user_id=? leaves global (NULL) pack overrides intact
  clarify_questions: { tenant: "user_id", purge: true, retention: "ledger" },
  claim_links: { tenant: "user_id", purge: true, retention: "ledger" },
  accountant_runs: { tenant: "user_id", purge: true, retention: "ledger" },
  work_use_inputs: { tenant: "user_id", purge: true, retention: "ledger" },
  loans_properties: { tenant: "user_id", purge: true, retention: "ledger" },
  fy_signoff: { tenant: "user_id", purge: true, retention: "ledger" },
  fy_carryovers: { tenant: "user_id", purge: true, retention: "ledger" }, // 0067 (noa_capture) — NOA-derived carry-over facts
  capital_loss_carryins: { tenant: "user_id", purge: true, retention: "ledger" },
  depreciation_opening_balances: { tenant: "user_id", purge: true, retention: "ledger" },
  entity_roles: { tenant: "user_id", purge: true, retention: "ledger" }, // 0032
  income_activities: { tenant: "user_id", purge: true, retention: "ledger" }, // 0033
  transaction_attributions: { tenant: "user_id", purge: true, retention: "ledger" }, // 0034
  company_tax_positions: { tenant: "user_id", purge: true, retention: "ledger", dark: "no writer (ADR-0002); read only on the company_carryforward=OFF path" }, // 0035
  rd_claims: { tenant: "user_id", purge: true, retention: "ledger", dark: "no writer yet; read by companyPositions (R&D offset scaffold)" }, // 0035
  cgt_assets: { tenant: "user_id", purge: true, retention: "ledger" }, // 0037 (#138)
  cgt_events: { tenant: "user_id", purge: true, retention: "ledger" }, // 0037 (#138)
  ess_grants: { tenant: "user_id", purge: true, retention: "ledger" }, // 0038 (#141)
  bas_periods: { tenant: "user_id", purge: true, retention: "ledger" }, // 0039 (#137)
  payg_instalments: { tenant: "user_id", purge: true, retention: "ledger" }, // 0039 (#137)
  vehicle_logbooks: { tenant: "user_id", purge: true, retention: "ledger" }, // 0040 (#142)
  trading_stock: { tenant: "user_id", purge: true, retention: "ledger" }, // 0068 (audit wave 4)
  car_inputs: { tenant: "user_id", purge: true, retention: "ledger" }, // 0061 (#245)
  wfh_diary_pattern: { tenant: "user_id", purge: true, retention: "ledger" }, // 0088 (#787) — typical work-from-home week
  wfh_diary_weeks: { tenant: "user_id", purge: true, retention: "ledger" }, // 0088 (#787) — confirmed weeks (the WFH hours record)
  trust_distributions: { tenant: "user_id", purge: true, retention: "ledger" }, // 0041 (#139)
  smsf_members: { tenant: "user_id", purge: true, retention: "ledger" }, // 0042 (#140)
  super_contributions: { tenant: "user_id", purge: true, retention: "ledger" }, // 0042 (#140)
  loan_interest_summaries: { tenant: "user_id", purge: true, retention: "ledger" }, // 0045 (#157 S4)
  chat_sessions: { tenant: "user_id", purge: true, retention: "ledger" }, // 0046 (#173 C2)
  chat_messages: { tenant: "user_id", purge: true, retention: { log: 730 } }, // 0046 (#173 C2)
  recurring_bills: { tenant: "user_id", purge: true, retention: "ledger" }, // 0047 (advisory)
  opportunities: { tenant: "user_id", purge: true, retention: "ledger" }, // 0047 (advisory)
  partner_members: { tenant: "user_id", purge: true, retention: "ledger", dark: "advisory phase-2 scaffold; no writer yet" }, // 0049 (advisory phase 2 scaffold) — staff↔org link
  referrals: { tenant: "user_id", purge: true, retention: "ledger" }, // 0049 — consumer referrals (user_id = the consumer)
  referral_consents: { tenant: "user_id", purge: true, retention: "ledger", dark: "Tier-2 referral consent scaffold (0049); unused until Phase 3" }, // 0049 — Tier-2 consent (created now, used in Phase 3)
  phi_policy: { tenant: "user_id", purge: true, retention: "ledger" }, // 0062 (PHI extras tracker) — policy + reset basis
  phi_limit: { tenant: "user_id", purge: true, retention: "ledger" }, // 0062 — per-category annual extras limit
  phi_benefit_usage: { tenant: "user_id", purge: true, retention: "ledger" }, // 0062 — benefit recorded against a limit
  phi_statement: { tenant: "user_id", purge: true, retention: "ledger", dark: "PHI annual-statement scaffold (0062); no read or write path yet" }, // 0062 — PHI annual tax statement (rebate/MLS inputs)
  credit_ledger: { tenant: "user_id", purge: true, retention: "keep" },
  bank_connections: { tenant: "user_id", purge: true, retention: "ledger" },
  bank_connection_accounts: { tenant: "user_id", purge: true, retention: "ledger" },
  bank_sync_runs: { tenant: "user_id", purge: true, retention: "ledger" },
  reconcile_dismissals: { tenant: "user_id", purge: true, retention: "ledger" }, // 0082 (A8, #574) — receipt ↔ bank-line proposals the user rejected
  situation_periods: { tenant: "user_id", purge: true, retention: "ledger" }, // 0079 (wages_payer, first-timer A3 #577): "We noticed…" credit-triage signals and the user's decision.
  noticed_signals: { tenant: "user_id", purge: true, retention: "ledger" },
  grow_layers: { tenant: "user_id", purge: true, retention: "ledger" }, // 0083 (ft_journey, A11b #592) — the user's Grow layer on/off choices
  bank_line_rollups: { tenant: "user_id", purge: true, retention: "ledger" },
  bank_line_tombstones: { tenant: "user_id", purge: true, retention: "ledger" },
  audit_log: { tenant: "user_id", purge: false, retention: "keep" },
  daily_cost: { tenant: "scope", purge: false, retention: "keep" },
  waitlist: { tenant: "none", purge: false, retention: "keep", dark: "write-only from the marketing form; read by the owner via wrangler" },
  partners: { tenant: "none", purge: false, retention: "keep", dark: "seeded by hand (wrangler); no in-app writer" },
  partner_offers: { tenant: "none", purge: false, retention: "keep", dark: "seeded by hand (wrangler); no in-app writer" },
  cdr_audit_log: { tenant: "user_id", purge: false, retention: "keep" },
} as const satisfies Record<string, TableSpec>;

export type TableName = keyof typeof TABLES;

const entries = Object.entries(TABLES) as [TableName, TableSpec][];

/** Every table purgeTenant erases (and exportTenant returns), in purge order. */
export const PURGE_TABLES = entries.filter(([, s]) => s.purge && s.tenant === "user_id").map(([t]) => t);

/** Tables the daily log prune may delete from, with their age limit in days. */
export const LOG_TABLES = entries.flatMap(([t, s]) => (typeof s.retention === "object" ? [{ table: t, days: s.retention.log }] : []));

export function secretColumns(table: string): readonly string[] {
  return (TABLES as Record<string, TableSpec>)[table]?.secretCols ?? [];
}
