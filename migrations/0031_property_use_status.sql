-- 0031: property use_status — deductibility is gated by USE, not just rented/vacant.
-- WHY: Case 2's father-occupied house is held rent-free => no assessable income => NO deductions
--      (s8-1; "slowly renovating" is not a deductibility trigger), but it STILL accrues a CGT cost
--      base. properties.status only knows rented|vacant|owner_occupied|sold, which can't express
--      "private use, rent-free" or "renovating, not available". This column adds that granularity.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0031_property_use_status.sql
-- Idempotency: ADD COLUMN apply-once; backfill is a guarded UPDATE (fills only NULL use_status).
-- NOTE: the backfill deliberately maps the existing four values to their EXISTING-behaviour
--       equivalents (vacant -> vacant_land is captured but NOT yet a deduction-denial trigger this
--       phase — only the genuinely-new statuses private_use_rent_free / under_renovation_not_available
--       deny, and no existing row carries those, so the report stays byte-identical). 'sold' is left
--       to be read via disposal_date.
ALTER TABLE properties ADD COLUMN use_status TEXT;  -- rented|genuinely_available_for_rent|
                                                    -- private_use_rent_free|under_renovation_not_available|
                                                    -- vacant_land|owner_occupied
UPDATE properties SET use_status = CASE status
  WHEN 'rented'         THEN 'rented'
  WHEN 'vacant'         THEN 'vacant_land'
  WHEN 'owner_occupied' THEN 'owner_occupied'
  ELSE use_status
END
WHERE use_status IS NULL AND status IN ('rented','vacant','owner_occupied');
