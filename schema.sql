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
  -- Categorisation path override: 'auto' | 'live' | 'batch'. NULL => env default (CATEGORISE_MODE,
  -- itself 'auto'). Lets us force live/batch per tenant to A/B the UX + measure cost (migration 0013).
  categorise_mode    TEXT,
  -- APP 8 cross-border consent must be EXPLICIT + dated (fix H7) — a bare default=1
  -- does not satisfy the principle. Recorded only via recordConsent().
  consent_xborder        INTEGER NOT NULL DEFAULT 0,
  consent_xborder_at     TEXT,
  consent_xborder_method TEXT,
  consent_xborder_text   TEXT,
  retention_years        INTEGER NOT NULL DEFAULT 5,  -- data-retention window for the flag sweep (lib/retention.ts)
  ui_state               TEXT,                        -- per-tenant UI state JSON (e.g. walkthrough seen) — no localStorage
  roles              TEXT NOT NULL DEFAULT '["individual"]', -- 0017: platform roles JSON (admin|accountant|bookkeeper|support|individual)
  email              TEXT,                            -- 0017: signup email (from Clerk JWT) for the admin signups list
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
  -- 0007: forward-only link to the canonical documents registry.
  document_id  TEXT,
  -- 0008: capital classification + the asset a capital receipt created.
  is_capital   INTEGER DEFAULT 0,        -- capital vs immediate repair/maintenance
  asset_id     TEXT,                     -- FK assets.id if this receipt created an asset
  capital_class TEXT,                    -- repair|div40|div43|initial_repair
  -- 0011: deductibility is DEFERRED to year-end review — captured/bucketed mid-year, resolved once.
  -- 0021: a rules-first matcher (src/lib/deductibility.ts) now stamps a DENY-BY-DEFAULT verdict on
  --       'payg' spend at ingest so the indicative position can exclude private/non-deductible spend
  --       (s8-1) without waiting for review; 0021 backfills clearly-private existing payg rows. No DDL.
  deductibility TEXT DEFAULT 'undetermined', -- undetermined|likely_deductible|likely_not|needs_apportionment|confirmed_deductible|confirmed_not
  deductible_amount_cents INTEGER,       -- apportioned claimable amount (cents), resolved at review; NULL until then
  -- 0012: a credit bank-line manually linked to the income row it duplicates (de-dup); NULL = unmatched.
  matched_income_id TEXT,
  -- 0030: employer-reimbursed spend isn't a deductible loss/outgoing — excluded from the position
  --       and never turned into a depreciating asset by the auto-linker. Defaults 0 => legacy.
  reimbursed   INTEGER NOT NULL DEFAULT 0,
  -- 0034: who actually paid + from which account, so the attribution layer can split payer from the
  --       entity entitled to deduct (TR 93/32; personally-paid company costs). NULL => legacy.
  payer_person_id     TEXT,
  paid_via_account_id TEXT,
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
CREATE INDEX IF NOT EXISTS idx_txn_matched_income ON transactions(user_id, matched_income_id);
CREATE INDEX IF NOT EXISTS idx_txn_user_date ON transactions(user_id, txn_date); -- per-FY dashboard/progress range scans (migration 0018)

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

-- 0027: links a loan account to the property it funds, with the deductible-interest %. Set-up data
-- only — pre-fills the Phase 5 interest/principal split; inert until that step reads it.
CREATE TABLE IF NOT EXISTS loans_properties (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL,
  loan_account_id         TEXT NOT NULL,            -- accounts.id (type='loan')
  property_id             TEXT NOT NULL,            -- properties.id
  deductible_interest_pct REAL NOT NULL DEFAULT 0,  -- 0-100; pre-fill default for the Phase 5 split
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, loan_account_id, property_id)
);
CREATE INDEX IF NOT EXISTS idx_loanprop_account ON loans_properties(user_id, loan_account_id);
CREATE INDEX IF NOT EXISTS idx_loanprop_property ON loans_properties(user_id, property_id);

-- 0028: soft, per-FY sign-off (user's own "ready to hand off" attestation; re-openable, never a lock).
CREATE TABLE IF NOT EXISTS fy_signoff (
  user_id       TEXT NOT NULL,
  fy            INTEGER NOT NULL,
  signed_off_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, fy)
);

