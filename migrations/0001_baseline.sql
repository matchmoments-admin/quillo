-- 0001_baseline.sql — the schema as it existed BEFORE migration 0002.
--
-- WHY: the base tables (tenants, profiles, transactions, …) historically lived ONLY in schema.sql,
-- so a rebuild from migrations/*.sql alone was broken (0002 ALTERs `transactions`, which never
-- existed). This baseline makes `migrations/*` self-sufficient: applying 0001..NNNN in order on a
-- fresh D1 reproduces the live schema. Enforced by scripts/check-schema-drift.ts.
--
-- This file is the PRE-0002 form on purpose: columns later migrations ADD via `ALTER TABLE` are
-- intentionally absent here (they're re-added, in order, by their own migration — adding them here
-- too would make those ALTERs fail with "duplicate column"). The reference is the migration tag on
-- each column in schema.sql.
--
-- Fully additive + apply-once (`CREATE TABLE/INDEX IF NOT EXISTS`). On the EXISTING remote DB every
-- statement is a no-op (the tables already exist) — applying it there is safe.

-- ── Identity / auth ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  user_id         TEXT PRIMARY KEY,
  display_name    TEXT,
  email_localpart TEXT UNIQUE,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tenant_keys (
  key_id      TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  secret      TEXT NOT NULL,
  label       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at  TEXT
);

-- ── Per-tenant profile (pre-0013/0015/0016/0017 columns) ──────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  user_id            TEXT PRIMARY KEY,
  jurisdiction       TEXT NOT NULL DEFAULT 'AU',
  rule_pack_ver      TEXT NOT NULL DEFAULT 'au-v1',
  gst_registered     INTEGER NOT NULL DEFAULT 0,
  buckets            TEXT NOT NULL DEFAULT '["payg","company","property"]',
  ledger_provider    TEXT NOT NULL DEFAULT 'qbo',
  inference_provider TEXT,
  inference_region   TEXT,
  consent_xborder        INTEGER NOT NULL DEFAULT 0,
  consent_xborder_at     TEXT,
  consent_xborder_method TEXT,
  consent_xborder_text   TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Captured transactions (pre-0002/0007/0008/0011/0012 columns) ──────────────
CREATE TABLE IF NOT EXISTS transactions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  source       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'needs_extraction',
  receipt_key  TEXT,
  merchant     TEXT,
  amount_cents INTEGER,
  currency     TEXT DEFAULT 'AUD',
  amount_aud_cents INTEGER,
  fx_rate      REAL,
  fx_date      TEXT,
  gst_cents    INTEGER,
  txn_date     TEXT,
  bucket       TEXT,
  ato_label    TEXT,
  property_id  TEXT,
  paid_account TEXT,
  confidence   REAL,
  reasoning    TEXT,
  image_hash   TEXT,
  duplicate_of TEXT,
  receipt_keys TEXT,
  ledger_ref   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_txn_imghash ON transactions(user_id, image_hash);
CREATE INDEX IF NOT EXISTS idx_txn_user    ON transactions(user_id, status);

-- ── User overrides ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS corrections (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  txn_id     TEXT NOT NULL,
  field      TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_corr_user ON corrections(user_id);

-- ── Decision traces ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS traces (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  txn_id      TEXT,
  model       TEXT,
  prompt_hash TEXT,
  input_json  TEXT,
  output_json TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Eval cases ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eval_cases (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  input_json      TEXT NOT NULL,
  expected_bucket TEXT NOT NULL,
  expected_label  TEXT NOT NULL,
  rule_pack_ver   TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Append-only hash-chained audit log ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  event      TEXT NOT NULL,
  detail     TEXT,
  prev_hash  TEXT,
  this_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, seq);

-- ── Notifications ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  body       TEXT NOT NULL,
  txn_id     TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at);

-- ── QuickBooks OAuth connection (pre-0014 enc_ver) ────────────────────────────
CREATE TABLE IF NOT EXISTS qbo_connections (
  user_id             TEXT PRIMARY KEY,
  realm_id            TEXT NOT NULL,
  access_token        TEXT,
  access_expires_at   TEXT,
  refresh_token       TEXT NOT NULL,
  refresh_expires_at  TEXT,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Properties (pre-0006 owner/jurisdiction/CGT columns) ──────────────────────
CREATE TABLE IF NOT EXISTS properties (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  label         TEXT NOT NULL,
  address       TEXT,
  status        TEXT NOT NULL DEFAULT 'rented',
  ownership_pct REAL NOT NULL DEFAULT 100,
  acquired_date TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prop_user ON properties(user_id);

-- ── Entities (pre-0006 person_id/jurisdiction columns) ────────────────────────
CREATE TABLE IF NOT EXISTS entities (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  name        TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ent_user ON entities(user_id, active);

-- ── Deterministic per-user categorisation overrides ───────────────────────────
CREATE TABLE IF NOT EXISTS user_rules (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  match_type  TEXT NOT NULL DEFAULT 'merchant_contains',
  pattern     TEXT NOT NULL,
  bucket      TEXT NOT NULL,
  ato_label   TEXT NOT NULL,
  property_id TEXT,
  priority    INTEGER NOT NULL DEFAULT 100,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rule_user ON user_rules(user_id, active, priority);

-- ── Public marketing waitlist (no tenant) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS waitlist (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  source      TEXT,
  ip_hash     TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_waitlist_created ON waitlist(created_at);
