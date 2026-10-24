-- 0089 — keep the hours recorded BEFORE the weekly diary started (F6, flag `wfh_weekly_diary`, #787 follow-up).
--
-- WHY. With the weekly diary ON, the diary's counted total was written over work_use_inputs.wfh_hours as
-- soon as one week was confirmed. A user who had typed 600 timesheet hours for July–December and then
-- confirmed one 16-hour week dropped to 16 hours; deleting that week wrote NULL, and the 600 was gone for
-- good. Now, when the diary first starts for an FY, the figure already in wfh_hours is copied here, and
-- the FY's hours are this figure PLUS the counted diary hours. Deleting diary weeks never touches it.
--
-- The user can edit it on the WFH card and must say what it came from (the same list as a late diary
-- week: calendar | timesheet | roster | system_log | memory). NULL source = carried over from the typed
-- field and not yet labelled (still counted, as it was before the diary). memory = an estimate, so it is
-- kept and shown but not counted (PCG 2023/1 para 58; docs/research/wfh-records.md).
--
-- POSITION. report.ts still reads only wfh_hours; flag OFF ⇒ nothing reads or writes these columns.
-- Additive and apply-once: ALTER TABLE ADD COLUMN only. work_use_inputs is already in PURGE_TABLES.

ALTER TABLE work_use_inputs ADD COLUMN wfh_hours_pre_diary REAL;
ALTER TABLE work_use_inputs ADD COLUMN wfh_hours_pre_diary_source TEXT;
