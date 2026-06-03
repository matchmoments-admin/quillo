-- 0008_assets_depreciation.sql
-- Depreciating assets (Div 40), capital works (Div 43), business/low-value pools, plus a
-- computed depreciation_schedule that materialises per-FY deductions that carry forward.
-- Apply: wrangler d1 execute tax-agent-db --remote --file=migrations/0008_assets_depreciation.sql
-- Additive + apply-once (mirrors 0002). All dollar THRESHOLDS (IAWO, car limit) live in the
-- per-FY rule pack (KV), never here — see src/rulepacks/au-v1.json `thresholds_by_fy`.

CREATE TABLE IF NOT EXISTS assets (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  person_id     TEXT,
  property_id   TEXT,                          -- asset belongs to a rental property, or NULL for business
  entity_id     TEXT,                          -- business owner (company/sole trader) for IAWO/pool
  label         TEXT NOT NULL,                 -- 'Dishwasher', 'Laptop', 'Kitchen renovation'
  asset_class   TEXT NOT NULL,                 -- div40_plant|div43_capital_works|business_asset|low_value_pool|immediate
  cost_cents    INTEGER NOT NULL,
  acquired_date TEXT NOT NULL,                 -- 'days held' start / placed-in-service
  effective_life_years REAL,                   -- Div 40 (TR 2022/1); NULL for Div 43
  method        TEXT,                          -- diminishing_value|prime_cost (Div 40 election, locked per asset)
  dv_rate_pct   REAL DEFAULT 200,              -- diminishing-value rate: 200 (post 10 May 2006) | 150 (pre)
  div43_rate    REAL,                          -- 0.025 (40yr) or 0.04 (25yr) for capital works
  construction_date TEXT,                      -- Div 43 eligibility (residential after 15 Sep 1987)
  is_second_hand INTEGER DEFAULT 0,            -- post-9-May-2017 second-hand residential Div40 lockout
  ownership_pct REAL DEFAULT 100.0,
  business_use_pct REAL DEFAULT 100.0,         -- apportionment
  disposed_date TEXT,
  disposal_value_cents INTEGER,                -- balancing adjustment on disposal
  source_doc_id TEXT,                          -- FK documents (QS depreciation schedule / invoice)
  status        TEXT DEFAULT 'active',         -- active|disposed|fully_depreciated
  needs_review  INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(user_id, status);
CREATE INDEX IF NOT EXISTS idx_assets_property ON assets(user_id, property_id);

-- One row per asset per FY: the deterministic carry-forward ledger.
CREATE TABLE IF NOT EXISTS depreciation_schedule (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  asset_id        TEXT NOT NULL,
  fy              TEXT NOT NULL,               -- '2025-26'
  opening_adjustable_value_cents INTEGER NOT NULL,
  days_held       INTEGER NOT NULL,           -- in this FY (366 in leap years)
  deduction_cents INTEGER NOT NULL,           -- computed decline in value for this FY
  closing_adjustable_value_cents INTEGER NOT NULL,
  method_applied  TEXT NOT NULL,              -- snapshot of method used
  computed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(asset_id, fy)
);
CREATE INDEX IF NOT EXISTS idx_depsched_user_fy ON depreciation_schedule(user_id, fy);

-- Flag transactions as capital + optionally link to the asset they created.
ALTER TABLE transactions ADD COLUMN is_capital INTEGER DEFAULT 0;  -- capital vs immediate repair
ALTER TABLE transactions ADD COLUMN asset_id TEXT;                 -- FK assets.id if this receipt created an asset
ALTER TABLE transactions ADD COLUMN capital_class TEXT;            -- repair|div40|div43|initial_repair
