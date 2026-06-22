-- 0065: usage-based wallet billing (flag `billing`). Free to join + a free credit allowance, then the
-- user pays their actual AI cost + a tiny margin, drawn from a pre-paid credit balance (topped up via
-- Stripe). Additive + apply-once. Inert unless `billing` is in FEATURES ⇒ byte-identical when off.
--
-- The wallet balance is in 1e-4-cent units (matches daily_cost.cents_e4) so sub-cent AI calls debit
-- exactly. credit_ledger records GRANTS + TOP-UPS (the credits coming in); debits adjust the balance
-- directly and are already itemised in llm_usage/daily_cost, so they're not duplicated here.
ALTER TABLE profiles ADD COLUMN credit_balance_e4 INTEGER NOT NULL DEFAULT 0; -- wallet balance, 1e-4-cent units
ALTER TABLE profiles ADD COLUMN free_grant_at TEXT;                            -- when the one-off free allowance was granted (NULL = not yet)

CREATE TABLE IF NOT EXISTS credit_ledger (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,                 -- 'grant' (free allowance) | 'topup' (Stripe)
  amount_e4   INTEGER NOT NULL,              -- credits added, 1e-4-cent units
  ref         TEXT,                          -- Stripe session/payment id (topup) or note
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger(user_id, created_at);
-- Idempotency backstop: one credit per (user, ref) — a re-delivered Stripe webhook (same session id)
-- or a double signup-grant (ref='signup free allowance') is a no-op via INSERT OR IGNORE.
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_ref ON credit_ledger(user_id, ref);
