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
  amount_cents INTEGER,                  -- amount in the ORIGINAL currency
  currency     TEXT DEFAULT 'AUD',       -- ISO-4217 of amount_cents
  amount_aud_cents INTEGER,              -- converted to AUD for reporting (= amount_cents when AUD)
  fx_rate      REAL,                     -- rate used (1 foreign unit -> AUD); null for AUD
  fx_date      TEXT,                     -- date the rate applies to
  gst_cents    INTEGER,                  -- AU GST component; null for overseas/foreign supplies
  txn_date     TEXT,
  bucket       TEXT,                     -- payg|company|property_rented|property_vacant|unknown
  ato_label    TEXT,                     -- e.g. D5, rental:interest, company:expense
  property_id  TEXT,                     -- which property, if bucket=property_*
  paid_account TEXT,                     -- 'visa-1234'|'amex'|'cash' — reconcile-vs-push (Phase 3)
  confidence   REAL,
  reasoning    TEXT,                     -- one-line "why this bucket/label" (teaching moment)
  -- Multi-source model: a row is either a 'receipt' (evidence) or a 'bank_line' (money).
  kind         TEXT NOT NULL DEFAULT 'receipt',  -- 'receipt' | 'bank_line'
  account_id   TEXT,                     -- accounts.id (bank_line, or a reconciled receipt)
  statement_id TEXT,                     -- statements.id (bank_line imported via a statement)
  line_fingerprint TEXT,                 -- sha256(account|date|amount|norm desc) — re-upload dedup
  matched_txn_id TEXT,                   -- on a receipt: the bank_line it is evidence for
  raw_description TEXT,                   -- original statement line text
  direction    TEXT DEFAULT 'debit',     -- 'debit' (spend) | 'credit' (income/refund — not counted)
  image_hash   TEXT,                     -- sha-256 of receipt bytes (exact-duplicate detection)
  duplicate_of TEXT,                     -- txn id this duplicates, if flagged
  receipt_keys TEXT,                     -- JSON array of all R2 keys (multi-screenshot receipts)
  ledger_ref   TEXT,                     -- ledger-side id once pushed (idempotency)
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_txn_imghash ON transactions(user_id, image_hash);
-- Statement re-upload de-dup: a bank line is unique per (account, fingerprint). NOT partial
-- so it's a valid ON CONFLICT target; receipts have NULL fingerprint and NULLs are distinct
-- in SQLite UNIQUE indexes, so they never collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_fingerprint
  ON transactions(user_id, account_id, line_fingerprint);
