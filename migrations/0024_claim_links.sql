-- 0024_claim_links.sql
-- Phase 3 (Find & attach claim). A claim_suggestion is a possible deduction the situational sweep
-- surfaced; this join table records which TRANSACTIONS the user attaches as evidence for it. A claim
-- with ≥1 link moves to status 'capturing' (free TEXT on claim_suggestions.status — no DDL needed).
-- Many-to-many on purpose (one txn can evidence several claims; a claim spans several txns) — a
-- claim_id column on transactions would force a destructive rewrite later.
-- Apply: wrangler d1 execute tax-agent-db --remote --file=migrations/0024_claim_links.sql
--
-- Additive + apply-once: CREATE TABLE/INDEX IF NOT EXISTS. The UNIQUE makes attach idempotent
-- (INSERT OR IGNORE), so re-attaching the same evidence is a no-op.
CREATE TABLE IF NOT EXISTS claim_links (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  claim_id   TEXT NOT NULL,            -- claim_suggestions.id
  txn_id     TEXT NOT NULL,            -- transactions.id (the attached evidence)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, claim_id, txn_id)
);

CREATE INDEX IF NOT EXISTS idx_claim_links_claim ON claim_links(user_id, claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_links_txn   ON claim_links(user_id, txn_id);
