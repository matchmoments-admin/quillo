-- 0047: Savings & Opportunities advisory layer (factual-info MVP — no partners, no PII egress).
-- Adds (a) a normalised biller_key on transactions for grouping recurring spend, (b) recurring_bills
-- (detected streams: variable bills AND fixed subscriptions), and (c) opportunities (factual, dismissible
-- nudges with a lifecycle). All per-user (carry user_id) → registered in PURGE_TABLES + export/retention.
-- The detection engine is deterministic (src/lib/advisory.ts) — NO LLM, so no AI-spend gate interaction.
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0047_advisory_savings.sql
-- Idempotency: ALTER ADD COLUMN (one-time) + CREATE TABLE/INDEX IF NOT EXISTS. The whole surface is
-- gated by the advisory_layer feature flag (OFF in prod until validated ⇒ no read/write path, byte-identical).

-- (a) Normalised biller identity on the transactions spine (channel-stripped; never entity-merged).
ALTER TABLE transactions ADD COLUMN biller_key TEXT;
CREATE INDEX IF NOT EXISTS idx_transactions_biller ON transactions(user_id, biller_key);

-- (b) Recurring bills / subscriptions detected from the transactions spine. One row per (tenant, biller).
CREATE TABLE IF NOT EXISTS recurring_bills (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL,
  biller_key           TEXT NOT NULL,            -- normalised from merchant/raw_description (NOT NULL ⇒ no NULL-distinct dedup hole)
  label                TEXT,                     -- a human sample of the merchant (display only)
  category             TEXT,                     -- energy|gas|water|internet|mobile|insurance|health|streaming|other
  cadence              TEXT,                     -- weekly|fortnightly|monthly|quarterly|annual|irregular
  typical_amount_cents INTEGER,
  amount_variance_cents INTEGER DEFAULT 0,       -- max−min spread; 0 ≈ fixed subscription
  annual_amount_cents  INTEGER,                  -- typical × payments/year (0 for irregular)
  is_subscription      INTEGER DEFAULT 0,        -- 1 if fixed-amount subscription
  is_essential         INTEGER DEFAULT 0,        -- 1 if switchable utility/insurance (drives the signpost)
  occurrences          INTEGER DEFAULT 0,
  first_seen_date      TEXT,
  last_seen_date       TEXT,
  next_expected_date   TEXT,
  status               TEXT DEFAULT 'detected',  -- detected|early|confirmed|dismissed|ended
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, biller_key)                   -- natural key; both cols NOT NULL ⇒ idempotent upsert
);
CREATE INDEX IF NOT EXISTS idx_recurring_bills_user ON recurring_bills(user_id);

-- (c) Opportunities: factual savings/insight nudges with a lifecycle. subject_key NOT NULL DEFAULT ''
-- so tenant-wide opportunities (no biller/bucket subject) still dedup under the UNIQUE natural key.
CREATE TABLE IF NOT EXISTS opportunities (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL,
  opportunity_type     TEXT NOT NULL,            -- run_rate|recurring_review|essential_switch
  subject_key          TEXT NOT NULL DEFAULT '', -- biller_key / bucket / '' (for idempotency)
  fy                   TEXT,                     -- FY start year the figure is scoped to (NULL = all-time)
  recurring_bill_id    TEXT,                     -- nullable FK → recurring_bills.id
  category             TEXT,
  title                TEXT,
  body                 TEXT,                     -- FACTUAL copy only (built in src/lib/advisory.ts)
  amount_cents         INTEGER,                  -- the factual figure shown
  signpost_label       TEXT,                     -- government comparator label (essentials only)
  signpost_url         TEXT,
  status               TEXT DEFAULT 'open',      -- open|dismissed|actioned|expired
  notified             INTEGER DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, opportunity_type, subject_key)
);
CREATE INDEX IF NOT EXISTS idx_opportunities_user ON opportunities(user_id);