CREATE INDEX IF NOT EXISTS idx_txn_kind     ON transactions(user_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_txn_matched  ON transactions(user_id, matched_txn_id);
CREATE INDEX IF NOT EXISTS idx_txn_acct_date ON transactions(user_id, account_id, txn_date);

-- ── Bank / card / investment accounts (per tenant) ────────────────────────────
-- Each account has ONE canonical money source: a QBO feed OR statement upload — never both
-- counted. This is the structural guard against feed-vs-statement double counting.
CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  institution    TEXT,                              -- 'CommBank' | 'Westpac' | 'Amex' ...
  name           TEXT NOT NULL,                     -- user label, e.g. "Westpac Everyday"
  last4          TEXT,
  type           TEXT NOT NULL DEFAULT 'transaction', -- transaction|credit_card|loan|investment
  source         TEXT NOT NULL DEFAULT 'statement',   -- qbo_feed|statement|manual
  qbo_account_id TEXT,                               -- QBO AccountRef when source='qbo_feed'
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_acct_user ON accounts(user_id, active);

-- ── Statement import batches (CSV/PDF) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS statements (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  filename       TEXT,
  file_key       TEXT,                  -- R2 key of the raw upload (audit)
  file_hash      TEXT,                  -- sha-256 of raw bytes — exact re-upload short-circuit
  format         TEXT,                  -- 'csv' | 'pdf'
  column_map     TEXT,                  -- JSON: inferred {date,amount|debit|credit,description,...}
  row_count      INTEGER,
  imported_count INTEGER,
  opening_cents  INTEGER,               -- balance reconciliation (self-check)
  closing_cents  INTEGER,
  reconciled     INTEGER,               -- 1 ok, 0 mismatch, NULL = no balances to check
  recon_diff_cents INTEGER,             -- expected - closing
  status         TEXT NOT NULL DEFAULT 'parsed',  -- parsed|previewed|imported|failed
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stmt_user ON statements(user_id, account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stmt_filehash ON statements(user_id, file_hash);

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

-- ── Tenant situation: who the user is (drives categorisation context) ─────────
-- The user registers these via scripts/onboard.mjs. They feed buildSystemPrompt so
-- the agent knows which properties exist, the company/GST status, the novated lease,
-- and any deterministic per-user rules.

-- Investment / owned properties. Resolves transactions.property_id and drives the
-- rented-vs-vacant deductibility split.
CREATE TABLE IF NOT EXISTS properties (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  label         TEXT NOT NULL,           -- short name shown to the model, e.g. "14 Rental St"
  address       TEXT,
  status        TEXT NOT NULL DEFAULT 'rented',  -- rented|vacant|owner_occupied|sold
  ownership_pct REAL NOT NULL DEFAULT 100,
  acquired_date TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The user's tax entities. detail_json holds kind-specific fields:
--   employment     -> { employer, payg }
--   company        -> { name, abn, gst_registered, financial_year }
--   novated_lease  -> { provider, vehicle, pre_tax, fbt_method }
CREATE TABLE IF NOT EXISTS entities (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,             -- employment|company|novated_lease|individual|trust
  name        TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Deterministic per-user categorisation overrides (e.g. "Bunnings -> company tools").
-- Applied AFTER extraction, BEFORE trusting the model's bucket (highest priority wins).
CREATE TABLE IF NOT EXISTS user_rules (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  match_type  TEXT NOT NULL DEFAULT 'merchant_contains',  -- merchant_contains|merchant_exact
  pattern     TEXT NOT NULL,
  bucket      TEXT NOT NULL,
  ato_label   TEXT NOT NULL,
  property_id TEXT,                       -- optional: attribute to a property
  priority    INTEGER NOT NULL DEFAULT 100,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_txn_user   ON transactions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_corr_user  ON corrections(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, seq);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_prop_user  ON properties(user_id);
CREATE INDEX IF NOT EXISTS idx_ent_user   ON entities(user_id, active);
CREATE INDEX IF NOT EXISTS idx_rule_user  ON user_rules(user_id, active, priority);

-- ── Inference cost accounting (every Claude call records real token usage + cost) ─────
CREATE TABLE IF NOT EXISTS llm_usage (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  feature           TEXT,                 -- receipt|text|statement_columns|statement_pdf|statement_batch
  model             TEXT,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cache_read_tokens INTEGER,
  cost_cents        REAL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON llm_usage(user_id, created_at);

-- ── Async categorisation jobs (Anthropic Message Batches, ~50% off, for bulk imports) ─
CREATE TABLE IF NOT EXISTS batch_jobs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  statement_id TEXT,
  batch_id     TEXT,                  -- Anthropic message-batch id
  status       TEXT NOT NULL DEFAULT 'submitted', -- submitted|applied|failed
  chunk_map    TEXT,                  -- JSON { "<custom_id index>": [ordered line ids] }
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_batch_status ON batch_jobs(status);
CREATE INDEX IF NOT EXISTS idx_batch_user ON batch_jobs(user_id, status);

-- ── Public marketing waitlist (no tenant; pre-signup) ─────────────────────────
-- Populated by the public POST /waitlist endpoint on the apex (quillo.au). This is
-- NOT tenant data — it has no user_id and sits outside the Access boundary. We store
-- a sha-256 hash of the client IP (never the raw IP) so the table stays privacy-clean.
CREATE TABLE IF NOT EXISTS waitlist (
  id          TEXT PRIMARY KEY,            -- crypto.randomUUID()
  email       TEXT NOT NULL UNIQUE,        -- stored lowercased+trimmed; UNIQUE = dedupe
  source      TEXT,                        -- e.g. 'landing-hero' | 'landing-beta'
  ip_hash     TEXT,                        -- sha-256 hex of CF-Connecting-IP (no raw IP)
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_waitlist_created ON waitlist(created_at);
