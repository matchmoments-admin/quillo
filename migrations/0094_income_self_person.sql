-- 0094 — income rows with no person belong to the primary taxpayer, so say so (#820, 2026-10-30).
--
-- WHY. A NULL person_id meant "self" before the persons model (0006); recordIncome has stamped
-- person_self_<uid> since. src/lib/self-person.ts reads both forms as self, but two readers matched
-- person_id = ? exactly and dropped the NULL rows (listIncome, incomeTotals with a person filter).
-- This sets the legacy rows to the self id so every reader agrees; the readers are aligned in the same change.
-- Prod held 0 income rows when this was written (tenant reset 2026-10-25), so nothing existing moves.
--
-- Additive and apply-once: a guarded UPDATE (re-running finds no NULL rows), plus the self person for any
-- tenant whose income predates its persons row (INSERT OR IGNORE, deterministic id). No schema change.

INSERT OR IGNORE INTO persons (id, user_id, display_name, role)
  SELECT DISTINCT 'person_self_' || user_id, user_id, 'Me', 'self' FROM income WHERE person_id IS NULL;
UPDATE income SET person_id = 'person_self_' || user_id WHERE person_id IS NULL;
