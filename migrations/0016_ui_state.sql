-- 0016: per-tenant UI state (JSON) — server-side persistence for things like the first-login
-- walkthrough "seen" flag, since the app must not use localStorage. Additive + apply-once.
ALTER TABLE profiles ADD COLUMN ui_state TEXT;
