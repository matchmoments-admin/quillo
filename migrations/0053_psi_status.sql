-- 0053_psi_status.sql — S2 (Phase 4): self-declared PSI (Personal Services Income, Div 86) status on a
-- business income activity. Capture-only: NULL = not assessed (the byte-identical default for every
-- existing row); 'not_psi' = user has assessed PSI does not apply; 'psi_applies' = user says it applies.
-- Drives a SHARPENED readiness defer nudge only — it never auto-removes deductions from the position
-- (deny-by-default already holds the line, and the Div 86 tests are a fact-specific judgement we defer).
-- Additive + apply-once.
ALTER TABLE income_activities ADD COLUMN psi_status TEXT;
