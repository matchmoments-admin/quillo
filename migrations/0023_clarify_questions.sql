-- 0023_clarify_questions.sql
-- Stage B (clarify-by-pattern). The accountant pass asks ONE question per recurring pattern, not per
-- transaction. Each open question is a group of look-alike bank lines (normalised group_key) the user
-- answers once → the answer creates a user_rule (future auto-apply) AND recategorises the whole group
-- now. Idempotent upsert by (user_id, fy, group_key) so re-running the scan never duplicates a
-- question, and a state-preserving ON CONFLICT (guarded by status='open') never resurrects an
-- answered/dismissed one.
-- Apply: wrangler d1 execute tax-agent-db --remote --file=migrations/0023_clarify_questions.sql
--
-- Additive + apply-once: CREATE TABLE/INDEX IF NOT EXISTS. The UNIQUE(user_id, fy, group_key) is the
-- upsert target — fy is part of the key so the same payee in two financial years is two questions.
CREATE TABLE IF NOT EXISTS clarify_questions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  fy            TEXT NOT NULL,                 -- FY start year as text, e.g. "2024"
  group_key     TEXT NOT NULL,                 -- normalised merchant stem (src/lib/clarify.ts groupKey)
  sample_desc   TEXT,                          -- a representative raw description for display
  direction     TEXT,                          -- debit | credit | mixed
  n             INTEGER NOT NULL DEFAULT 0,     -- how many lines in the group at scan time
  total_cents   INTEGER NOT NULL DEFAULT 0,     -- summed AUD magnitude
  suggested_json TEXT,                          -- JSON array of ClarifySuggestion (direction-aware)
  status        TEXT NOT NULL DEFAULT 'open',   -- open | answered | dismissed
  answer_json   TEXT,                           -- the chosen answer (kind + bucket/label/property)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, fy, group_key)
);

CREATE INDEX IF NOT EXISTS idx_clarify_user_status ON clarify_questions(user_id, status);
