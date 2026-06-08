-- 0034: transaction_attributions — split WHO PAID from WHO DEDUCTS (Phase B / G2).
-- WHY: the single most important change for Case 2 and the clearest divergence from Xero/MYOB/QBO
--      (which all assume the payer is the claimant). He pays 100% of a co-owned property's bills but
--      may only claim his legal-interest share (TR 93/32 — the rest is "no more than a loan"); and he
--      pays the startup's Cloudflare/Vercel/Claude bills personally, but the COMPANY gets the
--      deduction via a shareholder loan. One payment can fan out to many entities/activities by
--      ownership %. The report sums ATTRIBUTIONS for the position when present, else falls back to the
--      raw-transaction path (legacy, byte-identical). shareholder_loan_id FKs a table that lands in
--      Phase C; NULL until then.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0034_transaction_attributions.sql
-- Idempotency: ADD COLUMN apply-once; table IF NOT EXISTS. NO backfill — zero attribution rows means
--              every legacy report is unchanged. Gated behind the attribution_engine flag (OFF).
ALTER TABLE transactions ADD COLUMN payer_person_id     TEXT;  -- persons.id who actually paid
ALTER TABLE transactions ADD COLUMN paid_via_account_id TEXT;  -- accounts.id the cash left from

CREATE TABLE IF NOT EXISTS transaction_attributions (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL,
  transaction_id           TEXT NOT NULL,           -- transactions.id
  entity_id                TEXT NOT NULL,           -- the taxpayer claiming it (individual / partnership / company)
  income_activity_id       TEXT,                    -- income_activities.id
  attributed_pct           REAL,                    -- XOR with amount; the ownership/work split
  attributed_amount_cents  INTEGER,
  work_use_pct             REAL,                    -- mixed-use apportionment
  deduction_provision      TEXT,                    -- s8-1_general|div40|div43|s40-880|wfh_fixed_rate|private_non_deductible
  creates_shareholder_loan INTEGER NOT NULL DEFAULT 0,
  shareholder_loan_id      TEXT,                    -- FK shareholder_loans.id (Phase C); NULL until then
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_txn_attr_txn    ON transaction_attributions(user_id, transaction_id);
CREATE INDEX IF NOT EXISTS idx_txn_attr_entity ON transaction_attributions(user_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_txn_attr_act    ON transaction_attributions(user_id, income_activity_id);
