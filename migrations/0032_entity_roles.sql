-- 0032: person<->entity many-to-many roles + entity typing (Phase B / G1).
-- WHY: entities.person_id is a single owner FK. Case 2's developer is simultaneously individual
--      taxpayer + Lendi employee + director + 100% shareholder of his Pty Ltd + co-owner of two
--      rental "tax-law partnerships". One scalar FK can't express that. entity_roles is the join;
--      it OVERRIDES the scalar when rows exist (mirrors the property_owners pattern). entity_type +
--      base_rate_entity give the company-position engine (Phase C) real, query-able columns instead
--      of parsing kind/detail_json.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0032_entity_roles.sql
-- Idempotency: ADD COLUMN apply-once; table IF NOT EXISTS; backfills are INSERT OR IGNORE / guarded
--              UPDATE on deterministic ids. Dark until the report's attribution path reads it.
ALTER TABLE entities ADD COLUMN entity_type      TEXT;                       -- individual|payg_employment|company|property_partnership|trust|partnership|smsf
ALTER TABLE entities ADD COLUMN base_rate_entity INTEGER NOT NULL DEFAULT 0; -- 1 => 25% company rate (else 30)

CREATE TABLE IF NOT EXISTS entity_roles (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  person_id     TEXT NOT NULL,                  -- persons.id
  entity_id     TEXT NOT NULL,                  -- entities.id
  role          TEXT NOT NULL,                  -- individual_taxpayer|employee|director|shareholder|co_owner|partner
  ownership_pct REAL,                           -- shareholder/co-owner/partner %; NULL for non-equity roles
  start_date    TEXT,                           -- roles change over time (continuity-of-ownership tests)
  end_date      TEXT,
  detail_json   TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, person_id, entity_id, role)
);
CREATE INDEX IF NOT EXISTS idx_entity_roles_entity ON entity_roles(user_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_roles_person ON entity_roles(user_id, person_id);

-- Derive entity_type from the existing kind (additive; only fills NULLs so it's safe to re-run).
UPDATE entities SET entity_type = CASE kind
  WHEN 'employment' THEN 'payg_employment'
  WHEN 'company'    THEN 'company'
  WHEN 'individual' THEN 'individual'
  WHEN 'trust'      THEN 'trust'
  ELSE entity_type END
WHERE entity_type IS NULL;

-- One role row per existing entity from its single owner (kind -> sensible default role, 100%).
INSERT OR IGNORE INTO entity_roles (id, user_id, person_id, entity_id, role, ownership_pct)
SELECT 'erole_' || e.id, e.user_id, e.person_id, e.id,
       CASE e.kind WHEN 'employment' THEN 'employee'
                   WHEN 'company'    THEN 'director'
                   WHEN 'individual' THEN 'individual_taxpayer'
                   ELSE 'co_owner' END,
       100.0
FROM entities e
WHERE e.person_id IS NOT NULL;
