-- 0041: trust distributions + streaming (#139, EPIC #134). A discretionary trust distributes its net
-- income to beneficiaries with CHARACTER RETAINED (a franked dividend stays franked; a discount capital
-- gain stays discountable). Each beneficiary's share is assessable to THEM. The corporate beneficiary
-- ("bucket company") receives a distribution → its own company position. Div 7A/UPE + s100A stay
-- defer-to-agent (Bendel litigation is unsettled). INDICATIVE; flag-gated trust_distributions.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0041_trust_distributions.sql
-- Idempotency: table IF NOT EXISTS; no backfill. Zero rows ⇒ report byte-identical.
CREATE TABLE IF NOT EXISTS trust_distributions (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  trust_entity_id       TEXT NOT NULL,                -- entities.id (the trust)
  fy                    TEXT NOT NULL,
  beneficiary_person_id TEXT,                         -- persons.id (an individual beneficiary in this tenant)
  beneficiary_entity_id TEXT,                         -- entities.id (e.g. the corporate beneficiary)
  share_pct             REAL,                         -- the resolution share (display)
  amount_cents          INTEGER NOT NULL DEFAULT 0,
  character             TEXT NOT NULL DEFAULT 'ordinary', -- ordinary|franked_dividend|discount_capital_gain|foreign_income
  franking_credit_cents INTEGER NOT NULL DEFAULT 0,    -- carried with a franked_dividend distribution
  resolution_dated_before_30jun INTEGER NOT NULL DEFAULT 0, -- s100A / trustee-resolution timing flag (defer-to-agent)
  upe_present           INTEGER NOT NULL DEFAULT 0,    -- unpaid present entitlement → Div 7A risk (defer-to-agent)
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trust_dist_user ON trust_distributions(user_id, fy);
CREATE INDEX IF NOT EXISTS idx_trust_dist_trust ON trust_distributions(user_id, trust_entity_id);
