-- 0078 — situation profile as DATED PERIODS per subject (first-timer spec A1, ticket #571).
--
-- WHY A GENERIC PERIOD TABLE, NOT MORE COLUMNS ON `persons`.
--
-- A taxpayer's situation changes during a year: a part-year resident arrives in February, a student
-- holds two casual jobs that overlap, a rideshare side-hustle starts in March. `persons.occupation` and
-- `persons.tax_residency` are single scalars with no dates, so none of that could be recorded and the
-- year's first-timer logic (relevance scan, residency-aware foreign income, study-loan note) had nothing
-- to read. myTax's Personalise screen asks residency WITH dates; Xero/MYOB model an employment as a
-- record with start and termination dates. One generic dated-period primitive serves all of it, and is
-- the same primitive the property `use_status` move needs later (subject_kind = 'property', no new DDL).
-- Rejected: a column per fact on `persons` (no history, part-year impossible) and reusing
-- `entity_roles.start_date/end_date` for jobs (role-shaped, would split the profile across two tables).
--
-- `fact` and `value` are validated against the rule pack (`situation_facts` in au-v1.json), never a CHECK
-- constraint, so a jurisdiction can add or rename facts without DDL. Dates are ISO 'YYYY-MM-DD',
-- inclusive; NULL = open-ended.
--
-- Written ONLY by the /api/situation-periods endpoints behind the `situation_profile` flag; flag OFF ⇒ no
-- new writes and no feature reads. The table is NOT flag-gated for the tenant purge / APP-12 export (it is in
-- PURGE_TABLES), so APPLY THIS MIGRATION BEFORE DEPLOYING the code, not just before flipping the flag.
-- A deleted person's periods are kept (hidden by the reader) so an undo of the delete restores them.
--
-- `fy_signoff.lodged_at` (spec appendix lists it under 0078) is deliberately NOT here: it belongs to the
-- mark-as-lodged ticket (A1 ticket b, #572), which owns its own migration.
--
-- Additive and apply-once: CREATE TABLE/INDEX IF NOT EXISTS. Tenant table ⇒ PURGE_TABLES + export.

CREATE TABLE IF NOT EXISTS situation_periods (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  subject_kind TEXT NOT NULL DEFAULT 'person',   -- person | property (property reserved, no writer yet)
  subject_id   TEXT NOT NULL,                    -- persons.id (or properties.id)
  fact         TEXT NOT NULL,                    -- pack-validated: residency|spouse|state|employment|abn_activity|study|study_loan|wfh|car_for_work|foreign_income|private_hospital_cover
  value        TEXT,                             -- e.g. 'resident'|'temporary'|'foreign'|'whm'|'unsure'; occupation token; state code
  ref_id       TEXT,                             -- employment → entities.id; abn_activity → income_activities.id
  starts_on    TEXT,                             -- ISO date, NULL = open start
  ends_on      TEXT,                             -- ISO date inclusive, NULL = open end
  source       TEXT NOT NULL DEFAULT 'user',     -- user | onboarding | noticed
  detail_json  TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sitper_subject ON situation_periods(user_id, subject_id, fact);
