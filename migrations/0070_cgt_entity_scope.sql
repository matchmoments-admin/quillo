-- 0070_cgt_entity_scope.sql — capital tranche C-E: attribute a CGT holding to a SEPARATE TAXPAYER.
-- BUG THIS FIXES: cgtTotals (src/lib/ledger-totals.ts) selects cgt_events JOIN cgt_assets filtered on
-- user_id + fy ONLY. There is no entity dimension on cgt_assets at all, so a company/trust/SMSF holding
-- is inexpressible — and the workaround has been to REFUSE to materialise it: addIncome's `safeToSplit`
-- requires `!inc.entity_id` precisely because "cgtTotals isn't entity-scoped, so an entity's CG would
-- leak into the personal headline" (src/agent.ts). That trades a leak for a SILENT UNDER-COUNT: an
-- entity's AMMA capital gain is captured as components and then dropped from every position.
--
-- The fix mirrors the established invariant rather than inventing one: `entity_id IS NULL` = personal,
-- exactly as trading_stock/tradingStockAdjustment (0068) and incomeTotals' excludeEntityIds already do.
-- A company/trust/SMSF lodges its own return, so its gain must not reach the individual headline.
--
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0070_cgt_entity_scope.sql
-- Idempotency: additive + apply-once. Nullable column, NO backfill — every existing row stays NULL,
-- i.e. personal, i.e. exactly where it is counted today. The capital_entity_scope flag gates whether
-- any reader applies the predicate, so flag OFF ⇒ report/CSV byte-identical even after this lands.
ALTER TABLE cgt_assets ADD COLUMN entity_id TEXT;
CREATE INDEX IF NOT EXISTS idx_cgt_assets_entity ON cgt_assets(user_id, entity_id);
