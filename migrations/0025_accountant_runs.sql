-- 0025_accountant_runs.sql
-- Phase 4 — "Do my books" Accountant Pass. One row per run for progress/audit/resume and, crucially,
-- an IN-FLIGHT LOCK: a run is claimed status='running' so a double-click or overlapping trigger can't
-- start a second pass for the same (user_id, fy) and re-pay/duplicate work (B2 — the logged double-pay
-- mode). Deterministic stages only need this; the LLM remainder (Stage C) additionally honours the
-- budget gate + the existing submitted-batch guard.
-- Apply: wrangler d1 execute tax-agent-db --remote --file=migrations/0025_accountant_runs.sql
--
-- Additive + apply-once: CREATE TABLE/INDEX IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS accountant_runs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  fy          TEXT NOT NULL,                  -- FY start year as text
  stage       TEXT,                           -- last stage reached (cleanup|clarify|deductibility|claims|done)
  status      TEXT NOT NULL DEFAULT 'running',-- running | done | error
  summary_json TEXT,                          -- counts the sign-off pack renders
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_acctrun_user ON accountant_runs(user_id, status);
