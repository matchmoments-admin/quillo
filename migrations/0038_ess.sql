-- 0038: Employee Share Scheme grants (#141, EPIC #134). ESS discounts for RSUs/options.
-- WHY: knowledge workers (P2) and startup staff/founders (P9) receive ESS interests. Treatment is
--      error-prone: taxed-upfront (discount assessable at grant) vs deferral (assessable at a deferred
--      taxing point) vs the startup concession (NOT taxed as income — CGT applies on disposal instead,
--      cost base = market value at acquisition). This captures the grant facts; the upfront/deferral
--      discount becomes assessable income in the taxing-point FY, the startup path hands off to the CGT
--      engine (#138). INDICATIVE ONLY — eligibility (≤10% ownership, unlisted, <10yr, turnover) is
--      defer-to-agent.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0038_ess.sql
-- Idempotency: table IF NOT EXISTS; no backfill. Gated behind ess_engine (OFF) — zero rows ⇒ no change.
CREATE TABLE IF NOT EXISTS ess_grants (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  person_id           TEXT,
  employer_entity_id  TEXT,                         -- entities.id of the employer
  scheme_type         TEXT NOT NULL,                -- taxed_upfront|deferral|startup
  grant_date          TEXT,
  taxing_point_date   TEXT,                         -- when the discount is assessable (upfront=grant; deferral=deferred point)
  shares_or_options   TEXT,                         -- 'shares'|'options' (display)
  units               REAL,
  discount_cents      INTEGER NOT NULL DEFAULT 0,   -- the ESS discount (assessable for upfront/deferral)
  market_value_cents  INTEGER,                      -- MV at acquisition — the startup-path CGT cost base
  ownership_gt_10pct  INTEGER NOT NULL DEFAULT 0,   -- founders >10% are usually ineligible for the startup concession
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ess_grants_user ON ess_grants(user_id, scheme_type);
CREATE INDEX IF NOT EXISTS idx_ess_grants_person ON ess_grants(user_id, person_id);
