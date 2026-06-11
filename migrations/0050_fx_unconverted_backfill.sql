-- 0050: FX un-conversion backfill (H2). Before this fix, a foreign-currency amount whose rate lookup
-- FAILED was stored with amount_aud_cents = the raw foreign cents and fx_rate = NULL, then summed 1:1
-- as AUD into the tax position. The code now stores amount_aud_cents = NULL + flags the row for review,
-- and the sum paths exclude `currency<>'AUD' AND amount_aud_cents IS NULL`. This backfills the existing
-- bad rows to that same honest state so historical positions stop counting un-converted foreign money.
--
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0050_fx_unconverted_backfill.sql
-- Additive + idempotent: NULL-ing amount_aud_cents makes the WHERE stop matching on a re-run (no-op).
-- A row is "bad" iff it's foreign (currency<>'AUD') AND was never converted (fx_rate IS NULL) AND still
-- carries a non-NULL amount_aud_cents (the fabricated foreign value). Genuine conversions have fx_rate
-- set and are untouched; AUD rows (currency='AUD' or NULL) are untouched.

-- Transactions: drop the fabricated AUD value and flag for review (skip terminal/excluded rows).
UPDATE transactions
   SET amount_aud_cents = NULL,
       status = CASE WHEN status IN ('ignored','duplicate') THEN status ELSE 'needs_review' END
 WHERE COALESCE(currency,'AUD') <> 'AUD'
   AND fx_rate IS NULL
   AND amount_aud_cents IS NOT NULL;

-- Income: drop the fabricated AUD columns (net was rate-1 placeholder) and flag needs_review.
UPDATE income
   SET amount_aud_cents = NULL,
       net_cents = NULL,
       needs_review = 1
 WHERE COALESCE(currency,'AUD') <> 'AUD'
   AND fx_rate IS NULL
   AND amount_aud_cents IS NOT NULL;
