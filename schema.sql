-- tax-agent D1 schema. Apply: wrangler d1 execute tax-agent-db --file=schema.sql
-- Multi-tenant from day one: everything keyed by user_id. You = tenant #1.

-- ── Identity / auth (the multi-tenant seam) ───────────────────────────────────
-- A tenant is a real principal. user_id is derived SERVER-SIDE from either a
-- verified ingest key (HMAC) or a verified email mailbox — NEVER from a client
-- header (fixes review blocker B1: x-user-id spoofing).
CREATE TABLE IF NOT EXISTS tenants (
  user_id         TEXT PRIMARY KEY,
  display_name    TEXT,
  email_localpart TEXT UNIQUE,        -- receipts+<localpart>@yourdomain routes here
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-tenant ingest keys. The HMAC secret identifies the tenant: the server looks
-- up the key by key_id, verifies the signature, and derives user_id from THIS row.
-- Adding a tenant later = insert a tenant + a key. No re-architecture.
CREATE TABLE IF NOT EXISTS tenant_keys (
  key_id      TEXT PRIMARY KEY,        -- public id sent as x-key-id
  user_id     TEXT NOT NULL,
  secret      TEXT NOT NULL,           -- shared HMAC secret (high-entropy)
  label       TEXT,                    -- e.g. "android", "ios-shortcut", "web"
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at  TEXT
);

-- ── Per-tenant profile ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  user_id            TEXT PRIMARY KEY,
  jurisdiction       TEXT NOT NULL DEFAULT 'AU',
  rule_pack_ver      TEXT NOT NULL DEFAULT 'au-v1',
  gst_registered     INTEGER NOT NULL DEFAULT 0,
  buckets            TEXT NOT NULL DEFAULT '["payg","company","property"]',  -- JSON
  ledger_provider    TEXT NOT NULL DEFAULT 'qbo',   -- 'qbo' | 'xero' (adapter selector)
  -- Inference seam (finding: easy model switch): 'anthropic' (US) | 'bedrock' (AU residency)
  inference_provider TEXT,                            -- NULL => env default
  inference_region   TEXT,                            -- e.g. 'ap-southeast-2'
  -- APP 8 cross-border consent must be EXPLICIT + dated (fix H7) — a bare default=1
  -- does not satisfy the principle. Recorded only via recordConsent().
  consent_xborder        INTEGER NOT NULL DEFAULT 0,
  consent_xborder_at     TEXT,
  consent_xborder_method TEXT,
  consent_xborder_text   TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Captured transactions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id           TEXT PRIMARY KEY,        -- uuid
  user_id      TEXT NOT NULL,
  source       TEXT NOT NULL,           -- email|upload|shortcut|android|chat
  status       TEXT NOT NULL DEFAULT 'needs_extraction',
  receipt_key  TEXT,                     -- R2 object key
  merchant     TEXT,
  amount_cents INTEGER,
  gst_cents    INTEGER,
  txn_date     TEXT,
  bucket       TEXT,                     -- payg|company|property_rented|property_vacant|unknown
  ato_label    TEXT,                     -- e.g. D5, rental:interest, company:expense
  property_id  TEXT,                     -- which property, if bucket=property_*
  confidence   REAL,
  ledger_ref   TEXT,                     -- ledger-side id once pushed (idempotency)
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── User overrides => training signal for self-improvement ────────────────────
CREATE TABLE IF NOT EXISTS corrections (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  txn_id     TEXT NOT NULL,
  field      TEXT NOT NULL,              -- bucket|ato_label|amount_cents|merchant (allowlisted in code)
  old_value  TEXT,
  new_value  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Full decision trace (inputs -> model output) for auditability + evals ─────
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

-- ── Eval cases distilled from recurring corrections ───────────────────────────
CREATE TABLE IF NOT EXISTS eval_cases (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  input_json      TEXT NOT NULL,
  expected_bucket TEXT NOT NULL,
  expected_label  TEXT NOT NULL,
  rule_pack_ver   TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Append-only, hash-chained audit log (5-year retention) ────────────────────
-- Written ONLY via the TaxAgent DO, which serialises per-tenant, so the per-user
-- chain (prev_hash -> this_hash, ordered by seq) is race-free. Never UPDATE/DELETE.
CREATE TABLE IF NOT EXISTS audit_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  event      TEXT NOT NULL,
  detail     TEXT,
  prev_hash  TEXT,
  this_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Lightweight notifications (web UI / future channel polls these) ───────────
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  body       TEXT NOT NULL,
  txn_id     TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── QuickBooks OAuth connection per tenant (Stage 5) ──────────────────────────
-- Tokens ROTATE on every refresh (fix H5): persisted here, never a static secret.
CREATE TABLE IF NOT EXISTS qbo_connections (
  user_id             TEXT PRIMARY KEY,
  realm_id            TEXT NOT NULL,
  access_token        TEXT,
  access_expires_at   TEXT,
  refresh_token       TEXT NOT NULL,
  refresh_expires_at  TEXT,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_txn_user   ON transactions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_corr_user  ON corrections(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, seq);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at);
