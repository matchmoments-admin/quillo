-- 0063: one limit row per (user, policy, category). Backs the SELECT-then-upsert in savePhiLimit so a
-- retried/stale request can't create duplicate category rows that double-count total_limit_cents.
-- Additive + apply-once. Pre-flight confirmed no existing duplicates in remote D1 before applying.
CREATE UNIQUE INDEX IF NOT EXISTS idx_phi_limit_uniq ON phi_limit(user_id, policy_id, category);
