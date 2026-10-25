-- 0092 — the weekly sweep counts failed attempts at its next chunk (review of the D1 scale programme).
--
-- WHY. A slice killed by the platform before it checkpoints leaves the cursor where it was, so every tick
-- retried the same tenants forever and the sweep never went idle. attempts counts lease takeovers since the
-- last checkpoint; past a limit the sweep skips that chunk (logged) instead of looping. Additive, apply-once.

ALTER TABLE cron_sweeps ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
