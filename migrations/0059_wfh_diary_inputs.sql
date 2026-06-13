-- 0059: WFH diary inputs on work_use_inputs (Part 1 — WFH diary generator). Additive, capture-only.
-- These let a user declare WHICH weekdays they work from home and their leave/holiday periods, so Quillo
-- can generate an ATO-acceptable contemporaneous work-from-home DIARY for the accountant CSV. The diary
-- is OFF by default (wfh_generate_diary = 0) and gated by the `wfh_generate_diary` feature flag, so the
-- computed position and the legacy CSV byte-pin are unchanged until the user intentionally turns it on.
--   wfh_weekdays       — JSON int[] (0=Mon … 6=Sun) of the days normally worked from home.
--   wfh_leave_ranges   — JSON [{start,end,label?}] of inclusive date ranges NOT worked from home (leave,
--                        public holidays taken off, sick leave). Excluded from the generated diary.
--   wfh_generate_diary — 1 to emit the diary section in the hand-off CSV (suppressed when wfh_has_record
--                        is set — the user supplies their own record, so a generated one would mislead).
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0059_wfh_diary_inputs.sql
-- Idempotency: ALTER ADD COLUMN (one-time). work_use_inputs is already in PURGE_TABLES.

ALTER TABLE work_use_inputs ADD COLUMN wfh_weekdays       TEXT;            -- JSON int[] 0=Mon..6=Sun
ALTER TABLE work_use_inputs ADD COLUMN wfh_leave_ranges   TEXT;            -- JSON [{start,end,label?}]
ALTER TABLE work_use_inputs ADD COLUMN wfh_generate_diary INTEGER DEFAULT 0;
