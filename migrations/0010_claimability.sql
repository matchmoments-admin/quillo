-- 0010_claimability.sql
-- The claimability brain: deterministic rules (seeded from the rule pack) keyed on
-- situation/occupation/bucket/entity, plus a per-user log of suggested claims.
-- Apply: wrangler d1 execute tax-agent-db --remote --file=migrations/0010_claimability.sql
--
-- The canonical seed rules live in src/rulepacks/au-v1.json `claimability` (versioned +
-- KV-overridable). This table is the seam for FUTURE per-tenant custom rules — the matcher
-- unions rulepack rules with any rows here for the tenant's rule_pack_ver. Additive only.

CREATE TABLE IF NOT EXISTS claimability_rules (
  id            TEXT PRIMARY KEY,
  rule_pack_ver TEXT NOT NULL,               -- 'au-v1' etc; matches profiles.rule_pack_ver
  jurisdiction  TEXT NOT NULL DEFAULT 'AU',
  scope_type    TEXT NOT NULL,               -- occupation|bucket|entity_kind|property_status
  scope_value   TEXT NOT NULL,               -- 'nurse'|'property_rented'|'company'|'vacant'
  merchant_hint TEXT,                        -- optional merchant/category match
  ato_label     TEXT,                        -- D-label or rental category this maps to
  claim_type    TEXT NOT NULL,               -- immediate|div40|div43|apportioned|not_deductible
  default_method TEXT,                       -- diminishing_value|prime_cost (for capital)
  confidence_floor REAL DEFAULT 0.7,
  general_info_note TEXT NOT NULL,           -- the GENERAL-INFO string shown to the user
  defer_to_agent INTEGER DEFAULT 0,          -- 1 = LLM must defer, not assert
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_claimrules_ver ON claimability_rules(rule_pack_ver, scope_type, scope_value);

CREATE TABLE IF NOT EXISTS claim_suggestions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  person_id     TEXT,
  txn_id        TEXT,                         -- the upload that triggered it
  asset_id      TEXT,
  rule_id       TEXT,                         -- which deterministic rule fired (rulepack key or D1 id)
  suggestion    TEXT NOT NULL,                -- human-readable, GENERAL-INFO framed
  claim_type    TEXT,
  estimated_deduction_cents INTEGER,
  llm_explanation TEXT,                       -- LLM augmentation (explanation only)
  status        TEXT DEFAULT 'suggested',     -- suggested|accepted|dismissed
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_claimsug_user ON claim_suggestions(user_id, status);
