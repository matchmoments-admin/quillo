-- 0045: per-FY loan-interest EVIDENCE (#157 S4, EPIC). The actual interest charged on a loan for a
-- financial year, sourced from the lender's annual summary or the parsed statement — the canonical,
-- ATO-grade figure for the evidence-first loan-interest model. One row per (tenant, loan account, FY).
-- WHY a satellite table (not a column on accounts): interest is a PER-YEAR fact tied to the loan, and
-- it carries provenance (which source) + an evidence link (the document). The rate on the account
-- (0044) is only the fallback estimate; this is the figure that wins when present.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0045_loan_interest_summaries.sql
-- Idempotency: CREATE TABLE/INDEX IF NOT EXISTS. NOT read by report.ts in this slice (S5 wires it),
-- so the indicative position is byte-identical until S5 ships behind the loan_interest_v2 flag.
CREATE TABLE IF NOT EXISTS loan_interest_summaries (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  loan_account_id TEXT NOT NULL,                     -- accounts.id (type='loan')
  fy              TEXT NOT NULL,                      -- FY start year as a string ("2024"), matching clarify_questions.fy
  interest_cents  INTEGER NOT NULL,                   -- actual interest charged for the FY (the evidenced figure)
  source          TEXT NOT NULL DEFAULT 'lender_summary', -- lender_summary | statement_parsed | estimate
  document_id     TEXT,                               -- documents.id — the evidence (lender summary / statement) in R2
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, loan_account_id, fy)
);
CREATE INDEX IF NOT EXISTS idx_loanint_user_fy ON loan_interest_summaries(user_id, fy);
