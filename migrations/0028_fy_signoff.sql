-- Soft, per-FY sign-off: the user's own attestation that "this is my year-end position, ready to
-- hand to my agent". NOT a lock — it can be re-opened (DELETE) and a later import/run doesn't clear
-- it automatically (the Filing page shows the timestamp so a stale sign-off is visible). FY-scoped
-- (start year), not tied to a mutable accountant_runs row. Additive + idempotent. Quillo never lodges.
CREATE TABLE IF NOT EXISTS fy_signoff (
  user_id       TEXT NOT NULL,
  fy            INTEGER NOT NULL,      -- FY start year (e.g. 2024 = 2024-25)
  signed_off_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, fy)
);
