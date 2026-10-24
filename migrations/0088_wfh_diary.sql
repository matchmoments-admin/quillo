-- 0088 — weekly work-from-home diary (#787, flag `wfh_weekly_diary`). Research: docs/research/wfh-records.md.
--
-- WHY. The fixed-rate method needs a record of the ACTUAL hours worked from home for the whole year, kept
-- contemporaneously (PCG 2023/1 para 58); an estimate, or a sample period applied to the year, isn't
-- accepted. Most people's weeks look the same, so the user sets a TYPICAL WEEK once (wfh_diary_pattern) and
-- each week CONFIRMS it, or adjusts a day (office / leave / sick / public holiday), in one tap
-- (wfh_diary_weeks). The pattern only pre-fills the form: hours count only from a confirmed week. Each week
-- stores when it was first recorded (server clock) and last changed, so the exported record shows it was
-- kept as the user went. A week first recorded after the on-time window is a catch-up: labelled late, with
-- the source it was rebuilt from; a catch-up from memory is an estimate and is never counted.
--
-- POSITION. The diary total for an FY is written into the EXISTING work_use_inputs.wfh_hours, so the
-- fixed-rate maths in report.ts is unchanged. Flag OFF ⇒ nothing reads or writes these tables.
--
-- Additive and apply-once: CREATE TABLE IF NOT EXISTS only. Both tables are tenant tables, in PURGE_TABLES.
-- JURISDICTION-NEUTRAL: weeks are ISO Monday-start; the FY a day belongs to comes from the descriptor.

CREATE TABLE IF NOT EXISTS wfh_diary_pattern (
  user_id     TEXT PRIMARY KEY,
  hours_json  TEXT NOT NULL,               -- JSON number[7], Mon..Sun: hours worked from home in a usual week
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wfh_diary_weeks (
  user_id      TEXT NOT NULL,
  week_start   TEXT NOT NULL,              -- ISO date of the week's Monday
  days_json    TEXT NOT NULL,              -- JSON [{ h: number, why?: office|leave|sick|public_holiday|other }] × 7, Mon..Sun
  entry        TEXT NOT NULL,              -- on_time | late (fixed at FIRST confirmation, from the server clock)
  source       TEXT,                       -- late only: calendar | timesheet | roster | system_log | memory
  note         TEXT,
  recorded_at  TEXT NOT NULL,              -- first confirmation (server clock, ISO)
  updated_at   TEXT NOT NULL,              -- last change (server clock, ISO)
  PRIMARY KEY (user_id, week_start)
);
