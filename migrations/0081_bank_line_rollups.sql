-- 0081 — bank-data minimisation: per-account rollups + re-import tombstones (first-timer spec A5, ticket #581,
-- flag `bank_minimisation`, a genuine kill-switch that lands OFF).
--
-- WHY. Owner ruling #534: hold the least bank data that still gives the user everything their return needs.
-- Every credit and every relevant / worth-a-look / unsorted / linked debit is kept as a full row. An
-- IRRELEVANT debit (private payg spend, own-account transfers, card repayments, none of them linked to
-- anything) is kept only until its FY is lodged (fy_signoff.lodged_at / a NOA close, or the retention backstop
-- of the self-lodger due date + 60 days when never marked — src/lib/lodging-year.ts) AND it has been held 60
-- days, whichever is later. Then src/lib/minimise.ts deletes the row and folds it into:
--   * bank_line_rollups — one aggregate per (account, statement, FY, direction): count + total cents + date
--     range, so statement reconciliation and the Accounts listing still tie out. statement_id is NULL for
--     cdr_feed lines. SQLite treats NULLs as distinct in the UNIQUE, so the writer upserts by explicit
--     `statement_id IS ?` lookup, never ON CONFLICT.
--   * bank_line_tombstones — the shrunk line's fingerprint (a sha256, no description text), so a re-upload of
--     the same statement or a feed re-sync can never resurrect the deleted line. A feed fingerprint is unique
--     per TENANT (the provider transaction id), so the feed path checks (user_id, line_fingerprint) — hence the
--     extra index.
--
-- Nothing writes either table while the flag is OFF. Additive and apply-once (CREATE TABLE / INDEX IF NOT
-- EXISTS, no backfill). Both are tenant tables → PURGE_TABLES (and so the APP-12 export).
-- JURISDICTION-NEUTRAL: names no country; `fy` is the FY label ('2025-26') of the tenant's tax period.

CREATE TABLE IF NOT EXISTS bank_line_rollups (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  statement_id TEXT,                       -- NULL for cdr_feed lines
  fy           TEXT NOT NULL,              -- '2025-26'
  direction    TEXT NOT NULL DEFAULT 'debit',
  n            INTEGER NOT NULL DEFAULT 0,
  total_cents  INTEGER NOT NULL DEFAULT 0, -- sum of amount_aud_cents of the shrunk lines
  first_date   TEXT,
  last_date    TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, account_id, statement_id, fy, direction)
);
CREATE INDEX IF NOT EXISTS idx_bank_rollup_stmt ON bank_line_rollups(user_id, statement_id);

CREATE TABLE IF NOT EXISTS bank_line_tombstones (
  user_id          TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  line_fingerprint TEXT NOT NULL,          -- sha256, no description text
  fy               TEXT NOT NULL,
  PRIMARY KEY (user_id, account_id, line_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_bank_tomb_fp ON bank_line_tombstones(user_id, line_fingerprint);
