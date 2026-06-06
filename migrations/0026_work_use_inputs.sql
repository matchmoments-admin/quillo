-- Per-FY work-use inputs for COMPUTED deductions that aren't a percentage of tracked spend:
--   wfh_hours    → working-from-home fixed-rate method (hours × c/hr; covers electricity/internet/phone)
--   car_work_km  → car cents-per-kilometre method (min(km, cap) × c/km; covers running costs)
-- One row per user per FY. Additive + idempotent (CREATE TABLE IF NOT EXISTS). The computed deduction
-- is flag-gated (wfh_car_methods) in report.ts; this table is inert until that flag is on.
CREATE TABLE IF NOT EXISTS work_use_inputs (
  user_id      TEXT NOT NULL,
  fy           INTEGER NOT NULL,        -- FY start year (e.g. 2024 = 2024-25), matching buildReport(startYear)
  wfh_hours    REAL,                    -- hours genuinely worked from home this FY (fixed-rate method)
  car_work_km  REAL,                    -- work-related km this FY (cents-per-km method; capped in the calc)
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, fy)
);
