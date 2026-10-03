-- 0079 — "We noticed…" signals from the deterministic credit triage (first-timer spec A3, #577).
--
-- WHY. A bank-only first-timer's credits say WHERE to look, never WHAT to record (#532): a fortnightly
-- deposit from "BIG RETAIL PTY LTD" is take-home pay, so recording it as income would understate gross
-- pay and double-count once the income statement arrives (#554). The triage (src/lib/credit-triage.ts)
-- proposes a profile change per payer — payroll, platform payout, government payment, interest, money
-- from overseas — and the user confirms each one. A signal row remembers the proposal and the user's
-- decision so a dismissal sticks across re-imports (UNIQUE key + INSERT … ON CONFLICT, refreshed only
-- while still 'open').
--
-- MINIMISATION. evidence_json holds counts, first/last dates and a total only — never a raw bank
-- description. signal_key is the clarify groupKey stem (two normalised tokens), not the line text.
--
-- transactions.payer_entity_id: on a CREDIT, the employer entity it is pay from. Set only when the user
-- confirms "this is my wages"; it records NOTHING to the position. It powers the per-employer income
-- statement prompt and blocks the credit from ever being recorded as personal income.
--
-- Additive and apply-once: CREATE TABLE/INDEX IF NOT EXISTS + ALTER TABLE ADD COLUMN. Tenant table →
-- PURGE_TABLES (and so the APP-12 export). JURISDICTION-NEUTRAL: the payer lists live in the rule pack.

CREATE TABLE IF NOT EXISTS noticed_signals (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  fy            TEXT NOT NULL,                 -- '2025-26'
  kind          TEXT NOT NULL,                 -- payroll | platform | government | interest | foreign | grow_* (A11)
  signal_key    TEXT NOT NULL,                 -- groupKey stem of the payer (src/lib/clarify.ts groupKey)
  status        TEXT NOT NULL DEFAULT 'open',  -- open | confirmed | dismissed
  evidence_json TEXT NOT NULL DEFAULT '{}',    -- counts + first/last date + total_cents only (no raw descriptions)
  ref_id        TEXT,                          -- the entity / activity created on confirm
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at    TEXT,
  UNIQUE (user_id, fy, kind, signal_key)
);
CREATE INDEX IF NOT EXISTS idx_noticed_user_fy ON noticed_signals(user_id, fy, status);

ALTER TABLE transactions ADD COLUMN payer_entity_id TEXT;
CREATE INDEX IF NOT EXISTS idx_txn_payer_entity ON transactions(user_id, payer_entity_id);
