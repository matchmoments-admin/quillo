-- 0003: statement reconciliation (balance self-check). Additive, instant on D1.
-- Apply: wrangler d1 execute tax-agent-db --remote --file=migrations/0003_statement_verify.sql
ALTER TABLE statements ADD COLUMN opening_cents INTEGER;
ALTER TABLE statements ADD COLUMN closing_cents INTEGER;
ALTER TABLE statements ADD COLUMN reconciled INTEGER;        -- 1 ok, 0 mismatch, NULL = no balances
ALTER TABLE statements ADD COLUMN recon_diff_cents INTEGER;  -- expected - closing
