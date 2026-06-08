-- 0039: GST/BAS + PAYG instalments (#137, EPIC #134). Indicative BAS workpaper — Quillo NEVER lodges.
-- WHY: rideshare drivers must register for GST from the first dollar; sole traders register at $75k.
--      gst_cents was captured per line but there was no output-tax (1/11th of taxable supplies), no
--      BAS period, no PAYG-instalment tracking. This adds per-entity GST registration + a BAS-period
--      satellite + a PAYG-instalment satellite. GST is NOT income tax — its net never touches the
--      income-tax position. Flag-gated by gst_bas; defer-to-agent for lodgement.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0039_gst_bas.sql
-- Idempotency: ADD COLUMN apply-once; tables IF NOT EXISTS; no backfill.
ALTER TABLE entities ADD COLUMN gst_registered        INTEGER NOT NULL DEFAULT 0; -- per-entity (profiles.gst_registered is the tenant default)
ALTER TABLE entities ADD COLUMN gst_basis             TEXT;   -- cash|accrual
ALTER TABLE entities ADD COLUMN gst_period            TEXT;   -- quarterly|monthly
ALTER TABLE entities ADD COLUMN gst_registration_date TEXT;

CREATE TABLE IF NOT EXISTS bas_periods (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  entity_id             TEXT,                        -- the registered entity (NULL = sole trader on the individual)
  period_start          TEXT NOT NULL,
  period_end            TEXT NOT NULL,
  output_gst_cents      INTEGER NOT NULL DEFAULT 0,  -- GST collected (1/11th of taxable supplies)
  input_gst_cents       INTEGER NOT NULL DEFAULT 0,  -- GST credits on business inputs
  payg_withholding_cents INTEGER NOT NULL DEFAULT 0,
  payg_instalment_cents INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'draft', -- draft|finalised (never 'lodged' — Quillo doesn't lodge)
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bas_user ON bas_periods(user_id, entity_id);

CREATE TABLE IF NOT EXISTS payg_instalments (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  entity_id     TEXT,
  fy            TEXT NOT NULL,
  quarter       INTEGER,                              -- 1-4
  instalment_cents INTEGER NOT NULL DEFAULT 0,
  basis         TEXT,                                 -- ato_rate|ato_amount|varied (defer-to-agent)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payg_inst_user ON payg_instalments(user_id, fy);
