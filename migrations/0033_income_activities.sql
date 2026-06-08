-- 0033: income_activities — the explicit source-of-income spine (Phase B).
-- WHY: every transaction/attribution should hang off a SOURCE of income (or "private"), as a
--      first-class FK rather than the implicit (bucket, property_id, entity_id) tuple. This is what
--      distinguishes a salary deduction from a rental deduction from a company deduction, and lets the
--      attribution layer (0034) target an activity. Seeded from existing entities/properties;
--      transactions are NOT backfilled onto it, so the report stays byte-identical until the
--      attribution_engine flag is on.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0033_income_activities.sql
-- Idempotency: table IF NOT EXISTS; seeds use INSERT OR IGNORE on deterministic ids.
CREATE TABLE IF NOT EXISTS income_activities (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  entity_id        TEXT,                         -- entities.id (NULL for the 'private' sink)
  activity_type    TEXT NOT NULL,                -- salary_wages|rental_property|business|investment|private
  property_id      TEXT,                         -- properties.id for rental_property
  occupation_scope TEXT,                         -- rule-pack scope key (e.g. it_professional)
  fy               TEXT,                         -- nullable: cross-FY activities allowed
  label            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_income_act_user   ON income_activities(user_id, activity_type);
CREATE INDEX IF NOT EXISTS idx_income_act_entity ON income_activities(user_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_income_act_prop   ON income_activities(user_id, property_id);

-- Seed: one rental activity per property, one business per company entity, one salary per employment
-- entity, and a single private sink per tenant. Deterministic ids => INSERT OR IGNORE is re-runnable.
INSERT OR IGNORE INTO income_activities (id, user_id, entity_id, activity_type, property_id, label)
SELECT 'iact_prop_' || p.id, p.user_id, NULL, 'rental_property', p.id, p.label
FROM properties p;
INSERT OR IGNORE INTO income_activities (id, user_id, entity_id, activity_type, label)
SELECT 'iact_co_' || e.id, e.user_id, e.id, 'business', e.name
FROM entities e WHERE e.kind = 'company';
INSERT OR IGNORE INTO income_activities (id, user_id, entity_id, activity_type, label)
SELECT 'iact_sal_' || e.id, e.user_id, e.id, 'salary_wages', e.name
FROM entities e WHERE e.kind = 'employment';
INSERT OR IGNORE INTO income_activities (id, user_id, entity_id, activity_type, label)
SELECT 'iact_private_' || t.user_id, t.user_id, NULL, 'private', 'Private'
FROM (SELECT DISTINCT user_id FROM transactions) t;
