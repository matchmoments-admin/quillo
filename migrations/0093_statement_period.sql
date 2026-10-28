-- 0093 — the period a statement covers, as printed on it (flag statement_account_detect, 2026-10-28).
--
-- WHY. The statement extractor now reads the period off the statement. Storing it lets an evidence pack say which
-- dates each account's statements cover and where the gaps are, and lets two statements for one account be
-- compared without re-reading the PDF. NULL for statements parsed before the flag (and for CSVs).
--
-- Additive and apply-once.

ALTER TABLE statements ADD COLUMN period_start TEXT;  -- ISO YYYY-MM-DD, as printed
ALTER TABLE statements ADD COLUMN period_end TEXT;
