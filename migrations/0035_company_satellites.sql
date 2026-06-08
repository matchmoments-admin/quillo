-- 0035: company satellites (Phase C / G4) — the facts a pre-revenue Pty Ltd needs.
-- WHY: Case 2's startup earns no income; its SaaS costs are the COMPANY's deductions → carried-forward
--      losses (continuity-of-ownership / same-business test); capital start-up costs → s40-880; the
--      founder funding it personally → a shareholder loan (Division 7A direction matters); possible R&D
--      refundable offset (turnover < $20m → 43.5%). These tables hold FACTS; all policy numbers (rates,
--      the $20m cap, the Div 7A benchmark rate) live in the KV rule pack per FY, never here. The engine
--      computes the deterministic loss carry-forward; R&D + Div 7A nuance are surfaced defer-to-agent.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0035_company_satellites.sql
-- Idempotency: all tables IF NOT EXISTS; no backfill. user_id-keyed; FK to the company entity_id.

-- One row per company per FY: the computed position (income − deductions → loss → carry-forward).
-- cot_satisfied / sbt_satisfied are USER-ASSERTED flags (the actual test is defer-to-agent); they gate
-- whether prior-year losses are usable. base_rate_entity drives 25% vs 30% (losses carry a $ not a rate).
CREATE TABLE IF NOT EXISTS company_tax_positions (
  id                          TEXT PRIMARY KEY,
  user_id                     TEXT NOT NULL,
  entity_id                   TEXT NOT NULL,          -- the company entity
  fy                          TEXT NOT NULL,          -- '2025-26'
  assessable_income_cents     INTEGER NOT NULL DEFAULT 0,
  deductions_cents            INTEGER NOT NULL DEFAULT 0,
  current_year_loss_cents     INTEGER NOT NULL DEFAULT 0,   -- max(0, deductions − income)
  carried_forward_losses_cents INTEGER NOT NULL DEFAULT 0,  -- opening prior-year losses brought in
  cot_satisfied               INTEGER NOT NULL DEFAULT 1,   -- continuity-of-ownership (user-asserted)
  sbt_satisfied               INTEGER NOT NULL DEFAULT 0,   -- same/similar-business test (user-asserted)
  base_rate_entity            INTEGER NOT NULL DEFAULT 1,
  computed_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, entity_id, fy)
);
CREATE INDEX IF NOT EXISTS idx_cotaxpos_user ON company_tax_positions(user_id, fy);

-- s40-880 blackhole / start-up capital costs. immediate_deduction=1 for an SBE (the whole cost in
-- year one); else spread over s40_880_years (rule pack) at 20%/yr. years_claimed tracks the roll.
CREATE TABLE IF NOT EXISTS blackhole_costs (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  entity_id           TEXT NOT NULL,          -- the company entity
  incurred_date       TEXT NOT NULL,
  amount_cents        INTEGER NOT NULL,
  description         TEXT,
  immediate_deduction INTEGER NOT NULL DEFAULT 0,
  years_claimed       INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_blackhole_user ON blackhole_costs(user_id, entity_id);

-- Shareholder loans. direction is EXPLICIT so founder→company funding (person_funds_company) is never
-- mis-flagged as the Division 7A risk (company_loans_person). Written by the attribution path when an
-- individual funds a company cost; balance accumulates those amounts.
CREATE TABLE IF NOT EXISTS shareholder_loans (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL,
  company_entity_id        TEXT NOT NULL,
  shareholder_person_id    TEXT NOT NULL,
  direction                TEXT NOT NULL DEFAULT 'person_funds_company', -- person_funds_company | company_loans_person
  balance_cents            INTEGER NOT NULL DEFAULT 0,
  loan_agreement_in_place  INTEGER NOT NULL DEFAULT 0,
  benchmark_rate_pct       REAL,                  -- from the rule pack at report time, not stored as policy
  min_yearly_repayment_cents INTEGER,
  deemed_dividend_risk     INTEGER NOT NULL DEFAULT 0, -- only ever 1 for company_loans_person
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, company_entity_id, shareholder_person_id, direction)
);
CREATE INDEX IF NOT EXISTS idx_shloan_user ON shareholder_loans(user_id, company_entity_id);

-- R&D Tax Incentive facts. offset_type computed from turnover vs the rule pack's refundable cap.
-- registered_with_ausindustry gates eligibility. NEVER auto-claimed — surfaced defer-to-agent.
CREATE TABLE IF NOT EXISTS rd_claims (
  id                          TEXT PRIMARY KEY,
  user_id                     TEXT NOT NULL,
  entity_id                   TEXT NOT NULL,
  fy                          TEXT NOT NULL,
  eligible_expenditure_cents  INTEGER NOT NULL DEFAULT 0,
  aggregated_turnover_cents   INTEGER NOT NULL DEFAULT 0,
  offset_type                 TEXT,              -- refundable | non_refundable (computed)
  registered_with_ausindustry INTEGER NOT NULL DEFAULT 0,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, entity_id, fy)
);
CREATE INDEX IF NOT EXISTS idx_rdclaims_user ON rd_claims(user_id, entity_id);
