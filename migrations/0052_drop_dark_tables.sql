-- 0052: drop two dark tables (Slice 3 of the deferred backlog). DESTRUCTIVE — applied deliberately.
--   • blackhole_costs    — 0035 capture-only satellite; 0 reads / 0 writes anywhere in the app
--                          (only an inert test seed). Verified 0 rows in prod before dropping.
--   • shareholder_loans  — written by the former syncShareholderLoans but NEVER read: the report
--                          recomputes the balance on-demand from transaction_attributions
--                          (creates_shareholder_loan = 1). Verified 0 rows in prod before dropping.
-- Reverse plan: migration 0035 still contains both CREATE TABLEs (re-appliable), and the shareholder
-- balance is fully recomputable from transaction_attributions — so no irrecoverable loss.
--
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0052_drop_dark_tables.sql
-- DROP is idempotent via IF EXISTS; indexes drop with their table.

DROP TABLE IF EXISTS blackhole_costs;
DROP TABLE IF EXISTS shareholder_loans;
