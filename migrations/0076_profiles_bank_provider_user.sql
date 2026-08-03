-- 0076 — remember the aggregator-side consumer id per tenant.
--
-- Basiq bills per USER CREATED, for the full month, regardless of activity. So the id must be
-- stored and reused: calling createUser again on a reconnect would mint a second billable consumer
-- for the same human and split their connections across two aggregator identities.
--
-- It lives on `profiles` (one row per tenant) rather than on `bank_connections` (one row per
-- institution) because the Basiq user is a property of the TENANT, and it must exist BEFORE the
-- first connection does — the consent flow needs a CLIENT_ACCESS token bound to that user id in
-- order to run at all. Denormalising it onto each connection row would leave the bootstrap case
-- with nowhere to write.
--
-- NOT a credential: this id cannot authenticate to a bank or to Basiq on its own. It is an
-- identifier, so it is not envelope-encrypted (unlike the QBO OAuth tokens in qbo_connections).
--
-- Additive and apply-once: ALTER TABLE ADD COLUMN only. `profiles` is already in PURGE_TABLES, so
-- this column is covered by the tenant purge and the APP-12 export without further change — but
-- deleting the row does NOT delete the consumer at Basiq; that is deleteBasiqUser, wired with the
-- consent dashboard.
--
-- JURISDICTION-NEUTRAL: no currency, FY or date assumption. `bank_provider` names which aggregator
-- issued the id, so a second provider (or a non-AU one) is a new value, not a schema change.

ALTER TABLE profiles ADD COLUMN bank_provider_user_id TEXT;
ALTER TABLE profiles ADD COLUMN bank_provider TEXT;
