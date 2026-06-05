-- 0017: platform user roles + signup email. Additive + apply-once.
-- `roles` is a JSON array (a user may hold several, e.g. ["accountant","individual"]); default
-- ["individual"]. `email` is captured from the Clerk JWT at first sign-in so the admin signups list
-- can show who joined. Platform roles only (admin/support/accountant/bookkeeper/individual) — the
-- accountant→client delegation is a separate future table. Household roles live on persons.role.
-- Apply: wrangler d1 execute tax-agent-db --remote --file=migrations/0017_user_roles.sql
ALTER TABLE profiles ADD COLUMN roles TEXT NOT NULL DEFAULT '["individual"]';
ALTER TABLE profiles ADD COLUMN email TEXT;

-- Seed the founder tenant as admin (idempotent — only when not already admin).
UPDATE profiles SET roles = '["admin","individual"]' WHERE user_id = 'me' AND roles NOT LIKE '%admin%';
