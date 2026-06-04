-- 0015: configurable data-retention window per tenant (APP 11.2 / ATO record-keeping).
--
-- retention_years drives the weekly "old data" FLAG sweep (lib/retention.ts) — it never
-- auto-deletes tax records; it only surfaces a notification once records pass the window so the
-- user can decide. Default 5 = the ATO five-years-from-lodgement rule. Additive + apply-once.
ALTER TABLE profiles ADD COLUMN retention_years INTEGER NOT NULL DEFAULT 5;
