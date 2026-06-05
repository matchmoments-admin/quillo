-- 0021_payg_deductibility_backfill.sql — stamp deny-by-default deductibility on existing private payg spend.
--
-- The indicative taxable position was subtracting the ENTIRE 'payg' bucket as deductions, including
-- private/domestic spend (groceries, personal living, loan repayments, entertainment) which is NOT
-- deductible (s8-1(2)(b) ITAA 1997). Going forward the rules-first matcher (src/lib/deductibility.ts)
-- stamps a verdict at ingest; this one-off backfill self-heals data already captured before that shipped.
--
-- Additive + apply-once + idempotent:
--  - No DDL — the `deductibility` / `deductible_amount_cents` columns already exist (0011).
--  - GUARDED to deductibility='undetermined' (or NULL) so it NEVER clobbers a user's year-end
--    confirmed_* decision, and re-running it is a no-op (matched rows are no longer 'undetermined').
--  - Only the clearly-private payg deny-list is stamped. Work-related payg (union fees, WFH, etc.) is
--    deliberately LEFT 'undetermined' — deny-by-default already excludes it from the position until the
--    user confirms it, so we never wrongly stamp a deductible row as not-deductible here.
--  - The LIKE patterns MIRROR the rule pack's payg_deductibility.deny list (src/rulepacks/au-v1.json);
--    the pack is the source of truth for new data, this SQL re-states the same private categories.
--  - DELIBERATELY no property_vacant clause: a residential dwelling that is vacant *between tenants* but
--    genuinely available for rent keeps full deductibility (s8-1) — s26-102 only denies vacant LAND with
--    no structure. The "genuinely available for rent" judgement stays a defer-to-agent finding, not an
--    auto-deny, so property_vacant spend continues to count.
--
-- deductible_amount_cents is set to 0 on a denied row (explicitly $0 claimable), matching the matcher.

UPDATE transactions
   SET deductibility = 'likely_not', deductible_amount_cents = 0
 WHERE bucket = 'payg'
   AND (deductibility IS NULL OR deductibility = 'undetermined')
   AND (
        LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%grocer%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%supermarket%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%coles%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%woolworth%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%woolies%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%aldi%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%iga%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%personal%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%living%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%lifestyle%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%loan-repayment%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%loan repayment%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%credit-card-fee%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%credit card%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%bank fee%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%interest charge%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%meals-entertainment%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%entertainment%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%health-fitness%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%fitness%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%gym%'
     OR LOWER(COALESCE(ato_label,'') || ' ' || COALESCE(merchant,'')) LIKE '%clothing%'
   );
