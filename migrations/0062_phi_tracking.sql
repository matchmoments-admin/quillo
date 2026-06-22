-- 0062: Private Health Extras Tracker — data-model spine (Slice 2).
-- WHY: ~85% of policyholders never exhaust their private-health EXTRAS limits and hit the annual
-- reset with money unclaimed. Quillo already sees the premium debit + the allied-health spend, so it
-- can track per-category limits vs spend-to-date against the reset date ("use it before you lose it").
-- This migration is the SPINE only: tables + the two profiles datums. The write methods, encryption
-- wiring (enc_ver/PHI_FIELD_KEY) and UI land in later slices, gated by phi_extras_tracker / phi_tax_inputs.
-- Additive + apply-once. Extras tracking is engagement/display ONLY — it never feeds report.ts, so the
-- taxable position is byte-identical with the flags off (enforced by the P1 persona golden).
--
-- Sensitive-data note (Privacy Act / APPs): health-service categories are "sensitive information".
-- The enc_ver columns reserve sealing of the health-revealing fields (insurer/cover_type/category) via
-- token-crypto.ts once writers exist; health_extras_consent_at gates any PHI write (APP-3 separate
-- opt-in — this is NEW infra, not the existing free-text /consent gate).

-- ── Shared datum: does the tenant hold private HOSPITAL cover? (the MLS pivot) ──
-- The bank stream can detect that PHI exists but cannot tell hospital from extras-only — must-ask.
-- Mirrors the gst_registered per-tenant tax-status boolean precedent. Read by the extras tracker and
-- (when phi_tax_inputs is on) by the MLS defer-nudge. 0 = unknown/no, 1 = holds hospital cover.
ALTER TABLE profiles ADD COLUMN private_health INTEGER NOT NULL DEFAULT 0;

-- ── APP-3 typed consent for health data (NULL = not granted ⇒ PHI writes blocked) ──
-- There is no typed-consent taxonomy in the codebase (recordConsent stores one free-text blob), so the
-- health-data opt-in needs its own marker. Set by the consent UI (Slice 3); every PHI write checks it.
ALTER TABLE profiles ADD COLUMN health_extras_consent_at TEXT;

-- ── Policy (detected from a premium debit or entered manually) ──────────────────
CREATE TABLE IF NOT EXISTS phi_policy (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  person_id    TEXT,                              -- soft ref persons.id (household; couples on different funds)
  insurer      TEXT,                              -- Bupa/Medibank/HCF/nib/ahm/... (sealed once enc_ver=1)
  cover_type   TEXT,                              -- hospital | extras | combined (must-ask)
  reset_basis  TEXT NOT NULL DEFAULT 'calendar',  -- calendar | financial_year | anniversary
  reset_date   TEXT,                              -- ISO date limits reset (per-insurer default, user-confirmed)
  source       TEXT NOT NULL DEFAULT 'manual',    -- detected | manual
  enc_ver      INTEGER NOT NULL DEFAULT 0,        -- 0=plaintext / 1=sealed (insurer/cover_type)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_phi_policy_user ON phi_policy(user_id);

-- ── Per-category annual extras limit ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS phi_limit (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  policy_id          TEXT NOT NULL,               -- soft ref phi_policy.id
  category           TEXT NOT NULL,               -- extras.* taxonomy (dental/optical/physio/...) — sealed once enc_ver=1
  annual_limit_cents INTEGER NOT NULL DEFAULT 0,  -- INTEGER cents (post-0051; never REAL)
  period             TEXT NOT NULL DEFAULT 'annual',
  enc_ver            INTEGER NOT NULL DEFAULT 0,  -- seals category (health-revealing)
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_phi_limit_user ON phi_limit(user_id, policy_id);

-- ── Benefit recorded against a limit (user-entered; the bank debit is the GAP, not the limit drawn) ──
CREATE TABLE IF NOT EXISTS phi_benefit_usage (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  policy_id         TEXT NOT NULL,                -- soft ref phi_policy.id
  category          TEXT NOT NULL,                -- extras.* taxonomy — sealed once enc_ver=1
  amount_used_cents INTEGER NOT NULL DEFAULT 0,   -- benefit recorded against the limit
  txn_id            TEXT,                          -- optional soft ref transactions.id (the allied-health debit)
  used_on           TEXT,                          -- ISO date
  enc_ver           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_phi_benefit_usage_user ON phi_benefit_usage(user_id, policy_id);

-- ── PHI annual tax statement (rebate/MLS inputs; gated by phi_tax_inputs, held OFF) ──
CREATE TABLE IF NOT EXISTS phi_statement (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL,
  fy                       INTEGER NOT NULL,
  fund                     TEXT,                   -- sealed once enc_ver=1
  policy                   TEXT,
  premiums_eligible_cents  INTEGER NOT NULL DEFAULT 0,
  rebate_received_cents    INTEGER NOT NULL DEFAULT 0,
  days_covered             INTEGER NOT NULL DEFAULT 0,
  tier                     TEXT,                   -- base|tier1|tier2|tier3 (authoritative, from statement)
  enc_ver                  INTEGER NOT NULL DEFAULT 0,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_phi_statement_user ON phi_statement(user_id, fy);
