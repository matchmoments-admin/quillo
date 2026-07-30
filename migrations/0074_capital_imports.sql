-- 0074 — capital_statement_ingest (C6): CSV import of holdings and disposals.
--
-- WHY A TABLE AT ALL. The whole point of this slice is CONFIRM-BEFORE-WRITE: a broker or exchange export is
-- extracted, shown to the taxpayer, and only written to cgt_assets/cgt_events when they say so. Nothing is
-- ever auto-committed. This mirrors `statements` (bank CSV) exactly — the parsed rows live in R2 as a
-- sidecar and this row carries the status, so confirm never re-extracts and never re-pays for the model
-- call.
--
-- WHY NOT REUSE `statements`. That table is bound to `account_id` (a bank account) and its confirm path
-- writes `transactions` with a `line_fingerprint` dedupe. A holdings export has neither an account nor a
-- monetary line per row. Overloading it would mean a nullable account_id and a kind discriminator on every
-- query that reads it — a worse shape than one small sibling table.
--
-- JURISDICTION-NEUTRAL: no currency, FY or date-format assumption is stored here. Amounts are resolved to
-- the tenant's base currency at confirm time via the jurisdiction descriptor, and the FY of a disposal is
-- derived by fyForDate(event_date, jur) like every other capital write.
--
-- Additive and apply-once: CREATE TABLE/INDEX IF NOT EXISTS only. Added to PURGE_TABLES in
-- src/lib/retention.ts in the same PR (new tenant table ⇒ must be purgeable).

CREATE TABLE IF NOT EXISTS capital_imports (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  filename       TEXT,
  -- sha256 of the uploaded bytes — re-uploading the same export is detected instead of double-importing.
  file_hash      TEXT,
  -- R2 key of the raw upload; `${file_key}.rows` holds the extracted draft rows as JSON.
  file_key       TEXT,
  -- parsed | imported | discarded
  status         TEXT NOT NULL DEFAULT 'parsed',
  -- the LLM-derived column map, kept so a re-confirm is deterministic and so a wrong map is debuggable.
  column_map     TEXT,
  row_count      INTEGER NOT NULL DEFAULT 0,
  -- how many rows the user actually committed (holdings + disposals), set at confirm.
  imported_count INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  imported_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_capital_imports_user ON capital_imports(user_id, status);
CREATE INDEX IF NOT EXISTS idx_capital_imports_hash ON capital_imports(user_id, file_hash);
