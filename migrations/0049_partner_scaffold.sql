-- 0049: Partner platform — identity + isolation SCAFFOLD only (Advisory Phase 2, Slice 1).
-- Adds the partner data model + a SECOND isolation axis (partner_id) alongside the app's only existing
-- one (user_id). NO portal UI, NO consumer CTA, NO live partner rows ship in this slice — this is the
-- spine the legal/commercial decisions (docs/advisory-phase2-partners.md §5/§6) sit on top of.
-- All commercial surfaces are gated by the advisory_partners_energy flag (OFF in prod ⇒ byte-identical).
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0049_partner_scaffold.sql
-- Idempotency: CREATE TABLE/INDEX IF NOT EXISTS throughout (no ALTER, no backfill).

-- ── Global reference (NO user_id — org reference data, NOT in PURGE_TABLES) ───────────────────────
-- A partner organisation. Carries its licensing posture so a vertical that needs an AFSL/AR can't be
-- presented as a mere referral by accident.
CREATE TABLE IF NOT EXISTS partners (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  vertical                  TEXT NOT NULL,            -- energy|telco|... (Tier-1 verticals only for now)
  afsl_or_acl               TEXT,                     -- licence number, if the vertical needs one (energy doesn't)
  is_authorised_representative INTEGER DEFAULT 0,     -- 1 if Quillo acts as the partner's AR (Tier 2/Phase 3)
  commission_model          TEXT,                     -- cpa|cpl|none (display/audit; not used for any math here)
  disclosure_text           TEXT,                     -- the exact commercial-relationship disclosure shown pre-CTA
  status                    TEXT DEFAULT 'draft',     -- draft|active|paused|retired
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A specific offer / affiliate deep-link from a partner, scoped to a vertical (+ optional postcode set).
CREATE TABLE IF NOT EXISTS partner_offers (
  id                        TEXT PRIMARY KEY,
  partner_id                TEXT NOT NULL,
  vertical                  TEXT NOT NULL,
  title                     TEXT,
  description               TEXT,
  target_url                TEXT NOT NULL,            -- affiliate deep-link base (the referral_token is appended)
  postcode_scope            TEXT,                     -- NULL = nationwide; else a CSV/JSON of eligible postcodes
  cpl_cents                 INTEGER,
  cpa_cents                 INTEGER,
  active                    INTEGER DEFAULT 0,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_partner_offers_partner ON partner_offers(partner_id);
CREATE INDEX IF NOT EXISTS idx_partner_offers_vertical ON partner_offers(vertical, active);

-- ── Per-tenant (carry user_id → ADD to PURGE_TABLES + export/retention) ───────────────────────────
-- Links a Clerk-mapped staff tenant (user_id) to a partner org. This is the ONLY bridge from a logged-in
-- partner staff member to their partner_id; the portal resolves partner_id here, then scopes every read.
CREATE TABLE IF NOT EXISTS partner_members (
  id                        TEXT PRIMARY KEY,
  partner_id                TEXT NOT NULL,
  user_id                   TEXT NOT NULL,            -- the staff member's own tenant (ensureTenant)
  role                      TEXT NOT NULL DEFAULT 'partner_agent', -- partner_admin|partner_agent (ORG role, not a platform ROLE)
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id)                                    -- one staff tenant belongs to exactly one partner org
);
CREATE INDEX IF NOT EXISTS idx_partner_members_partner ON partner_members(partner_id);

-- A consumer→partner referral. user_id is the CONSUMER (the end user being referred), never the partner
-- staff. The portal reads these by partner_id; the consumer app reads by user_id — the two never cross.
CREATE TABLE IF NOT EXISTS referrals (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL,            -- the consumer
  opportunity_id            TEXT,                     -- the advisory opportunity that spawned it
  partner_id                TEXT NOT NULL,
  partner_offer_id          TEXT,
  referral_token            TEXT NOT NULL,            -- unique postback key appended to target_url
  status                    TEXT NOT NULL DEFAULT 'created', -- created|presented|clicked|converted|paid|dismissed|expired|clawed_back
  consent_id                TEXT,                     -- NULL for Tier 1 (no PII egress); set for Tier 2 (Phase 3)
  revenue_cents             INTEGER DEFAULT 0,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, opportunity_id),                   -- idempotent: one referral per opportunity (re-click = no-op)
  UNIQUE (referral_token)
);
CREATE INDEX IF NOT EXISTS idx_referrals_user ON referrals(user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_partner ON referrals(partner_id, status);

-- Tier-2 (Phase 3) data-sharing consent. Table created now (so the model is complete) but UNUSED in
-- Phase 2 — Tier-1 energy keeps PII in Quillo, so no referral_consents row is written this slice.
CREATE TABLE IF NOT EXISTS referral_consents (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL,            -- the consumer granting consent
  partner_id                TEXT NOT NULL,
  scope                     TEXT,                     -- which fields/purpose (fresh, specific, unbundled)
  disclosure_shown          TEXT,                     -- the exact disclosure copy displayed at consent time
  consented_at              TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at                TEXT
);
CREATE INDEX IF NOT EXISTS idx_referral_consents_user ON referral_consents(user_id);
