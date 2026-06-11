-- Seed a TEST energy partner + offer for Advisory Phase 2 Slice 2 testing.
-- This is NOT a migration (not auto-applied, not apply-once tracked) — it's a one-off test fixture.
-- No real affiliate account: target_url points at Econnex's PUBLIC compare page, so a click is harmless
-- (no affiliate token is honoured by anyone yet). Idempotent via fixed ids + INSERT OR IGNORE.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=scripts/seed-test-partner.sql
-- Remove: DELETE FROM partner_offers WHERE id='test-econnex-energy'; DELETE FROM partners WHERE id='test-econnex';

INSERT OR IGNORE INTO partners (id, name, vertical, commission_model, disclosure_text, status)
VALUES (
  'test-econnex',
  'Econnex (TEST)',
  'energy',
  'cpa',
  'Econnex pays Quillo a fee if you switch. This is a referral, not advice — compare the government option (Energy Made Easy) first, and you choose and start anything yourself.',
  'active'
);

INSERT OR IGNORE INTO partner_offers (id, partner_id, vertical, title, description, target_url, active)
VALUES (
  'test-econnex-energy',
  'test-econnex',
  'energy',
  'Get a quote from Econnex',
  'TEST offer — compare energy plans on Econnex.',
  'https://www.econnex.com.au/energy',
  1
);
