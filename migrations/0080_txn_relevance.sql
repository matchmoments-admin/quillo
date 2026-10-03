-- 0080 — relevance scan on bank lines (first-timer spec A4, ticket #578, flag `relevance_scan`).
--
-- WHY. Occupation claim rules only ever ran on photographed receipts, so a first-timer who connects a bank
-- (or uploads a statement) and never photographs anything got zero job-specific prompts: a nurse's AHPRA
-- renewal sat in the deny-by-default pile with the groceries (docs/first-timer/relevance-scan.md D3). The
-- scan sorts each debit bank line into one of three lists — relevant / worth_a_look / irrelevant — from the
-- person's situation profile + the rule pack. `worth_a_look` is the owner's ruling on #555: an occupation
-- match lifts a line out of the not-deductible default as a card the USER confirms. It NEVER changes
-- `deductibility`, so the position is untouched until the user confirms (no auto-claim, ever).
--
-- `relevance` / `relevance_rule_id` describe what to SHOW, never what is COUNTED: no report/position query
-- reads them. NULL = not scanned (flag OFF, a credit, a non-payg expense bucket, or an undated line).
--
-- The partial UNIQUE index keys the scan's claim_suggestions rows (source = 'relevance_scan') on
-- (user_id, txn_id, rule_id) so the scan's INSERT OR IGNORE is idempotent and a dismissed card stays
-- dismissed. It is PARTIAL on purpose: legacy 'ingest' / 'review' rows were never unique on that key, and a
-- full unique index could fail to build on existing data.
--
-- Additive and apply-once: ALTER TABLE ADD COLUMN + CREATE INDEX IF NOT EXISTS. No new table (so nothing
-- for PURGE_TABLES; both columns ride along with `transactions` in the purge and the export).
-- JURISDICTION-NEUTRAL: names no country; tokens and lists come from the rule pack.

ALTER TABLE transactions ADD COLUMN relevance TEXT;          -- NULL (not scanned) | relevant | worth_a_look | irrelevant
ALTER TABLE transactions ADD COLUMN relevance_rule_id TEXT;  -- the claimability rule (ruleKey) that made it relevant / worth a look
CREATE INDEX IF NOT EXISTS idx_txn_relevance ON transactions(user_id, relevance);
CREATE UNIQUE INDEX IF NOT EXISTS idx_claimsug_relevance_unique
  ON claim_suggestions(user_id, txn_id, rule_id) WHERE source = 'relevance_scan';
