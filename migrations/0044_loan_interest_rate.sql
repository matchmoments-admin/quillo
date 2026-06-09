-- 0044: loan interest facts on the account (#157 S3, EPIC). The owner's "interest-rate section
-- tied to the account" — the FALLBACK estimate inputs for the evidence-first loan-interest model.
-- WHY: Quillo is an evidence app — the bank statement already itemises the ACTUAL interest charged,
--      so the deductible figure is sourced (S4) from the lender's annual summary or the parsed
--      statement. These fields only feed a clearly-labelled "indicative" estimate (rate × balance)
--      when no evidenced figure exists. Meaningful only for type='loan' accounts.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0044_loan_interest_rate.sql
-- Idempotency: ADD COLUMN apply-once; nullable, no backfill — existing accounts are unchanged. Inert
-- until S4 reads them → recording a rate does NOT change the indicative position (still byte-identical).
ALTER TABLE accounts ADD COLUMN interest_rate_pct REAL;     -- annual interest rate %, e.g. 6.25 (fallback estimate only)
ALTER TABLE accounts ADD COLUMN balance_cents     INTEGER;  -- current/avg loan balance for the rate×balance estimate
