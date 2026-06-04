-- 0012_income_match.sql
-- Income de-duplication. A salary can arrive BOTH as a documented income row (payslip → income
-- table) and as a bank credit (transactions, bucket income_*). Shown separately today, they read
-- as double income. This adds a manual link from a credit bank-line to the income row it duplicates
-- so the report counts the pair once (the credit is excluded from the bank-credit income section
-- when matched). Matching is suggest-only + user-confirmed — never auto-merged.
-- Apply: wrangler d1 execute tax-agent-db --remote --file=migrations/0012_income_match.sql
--
-- Additive + apply-once: ADD COLUMN (NULL default = unmatched, today's behaviour) + an index.
ALTER TABLE transactions ADD COLUMN matched_income_id TEXT; -- income.id this credit duplicates; NULL = unmatched

CREATE INDEX IF NOT EXISTS idx_txn_matched_income ON transactions(user_id, matched_income_id);
