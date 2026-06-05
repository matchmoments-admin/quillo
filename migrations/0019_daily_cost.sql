-- 0019_daily_cost.sql — race-free daily AI-spend counters (C3).
--
-- The daily spend totals that back the budget gate (MAX_DAILY_COST_CENTS per-user and
-- MAX_DAILY_COST_CENTS_GLOBAL platform-wide) used to live in KV and were maintained by a
-- non-atomic read-compute-write. The GLOBAL key is written concurrently by every tenant's
-- Durable Object, so lost updates UNDER-counted it and the ceiling could be overshot. Move the
-- counter to D1: SQLite serialises writes, so `cents = cents + excluded.cents` in an
-- INSERT … ON CONFLICT DO UPDATE is atomic and cannot lose an increment.
--
-- `scope` is 'global' for the platform tally or a user_id for a per-tenant tally; `day` is the
-- UTC YYYY-MM-DD slice (same key the KV counter used). Additive + idempotent (CREATE TABLE IF
-- NOT EXISTS) — safe to re-run.
CREATE TABLE IF NOT EXISTS daily_cost (
  scope      TEXT NOT NULL,   -- 'global' OR a user_id
  day        TEXT NOT NULL,   -- YYYY-MM-DD (UTC)
  cents      REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope, day)
);
