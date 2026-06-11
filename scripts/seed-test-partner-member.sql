-- Link the founder tenant ('me') to the TEST Econnex partner org so the /partner portal is viewable.
-- TEST fixture, not a migration. Additive: grants the 'partner' role (keeping existing roles) and adds
-- a partner_members row. Idempotent (INSERT OR IGNORE + a roles UPDATE that's safe to re-run).
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=scripts/seed-test-partner-member.sql
-- Remove: DELETE FROM partner_members WHERE user_id='me'; then reset roles to ["admin","individual"].

-- Grant the partner role alongside the existing ones (founder 'me' currently ["admin","individual"]).
UPDATE profiles SET roles = '["admin","individual","partner"]' WHERE user_id = 'me';

-- Make 'me' a partner_admin of the seeded test-econnex org (see scripts/seed-test-partner.sql).
INSERT OR IGNORE INTO partner_members (id, partner_id, user_id, role)
VALUES ('test-member-me', 'test-econnex', 'me', 'partner_admin');
