-- 0054_cgt_property_provenance.sql — Slice F (Phase 4): wire a disposed property into the CGT engine.
-- properties.cost_base_cents/disposal_date/disposal_proceeds_cents were orphaned — the portfolio engine
-- (cgtTotals) reads cgt_events JOIN cgt_assets and never touched properties, so a property disposal never
-- reached the indicative position. We now MATERIALISE a cgt_asset (+cgt_event) from a disposed property.
-- This provenance column is the dedup key: one cgt_asset per property, rebuilt idempotently on each save —
-- a property-sourced asset (property_id set) never collides with a manually-entered cgt_asset (NULL).
-- Additive + apply-once (nullable, no backfill — existing cgt_assets unchanged). cgt_engine already gates
-- whether the report reads any of this.
ALTER TABLE cgt_assets ADD COLUMN property_id TEXT;
CREATE INDEX IF NOT EXISTS idx_cgt_assets_property ON cgt_assets(user_id, property_id);
