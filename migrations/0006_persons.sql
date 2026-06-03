-- 0006_persons.sql
-- Persons: the taxpayer abstraction above entities/properties — the apportionment ROOT for
-- income, deductions and depreciation (scales to spouse / joint ownership / multi-person).
-- Apply: wrangler d1 execute tax-agent-db --remote --file=migrations/0006_persons.sql
--
-- Additive + apply-once (mirrors 0002): ADD COLUMN is metadata-only; tables/indexes are
-- IF NOT EXISTS and the backfills are INSERT OR IGNORE / guarded UPDATE so the data steps are
-- idempotent even though the ADD COLUMNs are not. ONE 'self' person is backfilled per tenant,
-- so single-person tenants are a no-op.
--
-- Deviation from the v2 spec: created_at is TEXT datetime('now') (not INTEGER epoch) to match
-- the existing schema.sql convention and the situation-write insert helpers.

CREATE TABLE IF NOT EXISTS persons (
  id            TEXT PRIMARY KEY,                 -- 'person_self_<user_id>' for the self person; uuid otherwise
  user_id       TEXT NOT NULL,                    -- tenant key (multi-tenant invariant)
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'self',     -- self|spouse|dependent|other
  occupation    TEXT,                             -- ATO occupation guide key (e.g. 'nurse','it_professional')
  tax_residency TEXT NOT NULL DEFAULT 'AU',       -- AU|UK|... drives rule-pack selection (Phase 5)
  tfn_last4     TEXT,                             -- never store the full TFN
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_persons_user ON persons(user_id);

-- Backfill exactly one 'self' person per tenant. Deterministic id => re-running is idempotent.
INSERT OR IGNORE INTO persons (id, user_id, display_name, role)
  SELECT 'person_self_' || user_id, user_id, COALESCE(display_name, 'Me'), 'self' FROM tenants;
-- Defensive: a tenant that has a profile but no tenants row still gets a self person.
INSERT OR IGNORE INTO persons (id, user_id, display_name, role)
  SELECT 'person_self_' || user_id, user_id, 'Me', 'self' FROM profiles;

-- Link entities to a person (nullable for migration safety) + jurisdiction tag.
ALTER TABLE entities ADD COLUMN person_id TEXT;
ALTER TABLE entities ADD COLUMN jurisdiction TEXT DEFAULT 'AU';
UPDATE entities SET person_id = 'person_self_' || user_id WHERE person_id IS NULL;

-- Properties: primary owner + CGT / cost-base fields (joint ownership via property_owners).
ALTER TABLE properties ADD COLUMN person_id TEXT;                 -- primary owner
ALTER TABLE properties ADD COLUMN jurisdiction TEXT DEFAULT 'AU';
ALTER TABLE properties ADD COLUMN cost_base_cents INTEGER;        -- purchase price + incidental capital costs
ALTER TABLE properties ADD COLUMN acquired_cost_detail_json TEXT; -- stamp duty, legals (capital, not deductible)
ALTER TABLE properties ADD COLUMN disposal_date TEXT;
ALTER TABLE properties ADD COLUMN disposal_proceeds_cents INTEGER;
ALTER TABLE properties ADD COLUMN first_income_date TEXT;         -- 'home first used to produce income' rule
ALTER TABLE properties ADD COLUMN main_residence_flag INTEGER DEFAULT 0;
UPDATE properties SET person_id = 'person_self_' || user_id WHERE person_id IS NULL;

-- Joint ownership (many persons : one property). When a property has rows here, this
-- ownership_pct OVERRIDES the scalar properties.ownership_pct (which stays the single-owner
-- fast path). Drives income/expense apportionment in the report.
CREATE TABLE IF NOT EXISTS property_owners (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  property_id   TEXT NOT NULL,
  person_id     TEXT NOT NULL,
  ownership_pct REAL NOT NULL DEFAULT 100.0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_property_owners ON property_owners(user_id, property_id);
