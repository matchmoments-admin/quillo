-- Links a loan/mortgage ACCOUNT to the PROPERTY it funds, with the share of interest that is
-- deductible (interest on a loan used to earn income is deductible; principal is not — s8-1).
-- This is SET-UP DATA ONLY: it is captured here so the later guided loan interest/principal split
-- (Phase 5) can pre-fill a per-loan default %. It is inert until that step reads it — recording a
-- link does NOT change the indicative position or claim any deduction (confirm-each-pattern holds).
-- Additive + idempotent (CREATE TABLE/INDEX IF NOT EXISTS). user_id first (multi-tenant seam).
CREATE TABLE IF NOT EXISTS loans_properties (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL,
  loan_account_id         TEXT NOT NULL,            -- accounts.id (type='loan')
  property_id             TEXT NOT NULL,            -- properties.id
  deductible_interest_pct REAL NOT NULL DEFAULT 0,  -- 0-100; pre-fill default for the Phase 5 split
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, loan_account_id, property_id)
);
CREATE INDEX IF NOT EXISTS idx_loanprop_account ON loans_properties(user_id, loan_account_id);
CREATE INDEX IF NOT EXISTS idx_loanprop_property ON loans_properties(user_id, property_id);
