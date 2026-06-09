-- 0046: Ask Quillo C2 (#173) — multi-turn chat. A session groups one conversation (scoped to an FY
-- for context); chat_messages stores each turn (role user|assistant). Answers are grounded ONLY in the
-- user's own ledger and GENERAL-INFO framed; rules are written only on the user's explicit confirm via
-- the existing /api/rules path. Quillo never gives tax advice / a refund / rates.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0046_chat.sql
-- Idempotency: CREATE TABLE/INDEX IF NOT EXISTS. Additive — no read path changes until the chat ships.
CREATE TABLE IF NOT EXISTS chat_sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  fy         INTEGER,                            -- FY start year the conversation's position is scoped to
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, created_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL,                      -- user | assistant
  content    TEXT NOT NULL,                      -- redacted question / model answer (no PII)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(user_id, session_id, created_at);
