-- 0005: async categorisation jobs (Message Batches). Apply: wrangler d1 execute tax-agent-db --remote --file=migrations/0005_batch_jobs.sql
CREATE TABLE IF NOT EXISTS batch_jobs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  statement_id TEXT,
  batch_id     TEXT,
  status       TEXT NOT NULL DEFAULT 'submitted',
  chunk_map    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_batch_status ON batch_jobs(status);
CREATE INDEX IF NOT EXISTS idx_batch_user ON batch_jobs(user_id, status);
