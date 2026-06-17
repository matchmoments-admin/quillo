-- 0061 (#245): split car cents-per-km out of work_use_inputs into its own typed per-FY unit.
-- WHY: WFH (fixed-rate hours) and CAR (cents-per-km km) are SEPARATE ATO methods; co-mingling them in
-- work_use_inputs coupled two unrelated calculators. work_use_inputs becomes WFH-only going forward;
-- car cents-per-km lives here. The logbook method already has its own table (vehicle_logbooks, 0040).
-- Additive + apply-once + idempotent backfill. Gated by the car_methods flag in report.ts — inert until on.
CREATE TABLE IF NOT EXISTS car_inputs (
  user_id     TEXT NOT NULL,
  fy          INTEGER NOT NULL,        -- FY start year (matches work_use_inputs.fy / buildReport(startYear))
  work_km     REAL,                    -- work-related km this FY (cents-per-km method; capped in the calc)
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, fy)
);

-- Idempotent backfill: seed car_inputs from any legacy work_use_inputs.car_work_km so existing data
-- surfaces identically once car_methods flips on. INSERT OR IGNORE → safe to re-run; never overwrites.
INSERT OR IGNORE INTO car_inputs (user_id, fy, work_km, updated_at)
  SELECT user_id, fy, car_work_km, datetime('now')
    FROM work_use_inputs
   WHERE car_work_km IS NOT NULL AND car_work_km > 0;
