-- 0036: WFH in days-per-week (Phase D / G5). Users think in "2 days a week", not "730 hours".
-- WHY: WFH is the #1 PAYG claim and the input asked for total hours — a figure people don't know.
--      Capturing days/week + working weeks lets the system DERIVE hours transparently (and explain the
--      basis to the agent), while wfh_hours stays the authoritative, editable figure the engine reads.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0036_wfh_days_per_week.sql
-- Idempotency: ADD COLUMN apply-once; nullable, no backfill — existing hours-only rows are unchanged.
ALTER TABLE work_use_inputs ADD COLUMN wfh_days_per_week REAL;  -- e.g. 2 (days/week worked from home)
ALTER TABLE work_use_inputs ADD COLUMN wfh_weeks         REAL;  -- working weeks (default ~48 when null)
