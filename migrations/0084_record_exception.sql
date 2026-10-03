-- 0084 — record-keeping exception attestation on a claim line (first-timer spec A7, ticket #588, flag `ft_journey`).
--
-- WHY. The Records step shows, for every confirmed claim, whether a record (receipt / document / claim link)
-- backs it. The tax authority lets a person claim small amounts without written evidence (pack
-- `record_keeping.exceptions`: e.g. laundry within a limit, or total work-related claims within a limit), so a
-- confirmed line with no receipt is not always "missing a record". The user ATTESTS that a line falls under
-- one of those exceptions; that attestation is stored here.
--
-- It is an attestation, NEVER evidence: "has a record" is never derived from this column, and the Records
-- step re-checks eligibility on every read (a line stops counting as an exception once totals pass the
-- limit). POSITION-NEUTRAL: no countable predicate, report or position query reads it.
--
-- Additive and apply-once: ALTER TABLE ADD COLUMN only. No new table (nothing for PURGE_TABLES; the column
-- rides along with `transactions` in the purge and the export). JURISDICTION-NEUTRAL: the values are the
-- pack's exception keys.

ALTER TABLE transactions ADD COLUMN record_exception TEXT;  -- NULL | <pack record_keeping.exceptions key> (laundry_150 | total_300 in au-v1); user attestation, not evidence

-- #587 (the Review queue, absorbing #589; flag `reconcile_proposals`): what a receipt <-> bank-line link changed,
-- stored on the RECEIPT row as JSON { line_id, auto, filled: {gst_cents?, bucket?, ato_label?}, line_status,
-- receipt_status }. `auto` marks a link the import-time auto-matcher made without a tap (listed in Review with an
-- Undo); `filled` + the statuses let that Undo put the line back exactly. Written only with the flag ON, cleared on
-- unlink/undo; a snapshot whose line_id isn't the current link is ignored. Working data, so it lives with the row
-- (purged and exported with `transactions`) rather than in the audit log. Never read by the position.
ALTER TABLE transactions ADD COLUMN link_snapshot TEXT;  -- NULL | JSON link snapshot (see above)
