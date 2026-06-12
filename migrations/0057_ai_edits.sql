-- 0057: ai_edits — the audited, reversible log of AI-driven (and optionally manual) record changes.
-- Generalises `corrections` (which is transaction-field-level) to whole-entity writes: persons,
-- properties, entities, rules. One row per applied create/update, with full old/new row snapshots so
-- a single action can be inverted reliably (create→delete, update→restore old). Written ONLY through
-- the TaxAgent DO (serialised per tenant) and mirrored to the hash-chained audit_log, so AI writes are
-- both undoable (this table) and tamper-evident (audit_log). Per-user ⇒ added to PURGE_TABLES.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0057_ai_edits.sql
-- Idempotency: CREATE TABLE/INDEX IF NOT EXISTS. The write path is gated behind ask_actions_v2 and the
-- feed behind ai_edit_feed (both OFF until validated), so nothing populates/reads it until enabled.

CREATE TABLE IF NOT EXISTS ai_edits (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  batch_id    TEXT,                                  -- groups one multi-action AI change (atomic undo); NULL = standalone
  action_id   TEXT,                                  -- client idempotency key — a double-confirm/retry with the same id is a no-op
  entity_type TEXT NOT NULL,                          -- person|property|entity|rule (allowlisted in code)
  entity_id   TEXT NOT NULL,
  op          TEXT NOT NULL,                          -- create|update
  old_json    TEXT,                                  -- full prior row snapshot (NULL for create) — the inverse target
  new_json    TEXT,                                  -- full new row snapshot (display + verification)
  source      TEXT NOT NULL DEFAULT 'ai_confirmed',   -- ai_confirmed|manual
  session_id  TEXT,                                  -- the chat session that produced it (AI writes)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  reverted_at TEXT                                   -- set when an undo restores old_json; NULL = still applied
);
CREATE INDEX IF NOT EXISTS idx_ai_edits_user ON ai_edits(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_edits_action ON ai_edits(user_id, action_id);
CREATE INDEX IF NOT EXISTS idx_ai_edits_batch ON ai_edits(user_id, batch_id);
