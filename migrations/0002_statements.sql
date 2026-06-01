-- 0002: statement import + multi-source de-duplication (additive, safe on prod).
-- Apply: wrangler d1 execute tax-agent-db --remote --file=migrations/0002_statements.sql
-- SQLite ADD COLUMN is metadata-only (instant); new tables/indexes are IF NOT EXISTS.

ALTER TABLE transactions ADD COLUMN kind TEXT NOT NULL DEFAULT 'receipt';
ALTER TABLE transactions ADD COLUMN account_id TEXT;
ALTER TABLE transactions ADD COLUMN statement_id TEXT;
ALTER TABLE transactions ADD COLUMN line_fingerprint TEXT;
ALTER TABLE transactions ADD COLUMN matched_txn_id TEXT;
ALTER TABLE transactions ADD COLUMN raw_description TEXT;
ALTER TABLE transactions ADD COLUMN direction TEXT DEFAULT 'debit';

CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_fingerprint
  ON transactions(user_id, account_id, line_fingerprint);
CREATE INDEX IF NOT EXISTS idx_txn_kind     ON transactions(user_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_txn_matched  ON transactions(user_id, matched_txn_id);
CREATE INDEX IF NOT EXISTS idx_txn_acct_date ON transactions(user_id, account_id, txn_date);

CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  institution    TEXT,
  name           TEXT NOT NULL,
  last4          TEXT,
  type           TEXT NOT NULL DEFAULT 'transaction',
  source         TEXT NOT NULL DEFAULT 'statement',
  qbo_account_id TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_acct_user ON accounts(user_id, active);

CREATE TABLE IF NOT EXISTS statements (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  filename       TEXT,
  file_key       TEXT,
  file_hash      TEXT,
  format         TEXT,
  column_map     TEXT,
  row_count      INTEGER,
  imported_count INTEGER,
  status         TEXT NOT NULL DEFAULT 'parsed',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stmt_user ON statements(user_id, account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stmt_filehash ON statements(user_id, file_hash);
