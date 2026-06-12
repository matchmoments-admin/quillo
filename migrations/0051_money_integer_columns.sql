-- 0051: integer money columns for the two REAL spend columns (Slice 1 of the deferred backlog).
-- daily_cost.cents and llm_usage.cost_cents are REAL — they back the AI-spend circuit-breaker and the
-- per-FY billing rollup. Accumulating floats can drift; integers SUM exactly. A single model call costs
-- a FRACTION of a cent (≈0.03–0.25¢, quantised to 4 dp), so plain integer cents would floor most calls
-- to 0. We store an integer at scale ×10,000 (1 unit = 1e-4 cent; 0.25¢ → 2500) — lossless vs the 4-dp
-- quantisation, exact under SUM, divided back to cents ONCE at read.
--
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0051_money_integer_columns.sql
-- Additive + idempotent: ALTER ADD COLUMN (apply-once) + guarded backfills (re-run no-ops). The old
-- REAL columns are kept and dual-written as a live audit mirror until a future cleanup drops them.

ALTER TABLE daily_cost ADD COLUMN cents_e4 INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_usage  ADD COLUMN cost_e4  INTEGER;

-- Backfill existing rows from the REAL columns. Idempotent: once cents_e4/cost_e4 is set the WHERE
-- stops matching (daily_cost guards on the default 0; llm_usage guards on NULL).
UPDATE daily_cost SET cents_e4 = CAST(ROUND(cents * 10000) AS INTEGER)
 WHERE cents_e4 = 0 AND COALESCE(cents, 0) <> 0;

UPDATE llm_usage SET cost_e4 = CAST(ROUND(cost_cents * 10000) AS INTEGER)
 WHERE cost_e4 IS NULL AND cost_cents IS NOT NULL;
