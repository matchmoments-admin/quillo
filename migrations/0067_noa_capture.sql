-- B1 (noa_capture, #71/#304): close a tax year off an ATO Notice of Assessment. Additive + apply-once.
--
-- (a) Extend the soft per-FY sign-off with the NOA link + a status, so a year can be "closed_with_noa"
--     rather than only softly attested. Existing rows keep status NULL (= the old soft attestation).
ALTER TABLE fy_signoff ADD COLUMN noa_document_id TEXT;
ALTER TABLE fy_signoff ADD COLUMN status TEXT;   -- NULL / 'signed_off' = soft attestation · 'closed_with_noa' = closed off an NOA

-- (b) Capture the ATO-confirmed carry-over facts read off the NOA. Written as a DRAFT at upload time and
--     only turned into carry-in rows (capital_loss_carryins / depreciation_opening_balances) once the user
--     confirms. Keyed by source FY (the assessed year) → target FY (source+1, where the carry-overs apply).
CREATE TABLE IF NOT EXISTS fy_carryovers (
  id                             TEXT PRIMARY KEY,
  user_id                        TEXT NOT NULL,
  source_fy                      INTEGER NOT NULL,               -- FY the NOA assessed (start year, e.g. 2024 = 2024-25)
  target_fy                      INTEGER NOT NULL,               -- source_fy + 1 (year the carry-overs apply to)
  noa_document_id                TEXT,                           -- the uploaded NOA document
  status                         TEXT NOT NULL DEFAULT 'draft',  -- 'draft' (awaiting confirm) | 'confirmed'
  taxable_income_cents           INTEGER,                        -- ATO-assessed taxable income (reconciliation nudge)
  tax_assessed_cents             INTEGER,
  net_capital_losses_cf_cents    INTEGER NOT NULL DEFAULT 0,     -- → capital_loss_carryins on confirm
  prior_year_tax_losses_cf_cents INTEGER NOT NULL DEFAULT 0,     -- captured now; applied to the position by B2 (carryforward_position)
  opening_depreciation_cents     INTEGER NOT NULL DEFAULT 0,     -- → depreciation_opening_balances on confirm (still capture-only)
  hecs_balance_cents             INTEGER,                        -- reference facts (income-test / repayment context only)
  mls_debt_cents                 INTEGER,
  franking_refund_cents          INTEGER,
  capital_loss_carryin_id        TEXT,                           -- row written on confirm (kept for the undo/reverse path)
  depreciation_opening_id        TEXT,                           -- row written on confirm (kept for the undo/reverse path)
  confidence                     REAL,
  created_at                     TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at                   TEXT
);
CREATE INDEX IF NOT EXISTS idx_fy_carryovers_user ON fy_carryovers(user_id, source_fy);
