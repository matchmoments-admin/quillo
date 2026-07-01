-- 0068 (audit wave 4, PR-8): trading stock for goods-selling sole traders.
-- ATO-shaped minimal model (s 70-35): one row per business per FY carrying opening + closing stock
-- values; purchases already flow through transactions. Assessable adjustment = closing − opening
-- (an increase adds to income; a decrease deducts), applied by report.ts ONLY when the
-- `trading_stock` flag is on. entity_id NULL = the personal (sole-trader) business; an entity-scoped
-- row is captured but stays out of the personal headline (separate taxpayer).
-- valuation_basis records the s 70-45 choice per item class (cost | market_selling_value |
-- replacement) — record-keeping only, never computed.
CREATE TABLE IF NOT EXISTS trading_stock (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  entity_id TEXT,
  fy TEXT NOT NULL,                 -- FY label '2025-26'
  opening_cents INTEGER NOT NULL DEFAULT 0,
  closing_cents INTEGER NOT NULL DEFAULT 0,
  valuation_basis TEXT,             -- cost | market_selling_value | replacement (record-keeping only)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_stock_unique ON trading_stock(user_id, fy, COALESCE(entity_id, ''));
CREATE INDEX IF NOT EXISTS idx_trading_stock_user_fy ON trading_stock(user_id, fy);
