-- Prior-year carry-ins captured at Set-up. CAPTURE-ONLY: these are stored and surfaced as
-- defer-to-agent findings; they do NOT auto-change the headline position (capital losses offset
-- capital GAINS only — never ordinary income — and there is no CGT-gain line in the indicative
-- position to net against; an opening adjustable value silently changing multi-year depreciation is
-- a STOP-and-ask money-output call). Additive + idempotent.
CREATE TABLE IF NOT EXISTS capital_loss_carryins (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  prior_fy    INTEGER NOT NULL,          -- FY the loss was incurred (start year)
  loss_cents  INTEGER NOT NULL,          -- carried-forward capital loss (>=0)
  asset_id    TEXT,                       -- optional link to an asset/property
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_caploss_user ON capital_loss_carryins(user_id);

CREATE TABLE IF NOT EXISTS depreciation_opening_balances (
  id                            TEXT PRIMARY KEY,
  user_id                       TEXT NOT NULL,
  fy                            INTEGER NOT NULL,   -- FY start year the opening value applies to
  asset_id                      TEXT,                -- optional link to an asset
  opening_adjustable_value_cents INTEGER NOT NULL,   -- prior-year closing adjustable value (>=0)
  notes                         TEXT,
  created_at                    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_depopen_user ON depreciation_opening_balances(user_id, fy);
