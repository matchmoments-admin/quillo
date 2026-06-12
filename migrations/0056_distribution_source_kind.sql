-- 0056_distribution_source_kind.sql — Slice E (Phase 4): partnership distributions. A partner's share of
-- partnership net income was vanishing from the personal position (the partnership is excluded as a separate
-- taxpayer). Generalise the shipped trust_distributions table into a distributions store with a source_kind
-- discriminator (trust | partnership) — a partner's share retains franking / CGT / foreign character the same
-- way a trust distribution does (ITAA36 Div 5 / Subdiv 207-B), so the existing character + franking_credit
-- columns are reused. Existing rows default to 'trust' ⇒ byte-identical. Additive + apply-once. The trust-only
-- columns (resolution_dated_before_30jun, upe_present) simply stay 0 for partnership rows; trust_entity_id
-- holds the partnership entity id for a partnership row (name retained for migration safety).
ALTER TABLE trust_distributions ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'trust';
