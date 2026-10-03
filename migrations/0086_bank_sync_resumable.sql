-- 0086 — make a bank-feed sync run resumable and its completeness evidence explicit (#511).
--
-- WHY. `bankSync` used to pull every page of every selected account inside ONE Durable Object
-- request, holding all rows in memory, and wrote the `bank_sync_runs` row only AFTER the work. Two
-- consequences, both found by the #507 review:
--   1. A large backfill blows the Workers 1000-subrequest cap (~45k rows), and
--   2. a request that dies mid-pull leaves NO run row at all — the coverage evidence vanishes in
--      exactly the case where coverage is in doubt.
-- The sync now writes the run row FIRST (status 'running'), flushes each page to D1 as it lands,
-- checkpoints a resume cursor on the row after every page, and continues across invocations (a DO
-- alarm) when it hits its per-invocation page budget. These columns are what that needs.
--
--   updated_at            heartbeat: bumped on every page checkpoint, and on every hop while a run
--                         is queued behind a sibling. The 'running' status is the concurrency guard
--                         (a second tab does not start a second full pagination); a 'running' row
--                         with a stale heartbeat is an interrupted run, closed as 'failed' — never
--                         left looking healthy.
--   finished_at           when the run reached a terminal status (ok | partial | failed).
--   cursor                JSON resume point {accounts:[{p,a}], i, next}: a snapshot of the selected
--                         provider-account → Quillo-account mapping, the index into it, and the
--                         provider's `links.next` URL. NULL once terminal. No transaction data and no
--                         credential — the URL is a query over the aggregator's user id, and is
--                         validated (origin + this consumer's path) before it is ever followed.
--   post_import_at        when this run's lines went through the post-import pipeline (receipt
--                         matching, deductibility, asset linking). NULL + imported > 0 on a terminal
--                         run ⇒ still owed, and the next sync runs it — so a failed hop can never
--                         leave a receipt and its fed line both counting.
--   pages                 provider pages consumed. Previously discarded.
--   duplicates            fetched rows the ledger already held (re-sync / overlapping window).
--   skipped_pending       rows dropped because they were still pending (unstable ids). Previously
--                         discarded.
--   skipped_out_of_window rows outside the requested window — a sign the vendor filter misbehaved.
--   correlation_id        the aggregator's error correlation id, so a failed run can be traced with
--                         the vendor. Previously thrown away with the error.
--
-- `skipped` is now the SUM of the counted reasons rather than `fetched - imported` (a residual that
-- silently absorbed anything unexplained). Status gains 'running'; the column is TEXT with no CHECK,
-- so that is a vocabulary extension recorded in schema.sql.
--
-- The index serves the cross-account dedup in the importer: a feed fingerprint is the provider's
-- transaction id, unique per tenant, so a line already imported under ANY Quillo account is not
-- imported again. Without it, re-pointing a feed account at a different Quillo account re-imported
-- the whole year into the new account and left both copies counting (the unique index includes
-- account_id, so it cannot catch that).
--
-- Additive and apply-once: ALTER TABLE ADD COLUMN + CREATE INDEX IF NOT EXISTS. No backfill — every
-- pre-existing row is already terminal. `bank_sync_runs` is already in PURGE_TABLES.
-- JURISDICTION-NEUTRAL: no currency, FY or date-format assumption.

ALTER TABLE bank_sync_runs ADD COLUMN updated_at TEXT;
ALTER TABLE bank_sync_runs ADD COLUMN finished_at TEXT;
ALTER TABLE bank_sync_runs ADD COLUMN cursor TEXT;
ALTER TABLE bank_sync_runs ADD COLUMN pages INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bank_sync_runs ADD COLUMN duplicates INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bank_sync_runs ADD COLUMN skipped_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bank_sync_runs ADD COLUMN skipped_out_of_window INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bank_sync_runs ADD COLUMN correlation_id TEXT;
ALTER TABLE bank_sync_runs ADD COLUMN post_import_at TEXT;

CREATE INDEX IF NOT EXISTS idx_bank_sync_status ON bank_sync_runs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_txn_user_fingerprint ON transactions(user_id, line_fingerprint);
