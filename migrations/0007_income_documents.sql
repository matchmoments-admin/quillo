-- 0007_income_documents.sql
-- First-class INCOME (salary, rent, interest, dividends, distributions, foreign) + the
-- canonical DOCUMENTS registry (the source-doc shelf income/asset records reference).
-- Apply: wrangler d1 execute tax-agent-db --remote --file=migrations/0007_income_documents.sql
--
-- Income is MODELLED, never inferred from bank credits: agent statements are net (rent less
-- commission + expenses), salary is gross-with-withholding. Additive + apply-once (mirrors 0002).

CREATE TABLE IF NOT EXISTS income (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,                 -- tenant key
  person_id     TEXT,                          -- whose income (FK persons.id)
  entity_id     TEXT,                          -- employer/company source (FK entities.id)
  property_id   TEXT,                          -- if rental income (FK properties.id)
  income_type   TEXT NOT NULL,                 -- salary_payg|rent|interest|dividend|managed_fund_distribution|foreign_pension|foreign_rent|other
  ato_label     TEXT,                          -- e.g. '1-salary','13R-rent','11-dividends','20-foreign'
  fy            TEXT NOT NULL,                 -- AU FY label '2025-26'
  gross_cents   INTEGER NOT NULL,              -- gross (before withholding/commission)
  net_cents     INTEGER,                       -- net received (agent disbursement / post-tax)
  withholding_cents INTEGER DEFAULT 0,         -- PAYG withheld / TFN withholding
  franking_credit_cents INTEGER DEFAULT 0,     -- imputation credit
  foreign_tax_paid_cents INTEGER DEFAULT 0,    -- for the foreign income tax offset (FITO)
  currency      TEXT NOT NULL DEFAULT 'AUD',
  amount_aud_cents INTEGER,                    -- gross converted to AUD for reporting
  fx_rate       REAL,
  source_doc_id TEXT,                          -- FK documents.id (payslip / agent summary / AMMA)
  txn_date      TEXT,
  detail_json   TEXT,                          -- AMMA components (cap gains, AMIT cost-base adj, etc.)
  needs_review  INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_income_user_fy  ON income(user_id, fy);
CREATE INDEX IF NOT EXISTS idx_income_property ON income(user_id, property_id);
CREATE INDEX IF NOT EXISTS idx_income_person   ON income(user_id, person_id);

-- Canonical file registry (the Smart-Inbox sink). Forward-only: every new upload writes a row;
-- legacy receipts (tracked only on transactions.receipt_key) are unioned in by the read layer
-- and backfilled later. income/assets reference documents.id via source_doc_id.
CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  person_id     TEXT,
  doc_type      TEXT NOT NULL,                 -- receipt|payslip|agent_rental_summary|dividend_statement|managed_fund_amma|depreciation_schedule|super_statement|bank_statement|loan_statement|invoice|other
  fy            TEXT,                          -- which FY it pertains to
  property_id   TEXT,
  entity_id     TEXT,
  r2_key        TEXT NOT NULL,                 -- R2 object key (5yr ATO retention)
  image_hash    TEXT,                          -- dedup
  issuer        TEXT,
  doc_date      TEXT,
  extracted_json TEXT,                         -- structured extraction snapshot
  classification_confidence REAL,
  needs_review  INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, doc_type, fy);

-- Forward-only link from a transaction to its registry document.
ALTER TABLE transactions ADD COLUMN document_id TEXT;
