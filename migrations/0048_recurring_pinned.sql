-- 0048: user-confirmed recurring bills (advisory extras). `pinned`=1 means the user pressed "Confirm"
-- on a detected stream — a sticky signal the detector must never downgrade (keeps it out of 'early'
-- limbo and respects the user's correction, mirroring the dismiss-is-sticky contract). Additive.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0048_recurring_pinned.sql
-- Idempotency: one-time ALTER ADD COLUMN (apply-once, like the rest of the sequence).
ALTER TABLE recurring_bills ADD COLUMN pinned INTEGER DEFAULT 0;
