-- 0020_claim_review.sql — segregate the "Find My Claims" situational sweep from per-transaction suggestions.
--
-- The new reviewClaims() sweep upserts situational claim_suggestions (status='suggested') alongside the
-- existing per-transaction rows written by suggestClaims(). A `source` column distinguishes the two so
-- the sweep's upsert stays idempotent (skip if a row with source='review' already exists for the rule)
-- and segregated (it never touches 'ingest' rows). Additive + apply-once: the NOT NULL DEFAULT 'ingest'
-- backfills every existing row to the per-transaction origin, so no separate backfill is needed.
ALTER TABLE claim_suggestions ADD COLUMN source TEXT NOT NULL DEFAULT 'ingest';

-- Per-tenant scope for the AI gap-fill write path (addClaimabilityRules). Until now claimability_rules
-- was a global per-rule-pack override table; the new write path persists per-user confirmed candidate
-- rules, so they MUST be isolated by tenant. NULL = a global pack override (existing rows, unchanged
-- behaviour); a set user_id = a per-tenant rule. Every loader filters (user_id IS NULL OR user_id = ?).
-- Additive + apply-once: existing rows backfill to NULL (global), preserving current behaviour.
ALTER TABLE claimability_rules ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_claimrules_user ON claimability_rules(rule_pack_ver, user_id);
