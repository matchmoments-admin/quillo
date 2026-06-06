-- 0022_correction_batch.sql
-- Batch corrections + undo. Phase 2 (review editing) lets the user re-categorise MANY transactions
-- in one action (bulk bar) and Stage B (clarify-by-pattern) applies one answer to a whole group.
-- Both write a corrections row per txn sharing a `batch_id`, so the action can be undone as a unit
-- (write back old_value where reverted_at IS NULL). Existing single corrections have a NULL batch_id
-- (un-grouped) and NULL reverted_at (live) — today's behaviour, unchanged.
-- Apply: wrangler d1 execute tax-agent-db --remote --file=migrations/0022_correction_batch.sql
--
-- Additive + apply-once: two nullable ADD COLUMNs + one index. No backfill needed.
ALTER TABLE corrections ADD COLUMN batch_id TEXT;     -- groups the per-txn corrections of one bulk action; NULL = standalone
ALTER TABLE corrections ADD COLUMN reverted_at TEXT;  -- set when an undo writes old_value back; NULL = still applied

CREATE INDEX IF NOT EXISTS idx_corr_batch ON corrections(user_id, batch_id);
