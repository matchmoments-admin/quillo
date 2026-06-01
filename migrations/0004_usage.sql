-- 0004: inference cost accounting. Apply: wrangler d1 execute tax-agent-db --remote --file=migrations/0004_usage.sql
CREATE TABLE IF NOT EXISTS llm_usage (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  feature           TEXT,
  model             TEXT,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cache_read_tokens INTEGER,
  cost_cents        REAL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON llm_usage(user_id, created_at);
