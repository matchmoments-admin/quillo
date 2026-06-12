-- 0055_cgt_income_provenance.sql — Slice B (Phase 4): managed-fund (AMMA) capital-gain components reach the
-- CGT engine. A managed_fund_distribution income row's discounted/other-method capital gains are MATERIALISED
-- into cgt_events so they get the 50% discount + loss-offset instead of being taxed as ordinary income. This
-- provenance column is the dedup key (mirrors 0054's property_id): one set of CGT rows per income row, rebuilt
-- idempotently — an income-sourced asset (income_id set) never collides with a property-sourced (property_id)
-- or manually-entered (both NULL) asset. Additive + apply-once. cgt_engine already gates the read.
ALTER TABLE cgt_assets ADD COLUMN income_id TEXT;
CREATE INDEX IF NOT EXISTS idx_cgt_assets_income ON cgt_assets(user_id, income_id);
