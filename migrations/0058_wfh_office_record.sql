-- 0058: two capture-only WFH context fields on work_use_inputs (Item 2). These DRIVE GUIDANCE, not the
-- fixed-rate $ figure (70c/hr × hours is unchanged), so they have NO effect on the computed position —
-- personas stay byte-identical.
--   has_dedicated_home_office — a dedicated room isn't required for the fixed-rate method, but it
--     matters for the actual-cost method and for cleaning/occupancy claims; we capture it to tailor the
--     guidance the user sees.
--   wfh_has_record — from 1 Mar 2023 the ATO requires a record of ACTUAL hours worked from home for the
--     whole year (it won't accept a 4-week estimate). This flag lets us nudge the user to keep one.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0058_wfh_office_record.sql
-- Idempotency: ALTER ADD COLUMN (one-time). work_use_inputs is already in PURGE_TABLES.

ALTER TABLE work_use_inputs ADD COLUMN has_dedicated_home_office INTEGER DEFAULT 0;
ALTER TABLE work_use_inputs ADD COLUMN wfh_has_record INTEGER DEFAULT 0;
