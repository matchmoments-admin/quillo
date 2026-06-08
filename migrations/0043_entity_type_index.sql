-- 0043: index entities(user_id, entity_type) — H1/H2 follow-up to EPIC #134.
-- WHY: the new readers (separateTaxpayerEntityIds, companyPositions, smsfEntityIds, smsfFundPositions,
--      gstTotals) filter entities by entity_type, but the only index was (user_id, active). This adds
--      the covering index so those per-report lookups don't scan the tenant's entities. Additive.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0043_entity_type_index.sql
-- Idempotency: CREATE INDEX IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_ent_user_type ON entities(user_id, entity_type);
