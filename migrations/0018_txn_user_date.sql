-- 0018_txn_user_date.sql — index for per-FY dashboard/progress range scans.
--
-- The dashboard + summary bar are now scoped to the active financial year, so every KPI query adds
-- `WHERE user_id = ? AND txn_date BETWEEN ? AND ?`. The existing (user_id, account_id, txn_date)
-- index doesn't serve a date range without an account, so add a (user_id, txn_date) covering index
-- for those scans. Additive + idempotent (CREATE INDEX IF NOT EXISTS) — safe to re-run.
CREATE INDEX IF NOT EXISTS idx_txn_user_date ON transactions(user_id, txn_date);
