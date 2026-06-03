-- 0011_deductibility.sql
-- Separate "categorised" from "deductible". During the year the per-transaction model captures
-- and buckets but does NOT judge deductibility — that's decided once at year-end review with full
-- context (apportionment, thresholds, substantiation, method elections). So every transaction
-- carries a deductibility status that DEFAULTS to 'undetermined' and is only resolved in review.
-- Apply: wrangler d1 execute tax-agent-db --remote --file=migrations/0011_deductibility.sql
--
-- Additive + apply-once: ADD COLUMN with a default. Existing rows inherit 'undetermined', so the
-- resolved-deductible total is correctly ~$0 until a review runs — that is the intended behaviour,
-- not a bug. Values: undetermined | likely_deductible | likely_not | needs_apportionment |
-- confirmed_deductible | confirmed_not (resolved set, written only by the review flow).
ALTER TABLE transactions ADD COLUMN deductibility TEXT DEFAULT 'undetermined';

-- Apportioned claimable amount in cents, resolved at review for mixed-use items (phone, car,
-- home office). NULL until resolved; when set it is the amount that actually flows to a return.
ALTER TABLE transactions ADD COLUMN deductible_amount_cents INTEGER;
