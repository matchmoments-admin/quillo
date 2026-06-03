-- 0009_checklist.sql
-- FY-scoped kickoff/wrap-up checklist, driven by the tenant's buckets/entities/properties.
-- (The documents registry itself shipped in 0007.) Apply:
--   wrangler d1 execute tax-agent-db --remote --file=migrations/0009_checklist.sql
-- Additive + idempotent (table IF NOT EXISTS; items upserted on the UNIQUE key). person_id is
-- always the self person (never NULL) so the UNIQUE actually de-dups.

CREATE TABLE IF NOT EXISTS fy_checklist (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  person_id   TEXT NOT NULL,
  fy          TEXT NOT NULL,
  item_key    TEXT NOT NULL,                 -- 'rental_eofy_summary'|'qs_dep_schedule'|...
  title       TEXT NOT NULL,
  rationale   TEXT,                          -- why this item exists (bucket-driven, GENERAL-INFO)
  status      TEXT NOT NULL DEFAULT 'open',  -- open|done|dismissed|not_applicable
  trigger_bucket TEXT,                       -- which bucket/situation generated it
  due_hint    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, person_id, fy, item_key)
);
CREATE INDEX IF NOT EXISTS idx_checklist_user_fy ON fy_checklist(user_id, fy, status);
