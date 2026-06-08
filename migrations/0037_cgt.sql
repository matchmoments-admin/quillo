-- 0037: CGT engine (#138, EPIC #134) — holdings + disposal events for the capital-gains schedule.
-- WHY: cost-base/disposal fields already exist on properties/assets, but there was no holdings model
--      for shares/crypto and no gain COMPUTATION (50% discount, capital-loss offset/carry-forward).
--      A CGT asset is a parcel with a cost base; a CGT event is a disposal. Net capital gain (after
--      losses, then the 50% discount on ≥12-month holds) is ONE assessable line in the position. Crypto
--      is not special-cased: it's a cgt_asset with asset_kind='crypto'. capital_loss_carryins (0029)
--      supplies prior-year losses. INDICATIVE ONLY — feeds taxable income, never tax payable.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0037_cgt.sql
-- Idempotency: tables IF NOT EXISTS; no backfill. Gated behind the cgt_engine flag (OFF) — zero rows
--              means the report is byte-identical to today.
CREATE TABLE IF NOT EXISTS cgt_assets (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL,
  person_id              TEXT,                       -- the owning taxpayer (persons.id)
  asset_kind             TEXT NOT NULL,              -- shares|crypto|property|managed_fund|other
  code                   TEXT,                       -- e.g. 'CBA', 'BTC' — display/grouping only
  label                  TEXT,
  units                  REAL,                       -- parcel size (shares/coins); NULL for property
  acquired_date          TEXT,                       -- start of the 12-month discount clock
  cost_base_cents        INTEGER NOT NULL DEFAULT 0, -- purchase + incidental costs (brokerage, stamp duty)
  reduced_cost_base_cents INTEGER,                   -- for losses (excludes the indexation/discount elements)
  main_residence_exempt  INTEGER NOT NULL DEFAULT 0, -- property only — full/partial MRE flagged for the agent
  status                 TEXT NOT NULL DEFAULT 'held', -- held|part_disposed|disposed
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cgt_assets_user ON cgt_assets(user_id, asset_kind);
CREATE INDEX IF NOT EXISTS idx_cgt_assets_person ON cgt_assets(user_id, person_id);

CREATE TABLE IF NOT EXISTS cgt_events (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  cgt_asset_id        TEXT NOT NULL,                 -- cgt_assets.id
  fy                  TEXT NOT NULL,                 -- '2025-26' (the FY the event falls in)
  event_type          TEXT NOT NULL DEFAULT 'disposal', -- disposal|part_disposal
  event_date          TEXT NOT NULL,
  proceeds_cents      INTEGER NOT NULL DEFAULT 0,    -- capital proceeds (sale price net of selling costs)
  cost_base_used_cents INTEGER NOT NULL DEFAULT 0,   -- the cost base attributable to the units disposed
  units_disposed      REAL,
  discount_eligible   INTEGER,                       -- NULL => derive from held-≥12-months at compute time
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cgt_events_user_fy ON cgt_events(user_id, fy);
CREATE INDEX IF NOT EXISTS idx_cgt_events_asset ON cgt_events(user_id, cgt_asset_id);
