-- 0030: reimbursement / ownership flags so the asset auto-linker can't over-claim.
-- WHY: linkAssetsForUser (src/agent.ts) turns ANY capital debit into a 100%-business depreciating
--      asset. But employer-OWNED gear earns the employee no decline-in-value (Div 40 needs the
--      taxpayer to own it), and REIMBURSED spend isn't deductible at all (no loss/outgoing borne).
--      Case 1's laptop & phone are employer-owned; a reimbursed purchase can still hit her card.
--      These flags let the linker skip such lines, the report exclude reimbursed spend, and the
--      depreciation total drop employer-owned assets.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0030_asset_reimbursement_flags.sql
-- Idempotency: ALTER ADD COLUMN is metadata-only / apply-once; defaults make every legacy row
--              byte-identical (owned_by='self', reimbursed=0 => current behaviour unchanged).
ALTER TABLE assets       ADD COLUMN owned_by   TEXT    NOT NULL DEFAULT 'self';   -- self|employer
ALTER TABLE assets       ADD COLUMN reimbursed INTEGER NOT NULL DEFAULT 0;        -- 1 => not depreciable
ALTER TABLE transactions ADD COLUMN reimbursed INTEGER NOT NULL DEFAULT 0;        -- 1 => not deductible