-- 0029: prior-year carry-ins captured at Set-up. CAPTURE-ONLY — surfaced as defer-to-agent findings,
-- never auto-applied to the headline (capital losses offset capital gains only; opening adjustable
-- values changing depreciation is a STOP-and-ask money-output call).
CREATE TABLE IF NOT EXISTS capital_loss_carryins (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  prior_fy    INTEGER NOT NULL,
  loss_cents  INTEGER NOT NULL,
  asset_id    TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_caploss_user ON capital_loss_carryins(user_id);

CREATE TABLE IF NOT EXISTS depreciation_opening_balances (
  id                            TEXT PRIMARY KEY,
  user_id                       TEXT NOT NULL,
  fy                            INTEGER NOT NULL,
  asset_id                      TEXT,
  opening_adjustable_value_cents INTEGER NOT NULL,
  notes                         TEXT,
  created_at                    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_depopen_user ON depreciation_opening_balances(user_id, fy);

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
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  txn_id      TEXT NOT NULL,
  field       TEXT NOT NULL,              -- bucket|ato_label|amount_cents|merchant (allowlisted in code)
  old_value   TEXT,
  new_value   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  batch_id    TEXT,                       -- 0022: groups the per-txn corrections of one bulk action; NULL = standalone
  reverted_at TEXT                        -- 0022: set when an undo writes old_value back; NULL = still applied
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
  enc_ver             INTEGER NOT NULL DEFAULT 0,  -- 0=plaintext (legacy), 1=AES-GCM sealed (QBO_TOKEN_KEY); see lib/token-crypto.ts
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Tenant situation: who the user is (drives categorisation context) ─────────
-- The user registers these via scripts/onboard.mjs. They feed buildSystemPrompt so
-- the agent knows which properties exist, the company/GST status, the novated lease,
-- and any deterministic per-user rules.

-- Persons (0006): the taxpayer abstraction above entities/properties — the apportionment
-- root for income, deductions and depreciation. One 'self' person is seeded per tenant.
CREATE TABLE IF NOT EXISTS persons (
  id            TEXT PRIMARY KEY,                 -- 'person_self_<user_id>' for the self person
  user_id       TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'self',     -- self|spouse|dependent|other
  occupation    TEXT,                             -- ATO occupation guide key
  tax_residency TEXT NOT NULL DEFAULT 'AU',       -- drives rule-pack selection (Phase 5)
  tfn_last4     TEXT,                             -- never store the full TFN
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_persons_user ON persons(user_id);

-- Joint ownership (many persons : one property). Overrides properties.ownership_pct when present.
CREATE TABLE IF NOT EXISTS property_owners (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  property_id   TEXT NOT NULL,
  person_id     TEXT NOT NULL,
  ownership_pct REAL NOT NULL DEFAULT 100.0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_property_owners ON property_owners(user_id, property_id);

-- Investment / owned properties. Resolves transactions.property_id and drives the
-- rented-vs-vacant deductibility split.
CREATE TABLE IF NOT EXISTS properties (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  label         TEXT NOT NULL,           -- short name shown to the model, e.g. "14 Rental St"
  address       TEXT,
  status        TEXT NOT NULL DEFAULT 'rented',  -- rented|vacant|owner_occupied|sold
  -- 0031: finer use-status that GATES deductibility (private_use_rent_free / vacant_land /
  --       under_renovation_not_available deny deductions while CGT cost base still accrues).
  use_status    TEXT,                    -- rented|genuinely_available_for_rent|private_use_rent_free|under_renovation_not_available|vacant_land|owner_occupied
  ownership_pct REAL NOT NULL DEFAULT 100, -- single-owner fast path; property_owners overrides when present
  acquired_date TEXT,
  notes         TEXT,
  -- 0006_persons.sql: owner + jurisdiction + CGT/cost-base fields.
  person_id     TEXT,                    -- primary owner (FK persons.id)
  jurisdiction  TEXT DEFAULT 'AU',
  cost_base_cents INTEGER,               -- purchase price + incidental capital costs
  acquired_cost_detail_json TEXT,        -- stamp duty, legals (capital, not deductible)
  disposal_date TEXT,
  disposal_proceeds_cents INTEGER,
  first_income_date TEXT,                -- 'home first used to produce income' rule
  main_residence_flag INTEGER DEFAULT 0,
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
  person_id   TEXT,                      -- 0006_persons.sql: owning taxpayer (FK persons.id)
  jurisdiction TEXT DEFAULT 'AU',        -- 0006_persons.sql
  -- 0032: real columns for the company-position engine. entity_roles (many-to-many) overrides the
  --       single person_id when rows exist (mirrors property_owners).
  entity_type      TEXT,                 -- individual|payg_employment|company|property_partnership|trust|partnership|smsf
  base_rate_entity INTEGER NOT NULL DEFAULT 0, -- 1 => 25% company rate (else 30)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 0032: person<->entity many-to-many with roles (a person is many things to many entities).
-- Overrides entities.person_id when rows exist. Dark until the attribution engine reads it.
CREATE TABLE IF NOT EXISTS entity_roles (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  person_id     TEXT NOT NULL,                  -- persons.id
  entity_id     TEXT NOT NULL,                  -- entities.id
  role          TEXT NOT NULL,                  -- individual_taxpayer|employee|director|shareholder|co_owner|partner
  ownership_pct REAL,                           -- shareholder/co-owner/partner %; NULL for non-equity roles
  start_date    TEXT,                           -- roles change over time (continuity-of-ownership tests)
  end_date      TEXT,
  detail_json   TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, person_id, entity_id, role)
);
CREATE INDEX IF NOT EXISTS idx_entity_roles_entity ON entity_roles(user_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_roles_person ON entity_roles(user_id, person_id);

-- 0033: income_activities — the explicit source-of-income spine. Every transaction/attribution hangs
-- off an activity (or the 'private' sink). Seeded from entities/properties; transactions not backfilled.
CREATE TABLE IF NOT EXISTS income_activities (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  entity_id        TEXT,                         -- entities.id (NULL for the 'private' sink)
  activity_type    TEXT NOT NULL,                -- salary_wages|rental_property|business|investment|private
  property_id      TEXT,                         -- properties.id for rental_property
  occupation_scope TEXT,                         -- rule-pack scope key (e.g. it_professional)
  fy               TEXT,                         -- nullable: cross-FY activities allowed
  label            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_income_act_user   ON income_activities(user_id, activity_type);
CREATE INDEX IF NOT EXISTS idx_income_act_entity ON income_activities(user_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_income_act_prop   ON income_activities(user_id, property_id);

-- 0034: transaction_attributions — split WHO PAID from WHO DEDUCTS (TR 93/32; shareholder-loan
-- routing). One payment fans out to many entities/activities by ownership %. The report sums these
-- when present, else falls back to the raw-transaction path. Gated behind attribution_engine (OFF).
CREATE TABLE IF NOT EXISTS transaction_attributions (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL,
  transaction_id           TEXT NOT NULL,           -- transactions.id
  entity_id                TEXT NOT NULL,           -- the taxpayer claiming it
  income_activity_id       TEXT,                    -- income_activities.id
  attributed_pct           REAL,                    -- XOR with amount; the ownership/work split
  attributed_amount_cents  INTEGER,
  work_use_pct             REAL,                    -- mixed-use apportionment
  deduction_provision      TEXT,                    -- s8-1_general|div40|div43|s40-880|wfh_fixed_rate|private_non_deductible
  creates_shareholder_loan INTEGER NOT NULL DEFAULT 0,
  shareholder_loan_id      TEXT,                    -- FK shareholder_loans.id (Phase C); NULL until then
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_txn_attr_txn    ON transaction_attributions(user_id, transaction_id);
CREATE INDEX IF NOT EXISTS idx_txn_attr_entity ON transaction_attributions(user_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_txn_attr_act    ON transaction_attributions(user_id, income_activity_id);

-- 0035: company satellites (Phase C / G4). Facts a pre-revenue Pty Ltd needs; policy numbers live in
-- the KV rule pack per FY. The engine computes the loss carry-forward; R&D + Div 7A are defer-to-agent.
CREATE TABLE IF NOT EXISTS company_tax_positions (
  id                          TEXT PRIMARY KEY,
  user_id                     TEXT NOT NULL,
  entity_id                   TEXT NOT NULL,
  fy                          TEXT NOT NULL,
  assessable_income_cents     INTEGER NOT NULL DEFAULT 0,
  deductions_cents            INTEGER NOT NULL DEFAULT 0,
  current_year_loss_cents     INTEGER NOT NULL DEFAULT 0,
  carried_forward_losses_cents INTEGER NOT NULL DEFAULT 0,
  cot_satisfied               INTEGER NOT NULL DEFAULT 1,
  sbt_satisfied               INTEGER NOT NULL DEFAULT 0,
  base_rate_entity            INTEGER NOT NULL DEFAULT 1,
  computed_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, entity_id, fy)
);
CREATE INDEX IF NOT EXISTS idx_cotaxpos_user ON company_tax_positions(user_id, fy);

CREATE TABLE IF NOT EXISTS blackhole_costs (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  entity_id           TEXT NOT NULL,
  incurred_date       TEXT NOT NULL,
  amount_cents        INTEGER NOT NULL,
  description         TEXT,
  immediate_deduction INTEGER NOT NULL DEFAULT 0,
  years_claimed       INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_blackhole_user ON blackhole_costs(user_id, entity_id);

CREATE TABLE IF NOT EXISTS shareholder_loans (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL,
  company_entity_id        TEXT NOT NULL,
  shareholder_person_id    TEXT NOT NULL,
  direction                TEXT NOT NULL DEFAULT 'person_funds_company',
  balance_cents            INTEGER NOT NULL DEFAULT 0,
  loan_agreement_in_place  INTEGER NOT NULL DEFAULT 0,
  benchmark_rate_pct       REAL,
  min_yearly_repayment_cents INTEGER,
  deemed_dividend_risk     INTEGER NOT NULL DEFAULT 0,
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, company_entity_id, shareholder_person_id, direction)
);
CREATE INDEX IF NOT EXISTS idx_shloan_user ON shareholder_loans(user_id, company_entity_id);

CREATE TABLE IF NOT EXISTS rd_claims (
  id                          TEXT PRIMARY KEY,
  user_id                     TEXT NOT NULL,
  entity_id                   TEXT NOT NULL,
  fy                          TEXT NOT NULL,
  eligible_expenditure_cents  INTEGER NOT NULL DEFAULT 0,
  aggregated_turnover_cents   INTEGER NOT NULL DEFAULT 0,
  offset_type                 TEXT,
  registered_with_ausindustry INTEGER NOT NULL DEFAULT 0,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, entity_id, fy)
);
CREATE INDEX IF NOT EXISTS idx_rdclaims_user ON rd_claims(user_id, entity_id);

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

-- 0025: Phase 4 accountant pass — one row per "Do my books" run (progress/audit + in-flight lock).
CREATE TABLE IF NOT EXISTS accountant_runs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  fy          TEXT NOT NULL,
  stage       TEXT,
  status      TEXT NOT NULL DEFAULT 'running',
  summary_json TEXT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

-- 0024: Phase 3 claim auto-matcher — attached transaction evidence per claim_suggestion.
CREATE TABLE IF NOT EXISTS claim_links (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  claim_id   TEXT NOT NULL,
  txn_id     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, claim_id, txn_id)
);

-- 0023: Stage B clarify-by-pattern — one question per recurring merchant stem (per FY).
CREATE TABLE IF NOT EXISTS clarify_questions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  fy            TEXT NOT NULL,
  group_key     TEXT NOT NULL,
  sample_desc   TEXT,
  direction     TEXT,
  n             INTEGER NOT NULL DEFAULT 0,
  total_cents   INTEGER NOT NULL DEFAULT 0,
  suggested_json TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  answer_json   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, fy, group_key)
);

CREATE INDEX IF NOT EXISTS idx_txn_user   ON transactions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_corr_user  ON corrections(user_id);
CREATE INDEX IF NOT EXISTS idx_corr_batch ON corrections(user_id, batch_id);
CREATE INDEX IF NOT EXISTS idx_clarify_user_status ON clarify_questions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_claim_links_claim ON claim_links(user_id, claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_links_txn   ON claim_links(user_id, txn_id);
CREATE INDEX IF NOT EXISTS idx_acctrun_user ON accountant_runs(user_id, status);
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

-- Race-free daily AI-spend rollup (backs the budget gate). scope = 'global' or a tenant id;
-- incremented atomically via INSERT … ON CONFLICT DO UPDATE SET cents = cents + excluded.cents
-- (SQLite serialises writes, so the global tally can't lose concurrent increments). See 0019.
-- Keyed by `scope` (not a user_id column), so retention purges its per-tenant rows explicitly
-- by scope in purgeTenant — it's outside the user_id-column completeness check.
CREATE TABLE IF NOT EXISTS daily_cost (
  scope      TEXT NOT NULL,   -- 'global' OR a tenant id
  day        TEXT NOT NULL,   -- YYYY-MM-DD (UTC)
  cents      REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope, day)
);

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

-- ── Income (0007): first-class, not "counted credits" ─────────────────────────
CREATE TABLE IF NOT EXISTS income (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  person_id     TEXT,
  entity_id     TEXT,
  property_id   TEXT,
  income_type   TEXT NOT NULL,                 -- salary_payg|rent|interest|dividend|managed_fund_distribution|foreign_pension|foreign_rent|other
  ato_label     TEXT,
  fy            TEXT NOT NULL,                 -- '2025-26'
  gross_cents   INTEGER NOT NULL,
  net_cents     INTEGER,
  withholding_cents INTEGER DEFAULT 0,
  franking_credit_cents INTEGER DEFAULT 0,
  foreign_tax_paid_cents INTEGER DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'AUD',
  amount_aud_cents INTEGER,
  fx_rate       REAL,
  source_doc_id TEXT,
  txn_date      TEXT,
  detail_json   TEXT,
  needs_review  INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_income_user_fy  ON income(user_id, fy);
CREATE INDEX IF NOT EXISTS idx_income_property ON income(user_id, property_id);
CREATE INDEX IF NOT EXISTS idx_income_person   ON income(user_id, person_id);

-- ── Documents (0007): canonical R2-object registry / Smart-Inbox sink ──────────
CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  person_id     TEXT,
  doc_type      TEXT NOT NULL,
  fy            TEXT,
  property_id   TEXT,
  entity_id     TEXT,
  r2_key        TEXT NOT NULL,
  image_hash    TEXT,
  issuer        TEXT,
  doc_date      TEXT,
  extracted_json TEXT,
  classification_confidence REAL,
  needs_review  INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, doc_type, fy);

-- ── Assets & depreciation (0008) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assets (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  person_id     TEXT,
  property_id   TEXT,
  entity_id     TEXT,
  label         TEXT NOT NULL,
  asset_class   TEXT NOT NULL,                 -- div40_plant|div43_capital_works|business_asset|low_value_pool|immediate
  cost_cents    INTEGER NOT NULL,
  acquired_date TEXT NOT NULL,
  effective_life_years REAL,
  method        TEXT,                          -- diminishing_value|prime_cost
  dv_rate_pct   REAL DEFAULT 200,              -- 200 (post 10 May 2006) | 150 (pre)
  div43_rate    REAL,
  construction_date TEXT,
  is_second_hand INTEGER DEFAULT 0,
  ownership_pct REAL DEFAULT 100.0,
  business_use_pct REAL DEFAULT 100.0,
  -- 0030: who owns / whether reimbursed. owned_by='employer' or reimbursed=1 => no decline-in-value
  --       (Div 40 needs the taxpayer to own and bear the cost). Defaults => legacy behaviour.
  owned_by      TEXT NOT NULL DEFAULT 'self',   -- self|employer
  reimbursed    INTEGER NOT NULL DEFAULT 0,
  disposed_date TEXT,
  disposal_value_cents INTEGER,
  source_doc_id TEXT,
  status        TEXT DEFAULT 'active',
  needs_review  INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(user_id, status);
CREATE INDEX IF NOT EXISTS idx_assets_property ON assets(user_id, property_id);

CREATE TABLE IF NOT EXISTS depreciation_schedule (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  asset_id        TEXT NOT NULL,
  fy              TEXT NOT NULL,
  opening_adjustable_value_cents INTEGER NOT NULL,
  days_held       INTEGER NOT NULL,
  deduction_cents INTEGER NOT NULL,
  closing_adjustable_value_cents INTEGER NOT NULL,
  method_applied  TEXT NOT NULL,
  computed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(asset_id, fy)
);
CREATE INDEX IF NOT EXISTS idx_depsched_user_fy ON depreciation_schedule(user_id, fy);

-- ── CGT holdings + disposal events (0037, #138) ───────────────────────────────
-- A CGT asset is a parcel with a cost base; a CGT event is a disposal. Net capital gain (after losses
-- + the 50% discount) is computed in src/lib/cgt.ts and feeds taxable income (never tax payable).
-- Crypto is a cgt_asset with asset_kind='crypto'. Flag-gated by cgt_engine; zero rows ⇒ no change.
CREATE TABLE IF NOT EXISTS cgt_assets (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL,
  person_id              TEXT,
  asset_kind             TEXT NOT NULL,              -- shares|crypto|property|managed_fund|other
  code                   TEXT,
  label                  TEXT,
  units                  REAL,
  acquired_date          TEXT,
  cost_base_cents        INTEGER NOT NULL DEFAULT 0,
  reduced_cost_base_cents INTEGER,
  main_residence_exempt  INTEGER NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'held',
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cgt_assets_user ON cgt_assets(user_id, asset_kind);
CREATE INDEX IF NOT EXISTS idx_cgt_assets_person ON cgt_assets(user_id, person_id);

CREATE TABLE IF NOT EXISTS cgt_events (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  cgt_asset_id        TEXT NOT NULL,
  fy                  TEXT NOT NULL,
  event_type          TEXT NOT NULL DEFAULT 'disposal',
  event_date          TEXT NOT NULL,
  proceeds_cents      INTEGER NOT NULL DEFAULT 0,
  cost_base_used_cents INTEGER NOT NULL DEFAULT 0,
  units_disposed      REAL,
  discount_eligible   INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cgt_events_user_fy ON cgt_events(user_id, fy);
CREATE INDEX IF NOT EXISTS idx_cgt_events_asset ON cgt_events(user_id, cgt_asset_id);

-- ── FY checklist (0009): bucket-driven kickoff/wrap-up items ───────────────────
CREATE TABLE IF NOT EXISTS fy_checklist (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  person_id   TEXT NOT NULL,
  fy          TEXT NOT NULL,
  item_key    TEXT NOT NULL,
  title       TEXT NOT NULL,
  rationale   TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  trigger_bucket TEXT,
  due_hint    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, person_id, fy, item_key)
);
CREATE INDEX IF NOT EXISTS idx_checklist_user_fy ON fy_checklist(user_id, fy, status);

-- ── Claimability brain (0010): deterministic rules + per-user suggestion log ───
CREATE TABLE IF NOT EXISTS claimability_rules (
  id            TEXT PRIMARY KEY,
  rule_pack_ver TEXT NOT NULL,
  jurisdiction  TEXT NOT NULL DEFAULT 'AU',
  scope_type    TEXT NOT NULL,               -- occupation|bucket|entity_kind|property_status
  scope_value   TEXT NOT NULL,
  merchant_hint TEXT,
  ato_label     TEXT,
  claim_type    TEXT NOT NULL,               -- immediate|div40|div43|apportioned|not_deductible
  default_method TEXT,
  confidence_floor REAL DEFAULT 0.7,
  general_info_note TEXT NOT NULL,
  defer_to_agent INTEGER DEFAULT 0,
  user_id       TEXT,                          -- NULL = global pack override; set = per-tenant rule (AI gap-fill)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_claimrules_ver ON claimability_rules(rule_pack_ver, scope_type, scope_value);
CREATE INDEX IF NOT EXISTS idx_claimrules_user ON claimability_rules(rule_pack_ver, user_id);

CREATE TABLE IF NOT EXISTS claim_suggestions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  person_id     TEXT,
  txn_id        TEXT,
  asset_id      TEXT,
  rule_id       TEXT,
  suggestion    TEXT NOT NULL,
  claim_type    TEXT,
  estimated_deduction_cents INTEGER,
  llm_explanation TEXT,
  status        TEXT DEFAULT 'suggested',
  source        TEXT NOT NULL DEFAULT 'ingest',  -- 'ingest' = per-transaction suggestClaims; 'review' = Find My Claims sweep
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_claimsug_user ON claim_suggestions(user_id, status);

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

-- ── Per-FY work-use inputs (computed WFH / car deductions) ────────────────────
-- See migrations/0026_work_use_inputs.sql. wfh_hours → fixed-rate method; car_work_km → cents-per-km
-- method. One row per user per FY. Flag-gated (wfh_car_methods) in report.ts.
CREATE TABLE IF NOT EXISTS work_use_inputs (
  user_id      TEXT NOT NULL,
  fy           INTEGER NOT NULL,
  wfh_hours    REAL,
  car_work_km  REAL,
  -- 0036: capture WFH as days/week so hours can be derived transparently (wfh_hours stays authoritative).
  wfh_days_per_week REAL,
  wfh_weeks         REAL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, fy)
);
