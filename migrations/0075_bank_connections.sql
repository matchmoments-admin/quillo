-- 0075 — Bank feeds via an Open Banking / CDR aggregator (Basiq). Foundation only: schema +
-- purge coverage. No read/write path lands until the `bank_feed_cdr` flag is ON and the
-- connect/sync endpoints ship (PR 3/4), so this migration is inert on apply.
--
-- Design: docs/adr-0003-bank-feed-cdr-access.md §6.2. Canonical-source invariant (ADR-0002)
-- holds — an account's money comes from exactly ONE of cdr_feed | statement | qbo_feed, never two.
--
-- ACCESS TYPE IS THE LOAD-BEARING COLUMN. Basiq serves the same account shape over three
-- transports (its own dashboard counts them as CDR / WEB / PDF) and they carry DIFFERENT legal
-- obligations:
--   'cdr' — Consumer Data Right data. Subject to the CDR Privacy Safeguards for its whole life
--           inside Quillo. PS8 restricts disclosure to an overseas recipient and carries penalty
--           provisions; a consumer CANNOT consent past it. Inference on this data must be
--           AU-resident (Bedrock ap-southeast-2) — see src/llm.ts assertAuResidency.
--   'web'  — non-CDR web-connector data. Ordinary personal information: the existing APP-8
--           consent gate governs, PS8 does not attach.
-- Defaulting to 'cdr' is deliberate and fail-closed: a row that fails to record its transport
-- gets the STRICTER treatment. The reverse default would silently skip the residency guard.
--
-- Additive and apply-once: CREATE TABLE/INDEX IF NOT EXISTS only. All three tables are added to
-- PURGE_TABLES in src/lib/retention.ts in the same PR (new tenant table ⇒ must be purgeable), which
-- is both an existing invariant and a CDR Privacy Safeguard 12 obligation.
--
-- JURISDICTION-NEUTRAL: no currency, FY or date-format assumption is stored here. Transaction
-- currency arrives per-line from the provider and is resolved through the existing FX layer.

CREATE TABLE IF NOT EXISTS bank_connections (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL,
  provider               TEXT NOT NULL DEFAULT 'basiq',   -- 'basiq' | 'fiskil' | ...
  -- 'cdr' | 'web' — see the header. Drives the PS8 residency guard; default is the strict one.
  access_type            TEXT NOT NULL DEFAULT 'cdr',
  -- The aggregator-side consumer id. NOT a credential: it cannot authenticate to a bank.
  provider_user_id       TEXT,
  -- The aggregator-side connection id (one per institution the consumer links).
  provider_connection_id TEXT,
  institution            TEXT,                            -- display name, e.g. 'Hooli OB'
  institution_id         TEXT,                            -- provider institution code, e.g. 'AU00000'
  -- pending | active | expired | revoked | error
  status                 TEXT NOT NULL DEFAULT 'pending',
  consent_id             TEXT,
  -- JSON array of the consented data clusters (account.basic, transaction.detail, …). Recorded so
  -- the consent dashboard can show the consumer exactly what they granted (a CDR obligation).
  consent_scope          TEXT,
  consent_granted_at     TEXT,
  consent_expires_at     TEXT,                            -- CDR consent is capped at 12 months
  last_sync_at           TEXT,
  last_error             TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bank_conn_user ON bank_connections(user_id, status);
-- One row per aggregator connection per tenant — a repeated callback must not fork a second record.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_conn_provider
  ON bank_connections(user_id, provider, provider_connection_id);

-- The accounts a connection exposes. `selected` is data minimisation, not a nicety: unselected
-- accounts are never pulled, which is a CDR obligation. `account_id` stays NULL until the consumer
-- maps the feed account onto a Quillo account.
CREATE TABLE IF NOT EXISTS bank_connection_accounts (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  connection_id       TEXT NOT NULL,                      -- bank_connections.id
  provider_account_id TEXT NOT NULL,
  account_id          TEXT,                               -- accounts.id — NULL until mapped
  -- LAST FOUR DIGITS ONLY. A full account number is never persisted (ADR-0003 S11).
  masked_number       TEXT,
  name                TEXT,
  type                TEXT,
  currency            TEXT,
  selected            INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, connection_id, provider_account_id)
);

CREATE INDEX IF NOT EXISTS idx_bank_conn_acct_conn ON bank_connection_accounts(user_id, connection_id);
CREATE INDEX IF NOT EXISTS idx_bank_conn_acct_mapped ON bank_connection_accounts(user_id, account_id);

-- One row per sync attempt. This is the evidence trail for "did the feed actually cover the year",
-- which is the same completeness question statements get wrong today (issue #472) — recording the
-- requested window per run is what lets a coverage check exist at all.
CREATE TABLE IF NOT EXISTS bank_sync_runs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  from_date     TEXT,
  to_date       TEXT,
  fetched       INTEGER NOT NULL DEFAULT 0,
  imported      INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  -- ok | partial | failed
  status        TEXT NOT NULL DEFAULT 'ok',
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bank_sync_conn ON bank_sync_runs(user_id, connection_id, created_at);

-- accounts.source gains 'cdr_feed' as a fourth canonical source. No DDL: the column is TEXT with no
-- CHECK constraint, so this is a vocabulary extension recorded in schema.sql alongside the others.
