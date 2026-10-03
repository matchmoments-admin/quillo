-- 0082 — receipt ↔ bank-line match proposals the user said "Not this one" to (A8, #574).
--
-- WHY. The reconcile proposer (src/lib/reconcile-proposer.ts) suggests a receipt ↔ bank-line pair
-- for one-tap confirmation; it never writes a match itself. When the user rejects a suggestion the
-- same pair must never be suggested again — otherwise the proposer re-offers the wrong line on every
-- visit and trains the user to tap through. Proposals themselves are computed on read (no stored
-- state); only the user's rejections persist.
--
-- Not a money table: a dismissal changes what is SUGGESTED, never what is counted. Confirming a
-- match still goes through the one existing writer of transactions.matched_txn_id.
--
-- Additive and apply-once: CREATE TABLE IF NOT EXISTS. Tenant table → PURGE_TABLES + export.
-- JURISDICTION-NEUTRAL: names no country.

CREATE TABLE IF NOT EXISTS reconcile_dismissals (
  user_id    TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  line_id    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, receipt_id, line_id)
);

-- The proposer reads one FY of bank lines per request (user_id + kind + txn_date); the existing
-- (user_id, kind, status) and (user_id, txn_date) indexes each over-read. Additive, apply-once.
CREATE INDEX IF NOT EXISTS idx_txn_kind_date ON transactions(user_id, kind, txn_date);
