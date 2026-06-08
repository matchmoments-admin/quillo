-- 0042: SMSF members + super contributions (#140, EPIC #134). An SMSF is a SEPARATE taxpayer. In
-- retirement phase, fund earnings supporting a pension are exempt (ECPI). Account-based pension payments
-- are tax-free from age 60 (so they don't touch the member's personal position). Contributions feed the
-- concessional cap / Division 293 view (#124). Transfer balance cap + minimum drawdown + actuarial
-- certificate are specialist → defer-to-agent. INDICATIVE; flag-gated smsf_engine.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0042_smsf.sql
-- Idempotency: tables IF NOT EXISTS; no backfill. Zero rows ⇒ report byte-identical.
CREATE TABLE IF NOT EXISTS smsf_members (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL,
  smsf_entity_id         TEXT NOT NULL,                -- entities.id (entity_type='smsf')
  person_id              TEXT,
  phase                  TEXT NOT NULL DEFAULT 'accumulation', -- accumulation|pension
  pension_balance_cents  INTEGER NOT NULL DEFAULT 0,   -- retirement-phase balance (supports ECPI)
  accumulation_balance_cents INTEGER NOT NULL DEFAULT 0,
  transfer_balance_cents INTEGER NOT NULL DEFAULT 0,   -- against the transfer balance cap (defer-to-agent)
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_smsf_members_user ON smsf_members(user_id, smsf_entity_id);

CREATE TABLE IF NOT EXISTS super_contributions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  person_id     TEXT,
  fy            TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'concessional', -- concessional|non_concessional
  amount_cents  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_super_contrib_user ON super_contributions(user_id, fy);
