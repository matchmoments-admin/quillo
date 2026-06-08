-- 0040: motor-vehicle logbook method (#142, EPIC #134). Only cents-per-km existed (capped at 5,000km),
-- which under-claims high-business-use drivers (rideshare/tradie/sole trader). The logbook method =
-- business-use % (from a 12-week logbook) × actual running costs (incl. car decline-in-value), with no
-- km cap. This adds the logbook table + an is_car flag on assets. The report surfaces the logbook figure
-- and flags when it beats cents-per-km (you may claim only ONE method). INDICATIVE; flag-gated car_logbook.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0040_car_logbook.sql
-- Idempotency: ADD COLUMN apply-once; table IF NOT EXISTS; no backfill.
ALTER TABLE assets ADD COLUMN is_car INTEGER NOT NULL DEFAULT 0; -- also gates the Div 40 car cost-limit cap (#54)

CREATE TABLE IF NOT EXISTS vehicle_logbooks (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  person_id           TEXT,
  asset_id            TEXT,                          -- the car asset (assets.id, is_car=1) for decline-in-value
  fy                  TEXT NOT NULL,
  start_date          TEXT,                          -- 12-week logbook period
  end_date            TEXT,
  business_km         REAL,
  total_km            REAL,
  running_costs_cents INTEGER NOT NULL DEFAULT 0,    -- annual fuel/rego/insurance/servicing (ex decline-in-value)
  business_use_pct    REAL,                          -- explicit override; else derived from business_km/total_km
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vehicle_logbooks_user ON vehicle_logbooks(user_id, fy);
