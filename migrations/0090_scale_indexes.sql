-- 0090 — two indexes from the 2026-10-25 D1-at-scale review. Additive and apply-once (IF NOT EXISTS).
--
-- traces had NO index: every per-txn delete (bank-consent expiry, minimisation, purgeTenant) scanned the
-- whole table across every tenant. (user_id, txn_id) serves all of them.
--
-- llm_usage(created_at, cost_e4): the founder admin's "spend today / this month" read used
-- substr(created_at, …) = ?, a full scan of the largest log table on each page view. It now filters by a
-- half-open created_at range, which this covering index answers without touching the table.

CREATE INDEX IF NOT EXISTS idx_traces_user_txn ON traces(user_id, txn_id);
CREATE INDEX IF NOT EXISTS idx_usage_created ON llm_usage(created_at, cost_e4);
