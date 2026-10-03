-- 0085 — bank-feed consent lifecycle + CDR audit log (#576, ADR-0003 §6.3 step 7 + §6.4, S9/S10).
-- Numbered 0085 because 0078–0084 are reserved by docs/first-timer/spec.md for the first-timer areas;
-- all are additive and independent, so apply order between them does not matter.
--
-- The consent dashboard is the gate ADR-0003 names before `bank_feed_cdr` can flip: a consumer must
-- be able to SEE each consent and WITHDRAW it, and a withdrawal must (a) revoke upstream at the
-- aggregator and (b) run the Privacy Safeguard 12 delete path over the CDR data already collected.
--
-- bank_connections gains the lifecycle timestamps. They are separate columns, not one status, because
-- the three halves of a withdrawal can succeed independently and the dashboard has to say which did:
--   revoked_at           — WE stopped collecting (status flips to 'revoked'; sync reads only 'active').
--                          Written FIRST, so a vendor outage can never keep a withdrawn consent live.
--   upstream_revoked_at  — the aggregator confirmed the connection / consumer is gone. NULL after a
--                          failed vendor call ⇒ the dashboard offers a retry and the weekly sweep
--                          retries it.
--   data_deleted_at      — the PS12 delete of the CDR lines collected under this connection ran.
--   expiry_reminded_at   — one reminder per consent before its 12-month expiry (ADR-0003 §6.4).
--
-- cdr_audit_log is a STRUCTURED record of every consent grant, collection, expiry, withdrawal and
-- deletion — counts, ids and windows only, never an account number, description or payload. The
-- hash-chained audit_log keeps recording the same events in its generic shape; this table exists
-- because the CDR record-keeping and ACCC/OAIC reporting obligations ask questions ("how many
-- consents were withdrawn this period", "when was this consumer's data deleted") that a free-text
-- JSON column answers badly.
--
-- It is deliberately NOT in PURGE_TABLES, exactly like audit_log: the record that a consumer's CDR
-- data was deleted has to outlive the data (the CDR rules require these records be kept), and it
-- holds no CDR data itself — so erasing it would destroy the evidence of the erasure.
--
-- profiles.cdr_tainted (0077) is untouched by every path here. A withdrawal stops future collection;
-- it does not change what the safeguards cover for anything derived while consent was live.
--
-- Additive and apply-once: ALTER TABLE ADD COLUMN + CREATE TABLE/INDEX IF NOT EXISTS. Inert until
-- `bank_feed_cdr` is ON (no writer runs while it is OFF, except purgeTenant revoking an aggregator
-- consumer that already exists — which writes one row only for a tenant that has one).
-- JURISDICTION-NEUTRAL: no currency, FY or regulator-specific value is stored.

ALTER TABLE bank_connections ADD COLUMN revoked_at TEXT;
ALTER TABLE bank_connections ADD COLUMN upstream_revoked_at TEXT;
ALTER TABLE bank_connections ADD COLUMN data_deleted_at TEXT;
ALTER TABLE bank_connections ADD COLUMN expiry_reminded_at TEXT;

CREATE TABLE IF NOT EXISTS cdr_audit_log (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  connection_id TEXT,                      -- bank_connections.id; NULL for tenant-level events
  provider      TEXT,                      -- 'basiq' | …
  access_type   TEXT,                      -- 'cdr' | 'web' (web-connector rows are logged too, labelled)
  -- consent_granted | collected | consent_expired | expiry_reminder | consent_withdrawn |
  -- upstream_revoked | upstream_revoke_failed | data_deleted | tenant_purged
  event         TEXT NOT NULL,
  account_count INTEGER,
  row_count     INTEGER,
  from_date     TEXT,
  to_date       TEXT,
  detail        TEXT,                      -- JSON: counts / ids / error class only
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cdr_audit_user ON cdr_audit_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cdr_audit_event ON cdr_audit_log(event, created_at);
